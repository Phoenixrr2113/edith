/**
 * Edith MCP tool server.
 * Slim entrypoint — tool logic lives in lib/ modules.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { sendMessage, sendPhoto, tgCall } from "../lib/telegram";
import { logEvent } from "../lib/state";
import { fmtErr } from "../lib/util";
import { CHAT_ID, GOOGLE_API_KEY, TWILIO_WA_FROM, TWILIO_SMS_FROM, N8N_URL } from "../lib/config";
import { loadSchedule, saveSchedule, loadLocations, saveLocations, loadReminders, saveReminders } from "../lib/storage";
import { textResponse, jsonResponse } from "../lib/mcp-helpers";
import { sendTwilio } from "../lib/twilio";
import { n8nPost } from "../lib/n8n-client";
import type { ScheduleEntry, LocationEntry, Reminder } from "./types";


const ALLOWED_CHAT = CHAT_ID;

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
// Telegram
// ============================================================

server.registerTool("send_message", {
  description: "Send a message to Randy via Telegram. Can send a text reply, or react to a specific message with an emoji.",
  inputSchema: {
    chat_id: z.number().describe("Telegram chat ID"),
    text: z.string().optional().describe("The message text to send (for replies)"),
    emoji: z.string().optional().describe("Emoji to react with (for reactions, instead of text)"),
    message_id: z.number().optional().describe("Message ID to react to (required with emoji)"),
  },
}, async ({ chat_id, text, emoji, message_id }) => {
  if (ALLOWED_CHAT && chat_id !== ALLOWED_CHAT) return textResponse(`Blocked: chat_id ${chat_id} not authorized.`);
  if (emoji) {
    if (!message_id) return textResponse("Reactions require message_id");
    try { await tgCall("setMessageReaction", { chat_id, message_id, reaction: [{ type: "emoji", emoji }] }); } catch {}
    return textResponse("Reacted");
  }
  if (!text) return textResponse("Missing text or emoji");
  await sendMessage(chat_id, `🤖 *EDITH*\n\n${text}`);
  logEvent("message_sent", { chatId: chat_id, text: text.slice(0, 200) });
  return textResponse("Sent");
});

server.registerTool("send_image", {
  description: "Send an image to Randy via Telegram. Use the base64 data URL from generate_image.",
  inputSchema: {
    chat_id: z.number().describe("Telegram chat ID"),
    image_data: z.string().describe("Base64 data URL (data:image/png;base64,...)"),
    caption: z.string().optional().describe("Optional caption for the image"),
  },
}, async ({ chat_id, image_data, caption }) => {
  if (ALLOWED_CHAT && chat_id !== ALLOWED_CHAT) return textResponse(`Blocked: chat_id ${chat_id} not authorized.`);
  try {
    await sendPhoto(chat_id, image_data, caption);
    logEvent("image_sent", { chatId: chat_id, caption: caption?.slice(0, 100) });
    return textResponse("Image sent");
  } catch (err) {
    return textResponse(`Failed to send image: ${fmtErr(err)}`);
  }
});

// ============================================================
// Schedule
// ============================================================

server.registerTool("list_scheduled_tasks", {
  description: "List all scheduled tasks that edith.ts runs on a timer",
}, async () => {
  const tasks = loadSchedule();
  if (tasks.length === 0) return textResponse("No scheduled tasks.");
  const lines = tasks.map((t) => {
    if (t.intervalMinutes) return `- ${t.name}: every ${t.intervalMinutes}min`;
    return `- ${t.name}: daily at ${String(t.hour ?? 0).padStart(2, "0")}:${String(t.minute ?? 0).padStart(2, "0")}`;
  });
  return textResponse(lines.join("\n"));
});

server.registerTool("add_scheduled_task", {
  description: "Add a new scheduled task. Specify either hour+minute for daily tasks, or intervalMinutes for recurring.",
  inputSchema: {
    name: z.string().describe("Unique task name"),
    prompt: z.string().describe("The prompt or skill to run"),
    hour: z.number().min(0).max(23).optional(),
    minute: z.number().min(0).max(59).optional(),
    intervalMinutes: z.number().min(1).max(1440).optional(),
  },
}, async ({ name: taskName, prompt, hour, minute, intervalMinutes }) => {
  const tasks = loadSchedule();
  const existing = tasks.findIndex((t) => t.name === taskName);
  const entry: ScheduleEntry = { name: taskName, prompt };
  if (intervalMinutes != null) entry.intervalMinutes = intervalMinutes;
  else { entry.hour = hour ?? 9; entry.minute = minute ?? 0; }
  if (existing >= 0) tasks[existing] = entry; else tasks.push(entry);
  saveSchedule(tasks);
  return textResponse(`Scheduled: ${taskName}`);
});

server.registerTool("remove_scheduled_task", {
  description: "Remove a scheduled task by name",
  inputSchema: { name: z.string().describe("Name of the task to remove") },
}, async ({ name: taskName }) => {
  const tasks = loadSchedule();
  const filtered = tasks.filter((t) => t.name !== taskName);
  if (filtered.length === tasks.length) return textResponse(`Task not found: ${taskName}`);
  saveSchedule(filtered);
  return textResponse(`Removed: ${taskName}`);
});

// ============================================================
// Locations
// ============================================================

server.registerTool("save_location", {
  description: "Save a named location for geofencing and location-based reminders",
  inputSchema: {
    name: z.string().describe("Unique location key (e.g. 'home', 'office')"),
    label: z.string().describe("Human-readable label"),
    lat: z.number().min(-90).max(90).describe("Latitude"),
    lon: z.number().min(-180).max(180).describe("Longitude"),
    radiusMeters: z.number().min(50).max(50000).default(200).describe("Geofence radius in meters"),
  },
}, async ({ name: locName, label, lat, lon, radiusMeters }) => {
  const locations = loadLocations();
  const existing = locations.findIndex((l) => l.name === locName);
  const entry: LocationEntry = { name: locName, label, lat, lon, radiusMeters };
  if (existing >= 0) locations[existing] = entry; else locations.push(entry);
  saveLocations(locations);
  return textResponse(`Saved location: ${label} (${locName})`);
});

server.registerTool("list_locations", {
  description: "List all saved locations",
}, async () => {
  const locations = loadLocations();
  if (locations.length === 0) return textResponse("No saved locations.");
  const lines = locations.map((l) => `- ${l.name}: ${l.label} (${l.lat}, ${l.lon}) r=${l.radiusMeters}m`);
  return textResponse(lines.join("\n"));
});

// ============================================================
// Reminders
// ============================================================

server.registerTool("save_reminder", {
  description: "Create a reminder. Use type 'time' with fireAt, or type 'location' with a location name.",
  inputSchema: {
    text: z.string().describe("Reminder text"),
    type: z.enum(["time", "location"]).describe("'time' or 'location'"),
    fireAt: z.string().optional().describe("ISO timestamp for time-based reminders"),
    location: z.string().optional().describe("Location name for location-based reminders"),
  },
}, async ({ text, type, fireAt, location }) => {
  const reminder: Reminder = {
    id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text, type, fired: false, created: new Date().toISOString(),
  };
  if (type === "time") {
    if (!fireAt) return textResponse("Time-based reminders require fireAt");
    const parsed = new Date(fireAt);
    if (isNaN(parsed.getTime())) return textResponse(`Invalid fireAt: "${fireAt}". Use ISO 8601.`);
    if (parsed.getTime() < Date.now()) return textResponse(`fireAt is in the past: "${fireAt}"`);
    reminder.fireAt = parsed.toISOString();
  } else if (type === "location") {
    if (!location) return textResponse("Location-based reminders require location name");
    reminder.location = location;
  }
  const reminders = loadReminders();
  reminders.push(reminder);
  saveReminders(reminders);
  return textResponse(`Reminder saved: ${reminder.id}`);
});

server.registerTool("list_reminders", {
  description: "List all reminders (both fired and unfired)",
  inputSchema: { showFired: z.boolean().default(false).describe("Include already-fired reminders") },
}, async ({ showFired }) => {
  const reminders = loadReminders();
  const filtered = showFired ? reminders : reminders.filter((r) => !r.fired);
  if (filtered.length === 0) return textResponse("No active reminders.");
  const lines = filtered.map((r) => {
    const s = r.fired ? "✓" : "○";
    return r.type === "time" ? `${s} [${r.id}] ${r.text} — ${r.fireAt}` : `${s} [${r.id}] ${r.text} — at ${r.location}`;
  });
  return textResponse(lines.join("\n"));
});

server.registerTool("mark_reminder_fired", {
  description: "Mark one or more reminders as fired after delivering them to Randy",
  inputSchema: { ids: z.array(z.string()).describe("Array of reminder IDs to mark as fired") },
}, async ({ ids }) => {
  const reminders = loadReminders();
  let count = 0;
  for (const r of reminders) { if (ids.includes(r.id) && !r.fired) { r.fired = true; count++; } }
  saveReminders(reminders);
  return textResponse(`Marked ${count} reminder(s) as fired`);
});

// ============================================================
// Google (via n8n)
// ============================================================

server.registerTool("get_calendar", {
  description: "Get upcoming calendar events from Google Calendar. Returns events for the next N hours.",
  inputSchema: {
    hoursAhead: z.number().min(1).max(168).default(24).describe("Hours ahead to look (default: 24, max: 168 for full week)"),
    includeAllDay: z.boolean().default(true).describe("Include all-day events like milestones and deadlines (default: true)"),
  },
}, async ({ hoursAhead, includeAllDay }) => {
  const result = await n8nPost("calendar", { hoursAhead, includeAllDay });
  if (!result.ok) {
    if (result.data === null) return jsonResponse({ events: [], message: "No upcoming events" });
    return textResponse(`Calendar error: ${result.error}`);
  }
  const data = result.data;
  if (data?.events) {
    const cutoff = new Date(Date.now() + hoursAhead * 3600000).toISOString();
    data.events = data.events.filter((e: any) => {
      if (!includeAllDay && !e.start?.includes("T")) return false;
      return !e.start || e.start <= cutoff;
    });
    data.count = data.events.length;
  }
  return jsonResponse(data);
});

server.registerTool("get_emails", {
  description: "Get recent emails from Gmail. Returns unread/important emails from the last N hours.",
  inputSchema: {
    hoursBack: z.number().min(1).max(48).default(4).describe("Hours back to search"),
    unreadOnly: z.boolean().default(true).describe("Only return unread emails"),
    maxResults: z.number().min(1).max(20).default(10).describe("Max emails to return"),
  },
}, async ({ hoursBack, unreadOnly, maxResults }) => {
  const result = await n8nPost("gmail", { hoursBack, unreadOnly, maxResults });
  if (!result.ok) return textResponse(`Gmail error: ${result.error}`);
  const data = result.data;
  if (data?.emails?.length > maxResults) {
    data.emails = data.emails.slice(0, maxResults);
    data.count = data.emails.length;
  }
  return jsonResponse(data);
});

// ============================================================
// Image generation
// ============================================================

server.registerTool("generate_image", {
  description: "Generate an image using Google's Imagen AI. Returns base64 data URL to send via Telegram.",
  inputSchema: {
    prompt: z.string().describe("Text description of the image to generate"),
    numberOfImages: z.number().min(1).max(4).default(1).describe("Number of images (default: 1)"),
  },
}, async ({ prompt, numberOfImages }) => {
  if (!GOOGLE_API_KEY) return textResponse("GOOGLE_GENERATIVE_AI_API_KEY not set in .env");
  try {
    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "imagen-3.0-generate-001" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["image"], candidateCount: numberOfImages } as any,
    });
    const images: string[] = [];
    for (const c of result.response.candidates || [])
      for (const p of c.content.parts)
        if (p.inlineData?.data) images.push(`data:${p.inlineData.mimeType};base64,${p.inlineData.data}`);
    if (images.length === 0) return textResponse("No images generated. Check prompt or API quota.");
    return jsonResponse({ success: true, count: images.length, images, prompt });
  } catch (err) {
    return textResponse(`Image generation failed: ${fmtErr(err)}`);
  }
});

// ============================================================
// Notifications (multi-channel)
// ============================================================

server.registerTool("send_notification", {
  description: "Send a message via any channel (WhatsApp, Slack, email, SMS, etc). For Telegram, prefer send_message. WhatsApp/SMS go direct via Twilio. Email/Slack/Discord route through n8n.",
  inputSchema: {
    channel: z.enum(["whatsapp", "sms", "slack", "email", "discord", "telegram"]).describe("Channel to send through"),
    recipient: z.string().describe("Recipient — phone for WhatsApp/SMS, email for email, chat_id for Telegram"),
    text: z.string().describe("Message text to send"),
    subject: z.string().optional().describe("Subject line (for email only)"),
  },
}, async ({ channel, recipient, text, subject }) => {
  const log = () => logEvent("notification_sent", { channel, recipient: recipient.slice(0, 30), text: text.slice(0, 100) });

  if (channel === "telegram") {
    const chatId = Number(recipient) || CHAT_ID;
    try {
      await sendMessage(chatId, text);
      log();
      return textResponse("Telegram sent");
    } catch (err) {
      return textResponse(`Telegram failed: ${fmtErr(err)}`);
    }
  }

  if (channel === "whatsapp") {
    const to = recipient.startsWith("whatsapp:") ? recipient : `whatsapp:${recipient}`;
    const result = await sendTwilio(to, text, TWILIO_WA_FROM);
    if (result.ok) { log(); return textResponse(`WhatsApp sent (SID: ${result.sid})`); }
    return textResponse(`WhatsApp failed: ${result.error}`);
  }

  if (channel === "sms") {
    const result = await sendTwilio(recipient, text, TWILIO_SMS_FROM);
    if (result.ok) { log(); return textResponse(`SMS sent (SID: ${result.sid})`); }
    return textResponse(`SMS failed: ${result.error}`);
  }

  // Email, Slack, Discord — route through n8n
  const result = await n8nPost("notify", { channel, recipient, text, subject });
  if (!result.ok) return textResponse(`Notification failed: ${result.error}`);
  log();
  return textResponse(`Sent via ${channel}`);
});

// ============================================================
// Desktop Notifications (macOS)
// ============================================================

import { showNotification, showDialog } from "../lib/notify";
import { getInterventionHistory, recordIntervention, canIntervene } from "../lib/proactive";

server.registerTool("show_notification", {
  description: "Show a macOS desktop notification (toast). Use for non-blocking alerts — meeting reminders, task completions, status updates. Appears in Notification Center.",
  inputSchema: {
    title: z.string().describe("Notification title"),
    body: z.string().describe("Notification body text"),
  },
}, async ({ title, body }) => {
  try {
    await showNotification(title, body);
    logEvent("desktop_notification", { title, body: body.slice(0, 100) });
    return textResponse("Notification shown");
  } catch (err) {
    const msg = fmtErr(err);
    logEvent("desktop_notification_error", { title, error: msg });
    return textResponse(`Notification failed: ${msg}`);
  }
});

server.registerTool("show_dialog", {
  description: "Show a modal dialog on Randy's screen with buttons. Use for decisions that need immediate input — approval flows, yes/no questions, multi-option choices. Blocks until a button is clicked. Returns which button was pressed.",
  inputSchema: {
    title: z.string().describe("Dialog title"),
    body: z.string().describe("Dialog message text"),
    buttons: z.array(z.string()).min(1).max(3).default(["OK"]).describe("Button labels (max 3). Last button is the default."),
  },
}, async ({ title, body, buttons }) => {
  try {
    const clicked = await showDialog(title, body, buttons);
    logEvent("desktop_dialog", { title, clicked });
    return textResponse(`Button clicked: ${clicked}`);
  } catch (err) {
    const msg = fmtErr(err);
    logEvent("desktop_dialog_error", { title, error: msg });
    return textResponse(`Dialog failed: ${msg}`);
  }
});

// ============================================================
// Proactive Intelligence
// ============================================================

server.registerTool("proactive_history", {
  description: "Check what proactive interventions Edith has already made recently. Use before making a new proactive suggestion to avoid repeating yourself.",
  inputSchema: {
    hours: z.number().min(1).max(24).default(4).describe("Hours of history to check (default: 4)"),
  },
}, async ({ hours }) => {
  const history = getInterventionHistory(hours);
  if (history.length === 0) return textResponse("No recent interventions.");
  const lines = history.map((i) =>
    `- ${new Date(i.timestamp).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} [${i.category}] ${i.message}`
  );
  return textResponse(lines.join("\n"));
});

server.registerTool("record_intervention", {
  description: "Record that a proactive intervention was made. Call this AFTER sending a proactive notification or message, so Edith tracks it for rate limiting.",
  inputSchema: {
    category: z.string().describe("Intervention category (e.g. 'meeting-prep', 'break-reminder', 'email-help', 'error-help', 'calendar-conflict')"),
    message: z.string().describe("Brief description of what was suggested"),
  },
}, async ({ category, message }) => {
  const check = canIntervene(category);
  if (!check.allowed) {
    return textResponse(`Intervention blocked: ${check.reason}`);
  }
  recordIntervention(category, message);
  return textResponse(`Recorded: [${category}] ${message.slice(0, 80)}`);
});

// ============================================================
// Start
// ============================================================
const transport = new StdioServerTransport();
await server.connect(transport);
