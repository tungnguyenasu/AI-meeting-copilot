"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./types";
import { loadSettings, withOverrideHeaders } from "./clientSettings";

type SendArgs = {
  message: string;
  seededFrom?: { suggestionId: string; title: string } | null;
};

type UseChatArgs = {
  sessionId: string;
};

type UseChatReturn = {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  send: (args: SendArgs) => Promise<void>;
  stop: () => void;
  clear: () => Promise<void>;
  // Imperative seed used by the page's session-hydration effect.
  hydrate: (msgs: ChatMessage[]) => void;
};

function makeUserMsg(
  id: string,
  content: string,
  seededFrom: ChatMessage["seededFrom"] = null,
): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: Date.now(),
    seededFrom,
  };
}

function makeAssistantMsg(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
  };
}

export function useChat({ sessionId }: UseChatArgs): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track in-flight so a second send() can interrupt cleanly.
  const inFlightRef = useRef<Promise<void> | null>(null);

  // Wipe messages when the sessionId itself changes (New session).
  const lastSessionIdRef = useRef<string>(sessionId);
  useEffect(() => {
    if (lastSessionIdRef.current !== sessionId) {
      lastSessionIdRef.current = sessionId;
      setMessages([]);
      setError(null);
      abortRef.current?.abort();
    }
  }, [sessionId]);

  const hydrate = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
    setError(null);
  }, []);

  const runSend = useCallback(
    async ({ message, seededFrom }: SendArgs): Promise<void> => {
      const trimmed = message.trim();
      if (!trimmed) return;

      setError(null);

      const userMsgId = crypto.randomUUID();
      const asstMsgId = crypto.randomUUID();
      const userMsg = makeUserMsg(userMsgId, trimmed, seededFrom ?? null);
      const asstMsg = makeAssistantMsg(asstMsgId);
      setMessages((prev) => [...prev, userMsg, asstMsg]);

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);

      try {
        const settings = loadSettings();
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: withOverrideHeaders(
            { "content-type": "application/json" },
            settings,
          ),
          body: JSON.stringify({
            sessionId,
            message: trimmed,
            suggestionId: seededFrom?.suggestionId ?? null,
            userMessageId: userMsgId,
            assistantMessageId: asstMsgId,
            promptOverride: settings.prompts?.chat ?? null,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Chat failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!chunk) continue;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstMsgId ? { ...m, content: m.content + chunk } : m,
            ),
          );
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Chat request failed.";
        setError(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstMsgId ? { ...m, content: `_${msg}_` } : m,
          ),
        );
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [sessionId],
  );

  // Public send: if there's already a request in flight, interrupt it
  // (abort the stream, wait for it to wind down), then start the new
  // one. This makes clicking a second suggestion card feel responsive
  // instead of appearing broken.
  const send = useCallback(
    async (args: SendArgs): Promise<void> => {
      if (inFlightRef.current) {
        abortRef.current?.abort();
        try {
          await inFlightRef.current;
        } catch {
          /* swallow: we're replacing it */
        }
      }
      const p = runSend(args);
      inFlightRef.current = p;
      try {
        await p;
      } finally {
        if (inFlightRef.current === p) {
          inFlightRef.current = null;
        }
      }
    },
    [runSend],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await fetch(
        `/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
    } catch {
      /* non-fatal */
    }
    setMessages([]);
    setError(null);
  }, [sessionId]);

  return {
    messages,
    isStreaming,
    error,
    send,
    stop,
    clear,
    hydrate,
  };
}
