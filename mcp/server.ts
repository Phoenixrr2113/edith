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
import { CHAT_ID, GOOGLE_API_KEY, TWILIO_WA_FROM, TWILIO_SMS_FROM } from "../lib/config";
import { loadSchedule, saveSchedule, loadLocations, saveLocations, loadReminders, saveReminders } from "../lib/storage";
import { textResponse, jsonResponse } from "../lib/mcp-helpers";
import { sendTwilio } from "../lib/twilio";
import { n8nPost } from "../lib/n8n-client";
import { showNotification, showDialog } from "../lib/notify";
import { getInterventionHistory, recordIntervention, canIntervene } from "../lib/proactive";
import type { ScheduleEntry, LocationEntry, Reminder } from "./types";


const ALLOWED_CHAT = CHAT_ID;

// --- MCP Server ---
const server = new McpServer(
  { name: "edith", version: "0.1.0" },
  {
    instructions: `You are Edith, a personal assistant. Messages arrive from Randy via Telegram.
Respond using the "send_message" tool with the chat_id from the message context. Be direct and concise.
You can manage scheduled tasks, reminders, locations, emails, and calendar using the provided tools.`,
  }
);

// ============================================================
// Telegram — send_message (text, image, reaction)
// ============================================================

server.registerTool("send_message", {
  description: "Send a message to Randy via Telegram. Supports text, images, emoji reactions, or text+image together.",
  inputSchema: {
    chat_id: z.number().describe("Telegram chat ID"),
    text: z.string().optional().describe("Message text to send"),
    image: z.string().optional().describe("Base64 data URL (data:image/png;base64,...) to send as photo"),
    emoji: z.string().optional().describe("Emoji to react with (instead of text/image)"),
    message_id: z.number().optional().describe("Message ID to react to (required with emoji)"),
  },
}, async ({ chat_id, text, image, emoji, message_id }) => {
  if (ALLOWED_CHAT && chat_id !== ALLOWED_CHAT) return textResponse(`Blocked: chat_id ${chat_id} not authorized.`);

  // Emoji reaction
  if (emoji) {
    if (!message_id) return textResponse("Reactions require message_id");
    try { await tgCall("setMessageReaction", { chat_id, message_id, reaction: [{ type: "emoji", emoji }] }); } catch {}
    return textResponse("Reacted");
  }

  // Image (with optional caption)
  if (image) {
    try {
      await sendPhoto(chat_id, image, text);
      logEvent("image_sent", { chatId: chat_id, caption: text?.slice(0, 100) });
      return textResponse("Image sent");
    } catch (err) {
      return textResponse(`Failed to send image: ${fmtErr(err)}`);
    }
  }

  // Text only
  if (!text) return textResponse("Missing text, image, or emoji");
  await sendMessage(chat_id, `🤖 *EDITH*\n\n${text}`);
  logEvent("message_sent", { chatId: chat_id, text: text.slice(0, 200) });
  return textResponse("Sent");
});

// ============================================================
// Notifications — send_notification (all channels + desktop)
// ============================================================

server.registerTool("send_notification", {
  description: "Send a notification via any channel. Channels: telegram, whatsapp, sms, email, slack, discord (remote), desktop (macOS toast), dialog (macOS modal that blocks and returns which button was clicked).",
  inputSchema: {
    channel: z.enum(["whatsapp", "sms", "slack", "email", "discord", "telegram", "desktop", "dialog"]).describe("Delivery channel"),
    recipient: z.string().optional().describe("Recipient — phone for WhatsApp/SMS, email for email, chat_id for Telegram. Not needed for desktop/dialog."),
    text: z.string().describe("Message or notification body"),
    title: z.string().optional().describe("Title (for desktop/dialog notifications)"),
    subject: z.string().optional().describe("Subject line (for email)"),
    buttons: z.array(z.string()).min(1).max(3).optional().describe("Button labels for dialog channel (max 3). Returns which was clicked."),
  },
}, async ({ channel, recipient, text, title, subject, buttons }) => {
  const log = () => logEvent("notification_sent", { channel, recipient: recipient?.slice(0, 30), text: text.slice(0, 100) });

  // Desktop toast notification
  if (channel === "desktop") {
    try {
      await showNotification(title ?? "Edith", text);
      logEvent("desktop_notification", { title, body: text.slice(0, 100) });
      return textResponse("Notification shown");
    } catch (err) {
      return textResponse(`Notification failed: ${fmtErr(err)}`);
    }
  }

  // Modal dialog (blocks, returns button clicked)
  if (channel === "dialog") {
    try {
      const clicked = await showDialog(title ?? "Edith", text, buttons ?? ["OK"]);
      logEvent("desktop_dialog", { title, clicked });
      return textResponse(`Button clicked: ${clicked}`);
    } catch (err) {
      return textResponse(`Dialog failed: ${fmtErr(err)}`);
    }
  }

  // Telegram
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

  // WhatsApp (Twilio)
  if (channel === "whatsapp") {
    if (!recipient) return textResponse("WhatsApp requires a recipient phone number");
    const to = recipient.startsWith("whatsapp:") ? recipient : `whatsapp:${recipient}`;
    const result = await sendTwilio(to, text, TWILIO_WA_FROM);
    if (result.ok) { log(); return textResponse(`WhatsApp sent (SID: ${result.sid})`); }
    return textResponse(`WhatsApp failed: ${result.error}`);
  }

  // SMS (Twilio)
  if (channel === "sms") {
    if (!recipient) return textResponse("SMS requires a recipient phone number");
    const result = await sendTwilio(recipient, text, TWILIO_SMS_FROM);
    if (result.ok) { log(); return textResponse(`SMS sent (SID: ${result.sid})`); }
    return textResponse(`SMS failed: ${result.error}`);
  }

  // Email, Slack, Discord — route through n8n
  if (!recipient) return textResponse(`${channel} requires a recipient`);
  const result = await n8nPost("notify", { channel, recipient, text, subject });
  if (!result.ok) return textResponse(`Notification failed: ${result.error}`);
  log();
  return textResponse(`Sent via ${channel}`);
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
// Email — manage_emails (get + manage + batch, one tool)
// ============================================================

server.registerTool("manage_emails", {
  description: "Unified Gmail tool. Action 'get' fetches recent emails. Actions 'archive', 'trash', 'markAsRead', 'addLabel', 'removeLabel' manage a single email by messageId. Use 'operations' array for batch management (up to 50). Prefer archive over trash — archive is reversible.",
  inputSchema: {
    action: z.enum(["get", "archive", "trash", "markAsRead", "addLabel", "removeLabel"]).default("get")
      .describe("What to do. Default: 'get' to fetch emails."),
    // Get params
    hoursBack: z.number().min(1).max(48).optional().describe("(get) Hours back to search. Default: 4"),
    unreadOnly: z.boolean().optional().describe("(get) Only unread emails. Default: true"),
    maxResults: z.number().min(1).max(20).optional().describe("(get) Max emails. Default: 10"),
    // Single manage params
    messageId: z.string().optional().describe("(manage) Gmail message ID from a previous get"),
    label: z.string().optional().describe("(addLabel/removeLabel) Label name"),
    // Batch params
    operations: z.array(z.object({
      messageId: z.string(),
      action: z.enum(["archive", "trash", "markAsRead", "addLabel", "removeLabel"]),
      label: z.string().optional(),
    })).max(50).optional().describe("(batch) Array of operations. Overrides single messageId/action."),
  },
}, async ({ action, hoursBack, unreadOnly, maxResults, messageId, label, operations }) => {
  // Batch mode
  if (operations && operations.length > 0) {
    const result = await n8nPost("gmail", { action: "batch", operations });
    if (!result.ok) return textResponse(`Batch email error: ${result.error}`);
    logEvent("email_managed_batch", { count: operations.length, actions: [...new Set(operations.map(o => o.action))].join(",") });
    return jsonResponse(result.data ?? { success: true, count: operations.length });
  }

  // Get mode
  if (action === "get") {
    const params = { hoursBack: hoursBack ?? 4, unreadOnly: unreadOnly ?? true, maxResults: maxResults ?? 10 };
    const result = await n8nPost("gmail", params);
    if (!result.ok) return textResponse(`Gmail error: ${result.error}`);
    const data = result.data;
    if (data?.emails?.length > params.maxResults) {
      data.emails = data.emails.slice(0, params.maxResults);
      data.count = data.emails.length;
    }
    return jsonResponse(data);
  }

  // Single manage
  if (!messageId) return textResponse(`${action} requires a messageId`);
  if ((action === "addLabel" || action === "removeLabel") && !label) {
    return textResponse(`${action} requires a label name`);
  }
  const result = await n8nPost("gmail", { messageId, action, label });
  if (!result.ok) return textResponse(`Email manage error: ${result.error}`);
  logEvent("email_managed", { messageId, action, label });
  return textResponse(`Done: ${action} on ${messageId}`);
});

// ============================================================
// Calendar — manage_calendar (get + create + update + delete)
// ============================================================

server.registerTool("manage_calendar", {
  description: "Unified Google Calendar tool. Action 'get' fetches upcoming events. Actions 'create', 'update', 'delete' manage events.",
  inputSchema: {
    action: z.enum(["get", "create", "update", "delete"]).default("get")
      .describe("What to do. Default: 'get' to fetch events."),
    // Get params
    hoursAhead: z.number().min(1).max(168).optional().describe("(get) Hours ahead to look. Default: 24"),
    includeAllDay: z.boolean().optional().describe("(get) Include all-day events. Default: true"),
    // Create/update params
    summary: z.string().optional().describe("(create/update) Event title"),
    start: z.string().optional().describe("(create/update) Start time ISO 8601"),
    end: z.string().optional().describe("(create/update) End time ISO 8601"),
    location: z.string().optional().describe("(create/update) Event location"),
    description: z.string().optional().describe("(create/update) Event description"),
    allDay: z.boolean().optional().describe("(create) All-day event flag"),
    // Update/delete params
    eventId: z.string().optional().describe("(update/delete) Calendar event ID from a previous get"),
    calendar: z.string().optional().describe("Calendar ID. Default: randyrowanwilson@gmail.com"),
  },
}, async ({ action, hoursAhead, includeAllDay, summary, start, end, location, description, allDay, eventId, calendar }) => {
  // Get mode
  if (action === "get") {
    const hours = hoursAhead ?? 24;
    const inclAllDay = includeAllDay ?? true;
    const result = await n8nPost("calendar", { hoursAhead: hours, includeAllDay: inclAllDay });
    if (!result.ok) {
      if (result.data === null) return jsonResponse({ events: [], message: "No upcoming events" });
      return textResponse(`Calendar error: ${result.error}`);
    }
    const data = result.data;
    if (data?.events) {
      const cutoff = new Date(Date.now() + hours * 3600000).toISOString();
      data.events = data.events.filter((e: any) => {
        if (!inclAllDay && !e.start?.includes("T")) return false;
        return !e.start || e.start <= cutoff;
      });
      data.count = data.events.length;
    }
    return jsonResponse(data);
  }

  // Create
  if (action === "create") {
    if (!summary) return textResponse("create requires a summary (event title)");
    if (!start) return textResponse("create requires a start time");
    const result = await n8nPost("calendar", { action: "create", summary, start, end, location, description, allDay, calendar });
    if (!result.ok) return textResponse(`Calendar create error: ${result.error}`);
    logEvent("calendar_created", { summary, start });
    return jsonResponse(result.data ?? { ok: true, summary, start });
  }

  // Update
  if (action === "update") {
    if (!eventId) return textResponse("update requires an eventId");
    const result = await n8nPost("calendar", { action: "update", eventId, summary, start, end, location, description, calendar });
    if (!result.ok) return textResponse(`Calendar update error: ${result.error}`);
    logEvent("calendar_updated", { eventId, summary });
    return jsonResponse(result.data ?? { ok: true, eventId });
  }

  // Delete
  if (action === "delete") {
    if (!eventId) return textResponse("delete requires an eventId");
    const result = await n8nPost("calendar", { action: "delete", eventId, calendar });
    if (!result.ok) return textResponse(`Calendar delete error: ${result.error}`);
    logEvent("calendar_deleted", { eventId });
    return textResponse(`Deleted event: ${eventId}`);
  }

  return textResponse(`Unknown action: ${action}`);
});

// ============================================================
// Google Docs
// ============================================================

server.registerTool("manage_docs", {
  description: "Create a Google Doc. Returns a shareable URL accessible from any device. Use this for reviews, briefs, prep notes — anything Randy needs to read on his phone.",
  inputSchema: {
    title: z.string().describe("Document title"),
    content: z.string().describe("Document content (plain text or markdown)"),
    folderId: z.string().optional().describe("Google Drive folder ID (optional, defaults to root)"),
  },
  annotations: { title: "Google Docs", readOnlyHint: false },
  cb: async ({ title, content, folderId }) => {
    const result = await n8nPost("docs", { title, content, folderId });
    if (!result.ok) return textResponse(`Failed to create doc: ${result.error}`);
    const data = result.data as any;
    return jsonResponse({ ok: true, docId: data.docId, docUrl: data.docUrl, name: data.name });
  },
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
