/**
 * Edith Channel — MCP tool server.
 * Tools: reply, react (Telegram), add/list/remove scheduled tasks.
 * No polling — the edith.ts wrapper handles that.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const STATE_DIR = join(process.env.HOME ?? "~", ".edith");
const SCHEDULE_FILE = join(STATE_DIR, "schedule.json");
// Project root is one level up from channel/
const PROJECT_ROOT = join(import.meta.dir, "..");
const LOCATIONS_FILE = join(STATE_DIR, "locations.json");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");
const N8N_URL = process.env.N8N_URL ?? "http://localhost:5679";
const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
mkdirSync(STATE_DIR, { recursive: true });

function logEvent(type: string, data: Record<string, any> = {}): void {
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n", "utf-8");
  } catch {}
}

// --- Telegram helpers ---
async function tgCall(method: string, body?: Record<string, any>): Promise<any> {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4096) {
    chunks.push(text.slice(i, i + 4096));
  }
  for (const chunk of chunks) {
    await tgCall("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function sendPhoto(chatId: number, photoData: string, caption?: string): Promise<void> {
  // photoData should be base64 data URL like "data:image/png;base64,..."
  const base64Match = photoData.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!base64Match) {
    throw new Error("Invalid image data format");
  }

  const [, , base64Data] = base64Match;
  const imageBuffer = Buffer.from(base64Data, "base64");

  // Use FormData to send the image
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("photo", new Blob([imageBuffer]), "image.png");
  if (caption) {
    formData.append("caption", caption);
  }

  const res = await fetch(`${TG}/sendPhoto`, {
    method: "POST",
    body: formData,
  });

  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description}`);
}

// --- Schedule file helpers ---
interface ScheduleEntry {
  name: string;
  prompt: string;
  hour?: number;
  minute?: number;
  intervalMinutes?: number;
}

function loadSchedule(): ScheduleEntry[] {
  if (!existsSync(SCHEDULE_FILE)) return [];
  try { return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8")); } catch { return []; }
}

function saveSchedule(entries: ScheduleEntry[]): void {
  writeFileSync(SCHEDULE_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

// --- Location file helpers ---
interface LocationEntry {
  name: string;
  label: string;
  lat: number;
  lon: number;
  radiusMeters: number;
}

function loadLocations(): LocationEntry[] {
  if (!existsSync(LOCATIONS_FILE)) return [];
  try { return JSON.parse(readFileSync(LOCATIONS_FILE, "utf-8")).locations ?? []; } catch { return []; }
}

function saveLocations(locations: LocationEntry[]): void {
  writeFileSync(LOCATIONS_FILE, JSON.stringify({ locations }, null, 2), "utf-8");
}

// --- Reminder file helpers ---
interface Reminder {
  id: string;
  text: string;
  type: "location" | "time";
  location?: string;
  fireAt?: string;
  fired: boolean;
  created: string;
}

function loadReminders(): Reminder[] {
  if (!existsSync(REMINDERS_FILE)) return [];
  try { return JSON.parse(readFileSync(REMINDERS_FILE, "utf-8")); } catch { return []; }
}

function saveReminders(reminders: Reminder[]): void {
  writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8");
}

// --- MCP Server ---
const server = new Server(
  { name: "edith", version: "0.1.0" },
  {
    instructions: `You are Edith, a personal assistant. Messages arrive from Randy via Telegram.
Respond using the "send_message" tool with the chat_id from the message context. Be direct and concise.
You can manage scheduled tasks, reminders, and locations using the provided tools.`,
    capabilities: { tools: {} },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_message",
      description: "Send a message to Randy via Telegram. Can send a text reply, or react to a specific message with an emoji. To reply: provide text and chat_id. To react: provide emoji, message_id, and chat_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The message text to send (for replies)" },
          chat_id: { type: "number", description: "Telegram chat ID" },
          emoji: { type: "string", description: "Emoji to react with (for reactions, instead of text)" },
          message_id: { type: "number", description: "Message ID to react to (required with emoji)" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "send_image",
      description: "Send an image to Randy via Telegram. Use the base64 data URL from generate_image.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "number", description: "Telegram chat ID" },
          image_data: { type: "string", description: "Base64 data URL (data:image/png;base64,...)" },
          caption: { type: "string", description: "Optional caption for the image" },
        },
        required: ["chat_id", "image_data"],
      },
    },
    {
      name: "list_scheduled_tasks",
      description: "List all scheduled tasks that edith.ts runs on a timer",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "add_scheduled_task",
      description: "Add a new scheduled task. Specify either hour+minute for daily tasks, or intervalMinutes for recurring tasks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Unique task name (e.g. 'morning-brief', 'check-stocks')" },
          prompt: { type: "string", description: "The prompt or skill to run (e.g. '/morning-brief' or 'Check AAPL stock price and report')" },
          hour: { type: "number", description: "Hour to run (0-23). Use with minute for daily tasks." },
          minute: { type: "number", description: "Minute to run (0-59). Use with hour for daily tasks." },
          intervalMinutes: { type: "number", description: "Run every N minutes (e.g. 5). Use instead of hour/minute for recurring tasks." },
        },
        required: ["name", "prompt"],
      },
    },
    {
      name: "remove_scheduled_task",
      description: "Remove a scheduled task by name",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Name of the task to remove" },
        },
        required: ["name"],
      },
    },
    {
      name: "save_location",
      description: "Save a named location for geofencing and location-based reminders",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Unique location key (e.g. 'home', 'office', 'gym')" },
          label: { type: "string", description: "Human-readable label (e.g. 'Home', 'Downtown Office')" },
          lat: { type: "number", description: "Latitude" },
          lon: { type: "number", description: "Longitude" },
          radiusMeters: { type: "number", description: "Geofence radius in meters (default: 200)" },
        },
        required: ["name", "label", "lat", "lon"],
      },
    },
    {
      name: "list_locations",
      description: "List all saved locations",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "save_reminder",
      description: "Create a reminder. Use type 'time' with fireAt for time-based, or type 'location' with a location name for location-based.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Reminder text" },
          type: { type: "string", description: "'time' or 'location'" },
          fireAt: { type: "string", description: "ISO timestamp for time-based reminders (e.g. '2026-03-24T15:00:00-04:00')" },
          location: { type: "string", description: "Location name from locations.json for location-based reminders" },
        },
        required: ["text", "type"],
      },
    },
    {
      name: "list_reminders",
      description: "List all reminders (both fired and unfired)",
      inputSchema: {
        type: "object" as const,
        properties: {
          showFired: { type: "boolean", description: "Include already-fired reminders (default: false)" },
        },
      },
    },
    {
      name: "mark_reminder_fired",
      description: "Mark one or more reminders as fired after delivering them to Randy",
      inputSchema: {
        type: "object" as const,
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of reminder IDs to mark as fired",
          },
        },
        required: ["ids"],
      },
    },
    {
      name: "get_calendar",
      description: "Get upcoming calendar events from Google Calendar. Returns events for the next N hours.",
      inputSchema: {
        type: "object" as const,
        properties: {
          hoursAhead: { type: "number", description: "Hours ahead to look (default: 4, max: 24)" },
          includeAllDay: { type: "boolean", description: "Include all-day events (default: false)" },
        },
      },
    },
    {
      name: "get_emails",
      description: "Get recent emails from Gmail. Returns unread/important emails from the last N hours.",
      inputSchema: {
        type: "object" as const,
        properties: {
          hoursBack: { type: "number", description: "Hours back to search (default: 4, max: 48)" },
          unreadOnly: { type: "boolean", description: "Only return unread emails (default: true)" },
          maxResults: { type: "number", description: "Max emails to return (default: 10, max: 20)" },
        },
      },
    },
    {
      name: "generate_image",
      description: "Generate an image using Google's Imagen AI via Randy's Google AI subscription. Returns a URL to the generated image that can be sent via Telegram.",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: { type: "string", description: "Text description of the image to generate" },
          numberOfImages: { type: "number", description: "Number of images to generate (default: 1, max: 4)" },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // --- Telegram ---
  if (name === "send_message") {
    const chatId = args?.chat_id as number;
    if (!chatId) {
      return { content: [{ type: "text", text: "Missing chat_id" }] };
    }

    // Reaction mode
    if (args?.emoji) {
      const messageId = args?.message_id as number;
      if (!messageId) {
        return { content: [{ type: "text", text: "Reactions require message_id" }] };
      }
      try {
        await tgCall("setMessageReaction", {
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji: args.emoji as string }],
        });
      } catch {}
      return { content: [{ type: "text", text: "Reacted" }] };
    }

    // Text reply mode
    const text = args?.text as string;
    if (!text) {
      return { content: [{ type: "text", text: "Missing text or emoji" }] };
    }
    await sendMessage(chatId, `🤖 *EDITH*\n\n${text}`);
    logEvent("message_sent", { chatId, text: text.slice(0, 200) });
    return { content: [{ type: "text", text: "Sent" }] };
  }

  if (name === "send_image") {
    const chatId = args?.chat_id as number;
    const imageData = args?.image_data as string;
    if (!chatId || !imageData) {
      return { content: [{ type: "text", text: "Missing chat_id or image_data" }] };
    }

    const caption = args?.caption as string | undefined;
    try {
      await sendPhoto(chatId, imageData, caption);
      logEvent("image_sent", { chatId, caption: caption?.slice(0, 100) });
      return { content: [{ type: "text", text: "Image sent" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to send image: ${err instanceof Error ? err.message : err}` }] };
    }
  }

  // --- Schedule tools ---
  if (name === "list_scheduled_tasks") {
    const tasks = loadSchedule();
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: "No scheduled tasks." }] };
    }
    const lines = tasks.map((t) => {
      if (t.intervalMinutes) {
        return `- ${t.name}: every ${t.intervalMinutes}min → ${t.prompt}`;
      }
      const h = String(t.hour ?? 0).padStart(2, "0");
      const m = String(t.minute ?? 0).padStart(2, "0");
      return `- ${t.name}: daily at ${h}:${m} → ${t.prompt}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "add_scheduled_task") {
    const taskName = args?.name as string;
    const prompt = args?.prompt as string;
    if (!taskName || !prompt) {
      return { content: [{ type: "text", text: "Missing name or prompt" }] };
    }

    const tasks = loadSchedule();
    const existing = tasks.findIndex((t) => t.name === taskName);
    const entry: ScheduleEntry = { name: taskName, prompt };

    if (args?.intervalMinutes != null) {
      const interval = Number(args.intervalMinutes);
      if (isNaN(interval) || interval < 1 || interval > 1440) {
        return { content: [{ type: "text", text: "intervalMinutes must be between 1 and 1440" }] };
      }
      entry.intervalMinutes = interval;
    } else {
      const hour = Number(args?.hour ?? 9);
      const minute = Number(args?.minute ?? 0);
      if (isNaN(hour) || hour < 0 || hour > 23) {
        return { content: [{ type: "text", text: "hour must be between 0 and 23" }] };
      }
      if (isNaN(minute) || minute < 0 || minute > 59) {
        return { content: [{ type: "text", text: "minute must be between 0 and 59" }] };
      }
      entry.hour = hour;
      entry.minute = minute;
    }

    if (existing >= 0) {
      tasks[existing] = entry;
    } else {
      tasks.push(entry);
    }

    saveSchedule(tasks);
    return { content: [{ type: "text", text: `Scheduled: ${taskName}` }] };
  }

  if (name === "remove_scheduled_task") {
    const taskName = args?.name as string;
    if (!taskName) {
      return { content: [{ type: "text", text: "Missing name" }] };
    }

    const tasks = loadSchedule();
    const filtered = tasks.filter((t) => t.name !== taskName);
    if (filtered.length === tasks.length) {
      return { content: [{ type: "text", text: `Task not found: ${taskName}` }] };
    }

    saveSchedule(filtered);
    return { content: [{ type: "text", text: `Removed: ${taskName}` }] };
  }

  // --- Location tools ---
  if (name === "save_location") {
    const locName = args?.name as string;
    const label = args?.label as string;
    const lat = args?.lat as number;
    const lon = args?.lon as number;
    const radiusMeters = Math.max(50, Math.min(50000, Number(args?.radiusMeters ?? 200)));
    if (!locName || !label || lat == null || lon == null) {
      return { content: [{ type: "text", text: "Missing required fields" }] };
    }
    if (typeof lat !== "number" || lat < -90 || lat > 90 || typeof lon !== "number" || lon < -180 || lon > 180) {
      return { content: [{ type: "text", text: "Invalid coordinates. lat: -90 to 90, lon: -180 to 180" }] };
    }

    const locations = loadLocations();
    const existing = locations.findIndex((l) => l.name === locName);
    const entry: LocationEntry = { name: locName, label, lat, lon, radiusMeters };

    if (existing >= 0) {
      locations[existing] = entry;
    } else {
      locations.push(entry);
    }

    saveLocations(locations);
    return { content: [{ type: "text", text: `Saved location: ${label} (${locName})` }] };
  }

  if (name === "list_locations") {
    const locations = loadLocations();
    if (locations.length === 0) {
      return { content: [{ type: "text", text: "No saved locations." }] };
    }
    const lines = locations.map((l) =>
      `- ${l.name}: ${l.label} (${l.lat}, ${l.lon}) r=${l.radiusMeters}m`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // --- Reminder tools ---
  if (name === "save_reminder") {
    const text = args?.text as string;
    const type = args?.type as "time" | "location";
    if (!text || !type) {
      return { content: [{ type: "text", text: "Missing text or type" }] };
    }

    const reminder: Reminder = {
      id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      type,
      fired: false,
      created: new Date().toISOString(),
    };

    if (type === "time") {
      const fireAt = args?.fireAt as string;
      if (!fireAt) {
        return { content: [{ type: "text", text: "Time-based reminders require fireAt" }] };
      }
      reminder.fireAt = fireAt;
    } else if (type === "location") {
      const location = args?.location as string;
      if (!location) {
        return { content: [{ type: "text", text: "Location-based reminders require location name" }] };
      }
      reminder.location = location;
    }

    const reminders = loadReminders();
    reminders.push(reminder);
    saveReminders(reminders);
    return { content: [{ type: "text", text: `Reminder saved: ${reminder.id}` }] };
  }

  if (name === "list_reminders") {
    const showFired = (args?.showFired as boolean) ?? false;
    const reminders = loadReminders();
    const filtered = showFired ? reminders : reminders.filter((r) => !r.fired);

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: "No active reminders." }] };
    }

    const lines = filtered.map((r) => {
      const status = r.fired ? "✓" : "○";
      if (r.type === "time") {
        return `${status} [${r.id}] ${r.text} — fires at ${r.fireAt}`;
      }
      return `${status} [${r.id}] ${r.text} — at ${r.location}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // --- Google tools (via n8n) ---
  if (name === "get_calendar") {
    try {
      const res = await fetch(`${N8N_URL}/webhook/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hoursAhead: (args?.hoursAhead as number) ?? 4,
          includeAllDay: (args?.includeAllDay as boolean) ?? false,
        }),
      });
      const body = await res.text();
      // n8n returns 500 with "No item to return" when calendar is empty
      if (!res.ok) {
        if (body.includes("No item to return")) {
          return { content: [{ type: "text", text: JSON.stringify({ events: [], message: "No upcoming events" }, null, 2) }] };
        }
        return { content: [{ type: "text", text: `Calendar error (${res.status}): ${body}. Check n8n at ${N8N_URL} — Google credentials may need reauthorization.` }] };
      }
      try {
        const data = JSON.parse(body);
        // Filter events by hoursAhead (n8n returns 24h, we narrow it down)
        const hoursAhead = (args?.hoursAhead as number) ?? 4;
        const cutoff = new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
        const includeAllDay = (args?.includeAllDay as boolean) ?? false;
        if (data.events) {
          data.events = data.events.filter((e: any) => {
            if (!includeAllDay && !e.start?.includes("T")) return false; // skip all-day
            return !e.start || e.start <= cutoff;
          });
          data.count = data.events.length;
        }
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: body }] };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Calendar unreachable: ${err instanceof Error ? err.message : err}. Is n8n running at ${N8N_URL}?` }] };
    }
  }

  if (name === "get_emails") {
    try {
      const res = await fetch(`${N8N_URL}/webhook/gmail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hoursBack: (args?.hoursBack as number) ?? 4,
          unreadOnly: (args?.unreadOnly as boolean) ?? true,
          maxResults: (args?.maxResults as number) ?? 10,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { content: [{ type: "text", text: `Gmail error (${res.status}): ${body}. Check n8n at ${N8N_URL} — Google credentials may need reauthorization.` }] };
      }
      const data = await res.json();
      // Filter emails by maxResults (n8n returns all, we limit)
      const maxResults = (args?.maxResults as number) ?? 10;
      if (data.emails && data.emails.length > maxResults) {
        data.emails = data.emails.slice(0, maxResults);
        data.count = data.emails.length;
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Gmail unreachable: ${err instanceof Error ? err.message : err}. Is n8n running at ${N8N_URL}?` }] };
    }
  }

  if (name === "mark_reminder_fired") {
    const ids = args?.ids as string[];
    if (!ids || ids.length === 0) {
      return { content: [{ type: "text", text: "Missing ids" }] };
    }

    const reminders = loadReminders();
    let count = 0;
    for (const r of reminders) {
      if (ids.includes(r.id) && !r.fired) {
        r.fired = true;
        count++;
      }
    }
    saveReminders(reminders);
    return { content: [{ type: "text", text: `Marked ${count} reminder(s) as fired` }] };
  }

  // --- Google Image Generation ---
  if (name === "generate_image") {
    if (!GOOGLE_API_KEY) {
      return { content: [{ type: "text", text: "GOOGLE_GENERATIVE_AI_API_KEY not set in .env" }] };
    }

    const prompt = args?.prompt as string;
    if (!prompt) {
      return { content: [{ type: "text", text: "Missing prompt" }] };
    }

    const numberOfImages = (args?.numberOfImages as number) ?? 1;

    try {
      const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

      const result = await model.generateContent({
        contents: [{
          role: "user",
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseModalities: ["image"],
        }
      });

      const response = result.response;
      const imageUrls: string[] = [];

      // Extract base64 image data from response
      for (const candidate of response.candidates || []) {
        for (const part of candidate.content.parts) {
          if (part.inlineData?.data) {
            // Return base64 data that can be sent via Telegram
            imageUrls.push(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`);
          }
        }
      }

      if (imageUrls.length === 0) {
        return { content: [{ type: "text", text: "No images generated. Check the prompt or API quota." }] };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            count: imageUrls.length,
            images: imageUrls,
            prompt: prompt
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Image generation failed: ${err instanceof Error ? err.message : err}`
        }]
      };
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
