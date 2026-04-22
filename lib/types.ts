// Shared contracts between client + server. One file so the transcript,
// suggestion, chat, session-hydration, and export flows all speak the
// same shapes.

export type TranscriptSegment = {
  id: string;
  text: string;
  startedAt: number; // ms since session start
  endedAt: number; // ms since session start
  createdAt: number; // ms since epoch — used by the sliding-window filter
};

// The subset of a segment the client needs to render a transcript line.
export type SegmentPayload = {
  text: string;
  startedAt: number;
  endedAt: number;
};

export type TranscribeResponse =
  | { ok: true; segment: SegmentPayload | null }
  | { ok: false; error: string };

export type TranscriptResponse =
  | { ok: true; segments: TranscriptSegment[] }
  | { ok: false; error: string };

// ---------- Suggestions ----------

export type SuggestionType =
  | "question"
  | "insight"
  | "action"
  | "fact-check"
  | "talking-point";

export const SUGGESTION_TYPES: readonly SuggestionType[] = [
  "question",
  "insight",
  "action",
  "fact-check",
  "talking-point",
] as const;

export type Suggestion = {
  id: string;
  type: SuggestionType;
  title: string;
  preview: string;
  anchorQuote: string;
  createdAt: number;
};

// ---------- Phase ----------

export type Phase =
  | "opening"
  | "discovery"
  | "deep-dive"
  | "decision"
  | "wrap-up"
  | "smalltalk";

export const PHASES: readonly Phase[] = [
  "opening",
  "discovery",
  "deep-dive",
  "decision",
  "wrap-up",
  "smalltalk",
] as const;

export type SuggestionsResponse =
  | {
      ok: true;
      suggestions: Suggestion[];
      phase: Phase | null;
      latencyMs: number;
    }
  | { ok: false; error: string };

export type SuggestionsRequest = {
  sessionId: string;
  // Optional overrides from Settings. Server falls back to defaults when absent.
  promptOverride?: string | null;
};

// ---------- Running summary ----------

export type RunningSummary = {
  summary: string;
  summarizedUpToMs: number;
  updatedAt: number;
};

// ---------- Chat ----------

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  seededFrom?: { suggestionId: string; title: string } | null;
};

export type ChatRequest = {
  sessionId: string;
  message: string;
  suggestionId?: string | null;
  // Pass a stable client-generated id so the server can persist the same
  // assistant message id the UI is rendering — makes reload hydration
  // match what the user just saw.
  userMessageId?: string;
  assistantMessageId?: string;
  promptOverride?: string | null;
};

// ---------- Session hydration + export ----------

export type SessionState = {
  sessionId: string;
  transcript: TranscriptSegment[];
  latestSuggestions: Suggestion[];
  phase: Phase | null;
  summary: RunningSummary | null;
  chat: ChatMessage[];
};

export type SessionStateResponse =
  | { ok: true; state: SessionState }
  | { ok: false; error: string };

export type ExportFormat = "json" | "md";

// ---------- Client-side settings (localStorage) ----------

export type ClientPromptOverrides = {
  suggestion?: string;
  chat?: string;
};

export type ClientSettings = {
  groqApiKey?: string;
  prompts?: ClientPromptOverrides;
};
