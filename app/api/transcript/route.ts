import { NextRequest, NextResponse } from "next/server";
import { transcriptStore } from "@/lib/transcriptStore";
import type { TranscriptResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/transcript?sessionId=...
// Returns the full transcript for a session. Used by Day 2 (suggestions) +
// Day 3 (chat + export).
export async function GET(req: NextRequest): Promise<NextResponse<TranscriptResponse>> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId' query param." },
      { status: 400 },
    );
  }
  const segments = await transcriptStore.get(sessionId);
  return NextResponse.json({ ok: true, segments });
}
