import { NextRequest, NextResponse } from "next/server";
import { transcriptStore } from "@/lib/transcriptStore";
import { suggestionStore } from "@/lib/suggestionStore";
import { summaryStore } from "@/lib/summaryStore";
import { chatStore } from "@/lib/chatStore";
import type {
  ChatMessage,
  ExportFormat,
  Phase,
  RunningSummary,
  Suggestion,
  TranscriptSegment,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const r = (s % 60).toString().padStart(2, "0");
  return `${m}:${r}`;
}

function renderMarkdown(args: {
  sessionId: string;
  transcript: TranscriptSegment[];
  suggestions: Suggestion[];
  phase: Phase | null;
  summary: RunningSummary | null;
  chat: ChatMessage[];
}): string {
  const { sessionId, transcript, suggestions, phase, summary, chat } = args;
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`# Meeting Copilot Export`);
  lines.push("");
  lines.push(`- Session: \`${sessionId}\``);
  lines.push(`- Exported at: ${now}`);
  if (phase) lines.push(`- Last detected phase: **${phase}**`);
  lines.push("");

  if (summary?.summary) {
    lines.push(`## Rolling summary`);
    lines.push("");
    lines.push(summary.summary);
    lines.push("");
  }

  lines.push(`## Transcript`);
  lines.push("");
  if (transcript.length === 0) {
    lines.push("_(empty)_");
  } else {
    for (const seg of transcript) {
      lines.push(`- \`[${formatClock(seg.startedAt)}]\` ${seg.text}`);
    }
  }
  lines.push("");

  lines.push(`## Latest suggestions shown`);
  lines.push("");
  if (suggestions.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const s of suggestions) {
      lines.push(`### [${s.type.toUpperCase()}] ${s.title}`);
      lines.push("");
      lines.push(s.preview);
      lines.push("");
      lines.push(`> anchor: "${s.anchorQuote}"`);
      lines.push("");
    }
  }

  lines.push(`## Chat`);
  lines.push("");
  if (chat.length === 0) {
    lines.push("_(no chat yet)_");
  } else {
    for (const m of chat) {
      const who = m.role === "user" ? "**You**" : "**Copilot**";
      const seed = m.seededFrom
        ? ` _(from suggestion: ${m.seededFrom.title})_`
        : "";
      lines.push(`${who}${seed}:`);
      lines.push("");
      lines.push(m.content);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  const format = (req.nextUrl.searchParams.get("format") ?? "json") as ExportFormat;

  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Missing 'sessionId'." },
      { status: 400 },
    );
  }
  if (format !== "json" && format !== "md") {
    return NextResponse.json(
      { ok: false, error: "Invalid 'format' (must be 'json' or 'md')." },
      { status: 400 },
    );
  }

  const [transcript, suggestions, phase, summary, chat] = await Promise.all([
    transcriptStore.get(sessionId),
    suggestionStore.getLatest(sessionId),
    suggestionStore.getLastPhase(sessionId),
    summaryStore.get(sessionId),
    chatStore.get(sessionId),
  ]);

  const short = sessionId.slice(0, 8);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  if (format === "md") {
    const md = renderMarkdown({
      sessionId,
      transcript,
      suggestions,
      phase,
      summary,
      chat,
    });
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="copilot-${short}-${ts}.md"`,
        "cache-control": "no-store",
      },
    });
  }

  const payload = {
    sessionId,
    exportedAt: new Date().toISOString(),
    phase,
    summary,
    transcript,
    latestSuggestions: suggestions,
    chat,
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="copilot-${short}-${ts}.json"`,
      "cache-control": "no-store",
    },
  });
}
