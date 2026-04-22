import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { streamChat } from "@/lib/chatService";
import { chatStore } from "@/lib/chatStore";
import { suggestionStore } from "@/lib/suggestionStore";
import { readGroqKeyFromHeaders, toFriendlyGroqError } from "@/lib/groq";
import type { ChatMessage, ChatRequest } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Partial<ChatRequest>;
  try {
    body = (await req.json()) as Partial<ChatRequest>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { sessionId, message, suggestionId } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId'." },
      { status: 400 },
    );
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing 'message'." },
      { status: 400 },
    );
  }

  const overrideKey = readGroqKeyFromHeaders(req.headers);
  const promptOverride =
    typeof body.promptOverride === "string" ? body.promptOverride : null;
  const userMessageId =
    typeof body.userMessageId === "string" && body.userMessageId.length > 0
      ? body.userMessageId
      : randomUUID();
  const assistantMessageId =
    typeof body.assistantMessageId === "string" &&
    body.assistantMessageId.length > 0
      ? body.assistantMessageId
      : randomUUID();

  // Persist the user turn up-front so even if the stream dies mid-flight
  // the hydration endpoint will show what they asked.
  const seed =
    suggestionId && typeof suggestionId === "string"
      ? await suggestionStore.findById(sessionId, suggestionId)
      : null;
  const userMsg: ChatMessage = {
    id: userMessageId,
    role: "user",
    content: message.trim(),
    createdAt: Date.now(),
    seededFrom: seed ? { suggestionId: seed.id, title: seed.title } : null,
  };
  await chatStore.append(sessionId, userMsg);

  const encoder = new TextEncoder();
  const t0 = Date.now();
  let assistantContent = "";
  const shortSession = sessionId.slice(0, 8);

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of streamChat({
          sessionId,
          message: message.trim(),
          suggestionId: suggestionId ?? null,
          overrideKey,
          promptOverride,
        })) {
          assistantContent += delta;
          controller.enqueue(encoder.encode(delta));
        }
        console.log(
          `[chat] ${Date.now() - t0}ms, ${assistantContent.length} chars, session=${shortSession}`,
        );
      } catch (err) {
        const friendly = toFriendlyGroqError(err);
        console.error(
          `[chat] error (${friendly.status}):`,
          friendly.message,
        );
        controller.enqueue(
          encoder.encode(`\n\n[error] ${friendly.userMessage}`),
        );
      } finally {
        // Persist whatever streamed (including partial content on abort).
        // We skip the error-tail for cleaner replay — what's in
        // assistantContent is the portion the model actually produced.
        if (assistantContent.trim().length > 0) {
          const asstMsg: ChatMessage = {
            id: assistantMessageId,
            role: "assistant",
            content: assistantContent,
            createdAt: Date.now(),
          };
          // Fire-and-forget: we're in a ReadableStream's finally, the
          // response body is already closing. Await would keep the
          // controller open needlessly; errors are still logged.
          chatStore
            .upsert(sessionId, asstMsg)
            .catch((err) =>
              console.error("[chat] failed to persist assistant turn:", err),
            );
        }
        controller.close();
      }
    },
    cancel() {
      // Client aborted mid-stream; the `finally` above still runs and
      // persists whatever we had. No-op here.
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      // Expose the ids the server used so the client can reconcile state
      // if it didn't pre-supply them.
      "x-user-message-id": userMessageId,
      "x-assistant-message-id": assistantMessageId,
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
  await chatStore.clear(sessionId);
  return NextResponse.json({ ok: true });
}
