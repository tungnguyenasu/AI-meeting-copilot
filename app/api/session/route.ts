import { NextRequest, NextResponse } from "next/server";
import { transcriptStore } from "@/lib/transcriptStore";
import { suggestionStore } from "@/lib/suggestionStore";
import { summaryStore } from "@/lib/summaryStore";
import { chatStore } from "@/lib/chatStore";
import type { SessionStateResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-shot hydration endpoint. The client calls this on mount if it
// finds a stored sessionId in localStorage. A tab refresh then restores
// the full UI (transcript, last suggestions batch, phase, rolling
// summary, chat history) so sessions feel durable even though the
// underlying stores are still in-memory.
export async function GET(
  req: NextRequest,
): Promise<NextResponse<SessionStateResponse>> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId'." },
      { status: 400 },
    );
  }

  const [transcript, latestSuggestions, phase, summary, chat] =
    await Promise.all([
      transcriptStore.get(sessionId),
      suggestionStore.getLatest(sessionId),
      suggestionStore.getLastPhase(sessionId),
      summaryStore.get(sessionId),
      chatStore.get(sessionId),
    ]);

  return NextResponse.json({
    ok: true,
    state: {
      sessionId,
      transcript,
      latestSuggestions,
      phase,
      summary,
      chat,
    },
  });
}

export async function DELETE(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId'." },
      { status: 400 },
    );
  }
  await Promise.all([
    transcriptStore.clear(sessionId),
    suggestionStore.clear(sessionId),
    summaryStore.clear(sessionId),
    chatStore.clear(sessionId),
  ]);
  return NextResponse.json({ ok: true });
}
