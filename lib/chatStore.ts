import type { ChatMessage } from "./types";
import { getRedis, isRedisEnabled, keys, SESSION_TTL_SECONDS } from "./redis";

// Session-scoped chat history.
//
// Redis layout uses two keys per session so upsert-by-id is O(1):
//   sess:<sid>:chat:ids   list of message ids in insertion order
//   sess:<sid>:chat:msgs  hash { msgId → JSON(ChatMessage) }
// Append: RPUSH ids + HSET msgs.
// Upsert: HEXISTS check; if new, RPUSH ids; always HSET msgs.
// Get:    LRANGE ids + HMGET msgs → reconstruct ordered list.
// Clear:  DEL both keys.
//
// We store the user's raw typed text (not the transcript-augmented
// prompt block the server builds around it). On replay we re-augment
// only the latest turn with fresh transcript context, so prior turns
// stay fixed and token cost stays bounded.

const globalForStore = globalThis as unknown as {
  __chatStore?: Map<string, ChatMessage[]>;
};

const mem: Map<string, ChatMessage[]> =
  globalForStore.__chatStore ?? new Map();

if (!globalForStore.__chatStore) {
  globalForStore.__chatStore = mem;
}

export const chatStore = {
  async get(sessionId: string): Promise<ChatMessage[]> {
    if (isRedisEnabled()) {
      const redis = getRedis();
      const ids = await redis.lrange<string>(keys.chatIds(sessionId), 0, -1);
      if (ids.length === 0) return [];
      const raw = await redis.hmget<Record<string, unknown>>(
        keys.chatMsgs(sessionId),
        ...ids,
      );
      if (!raw) return [];
      return ids
        .map((id) => parseMessage(raw[id]))
        .filter((m): m is ChatMessage => m !== null);
    }
    return mem.get(sessionId) ?? [];
  },

  async append(sessionId: string, message: ChatMessage): Promise<void> {
    if (isRedisEnabled()) {
      const redis = getRedis();
      const idsKey = keys.chatIds(sessionId);
      const msgsKey = keys.chatMsgs(sessionId);
      await redis.rpush(idsKey, message.id);
      await redis.hset(msgsKey, { [message.id]: JSON.stringify(message) });
      await redis.expire(idsKey, SESSION_TTL_SECONDS);
      await redis.expire(msgsKey, SESSION_TTL_SECONDS);
      return;
    }
    const list = mem.get(sessionId) ?? [];
    list.push(message);
    mem.set(sessionId, list);
  },

  // Replace by id (used to commit the final assistant content after
  // streaming completes). If the id isn't present we append.
  async upsert(sessionId: string, message: ChatMessage): Promise<void> {
    if (isRedisEnabled()) {
      const redis = getRedis();
      const idsKey = keys.chatIds(sessionId);
      const msgsKey = keys.chatMsgs(sessionId);
      const exists = await redis.hexists(msgsKey, message.id);
      if (!exists) {
        await redis.rpush(idsKey, message.id);
      }
      await redis.hset(msgsKey, { [message.id]: JSON.stringify(message) });
      await redis.expire(idsKey, SESSION_TTL_SECONDS);
      await redis.expire(msgsKey, SESSION_TTL_SECONDS);
      return;
    }
    const list = mem.get(sessionId) ?? [];
    const idx = list.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      list[idx] = message;
    } else {
      list.push(message);
    }
    mem.set(sessionId, list);
  },

  async clear(sessionId: string): Promise<void> {
    if (isRedisEnabled()) {
      await getRedis().del(
        keys.chatIds(sessionId),
        keys.chatMsgs(sessionId),
      );
      return;
    }
    mem.delete(sessionId);
  },
};

function parseMessage(raw: unknown): ChatMessage | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as ChatMessage;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ChatMessage;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------- Prompt replay helpers (pure, no store access) ----------

const HISTORY_MAX_CHARS = 6000;
const HISTORY_MAX_TURNS = 6;

type GroqChatMessage = { role: "user" | "assistant"; content: string };

// Returns the prior turns trimmed to fit replay limits. Caller prepends
// the system message and appends the fresh user turn (with its context
// block). Pure — caller does the async chatStore.get() first.
export function buildHistoryForReplay(messages: ChatMessage[]): GroqChatMessage[] {
  if (messages.length === 0) return [];

  const tail = messages.slice(-HISTORY_MAX_TURNS);
  const out: GroqChatMessage[] = tail.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 0 && total > HISTORY_MAX_CHARS) {
    const dropped = out.shift();
    if (dropped) total -= dropped.content.length;
  }

  // Don't start with an assistant turn after the system message.
  while (out.length > 0 && out[0].role !== "user") {
    out.shift();
  }
  return out;
}
