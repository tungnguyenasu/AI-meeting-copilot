import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  getGroq,
  readGroqKeyFromHeaders,
  toFriendlyGroqError,
  WHISPER_MODEL,
} from "@/lib/groq";
import { transcriptStore } from "@/lib/transcriptStore";
import type { TranscribeResponse } from "@/lib/types";

export const runtime = "nodejs";
// This route MUST be dynamic — we read fresh FormData on every call.
export const dynamic = "force-dynamic";

// Silence guard: MediaRecorder emits ~1-2 KB even for pure silence (just the
// WebM container header). Anything under this is almost certainly a no-op
// chunk from a stopped or empty stream.
const MIN_BLOB_BYTES = 2000;

// Common Whisper hallucinations on silence / music. These show up even with
// whisper-large-v3-turbo and are worth dropping server-side so they never
// reach the transcript UI.
const HALLUCINATIONS = new Set(
  [
    "thanks for watching!",
    "thank you for watching!",
    "thank you for watching.",
    "thanks for watching.",
    "thank you.",
    "thank you",
    "you",
    ".",
    "bye.",
    "bye",
  ].map((s) => s.toLowerCase()),
);

function isHallucination(text: string): boolean {
  return HALLUCINATIONS.has(text.trim().toLowerCase());
}

export async function POST(req: NextRequest): Promise<NextResponse<TranscribeResponse>> {
  const t0 = Date.now();

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Invalid multipart payload." },
      { status: 400 },
    );
  }

  const file = form.get("audio");
  const sessionId = form.get("sessionId");
  const startedAtRaw = form.get("startedAt");
  const endedAtRaw = form.get("endedAt");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "Missing 'audio' file in form data." },
      { status: 400 },
    );
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId'." },
      { status: 400 },
    );
  }

  const startedAt = Number(startedAtRaw);
  const endedAt = Number(endedAtRaw);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return NextResponse.json(
      { ok: false, error: "Missing/invalid 'startedAt' or 'endedAt'." },
      { status: 400 },
    );
  }

  // Drop trivially-small or empty chunks — no need to burn a Groq call.
  if (file.size < MIN_BLOB_BYTES) {
    console.log(
      `[transcribe] skip tiny chunk (${file.size} bytes) session=${sessionId.slice(0, 8)}`,
    );
    return NextResponse.json({ ok: true, segment: null });
  }

  try {
    const overrideKey = readGroqKeyFromHeaders(req.headers);
    const groq = getGroq(overrideKey);
    const tGroq = Date.now();

    // groq-sdk accepts a browser-style File directly. We pass-through the
    // File from FormData so the WebM container stays intact.
    const resp = await groq.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      // "en" hint cuts latency and reduces mislabeling on short clips.
      // Revisit when we add multi-language UX.
      language: "en",
      // Plain text response is the fastest path — we don't need word-level
      // timestamps yet (Day 4 streaming pass will).
      response_format: "text",
      temperature: 0,
    });

    // With response_format: "text" the SDK returns a string.
    const text = (typeof resp === "string" ? resp : (resp as { text?: string }).text ?? "")
      .trim();

    const groqMs = Date.now() - tGroq;
    const totalMs = Date.now() - t0;
    console.log(
      `[transcribe] ${totalMs}ms (groq ${groqMs}ms), ${text.length} chars, ${file.size} bytes, session=${sessionId.slice(0, 8)}`,
    );

    if (text.length === 0 || isHallucination(text)) {
      return NextResponse.json({ ok: true, segment: null });
    }

    const segment = {
      id: randomUUID(),
      text,
      startedAt,
      endedAt,
      createdAt: Date.now(),
    };
    await transcriptStore.append(sessionId, segment);

    return NextResponse.json({
      ok: true,
      segment: { text: segment.text, startedAt: segment.startedAt, endedAt: segment.endedAt },
    });
  } catch (err) {
    const friendly = toFriendlyGroqError(err);
    console.error(
      `[transcribe] error (${friendly.status}):`,
      friendly.message,
    );
    return NextResponse.json(
      { ok: false, error: friendly.userMessage },
      { status: friendly.status },
    );
  }
}
