/**
 * Edith MCP tool server.
 * Slim entrypoint — tool logic lives in mcp/tools/*.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GROQ_API_KEY } from "../lib/config";

import { registerMessagingTools } from "./tools/messaging";
import { registerScheduleTools } from "./tools/schedule";
import { registerLocationTools } from "./tools/location";
import { registerEmailTools } from "./tools/email";
import { registerCalendarTools } from "./tools/calendar";
import { registerDocsTools } from "./tools/docs";
import { registerProactiveTools } from "./tools/proactive";
import { registerActivityTools } from "./tools/activity";

// --- MCP Server ---
const server = new McpServer(
  { name: "edith", version: "0.1.0" },
  {
    instructions: `You are Edith, a personal assistant. Messages arrive from Randy via Telegram.
Respond using the "send_message" tool with the chat_id from the message context. Be direct and concise.
You can manage scheduled tasks, reminders, locations, emails, and calendar using the provided tools.`,
  }
);

// Register all tool domains
registerMessagingTools(server);
registerScheduleTools(server);
registerLocationTools(server);
registerEmailTools(server);
registerCalendarTools(server);
registerDocsTools(server);
registerProactiveTools(server);
registerActivityTools(server);

// ============================================================
// Transcribe — Groq Whisper (exported for use by other modules)
// ============================================================

async function transcribeAudio(audioUrl: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GROQ_API_KEY) return { ok: false, error: "GROQ_API_KEY not set" };
  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) return { ok: false, error: `Failed to fetch audio: ${audioRes.status}` };
    const blob = await audioRes.blob();
    const form = new FormData();
    form.append("file", blob, "audio.ogg");
    form.append("model", "whisper-large-v3");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    const data = (await res.json()) as any;
    return res.ok ? { ok: true, text: data.text } : { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export { transcribeAudio };

// ============================================================
// Start
// ============================================================
const transport = new StdioServerTransport();
await server.connect(transport);
