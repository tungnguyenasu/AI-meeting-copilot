"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecorder } from "@/lib/useRecorder";
import { useSuggestions } from "@/lib/useSuggestions";
import { useChat } from "@/lib/useChat";
import SettingsDrawer from "@/components/SettingsDrawer";
import { loadSettings } from "@/lib/clientSettings";
import type {
  Phase,
  SessionState,
  SessionStateResponse,
  Suggestion,
  SuggestionType,
} from "@/lib/types";

type Line = { id: string; text: string; startedAt: number; endedAt: number };

const SESSION_STORAGE_KEY = "copilot:sessionId/v1";

function formatClock(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const r = (s % 60).toString().padStart(2, "0");
  return `${m}:${r}`;
}

const TYPE_STYLES: Record<SuggestionType, { label: string; cls: string }> = {
  question: {
    label: "QUESTION",
    cls: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  },
  insight: {
    label: "INSIGHT",
    cls: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  },
  action: {
    label: "ACTION",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  "fact-check": {
    label: "FACT-CHECK",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  "talking-point": {
    label: "TALKING POINT",
    cls: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  },
};

const PHASE_LABEL: Record<Phase, string> = {
  opening: "Opening",
  discovery: "Discovery",
  "deep-dive": "Deep dive",
  decision: "Decision",
  "wrap-up": "Wrap-up",
  smalltalk: "Small talk",
};

function composeSeed(s: Suggestion): string {
  switch (s.type) {
    case "question":
    case "talking-point":
      return `Help me phrase this: "${s.title}". Give me 1-2 ways I could say it, grounded in what was just said.`;
    case "action":
      return `What specific next step does this imply, and what exactly should I do?\n\n${s.title} — ${s.preview}`;
    case "fact-check":
      return `What's the claim here, and how should I verify it?\n\n${s.preview}`;
    case "insight":
    default:
      return `Expand on this insight with specifics from the conversation:\n\n${s.title} — ${s.preview}`;
  }
}

function SuggestionCard({
  s,
  onClick,
}: {
  s: Suggestion;
  onClick: () => void;
}) {
  const style = TYPE_STYLES[s.type];
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 hover:border-zinc-600 hover:bg-zinc-900 transition"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`text-[10px] font-semibold tracking-wider px-1.5 py-0.5 rounded border ${style.cls}`}
        >
          {style.label}
        </span>
        <h3 className="text-sm font-medium text-zinc-100">{s.title}</h3>
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed">{s.preview}</p>
      <p className="mt-2 text-xs italic text-zinc-500 border-l-2 border-zinc-700 pl-2">
        “{s.anchorQuote}”
      </p>
    </button>
  );
}

// Hook: persisted session id with a "new session" escape hatch.
function useSessionId(): {
  sessionId: string | null;
  newSession: () => string;
} {
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) {
        setSessionId(existing);
        return;
      }
    } catch {
      /* fallthrough */
    }
    const fresh = crypto.randomUUID();
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
    } catch {
      /* non-fatal */
    }
    setSessionId(fresh);
  }, []);

  const newSession = useCallback(() => {
    const fresh = crypto.randomUUID();
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
    } catch {
      /* non-fatal */
    }
    setSessionId(fresh);
    return fresh;
  }, []);

  return { sessionId, newSession };
}

export default function Home() {
  const { sessionId, newSession } = useSessionId();
  const [lines, setLines] = useState<Line[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [usingOverrideKey, setUsingOverrideKey] = useState(false);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Track whether we're using the user's own key so the UI can show a
  // banner. Re-check when the drawer closes (save happens in there).
  useEffect(() => {
    const s = loadSettings();
    setUsingOverrideKey(
      !!s.groqApiKey && s.groqApiKey.trim().length > 0,
    );
  }, [settingsOpen]);

  const { isRecording, error: recError, start, stop } = useRecorder({
    sessionId: sessionId ?? "",
    onSegmentText: (seg) =>
      setLines((prev) => [...prev, { id: crypto.randomUUID(), ...seg }]),
  });

  const {
    suggestions,
    phase,
    isLoading: suggestionsLoading,
    error: suggestionsError,
    latencyMs: suggestionLatency,
    refresh: refreshSuggestions,
    hydrate: hydrateSuggestions,
    reset: resetSuggestions,
  } = useSuggestions({
    sessionId: sessionId ?? "",
    segmentCount: lines.length,
  });

  const {
    messages,
    isStreaming,
    error: chatError,
    send,
    stop: stopChat,
    clear: clearChat,
    hydrate: hydrateChat,
  } = useChat({
    sessionId: sessionId ?? "",
  });

  // Fetch server state when the sessionId changes. Restores transcript,
  // last suggestions batch, phase, and chat after a reload or New-session.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setHydrated(false);
    (async () => {
      try {
        const res = await fetch(
          `/api/session?sessionId=${encodeURIComponent(sessionId)}`,
        );
        const data = (await res.json()) as SessionStateResponse;
        if (cancelled) return;
        if (data.ok) {
          const s: SessionState = data.state;
          setLines(
            s.transcript.map((seg) => ({
              id: seg.id,
              text: seg.text,
              startedAt: seg.startedAt,
              endedAt: seg.endedAt,
            })),
          );
          hydrateSuggestions(
            s.latestSuggestions,
            s.phase,
            s.transcript.length,
          );
          hydrateChat(s.chat);
        }
      } catch {
        /* non-fatal — UI just starts empty */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, hydrateSuggestions, hydrateChat]);

  useEffect(() => {
    transcriptScrollRef.current?.scrollTo({
      top: transcriptScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [lines.length]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const handleSuggestionClick = (s: Suggestion) => {
    // Interruptible send — useChat aborts any in-flight stream first.
    void send({
      message: composeSeed(s),
      seededFrom: { suggestionId: s.id, title: s.title },
    });
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const msg = chatDraft.trim();
    if (!msg) return;
    setChatDraft("");
    void send({ message: msg });
  };

  const handleNewSession = async () => {
    if (!sessionId) return;
    const confirmed = window.confirm(
      "Start a new session? The current transcript, suggestions, and chat will be cleared on the server.",
    );
    if (!confirmed) return;
    // Best-effort server cleanup; ignore failures.
    try {
      await fetch(
        `/api/session?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
    } catch {
      /* ignore */
    }
    stop();
    setLines([]);
    resetSuggestions();
    // useChat's effect will clear messages on sessionId change.
    newSession();
  };

  const handleExport = (format: "json" | "md") => {
    if (!sessionId) return;
    const url = `/api/export?sessionId=${encodeURIComponent(sessionId)}&format=${format}`;
    window.open(url, "_blank");
  };

  return (
    <main className="h-screen w-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Meeting Copilot</h1>
          {usingOverrideKey && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300"
              title="Requests use the Groq key you saved in Settings"
            >
              BYOK
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">
            session: {sessionId ? sessionId.slice(0, 8) : "…"}
          </span>
          <button
            onClick={handleNewSession}
            disabled={!sessionId || !hydrated}
            className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            New
          </button>
          <div className="relative group">
            <button
              disabled={!sessionId}
              className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Export ▾
            </button>
            <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-zinc-900 border border-zinc-800 rounded-md shadow-lg z-10 min-w-[140px]">
              <button
                onClick={() => handleExport("json")}
                className="block w-full text-left text-xs px-3 py-2 hover:bg-zinc-800"
              >
                Export JSON
              </button>
              <button
                onClick={() => handleExport("md")}
                className="block w-full text-left text-xs px-3 py-2 hover:bg-zinc-800"
              >
                Export Markdown
              </button>
            </div>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            Settings
          </button>
          {isRecording ? (
            <button
              onClick={stop}
              className="ml-2 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-sm"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              disabled={!sessionId}
              className="ml-2 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-sm disabled:opacity-40"
            >
              Start
            </button>
          )}
        </div>
      </header>

      {recError && (
        <div className="px-6 py-2 bg-red-900/40 text-red-200 text-sm">
          {recError}
        </div>
      )}

      <div className="flex-1 grid grid-cols-[1fr_1fr_1fr] min-h-0">
        {/* Transcript */}
        <section className="border-r border-zinc-800 flex flex-col min-h-0">
          <h2 className="px-4 py-2 text-xs uppercase tracking-wider text-zinc-400 border-b border-zinc-800">
            Transcript
          </h2>
          <div
            ref={transcriptScrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-3"
          >
            {lines.length === 0 && (
              <p className="text-zinc-500 text-sm">
                {isRecording
                  ? "Listening… first segment appears in ~30s."
                  : "Click Start to begin."}
              </p>
            )}
            {lines.map((l) => (
              <div key={l.id} className="text-sm leading-relaxed">
                <span className="text-zinc-500 mr-2 font-mono text-xs">
                  [{formatClock(l.startedAt)}]
                </span>
                {l.text}
              </div>
            ))}
            {isRecording && lines.length > 0 && (
              <div className="text-zinc-500 text-xs italic">
                transcribing next segment…
              </div>
            )}
          </div>
        </section>

        {/* Suggestions */}
        <section className="border-r border-zinc-800 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
            <h2 className="text-xs uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              Suggestions
              {phase && (
                <span className="normal-case text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-700 text-zinc-300">
                  {PHASE_LABEL[phase]}
                </span>
              )}
              {suggestionLatency !== null && (
                <span className="ml-1 normal-case text-zinc-600 text-[10px]">
                  {suggestionLatency}ms
                </span>
              )}
            </h2>
            <button
              onClick={refreshSuggestions}
              disabled={suggestionsLoading || lines.length === 0}
              className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {suggestionsLoading ? "…" : "Refresh"}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {suggestionsError && (
              <p className="text-xs text-red-300">{suggestionsError}</p>
            )}
            {suggestions.length === 0 && !suggestionsLoading && (
              <p className="text-zinc-500 text-sm">
                {lines.length === 0
                  ? "Suggestions appear after the first transcript segment."
                  : "Generating…"}
              </p>
            )}
            {suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                s={s}
                onClick={() => handleSuggestionClick(s)}
              />
            ))}
            {suggestionsLoading && suggestions.length > 0 && (
              <p className="text-zinc-500 text-xs italic">regenerating…</p>
            )}
          </div>
        </section>

        {/* Chat */}
        <section className="flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
            <h2 className="text-xs uppercase tracking-wider text-zinc-400">
              Chat
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void clearChat()}
                disabled={messages.length === 0 || isStreaming}
                className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Clear
              </button>
              {isStreaming && (
                <button
                  onClick={stopChat}
                  className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
          <div
            ref={chatScrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-4"
          >
            {messages.length === 0 && (
              <p className="text-zinc-500 text-sm">
                Click a suggestion, or ask your own question below.
              </p>
            )}
            {chatError && <p className="text-xs text-red-300">{chatError}</p>}
            {messages.map((m) => (
              <div key={m.id} className="text-sm leading-relaxed">
                {m.seededFrom && m.role === "user" && (
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    from suggestion · {m.seededFrom.title}
                  </p>
                )}
                <p className="mb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
                  {m.role === "user" ? "You" : "Copilot"}
                </p>
                <div
                  className={`whitespace-pre-wrap ${
                    m.role === "user" ? "text-zinc-200" : "text-zinc-100"
                  }`}
                >
                  {m.content || (isStreaming ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
          <form
            onSubmit={handleSend}
            className="border-t border-zinc-800 p-3 flex gap-2"
          >
            <input
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              placeholder="Ask about the conversation…"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
              disabled={isStreaming}
            />
            <button
              type="submit"
              disabled={isStreaming || chatDraft.trim().length === 0}
              className="px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </form>
        </section>
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}
