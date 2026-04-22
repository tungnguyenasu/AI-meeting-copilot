import { getGroq } from "./groq";
import { summaryStore } from "./summaryStore";
import { transcriptStore } from "./transcriptStore";
import { getUnsummarizedOld } from "./context";
import type { RunningSummary, TranscriptSegment } from "./types";

// 8B is well within its capability for summarization and it's ~2x faster
// on Groq than 70B. The summary isn't on the suggestion critical path —
// it runs in the background — but keeping it cheap is still nice.
const SUMMARY_MODEL = "llama-3.1-8b-instant";

// Don't churn on every new segment. Wait until enough old-segment
// material has accumulated to be worth a fold-in.
const MIN_NEW_OLD_SEGMENTS_TO_REFRESH = 4;
const MAX_SUMMARY_CHARS = 500;

const SYSTEM = `You compress a meeting transcript into a running summary.

You will be given:
- EXISTING_SUMMARY: the running summary so far (may be empty).
- NEW_SEGMENTS: transcript chunks we now want folded in.

Produce a NEW running summary, 2-3 sentences, <=400 chars, that captures:
- the topic(s) under discussion,
- key claims / numbers / names / decisions / unresolved questions,
- anything still likely relevant 10 minutes from now.

Rules:
- Output the summary text only. No preamble, no JSON, no quotes.
- Do NOT drop prior facts just because they weren't repeated in NEW_SEGMENTS.
- Stay neutral; no speaker inference beyond what the transcript shows.`;

// Fire-and-forget. The current /api/suggestions call won't see the updated
// summary — the NEXT one will. This keeps suggestion-refresh latency flat.
// `overrideKey` lets the user's Settings-supplied Groq key flow through
// so BYOK also covers the background summarization path.
//
// Stays a void-returning function so callers can invoke it without
// awaiting; the real work happens inside an inner async IIFE.
export function maybeRefreshSummary(
  sessionId: string,
  overrideKey?: string | null,
): void {
  void (async () => {
    try {
      const [existing, segments] = await Promise.all([
        summaryStore.get(sessionId),
        transcriptStore.get(sessionId),
      ]);
      const summarizedUpToMs = existing?.summarizedUpToMs ?? 0;
      const oldUnsummarized = getUnsummarizedOld(segments, summarizedUpToMs);
      if (oldUnsummarized.length < MIN_NEW_OLD_SEGMENTS_TO_REFRESH) return;

      const acquired = await summaryStore.beginRefresh(sessionId);
      if (!acquired) return;

      try {
        await runSummary(
          sessionId,
          existing?.summary ?? "",
          oldUnsummarized,
          overrideKey ?? null,
        );
      } finally {
        await summaryStore.endRefresh(sessionId);
      }
    } catch (err) {
      console.error("[summary] refresh failed:", err);
    }
  })();
}

async function runSummary(
  sessionId: string,
  existingSummary: string,
  newSegments: TranscriptSegment[],
  overrideKey: string | null,
): Promise<void> {
  if (newSegments.length === 0) return;

  const joined = newSegments.map((s) => s.text).join(" ");
  const user = [
    "EXISTING_SUMMARY:",
    existingSummary || "(none)",
    "",
    "NEW_SEGMENTS:",
    `"""`,
    joined,
    `"""`,
    "",
    "Write the new running summary now.",
  ].join("\n");

  const groq = getGroq(overrideKey);
  const t0 = Date.now();
  const resp = await groq.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0.2,
    max_tokens: 220,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
  });
  const ms = Date.now() - t0;

  const summary = (resp.choices[0]?.message?.content ?? "")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
  if (!summary) {
    console.warn("[summary] model returned empty summary");
    return;
  }

  const latestCreatedAt = newSegments[newSegments.length - 1].createdAt;

  const next: RunningSummary = {
    summary,
    summarizedUpToMs: latestCreatedAt,
    updatedAt: Date.now(),
  };
  await summaryStore.set(sessionId, next);

  console.log(
    `[summary] ${ms}ms, ${summary.length} chars, folded ${newSegments.length} segments, session=${sessionId.slice(0, 8)}`,
  );
}
