import type { TranscriptSegment } from "./types";

// Sliding window used to build the "recent conversation" context we feed
// to the suggestion model. Keep this small and cheap. Segments older than
// the window are folded into the rolling summary instead.
export const WINDOW_MS = 120_000; // 2 minutes
const MIN_SEGMENTS = 2;
const MAX_CHARS = 6000; // hard cap for cost/latency

export function getWindowCutoff(now: number = Date.now()): number {
  return now - WINDOW_MS;
}

export function buildRecentWindow(
  segments: TranscriptSegment[],
  now: number = Date.now(),
): string {
  if (segments.length === 0) return "";

  const cutoff = getWindowCutoff(now);
  let recent = segments.filter((s) => s.createdAt >= cutoff);

  // Even if the user just started, we want at least MIN_SEGMENTS of context
  // (or as many as exist) so the prompt has something to chew on.
  if (recent.length < MIN_SEGMENTS) {
    recent = segments.slice(-MIN_SEGMENTS);
  }

  let joined = recent.map((s) => s.text).join(" ");
  if (joined.length > MAX_CHARS) {
    joined = joined.slice(joined.length - MAX_CHARS);
  }
  return joined;
}

// Segments older than the sliding window that haven't been folded into
// the rolling summary yet. `summarizedUpToMs` is the createdAt of the
// last segment already baked in (0 if there's no summary yet).
export function getUnsummarizedOld(
  segments: TranscriptSegment[],
  summarizedUpToMs: number,
  now: number = Date.now(),
): TranscriptSegment[] {
  const cutoff = getWindowCutoff(now);
  return segments.filter(
    (s) => s.createdAt < cutoff && s.createdAt > summarizedUpToMs,
  );
}
