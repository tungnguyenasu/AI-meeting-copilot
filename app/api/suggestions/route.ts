import { NextRequest, NextResponse } from "next/server";
import { transcriptStore } from "@/lib/transcriptStore";
import { suggestionStore } from "@/lib/suggestionStore";
import { summaryStore } from "@/lib/summaryStore";
import { generateSuggestions } from "@/lib/suggestionService";
import { maybeRefreshSummary } from "@/lib/summaryService";
import { readGroqKeyFromHeaders, toFriendlyGroqError } from "@/lib/groq";
import type { SuggestionsRequest, SuggestionsResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
): Promise<NextResponse<SuggestionsResponse>> {
  let body: Partial<SuggestionsRequest>;
  try {
    body = (await req.json()) as Partial<SuggestionsRequest>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const sessionId = body.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId'." },
      { status: 400 },
    );
  }

  const overrideKey = readGroqKeyFromHeaders(req.headers);
  const promptOverride =
    typeof body.promptOverride === "string" ? body.promptOverride : null;

  const segments = await transcriptStore.get(sessionId);
  if (segments.length === 0) {
    return NextResponse.json({
      ok: true,
      suggestions: [],
      phase: null,
      latencyMs: 0,
    });
  }

  // Fire-and-forget the rolling-summary refresh. THIS request uses
  // whatever summary is already stored; the NEXT request sees the update.
  maybeRefreshSummary(sessionId, overrideKey);

  // Parallel reads: Redis adds ~30ms per round-trip and these three are
  // independent, so serial awaits would burn ~60-90ms on the hot path.
  const [recentTitles, recentForDedup, summaryEntry] = await Promise.all([
    suggestionStore.getRecentTitlesForPrompt(sessionId),
    suggestionStore.getRecentForDedup(sessionId),
    summaryStore.get(sessionId),
  ]);
  const olderSummary = summaryEntry?.summary ?? "";

  try {
    const t0 = Date.now();
    const { suggestions, phase, latencyMs } = await generateSuggestions({
      segments,
      recentTitles,
      recentForDedup,
      olderSummary,
      overrideKey,
      promptOverride,
    });
    const totalMs = Date.now() - t0;

    if (suggestions.length > 0) {
      await suggestionStore.recordBatch(sessionId, suggestions, phase);
    }

    console.log(
      `[suggestions] ${totalMs}ms (model ${latencyMs}ms), ${suggestions.length} items, phase=${phase ?? "?"}, summary=${olderSummary ? "yes" : "no"}, session=${sessionId.slice(0, 8)}`,
    );

    return NextResponse.json({ ok: true, suggestions, phase, latencyMs });
  } catch (err) {
    const friendly = toFriendlyGroqError(err);
    console.error(
      `[suggestions] error (${friendly.status}):`,
      friendly.message,
    );
    return NextResponse.json(
      { ok: false, error: friendly.userMessage },
      { status: friendly.status },
    );
  }
}
