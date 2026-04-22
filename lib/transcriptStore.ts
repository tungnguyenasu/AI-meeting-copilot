import type { TranscriptSegment } from "./types";
import { getRedis, isRedisEnabled, keys, SESSION_TTL_SECONDS } from "./redis";

// Session-scoped transcript store. Has two interchangeable backends:
//   - "memory": Map<string, TranscriptSegment[]> on globalThis, survives
//     next-dev HMR but not a server restart. Default for local dev.
//   - "redis": Upstash list, keyed per session. Survives restarts and
//     works across serverless instances (the actual reason this exists).
//
// The public interface is identical; routes / services see a promise
// either way. Pick the backend via STORE_BACKEND=memory|redis in env.

const globalForStore = globalThis as unknown as {
  __transcriptStore?: Map<string, TranscriptSegment[]>;
};

const memStore: Map<string, TranscriptSegment[]> =
  globalForStore.__transcriptStore ?? new Map();

if (!globalForStore.__transcriptStore) {
  globalForStore.__transcriptStore = memStore;
}

export const transcriptStore = {
  async append(sessionId: string, segment: TranscriptSegment): Promise<void> {
    if (isRedisEnabled()) {
      const redis = getRedis();
      const key = keys.transcript(sessionId);
      // JSON.stringify explicitly so we don't depend on the SDK's
      // auto-serialization behavior (which has historically surprised
      // people on edge cases like Date round-trips).
      await redis.rpush(key, JSON.stringify(segment));
      await redis.expire(key, SESSION_TTL_SECONDS);
      return;
    }
    const existing = memStore.get(sessionId) ?? [];
    existing.push(segment);
    memStore.set(sessionId, existing);
  },

  async get(sessionId: string): Promise<TranscriptSegment[]> {
    if (isRedisEnabled()) {
      const raw = await getRedis().lrange<string>(
        keys.transcript(sessionId),
        0,
        -1,
      );
      return raw.map((item) => parseSegment(item)).filter(Boolean) as TranscriptSegment[];
    }
    return memStore.get(sessionId) ?? [];
  },

  async clear(sessionId: string): Promise<void> {
    if (isRedisEnabled()) {
      await getRedis().del(keys.transcript(sessionId));
      return;
    }
    memStore.delete(sessionId);
  },
};

// Upstash's SDK may auto-parse JSON strings back into objects. Handle
// both shapes so we're resilient to SDK version drift.
function parseSegment(raw: unknown): TranscriptSegment | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as TranscriptSegment;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as TranscriptSegment;
    } catch {
      return null;
    }
  }
  return null;
}
