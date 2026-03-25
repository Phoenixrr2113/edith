/**
 * Edith MCP tool server.
 * Tools: send_message, send_image, schedule, locations, reminders, calendar, email, image gen.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { sendMessage, sendPhoto, tgCall } from "../lib/telegram";
import { STATE_DIR, CHAT_ID, logEvent } from "../lib/state";
import type { ScheduleEntry, LocationEntry, Reminder } from "./types";

// --- Config ---
const SCHEDULE_FILE = join(STATE_DIR, "schedule.json");
const LOCATIONS_FILE = join(STATE_DIR, "locations.json");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");
const N8N_URL = process.env.N8N_URL ?? "http://localhost:5679";
const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
const ALLOWED_CHAT = CHAT_ID;

function loadSchedule(): ScheduleEntry[] {
  if (!existsSync(SCHEDULE_FILE)) return [];
  try { return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8")); } catch { return []; }
}
function saveSchedule(entries: ScheduleEntry[]): void {
  writeFileSync(SCHEDULE_FILE, JSON.stringify(entries, null, 2), "utf-8");
}
function loadLocations(): LocationEntry[] {
  if (!existsSync(LOCATIONS_FILE)) return [];
  try { return JSON.parse(readFileSync(LOCATIONS_FILE, "utf-8")).locations ?? []; } catch { return []; }
}
function saveLocations(locations: LocationEntry[]): void {
  writeFileSync(LOCATIONS_FILE, JSON.stringify({ locations }, null, 2), "utf-8");
}
function loadReminders(): Reminder[] {
  if (!existsSync(REMINDERS_FILE)) return [];
  try { return JSON.parse(readFileSync(REMINDERS_FILE, "utf-8")); } catch { return []; }
}
function saveReminders(reminders: Reminder[]): void {
  writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8");
}

// --- MCP Server ---
const server = new McpServer(
  { name: "edith", version: "0.1.0" },
  {
    instructions: `You are Edith, a personal assistant. Messages arrive from Randy via Telegram.
Respond using the "send_message" tool with the chat_id from the message context. Be direct and concise.
You can manage scheduled tasks, reminders, and locations using the provided tools.`,
  }
);

// ============================================================
// Telegram tools
// ============================================================

server.registerTool(
  "send_message",
  {
    description: "Send a message to Randy via Telegram. Can send a text reply, or react to a specific message with an emoji. To reply: provide text and chat_id. To react: provide emoji, message_id, and chat_id.",
    inputSchema: {
    chat_id: z.number().describe("Telegram chat ID"),
    text: z.string().optional().describe("The message text to send (for replies)"),
    emoji: z.string().optional().describe("Emoji to react with (for reactions, instead of text)"),
    message_id: z.number().optional().describe("Message ID to react to (required with emoji)"),
  },
  },
  async ({ chat_id, text, emoji, message_id }) => {
    if (ALLOWED_CHAT && chat_id !== ALLOWED_CHAT) {
      return { content: [{ type: "text" as const, text: `Blocked: chat_id ${chat_id} is not authorized.` }] };
    }

    if (emoji) {
      if (!message_id) return { content: [{ type: "text" as const, text: "Reactions require message_id" }] };
      try {
        await tgCall("setMessageReaction", { chat_id, message_id, reaction: [{ type: "emoji", emoji }] });
      } catch {}
      return { content: [{ type: "text" as const, text: "Reacted" }] };
    }

    if (!text) return { content: [{ type: "text" as const, text: "Missing text or emoji" }] };
    await sendMessage(chat_id, `🤖 *EDITH*\n\n${text}`);
    logEvent("message_sent", { chatId: chat_id, text: text.slice(0, 200) });
    return { content: [{ type: "text" as const, text: "Sent" }] };
  }
);

server.registerTool(
  "send_image",
  {
    description: "Send an image to Randy via Telegram. Use the base64 data URL from generate_image.",
    inputSchema: {
    chat_id: z.number().describe("Telegram chat ID"),
    image_data: z.string().describe("Base64 data URL (data:image/png;base64,...)"),
    caption: z.string().optional().describe("Optional caption for the image"),
  },
  },
  async ({ chat_id, image_data, caption }) => {
    if (ALLOWED_CHAT && chat_id !== ALLOWED_CHAT) {
      return { content: [{ type: "text" as const, text: `Blocked: chat_id ${chat_id} is not authorized.` }] };
    }
    try {
      await sendPhoto(chat_id, image_data, caption);
      logEvent("image_sent", { chatId: chat_id, caption: caption?.slice(0, 100) });
      return { content: [{ type: "text" as const, text: "Image sent" }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to send image: ${err instanceof Error ? err.message : err}` }] };
    }
  }
);

// ============================================================
// Schedule tools
// ============================================================

server.registerTool(
  "list_scheduled_tasks",
  {
    description: "List all scheduled tasks that edith.ts runs on a timer",
  },
  async () => {
    const tasks = loadSchedule();
    if (tasks.length === 0) return { content: [{ type: "text" as const, text: "No scheduled tasks." }] };
    const lines = tasks.map((t) => {
      if (t.intervalMinutes) return `- ${t.name}: every ${t.intervalMinutes}min → ${t.prompt}`;
      const h = String(t.hour ?? 0).padStart(2, "0");
      const m = String(t.minute ?? 0).padStart(2, "0");
      return `- ${t.name}: daily at ${h}:${m} → ${t.prompt}`;
    });
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.registerTool(
  "add_scheduled_task",
  {
    description: "Add a new scheduled task. Specify either hour+minute for daily tasks, or intervalMinutes for recurring tasks.",
    inputSchema: {
    name: z.string().describe("Unique task name (e.g. 'morning-brief', 'check-stocks')"),
    prompt: z.string().describe("The prompt or skill to run"),
    hour: z.number().min(0).max(23).optional().describe("Hour to run (0-23)"),
    minute: z.number().min(0).max(59).optional().describe("Minute to run (0-59)"),
    intervalMinutes: z.number().min(1).max(1440).optional().describe("Run every N minutes"),
  },
  },
  async ({ name: taskName, prompt, hour, minute, intervalMinutes }) => {
    const tasks = loadSchedule();
    const existing = tasks.findIndex((t) => t.name === taskName);
    const entry: ScheduleEntry = { name: taskName, prompt };

    if (intervalMinutes != null) {
      entry.intervalMinutes = intervalMinutes;
    } else {
      entry.hour = hour ?? 9;
      entry.minute = minute ?? 0;
    }

    if (existing >= 0) tasks[existing] = entry; else tasks.push(entry);
    saveSchedule(tasks);
    return { content: [{ type: "text" as const, text: `Scheduled: ${taskName}` }] };
  }
);

server.registerTool(
  "remove_scheduled_task",
  {
    description: "Remove a scheduled task by name",
    inputSchema: { name: z.string().describe("Name of the task to remove") },
  },
  async ({ name: taskName }) => {
    const tasks = loadSchedule();
    const filtered = tasks.filter((t) => t.name !== taskName);
    if (filtered.length === tasks.length) {
      return { content: [{ type: "text" as const, text: `Task not found: ${taskName}` }] };
    }
    saveSchedule(filtered);
    return { content: [{ type: "text" as const, text: `Removed: ${taskName}` }] };
  }
);

// ============================================================
// Location tools
// ============================================================

server.registerTool(
  "save_location",
  {
    description: "Save a named location for geofencing and location-based reminders",
    inputSchema: {
    name: z.string().describe("Unique location key (e.g. 'home', 'office', 'gym')"),
    label: z.string().describe("Human-readable label (e.g. 'Home', 'Downtown Office')"),
    lat: z.number().min(-90).max(90).describe("Latitude"),
    lon: z.number().min(-180).max(180).describe("Longitude"),
    radiusMeters: z.number().min(50).max(50000).default(200).describe("Geofence radius in meters (default: 200)"),
  },
  },
  async ({ name: locName, label, lat, lon, radiusMeters }) => {
    const locations = loadLocations();
    const existing = locations.findIndex((l) => l.name === locName);
    const entry: LocationEntry = { name: locName, label, lat, lon, radiusMeters };
    if (existing >= 0) locations[existing] = entry; else locations.push(entry);
    saveLocations(locations);
    return { content: [{ type: "text" as const, text: `Saved location: ${label} (${locName})` }] };
  }
);

server.registerTool(
  "list_locations",
  {
    description: "List all saved locations",
  },
  async () => {
    const locations = loadLocations();
    if (locations.length === 0) return { content: [{ type: "text" as const, text: "No saved locations." }] };
    const lines = locations.map((l) => `- ${l.name}: ${l.label} (${l.lat}, ${l.lon}) r=${l.radiusMeters}m`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ============================================================
// Reminder tools
// ============================================================

server.registerTool(
  "save_reminder",
  {
    description: "Create a reminder. Use type 'time' with fireAt for time-based, or type 'location' with a location name for location-based.",
    inputSchema: {
    text: z.string().describe("Reminder text"),
    type: z.enum(["time", "location"]).describe("'time' or 'location'"),
    fireAt: z.string().optional().describe("ISO timestamp for time-based reminders (e.g. '2026-03-24T15:00:00-04:00')"),
    location: z.string().optional().describe("Location name from locations.json for location-based reminders"),
  },
  },
  async ({ text, type, fireAt, location }) => {
    const reminder: Reminder = {
      id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text, type, fired: false, created: new Date().toISOString(),
    };

    if (type === "time") {
      if (!fireAt) return { content: [{ type: "text" as const, text: "Time-based reminders require fireAt" }] };
      const parsed = new Date(fireAt);
      if (isNaN(parsed.getTime())) return { content: [{ type: "text" as const, text: `Invalid fireAt: "${fireAt}". Use ISO 8601.` }] };
      if (parsed.getTime() < Date.now()) return { content: [{ type: "text" as const, text: `fireAt is in the past: "${fireAt}"` }] };
      reminder.fireAt = parsed.toISOString();
    } else if (type === "location") {
      if (!location) return { content: [{ type: "text" as const, text: "Location-based reminders require location name" }] };
      reminder.location = location;
    }

    const reminders = loadReminders();
    reminders.push(reminder);
    saveReminders(reminders);
    return { content: [{ type: "text" as const, text: `Reminder saved: ${reminder.id}` }] };
  }
);

server.registerTool(
  "list_reminders",
  {
    description: "List all reminders (both fired and unfired)",
    inputSchema: { showFired: z.boolean().default(false).describe("Include already-fired reminders (default: false)") },
  },
  async ({ showFired }) => {
    const reminders = loadReminders();
    const filtered = showFired ? reminders : reminders.filter((r) => !r.fired);
    if (filtered.length === 0) return { content: [{ type: "text" as const, text: "No active reminders." }] };
    const lines = filtered.map((r) => {
      const status = r.fired ? "✓" : "○";
      return r.type === "time"
        ? `${status} [${r.id}] ${r.text} — fires at ${r.fireAt}`
        : `${status} [${r.id}] ${r.text} — at ${r.location}`;
    });
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.registerTool(
  "mark_reminder_fired",
  {
    description: "Mark one or more reminders as fired after delivering them to Randy",
    inputSchema: { ids: z.array(z.string()).describe("Array of reminder IDs to mark as fired") },
  },
  async ({ ids }) => {
    const reminders = loadReminders();
    let count = 0;
    for (const r of reminders) {
      if (ids.includes(r.id) && !r.fired) { r.fired = true; count++; }
    }
    saveReminders(reminders);
    return { content: [{ type: "text" as const, text: `Marked ${count} reminder(s) as fired` }] };
  }
);

// ============================================================
// Google tools (via n8n)
// ============================================================

server.registerTool(
  "get_calendar",
  {
    description: "Get upcoming calendar events from Google Calendar. Returns events for the next N hours.",
    inputSchema: {
    hoursAhead: z.number().min(1).max(24).default(4).describe("Hours ahead to look (default: 4, max: 24)"),
    includeAllDay: z.boolean().default(false).describe("Include all-day events (default: false)"),
  },
  },
  async ({ hoursAhead, includeAllDay }) => {
    try {
      const res = await fetch(`${N8N_URL}/webhook/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hoursAhead, includeAllDay }),
      });
      const body = await res.text();
      if (!res.ok) {
        if (body.includes("No item to return")) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ events: [], message: "No upcoming events" }, null, 2) }] };
        }
        return { content: [{ type: "text" as const, text: `Calendar error (${res.status}): ${body}. Check n8n at ${N8N_URL}.` }] };
      }
      try {
        const data = JSON.parse(body);
        const cutoff = new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
        if (data.events) {
          data.events = data.events.filter((e: any) => {
            if (!includeAllDay && !e.start?.includes("T")) return false;
            return !e.start || e.start <= cutoff;
          });
          data.count = data.events.length;
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch {
        return { content: [{ type: "text" as const, text: body }] };
      }
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Calendar unreachable: ${err instanceof Error ? err.message : err}. Is n8n running at ${N8N_URL}?` }] };
    }
  }
);

server.registerTool(
  "get_emails",
  {
    description: "Get recent emails from Gmail. Returns unread/important emails from the last N hours.",
    inputSchema: {
    hoursBack: z.number().min(1).max(48).default(4).describe("Hours back to search (default: 4, max: 48)"),
    unreadOnly: z.boolean().default(true).describe("Only return unread emails (default: true)"),
    maxResults: z.number().min(1).max(20).default(10).describe("Max emails to return (default: 10, max: 20)"),
  },
  },
  async ({ hoursBack, unreadOnly, maxResults }) => {
    try {
      const res = await fetch(`${N8N_URL}/webhook/gmail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hoursBack, unreadOnly, maxResults }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { content: [{ type: "text" as const, text: `Gmail error (${res.status}): ${body}. Check n8n at ${N8N_URL}.` }] };
      }
      const data = await res.json();
      if (data.emails && data.emails.length > maxResults) {
        data.emails = data.emails.slice(0, maxResults);
        data.count = data.emails.length;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Gmail unreachable: ${err instanceof Error ? err.message : err}. Is n8n running at ${N8N_URL}?` }] };
    }
  }
);

// ============================================================
// Image generation
// ============================================================

server.registerTool(
  "generate_image",
  {
    description: "Generate an image using Google's Imagen AI via Randy's Google AI subscription. Returns a URL to the generated image that can be sent via Telegram.",
    inputSchema: {
    prompt: z.string().describe("Text description of the image to generate"),
    numberOfImages: z.number().min(1).max(4).default(1).describe("Number of images to generate (default: 1, max: 4)"),
  },
  },
  async ({ prompt }) => {
    if (!GOOGLE_API_KEY) {
      return { content: [{ type: "text" as const, text: "GOOGLE_GENERATIVE_AI_API_KEY not set in .env" }] };
    }

    try {
      const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
      const model = genAI.getGenerativeModel({ model: "imagen-3.0-generate-001" });

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["image"] } as any,
      });

      const imageUrls: string[] = [];
      for (const candidate of result.response.candidates || []) {
        for (const part of candidate.content.parts) {
          if (part.inlineData?.data) {
            imageUrls.push(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`);
          }
        }
      }

      if (imageUrls.length === 0) {
        return { content: [{ type: "text" as const, text: "No images generated. Check the prompt or API quota." }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: imageUrls.length, images: imageUrls, prompt }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Image generation failed: ${err instanceof Error ? err.message : err}` }] };
    }
  }
);

// ============================================================
// Unified notification (multi-channel via n8n)
// ============================================================

server.registerTool(
  "send_notification",
  {
    description: "Send a message via any channel (WhatsApp, Slack, email, etc) through n8n. For Telegram, prefer send_message (faster, direct). Use this for non-Telegram channels or when you want n8n to handle routing.",
    inputSchema: {
    channel: z.enum(["whatsapp", "slack", "email", "discord", "telegram"]).describe("Which channel to send through"),
    recipient: z.string().describe("Recipient identifier — phone number for WhatsApp, email for email, channel/user for Slack, user ID for Discord, chat_id for Telegram"),
    text: z.string().describe("Message text to send"),
    subject: z.string().optional().describe("Subject line (for email only)"),
  },
  },
  async ({ channel, recipient, text, subject }) => {
    try {
      const res = await fetch(`${N8N_URL}/webhook/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, recipient, text, subject }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { content: [{ type: "text" as const, text: `Notification failed (${res.status}): ${body}. Is the n8n Notify workflow active at ${N8N_URL}?` }] };
      }
      const data = await res.json();
      logEvent("notification_sent", { channel, recipient: recipient.slice(0, 30), text: text.slice(0, 100) });
      return { content: [{ type: "text" as const, text: `Sent via ${channel}: ${JSON.stringify(data)}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Notification unreachable: ${err instanceof Error ? err.message : err}. Is n8n running at ${N8N_URL}?` }] };
    }
  }
);

// ============================================================
// Start
// ============================================================
const transport = new StdioServerTransport();
await server.connect(transport);
