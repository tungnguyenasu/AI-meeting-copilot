import type { RunningSummary } from "./types";
import { getRedis, isRedisEnabled, keys, SESSION_TTL_SECONDS } from "./redis";

// Session-scoped rolling summary plus a refresh lock.
//
// On memory backend the lock is a per-process Set — two overlapping
// summary refreshes inside the same Node process can't both start.
//
// On Redis backend the lock is a SET NX EX value — two concurrent
// serverless instances can't both spawn a summary refresh for the same
// session. Lock has a 30s TTL so a crashed instance can't deadlock a
// session permanently.

const LOCK_TTL_SECONDS = 30;

type MemShape = {
  data: Map<string, RunningSummary>;
  inFlight: Set<string>;
};

const globalForStore = globalThis as unknown as {
  __summaryStore?: MemShape;
};

const mem: MemShape =
  globalForStore.__summaryStore ?? {
    data: new Map(),
    inFlight: new Set(),
  };

if (!globalForStore.__summaryStore) {
  globalForStore.__summaryStore = mem;
}

export const summaryStore = {
  async get(sessionId: string): Promise<RunningSummary | null> {
    if (isRedisEnabled()) {
      const raw = await getRedis().get<unknown>(keys.summary(sessionId));
      return parseSummary(raw);
    }
    return mem.data.get(sessionId) ?? null;
  },

  async set(sessionId: string, value: RunningSummary): Promise<void> {
    if (isRedisEnabled()) {
      const redis = getRedis();
      await redis.set(keys.summary(sessionId), JSON.stringify(value), {
        ex: SESSION_TTL_SECONDS,
      });
      return;
    }
    mem.data.set(sessionId, value);
  },

  // Atomically acquires the refresh lock. Returns false if another
  // refresh is already running for this session.
  async beginRefresh(sessionId: string): Promise<boolean> {
    if (isRedisEnabled()) {
      const redis = getRedis();
      const result = await redis.set(keys.summaryLock(sessionId), "1", {
        nx: true,
        ex: LOCK_TTL_SECONDS,
      });
      // Upstash returns "OK" on success and null on NX-miss.
      return result === "OK";
    }
    if (mem.inFlight.has(sessionId)) return false;
    mem.inFlight.add(sessionId);
    return true;
  },

  async endRefresh(sessionId: string): Promise<void> {
    if (isRedisEnabled()) {
      await getRedis().del(keys.summaryLock(sessionId));
      return;
    }
    mem.inFlight.delete(sessionId);
  },

  async clear(sessionId: string): Promise<void> {
    if (isRedisEnabled()) {
      await getRedis().del(keys.summary(sessionId), keys.summaryLock(sessionId));
      return;
    }
    mem.data.delete(sessionId);
    mem.inFlight.delete(sessionId);
  },
};

function parseSummary(raw: unknown): RunningSummary | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as RunningSummary;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RunningSummary;
    } catch {
      return null;
    }
  }
  return null;
}
