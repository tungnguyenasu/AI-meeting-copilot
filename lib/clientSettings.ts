"use client";

import type { ClientSettings } from "./types";

// LocalStorage-backed client settings: BYOK Groq key + per-prompt overrides.
// We keep this tiny on purpose — one key, one JSON blob, no framework.

const STORAGE_KEY = "copilot:settings/v1";

export function loadSettings(): ClientSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as ClientSettings;
  } catch {
    return {};
  }
}

export function saveSettings(next: ClientSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private-mode errors: non-fatal, just drop the save.
  }
}

export function clearSettings(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- Request header/body helpers ----------

// Attach the override key (if any) to a plain headers object. Used by
// useSuggestions, useChat, useRecorder, and the one-shot /api/session
// and /api/export GETs.
export function withOverrideHeaders(
  base: Record<string, string> = {},
  settings: ClientSettings = loadSettings(),
): Record<string, string> {
  if (settings.groqApiKey && settings.groqApiKey.trim().length > 0) {
    return { ...base, "x-groq-api-key": settings.groqApiKey.trim() };
  }
  return base;
}
