import type { Phase, Suggestion } from "./types";
import { getRedis, isRedisEnabled, keys, SESSION_TTL_SECONDS } from "./redis";

// Session-scoped suggestion store. Stores three things:
//   - latest batch (for UI hydration + findById on chat click-seed),
//   - rolling "recent meta" (title+preview) used by the prompt
//     negative-example hint AND by the server-side Jaccard dedup gate,
//   - last detected phase (for UI display).
//
// Redis layout: a single hash per session so state reads are 1 round-trip.
//   sess:<sid>:sug:state { latest: JSON, recentMeta: JSON, lastPhase: string }

const RECENT_LIMIT = 20;
const RECENT_FOR_PROMPT = 5;

type RecentMeta = { title: string; preview: string };

type MemShape = {
  latest: Map<string, Suggestion[]>;
  recentMeta: Map<string, RecentMeta[]>;
  lastPhase: Map<string, Phase>;
};

const globalForStore = globalThis as unknown as {
  __suggestionStore?: MemShape;
};

const mem: MemShape =
  globalForStore.__suggestionStore ?? {
    latest: new Map(),
    recentMeta: new Map(),
    lastPhase: new Map(),
  };

if (!globalForStore.__suggestionStore) {
  globalForStore.__suggestionStore = mem;
}

async function readState(sessionId: string): Promise<{
  latest: Suggestion[];
  recentMeta: RecentMeta[];
  lastPhase: Phase | null;
}> {
  if (!isRedisEnabled()) {
    return {
      latest: mem.latest.get(sessionId) ?? [],
      recentMeta: mem.recentMeta.get(sessionId) ?? [],
      lastPhase: mem.lastPhase.get(sessionId) ?? null,
    };
  }
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string>>(
    keys.sugState(sessionId),
  );
  if (!raw) {
    return { latest: [], recentMeta: [], lastPhase: null };
  }
  return {
    latest: parseJsonField<Suggestion[]>(raw.latest) ?? [],
    recentMeta: parseJsonField<RecentMeta[]>(raw.recentMeta) ?? [],
    lastPhase: (raw.lastPhase as Phase | undefined) ?? null,
  };
}

export const suggestionStore = {
  async recordBatch(
    sessionId: string,
    suggestions: Suggestion[],
    phase: Phase | null,
  ): Promise<void> {
    const state = await readState(sessionId);
    const nextMeta = [
      ...state.recentMeta,
      ...suggestions.map((s) => ({ title: s.title, preview: s.preview })),
    ];
    const trimmed =
      nextMeta.length > RECENT_LIMIT
        ? nextMeta.slice(nextMeta.length - RECENT_LIMIT)
        : nextMeta;
    const nextPhase = phase ?? state.lastPhase;

    if (isRedisEnabled()) {
      const redis = getRedis();
      const key = keys.sugState(sessionId);
      const fields: Record<string, string> = {
        latest: JSON.stringify(suggestions),
        recentMeta: JSON.stringify(trimmed),
      };
      if (nextPhase) fields.lastPhase = nextPhase;
      await redis.hset(key, fields);
      await redis.expire(key, SESSION_TTL_SECONDS);
      return;
    }

    mem.latest.set(sessionId, suggestions);
    mem.recentMeta.set(sessionId, trimmed);
    if (phase) mem.lastPhase.set(sessionId, phase);
  },

  async getLatest(sessionId: string): Promise<Suggestion[]> {
    return (await readState(sessionId)).latest;
  },

  async getRecentForDedup(sessionId: string): Promise<RecentMeta[]> {
    return (await readState(sessionId)).recentMeta;
  },

  async getRecentTitlesForPrompt(
    sessionId: string,
    n: number = RECENT_FOR_PROMPT,
  ): Promise<string[]> {
    const { recentMeta } = await readState(sessionId);
    return recentMeta.slice(-n).map((m) => m.title);
  },

  async getLastPhase(sessionId: string): Promise<Phase | null> {
    return (await readState(sessionId)).lastPhase;
  },

  // findById currently only searches the latest batch, preserving the
  // pre-Redis behavior. If we ever need cross-batch lookup we'll add a
  // secondary hash keyed by id.
  async findById(sessionId: string, id: string): Promise<Suggestion | null> {
    const { latest } = await readState(sessionId);
    return latest.find((s) => s.id === id) ?? null;
  },

  async clear(sessionId: string): Promise<void> {
    if (isRedisEnabled()) {
      await getRedis().del(keys.sugState(sessionId));
      return;
    }
    mem.latest.delete(sessionId);
    mem.recentMeta.delete(sessionId);
    mem.lastPhase.delete(sessionId);
  },
};

function parseJsonField<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as T;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}
