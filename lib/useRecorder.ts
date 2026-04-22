"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SegmentPayload, TranscribeResponse } from "./types";
import { loadSettings, withOverrideHeaders } from "./clientSettings";

// 30s per chunk. Each blob is a self-contained WebM file Whisper can decode
// end-to-end. Trade-off: ~50ms seam between clips where mic is stopped/started.
// Day 4 fix: MediaRecorder.requestData() + header-patching, or WebSocket stream.
const SEGMENT_MS = 30_000;

type UseRecorderArgs = {
  sessionId: string;
  onSegmentText: (seg: SegmentPayload) => void;
  segmentMs?: number;
};

type UseRecorderReturn = {
  isRecording: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  // Chromium/Edge: opus-in-webm works perfectly with Whisper.
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const mt of candidates) {
    if (MediaRecorder.isTypeSupported(mt)) return mt;
  }
  return undefined;
}

export function useRecorder({
  sessionId,
  onSegmentText,
  segmentMs = SEGMENT_MS,
}: UseRecorderArgs): UseRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs — these must NOT trigger re-renders and must survive across
  // start/stop cycles.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string | undefined>(undefined);
  const sessionStartRef = useRef<number>(0);
  const segmentStartRef = useRef<number>(0);
  const rotateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True only while the user-facing loop should keep running. When `stop()`
  // is called we flip this to false so the final `onstop` handler doesn't
  // kick off another segment.
  const runningRef = useRef<boolean>(false);
  // Callback ref so we don't re-subscribe when the parent passes a fresh fn.
  const onSegmentTextRef = useRef(onSegmentText);
  useEffect(() => {
    onSegmentTextRef.current = onSegmentText;
  }, [onSegmentText]);

  const uploadSegment = useCallback(
    async (blob: Blob, startedAt: number, endedAt: number) => {
      // Tiny guard mirrors the server — saves a network round-trip.
      if (blob.size < 2000) return;

      const form = new FormData();
      const ext = (mimeRef.current ?? "").includes("mp4") ? "mp4" : "webm";
      form.append("audio", new File([blob], `chunk-${startedAt}.${ext}`, { type: blob.type }));
      form.append("sessionId", sessionId);
      form.append("startedAt", String(startedAt));
      form.append("endedAt", String(endedAt));

      try {
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: withOverrideHeaders({}, loadSettings()),
          body: form,
        });
        const data: TranscribeResponse = await res.json();
        if (!data.ok) {
          setError(data.error);
          return;
        }
        if (data.segment) {
          // Clear any stale error from a prior failed upload (e.g. the
          // first chunk that raced the dev server picking up .env.local).
          setError(null);
          onSegmentTextRef.current(data.segment);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed.";
        setError(msg);
      }
    },
    [sessionId],
  );

  // Starts a single MediaRecorder pass. When it stops, we drain chunks,
  // upload, and (if still running) kick off the next pass.
  const startOneSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    chunksRef.current = [];
    const rec = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    recorderRef.current = rec;
    segmentStartRef.current = Date.now();

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    rec.onstop = () => {
      const startedAt = segmentStartRef.current - sessionStartRef.current;
      const endedAt = Date.now() - sessionStartRef.current;
      const blob = new Blob(chunksRef.current, { type: mimeRef.current ?? "audio/webm" });
      chunksRef.current = [];

      // Fire-and-forget upload; next segment starts immediately to minimize seam.
      void uploadSegment(blob, startedAt, endedAt);

      if (runningRef.current) {
        startOneSegment();
      }
    };

    rec.onerror = (e) => {
      const msg =
        (e as unknown as { error?: { message?: string } }).error?.message ??
        "MediaRecorder error.";
      setError(msg);
    };

    rec.start();

    // Schedule the rotate. We call stop() after SEGMENT_MS; the onstop
    // handler above will push the blob and start the next segment.
    rotateTimerRef.current = setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, segmentMs);
  }, [segmentMs, uploadSegment]);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    setError(null);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support microphone capture.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;
      mimeRef.current = pickMimeType();
      if (!mimeRef.current) {
        setError("No supported audio MIME type found (try Chrome or Edge).");
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }
      sessionStartRef.current = Date.now();
      runningRef.current = true;
      setIsRecording(true);
      startOneSegment();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not access microphone.";
      setError(msg);
      runningRef.current = false;
      setIsRecording(false);
    }
  }, [startOneSegment]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setIsRecording(false);

    if (rotateTimerRef.current) {
      clearTimeout(rotateTimerRef.current);
      rotateTimerRef.current = null;
    }

    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      // onstop handler will upload whatever partial chunk we have AND will
      // not start another segment because runningRef is now false.
      rec.stop();
    }
    recorderRef.current = null;

    // Release the mic so the OS indicator goes away.
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
  }, []);

  // Safety net: if the component unmounts mid-recording, release the mic.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
      const stream = streamRef.current;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { isRecording, error, start, stop };
}
