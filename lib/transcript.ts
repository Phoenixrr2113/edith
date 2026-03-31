/**
 * Transcript logging — saves every session's message stream to JSONL.
 * Useful for debugging and self-improvement.
 */
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./config";

const TRANSCRIPTS_DIR = join(STATE_DIR, "transcripts");

// Ensure transcripts directory exists
if (!existsSync(TRANSCRIPTS_DIR)) {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

/**
 * Start a new transcript file.
 */
export function startTranscript(wakeId: string): void {
  const path = join(TRANSCRIPTS_DIR, `${wakeId}.jsonl`);
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), type: "session_start", wakeId }) + "\n", "utf-8");
  } catch {}
}

type ContentBlock = { type: string; name?: string; input?: unknown; text?: string };
type SDKMessageLike = { type?: string; message?: { content?: ContentBlock[] | string }; subtype?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; duration_ms?: number; result?: string; session_id?: string };

/**
 * Append a message to the transcript.
 */
export function appendTranscript(wakeId: string, message: SDKMessageLike): void {
  const path = join(TRANSCRIPTS_DIR, `${wakeId}.jsonl`);
  try {
    // Only log meaningful message types, skip streaming events to keep size reasonable
    const type = message?.type;
    if (type === "stream_event") return;

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      type,
    };

    if (type === "assistant") {
      // Log tool calls and text blocks, but truncate content
      const content = message.message?.content;
      if (Array.isArray(content)) {
        entry.blocks = content.map((block) => {
          if (block.type === "tool_use") {
            return { type: "tool_use", name: block.name, input_preview: (JSON.stringify(block.input) ?? "").slice(0, 200) };
          }
          if (block.type === "text") {
            return { type: "text", text: block.text?.slice(0, 300) };
          }
          return { type: block.type };
        });
      }
    } else if (type === "result") {
      entry.subtype = message.subtype;
      entry.is_error = message.is_error;
      entry.num_turns = message.num_turns;
      entry.total_cost_usd = message.total_cost_usd;
      entry.duration_ms = message.duration_ms;
      if (message.result) entry.result_preview = (typeof message.result === "string" ? message.result : JSON.stringify(message.result)).slice(0, 300);
    } else if (type === "user") {
      const rawContent = message.message?.content;
      const content = typeof rawContent === "string"
        ? rawContent.slice(0, 300)
        : JSON.stringify(rawContent).slice(0, 300);
      entry.content_preview = content;
    }

    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}
