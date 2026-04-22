"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_SUGGESTION_SYSTEM_PROMPT,
} from "@/lib/prompts";
import {
  clearSettings,
  loadSettings,
  saveSettings,
} from "@/lib/clientSettings";
import type { ClientSettings } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
};

type DraftState = {
  groqApiKey: string;
  suggestionPrompt: string;
  chatPrompt: string;
};

function emptyDraft(): DraftState {
  return { groqApiKey: "", suggestionPrompt: "", chatPrompt: "" };
}

function draftFromSettings(s: ClientSettings): DraftState {
  return {
    groqApiKey: s.groqApiKey ?? "",
    suggestionPrompt: s.prompts?.suggestion ?? "",
    chatPrompt: s.prompts?.chat ?? "",
  };
}

export default function SettingsDrawer({ open, onClose }: Props) {
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-read from localStorage every time the drawer opens so we reflect
  // any out-of-band changes.
  useEffect(() => {
    if (open) {
      setDraft(draftFromSettings(loadSettings()));
      setSavedAt(null);
    }
  }, [open]);

  const handleSave = () => {
    const next: ClientSettings = {
      groqApiKey: draft.groqApiKey.trim() || undefined,
      prompts: {
        suggestion: draft.suggestionPrompt.trim() || undefined,
        chat: draft.chatPrompt.trim() || undefined,
      },
    };
    // If both prompts are empty, drop the prompts key so we don't send
    // an empty object each request.
    if (!next.prompts?.suggestion && !next.prompts?.chat) {
      delete next.prompts;
    }
    saveSettings(next);
    setSavedAt(Date.now());
  };

  const handleResetAll = () => {
    clearSettings();
    setDraft(emptyDraft());
    setSavedAt(Date.now());
  };

  const handleResetSuggestion = () => {
    setDraft((d) => ({ ...d, suggestionPrompt: DEFAULT_SUGGESTION_SYSTEM_PROMPT }));
  };

  const handleResetChat = () => {
    setDraft((d) => ({ ...d, chatPrompt: DEFAULT_CHAT_SYSTEM_PROMPT }));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close settings"
      />
      <aside className="w-full max-w-xl h-full bg-zinc-950 border-l border-zinc-800 flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1">
              Groq API key
            </h3>
            <p className="text-xs text-zinc-500 mb-2">
              Stored in your browser&apos;s localStorage only, sent per-request
              as <code className="text-zinc-300">x-groq-api-key</code>. Leave
              blank to use the server&apos;s default key.
            </p>
            <input
              type="password"
              autoComplete="off"
              value={draft.groqApiKey}
              onChange={(e) =>
                setDraft((d) => ({ ...d, groqApiKey: e.target.value }))
              }
              placeholder="gsk_..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-600"
            />
          </section>

          <section>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Suggestion system prompt
              </h3>
              <button
                onClick={handleResetSuggestion}
                className="text-[11px] text-zinc-400 hover:text-zinc-100"
              >
                Load default
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-2">
              Overrides the prompt used for the middle column. Leave blank to
              use the built-in default.
            </p>
            <textarea
              value={draft.suggestionPrompt}
              onChange={(e) =>
                setDraft((d) => ({ ...d, suggestionPrompt: e.target.value }))
              }
              rows={10}
              placeholder="(using default)"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:border-zinc-600"
            />
          </section>

          <section>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Chat system prompt
              </h3>
              <button
                onClick={handleResetChat}
                className="text-[11px] text-zinc-400 hover:text-zinc-100"
              >
                Load default
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-2">
              Overrides the prompt used for the right-column chat panel.
            </p>
            <textarea
              value={draft.chatPrompt}
              onChange={(e) =>
                setDraft((d) => ({ ...d, chatPrompt: e.target.value }))
              }
              rows={8}
              placeholder="(using default)"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:border-zinc-600"
            />
          </section>
        </div>

        <footer className="border-t border-zinc-800 px-5 py-3 flex items-center justify-between">
          <button
            onClick={handleResetAll}
            className="text-xs text-zinc-400 hover:text-red-300"
          >
            Clear all saved settings
          </button>
          <div className="flex items-center gap-3">
            {savedAt !== null && (
              <span className="text-[11px] text-emerald-400">saved</span>
            )}
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-sm"
            >
              Save
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
