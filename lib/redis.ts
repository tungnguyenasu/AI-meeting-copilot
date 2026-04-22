import { Redis } from "@upstash/redis";

// Session key TTL: 4 hours. Keeps Upstash free-tier usage tidy and
// evicts abandoned sessions automatically. Every write path re-applies
// this so an active session gets its TTL refreshed.
export const SESSION_TTL_SECONDS = 60 * 60 * 4;

// Namespaced keys for every store, keyed by sessionId. Centralised so
// all stores agree on key shapes and a future Redis DB inspection is easy.
export const keys = {
  transcript: (sid: string) => `sess:${sid}:transcript`,
  chatIds: (sid: string) => `sess:${sid}:chat:ids`,
  chatMsgs: (sid: string) => `sess:${sid}:chat:msgs`,
  sugState: (sid: string) => `sess:${sid}:sug:state`,
  summary: (sid: string) => `sess:${sid}:summary`,
  summaryLock: (sid: string) => `sess:${sid}:summary:lock`,
};

let client: Redis | null = null;

// Returns `true` if the user has opted into Redis and supplied both the
// URL and token. Otherwise every store falls back to the in-memory path.
// Local dev stays single-process + zero-config; Vercel deploys flip the
// switch by setting STORE_BACKEND=redis.
export function isRedisEnabled(): boolean {
  if (process.env.STORE_BACKEND !== "redis") return false;
  if (!process.env.UPSTASH_REDIS_REST_URL) return false;
  if (!process.env.UPSTASH_REDIS_REST_TOKEN) return false;
  return true;
}

export function getRedis(): Redis {
  if (client) return client;
  if (!isRedisEnabled()) {
    throw new Error(
      "getRedis() called but STORE_BACKEND is not 'redis' or Upstash env vars are missing. " +
        "Check STORE_BACKEND, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN in .env.local.",
    );
  }
  client = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return client;
}
