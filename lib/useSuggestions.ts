"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Phase, Suggestion, SuggestionsResponse } from "./types";
import { loadSettings, withOverrideHeaders } from "./clientSettings";

type UseSuggestionsArgs = {
  sessionId: string;
  // Number of transcript segments the client has seen so far. The hook
  // re-fetches whenever this number increases.
  segmentCount: number;
};

type UseSuggestionsReturn = {
  suggestions: Suggestion[];
  phase: Phase | null;
  isLoading: boolean;
  error: string | null;
  latencyMs: number | null;
  refresh: () => void;
  reset: () => void;
  // Imperative setter used by the page after session hydration resolves.
  hydrate: (
    suggestions: Suggestion[],
    phase: Phase | null,
    segmentCountMarker?: number,
  ) => void;
};

export function useSuggestions({
  sessionId,
  segmentCount,
}: UseSuggestionsArgs): UseSuggestionsReturn {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // We dedupe in-flight calls with a ref (not state) so spam-clicking
  // Refresh and overlapping auto-triggers collapse to a single request.
  const inFlightRef = useRef(false);
  // Track the last segmentCount we fetched for so we don't re-run with
  // the same value (e.g. after a re-render that didn't add a new segment).
  const lastFetchedCountRef = useRef<number>(-1);

  const fetchOnce = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const settings = loadSettings();
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: withOverrideHeaders(
          { "content-type": "application/json" },
          settings,
        ),
        body: JSON.stringify({
          sessionId,
          promptOverride: settings.prompts?.suggestion ?? null,
        }),
      });
      const data: SuggestionsResponse = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      if (data.suggestions.length > 0) {
        setSuggestions(data.suggestions);
        setLatencyMs(data.latencyMs);
      }
      // Phase updates whether or not suggestions changed so the badge
      // can shift on smalltalk moments where we intentionally returned 0.
      setPhase(data.phase);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suggestion fetch failed.");
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
    }
  }, [sessionId]);

  // Auto-trigger: every time segmentCount advances (and is >= 1) refetch.
  useEffect(() => {
    if (segmentCount <= 0) return;
    if (segmentCount === lastFetchedCountRef.current) return;
    lastFetchedCountRef.current = segmentCount;
    void fetchOnce();
  }, [segmentCount, fetchOnce]);

  const refresh = useCallback(() => {
    // Manual refresh ignores the dedup-on-count guard.
    void fetchOnce();
  }, [fetchOnce]);

  // Used by "New session" to wipe local state and let the next segment
  // trigger a fresh fetch.
  const reset = useCallback(() => {
    setSuggestions([]);
    setPhase(null);
    setLatencyMs(null);
    setError(null);
    lastFetchedCountRef.current = -1;
  }, []);

  // Imperative seed from the page's session-hydration effect. Also
  // advances the fetched-count marker so the first auto-fetch doesn't
  // duplicate what we just restored.
  const hydrate = useCallback(
    (
      nextSuggestions: Suggestion[],
      nextPhase: Phase | null,
      segmentCountMarker?: number,
    ) => {
      setSuggestions(nextSuggestions);
      setPhase(nextPhase);
      setLatencyMs(null);
      setError(null);
      // When hydration gives us suggestions, suppress the next auto-fetch
      // triggered by the transcript jumping from 0 → N. Caller supplies
      // the count that corresponds to the hydrated state; a later
      // segment will advance past this marker and trigger a real refresh.
      if (
        nextSuggestions.length > 0 &&
        typeof segmentCountMarker === "number"
      ) {
        lastFetchedCountRef.current = segmentCountMarker;
      }
    },
    [],
  );

  // Wipe local state when the sessionId itself changes (New session).
  const lastSessionIdRef = useRef<string>(sessionId);
  useEffect(() => {
    if (lastSessionIdRef.current !== sessionId) {
      lastSessionIdRef.current = sessionId;
      setSuggestions([]);
      setPhase(null);
      setLatencyMs(null);
      setError(null);
      lastFetchedCountRef.current = -1;
    }
  }, [sessionId]);

  return {
    suggestions,
    phase,
    isLoading,
    error,
    latencyMs,
    refresh,
    reset,
    hydrate,
  };
}
