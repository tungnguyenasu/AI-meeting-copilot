import { getGroq } from "./groq";
import { buildRecentWindow } from "./context";
import { transcriptStore } from "./transcriptStore";
import { suggestionStore } from "./suggestionStore";
import { summaryStore } from "./summaryStore";
import { buildHistoryForReplay, chatStore } from "./chatStore";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./prompts";

// Re-export so existing callers keep working.
export { DEFAULT_CHAT_SYSTEM_PROMPT };

// 70B for chat: response quality matters more here than in summaries,
// and with streaming the user sees the first token in <1s anyway.
const CHAT_MODEL = "llama-3.3-70b-versatile";

export type ChatPromptInput = {
  sessionId: string;
  message: string;
  suggestionId?: string | null;
  overrideKey?: string | null;
  promptOverride?: string | null;
};

// Builds the FRESH user-turn content with current context. Prior turns
// are replayed as their original text (see chatStore.buildHistoryForReplay)
// so we don't re-send stale transcript windows. We fire all three store
// reads in parallel — Redis adds ~30ms per round-trip, so serial reads
// would be a needless 60ms on the critical path to first token.
async function buildUserBlock(input: ChatPromptInput): Promise<string> {
  const [segments, summaryEntry, seed] = await Promise.all([
    transcriptStore.get(input.sessionId),
    summaryStore.get(input.sessionId),
    input.suggestionId
      ? suggestionStore.findById(input.sessionId, input.suggestionId)
      : Promise.resolve(null),
  ]);
  const window = buildRecentWindow(segments);
  const summary = summaryEntry?.summary ?? "";

  return [
    "OLDER_CONTEXT:",
    summary || "(none)",
    "",
    "RECENT_TRANSCRIPT:",
    `"""`,
    window || "(empty)",
    `"""`,
    "",
    ...(seed
      ? [
          "SUGGESTION_CONTEXT (the user clicked this suggestion):",
          `- type: ${seed.type}`,
          `- title: ${seed.title}`,
          `- preview: ${seed.preview}`,
          `- anchor quote: "${seed.anchorQuote}"`,
          "",
        ]
      : []),
    "USER_REQUEST:",
    input.message,
  ].join("\n");
}

// Returns an async iterable of plaintext deltas. The route adapts it into
// a ReadableStream for the HTTP response. Caller owns error handling.
//
// Multi-turn memory: we pull prior turns from chatStore and insert them
// BETWEEN the system message and the fresh user turn. Prior turns keep
// their original raw message content (no stale transcript blocks).
export async function* streamChat(
  input: ChatPromptInput,
): AsyncGenerator<string, void, unknown> {
  const systemPrompt =
    input.promptOverride && input.promptOverride.trim().length > 0
      ? input.promptOverride.trim()
      : DEFAULT_CHAT_SYSTEM_PROMPT;

  // Parallel again — chat history read and the user-block builder are
  // independent. buildUserBlock internally also parallelises its reads.
  const [priorMessages, freshUser] = await Promise.all([
    chatStore.get(input.sessionId),
    buildUserBlock(input),
  ]);
  const priorTurns = buildHistoryForReplay(priorMessages);

  const groq = getGroq(input.overrideKey ?? null);
  const stream = await groq.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      ...priorTurns,
      { role: "user", content: freshUser },
    ],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) yield delta;
  }
}
