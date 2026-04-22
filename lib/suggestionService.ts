import { randomUUID } from "node:crypto";
import { getGroq } from "./groq";
import {
  PHASES,
  SUGGESTION_TYPES,
  type Phase,
  type Suggestion,
  type SuggestionType,
  type TranscriptSegment,
} from "./types";
import { buildRecentWindow } from "./context";
import { DUPLICATE_THRESHOLD, similarityScore } from "./similarity";
import { DEFAULT_SUGGESTION_SYSTEM_PROMPT } from "./prompts";

// Re-export so existing callers keep working.
export { DEFAULT_SUGGESTION_SYSTEM_PROMPT };

// 70B on Groq comes back in ~400–800ms for this payload and produces
// dramatically better JSON + anchor-quote grounding than 8B. The ~500ms
// cost buys a big quality jump. Swap to "llama-3.1-8b-instant" here if
// you ever need to trade quality for latency.
const SUGGESTION_MODEL = "llama-3.3-70b-versatile";

type RawSuggestion = {
  type?: unknown;
  title?: unknown;
  preview?: unknown;
  anchorQuote?: unknown;
};

function isSuggestionType(value: unknown): value is SuggestionType {
  return (
    typeof value === "string" &&
    (SUGGESTION_TYPES as readonly string[]).includes(value)
  );
}

function isPhase(value: unknown): value is Phase {
  return (
    typeof value === "string" && (PHASES as readonly string[]).includes(value)
  );
}

function trimTrailingPunct(s: string): string {
  return s.replace(/[.!?,;:]+\s*$/u, "").trim();
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export type SuggestionServiceResult = {
  suggestions: Suggestion[];
  phase: Phase | null;
  latencyMs: number;
};

export async function generateSuggestions(args: {
  segments: TranscriptSegment[];
  recentTitles: string[];
  recentForDedup: { title: string; preview: string }[];
  olderSummary: string; // "" when none
  overrideKey?: string | null;
  promptOverride?: string | null;
}): Promise<SuggestionServiceResult> {
  const {
    segments,
    recentTitles,
    recentForDedup,
    olderSummary,
    overrideKey,
    promptOverride,
  } = args;

  const window = buildRecentWindow(segments);
  if (window.trim().length === 0) {
    return { suggestions: [], phase: null, latencyMs: 0 };
  }

  const user = [
    "OLDER_CONTEXT:",
    olderSummary.trim().length > 0 ? olderSummary : "(none)",
    "",
    "RECENT_TITLES (avoid repeating or paraphrasing these):",
    recentTitles.length > 0
      ? recentTitles.map((t) => `- ${t}`).join("\n")
      : "(none yet)",
    "",
    "RECENT_TRANSCRIPT:",
    `"""`,
    window,
    `"""`,
    "",
    'Respond with JSON only: {"phase":"...","suggestions":[ ... 3 items ... ]}',
  ].join("\n");

  const systemPrompt =
    promptOverride && promptOverride.trim().length > 0
      ? promptOverride.trim()
      : DEFAULT_SUGGESTION_SYSTEM_PROMPT;

  const groq = getGroq(overrideKey ?? null);
  const t0 = Date.now();
  const resp = await groq.chat.completions.create({
    model: SUGGESTION_MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: user },
    ],
  });
  const latencyMs = Date.now() - t0;

  const content = resp.choices[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Model returned non-JSON output: ${content.slice(0, 200)}`);
  }

  const phaseRaw = (parsed as { phase?: unknown }).phase;
  const phase: Phase | null = isPhase(phaseRaw) ? phaseRaw : null;

  const raw = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(raw)) {
    throw new Error("Model JSON missing 'suggestions' array.");
  }

  const normalizedWindow = normalizeForMatch(window);
  const createdAt = Date.now();
  const seenTypes = new Set<SuggestionType>();
  const out: Suggestion[] = [];

  for (const item of raw as RawSuggestion[]) {
    if (
      !isSuggestionType(item.type) ||
      typeof item.title !== "string" ||
      typeof item.preview !== "string" ||
      typeof item.anchorQuote !== "string"
    ) {
      continue;
    }
    if (seenTypes.has(item.type)) {
      // Enforce the "3 different types" contract on our side even if the
      // model slipped.
      continue;
    }

    const title = trimTrailingPunct(item.title).slice(0, 80);
    const preview = item.preview.trim().slice(0, 400);
    const anchorQuote = item.anchorQuote.trim().slice(0, 240);
    if (!title || !preview || !anchorQuote) continue;

    // Semantic dedup vs recent suggestions. Catches "ask about pricing"
    // vs "probe on cost" that the title-only prompt hint missed.
    const candidate = { title, preview };
    const worst = recentForDedup.reduce(
      (acc, prior) => Math.max(acc, similarityScore(candidate, prior)),
      0,
    );
    if (worst >= DUPLICATE_THRESHOLD) {
      console.log(
        `[suggestions] dropped semantic dupe (score=${worst.toFixed(2)}): ${title}`,
      );
      continue;
    }

    // Soft grounding check. If the quote isn't a verbatim substring we
    // still keep the suggestion — the LLM occasionally merges adjacent
    // fragments — but we log it so bad grounding shows up in the server
    // log while you're iterating on the prompt.
    if (!normalizedWindow.includes(normalizeForMatch(anchorQuote))) {
      console.warn(
        `[suggestions] anchor quote not found verbatim: ${JSON.stringify(anchorQuote)}`,
      );
    }

    seenTypes.add(item.type);
    out.push({
      id: randomUUID(),
      type: item.type,
      title,
      preview,
      anchorQuote,
      createdAt,
    });

    if (out.length === 3) break;
  }

  if (out.length === 0) {
    // Either the model duped everything or returned nothing usable.
    // Surface this rather than pretending — the UI keeps the prior batch.
    throw new Error("No non-duplicate suggestions survived filtering.");
  }

  return { suggestions: out, phase, latencyMs };
}
