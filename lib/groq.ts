import Groq from "groq-sdk";

// Lazy singleton for the server's default key. We don't want to crash
// module import if GROQ_API_KEY is missing during build — only when a
// request actually needs the client.
let defaultClient: Groq | null = null;

// Returns a Groq client. When an override key is provided (from the
// x-groq-api-key header, set by the Settings drawer), builds a fresh
// non-cached client so users can BYOK without polluting the server default.
export function getGroq(overrideKey?: string | null): Groq {
  if (overrideKey && overrideKey.trim().length > 0) {
    return new Groq({ apiKey: overrideKey.trim() });
  }

  if (defaultClient) return defaultClient;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local (see .env.local.example), or provide a key in Settings.",
    );
  }

  defaultClient = new Groq({ apiKey });
  return defaultClient;
}

// Helper used by routes: pull the override key off the incoming headers.
// Headers values are always strings (or null) per the Fetch API.
export function readGroqKeyFromHeaders(headers: Headers): string | null {
  const v = headers.get("x-groq-api-key");
  return v && v.trim().length > 0 ? v.trim() : null;
}

export const WHISPER_MODEL = "whisper-large-v3-turbo";

// Map Groq SDK / network errors into a user-friendly message + HTTP
// status so the UI can show something actionable ("your key was
// rejected") instead of a raw stack trace leak. groq-sdk throws
// APIError-shaped objects with a `status` number — we also handle the
// generic network-failure and aborted-request cases.
type GroqErrorShape = {
  status: number;
  message: string;
  userMessage: string;
};

function pickStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

export function toFriendlyGroqError(err: unknown): GroqErrorShape {
  const status = pickStatus(err);
  const rawMessage = err instanceof Error ? err.message : String(err);

  if (status === 401 || /invalid api key|unauthorized/i.test(rawMessage)) {
    return {
      status: 401,
      message: rawMessage,
      userMessage:
        "Groq API key was rejected. Check the key in Settings (or the server's GROQ_API_KEY).",
    };
  }
  if (status === 429 || /rate[_\s-]?limit/i.test(rawMessage)) {
    return {
      status: 429,
      message: rawMessage,
      userMessage:
        "Rate-limited by Groq — try again in a few seconds.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      status,
      message: rawMessage,
      userMessage: "Groq is having trouble. Try again in a moment.",
    };
  }
  return {
    status: status ?? 500,
    message: rawMessage,
    userMessage: rawMessage || "Unknown error.",
  };
}
