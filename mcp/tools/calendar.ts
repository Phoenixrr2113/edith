import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logEvent } from "../../lib/state";
import { textResponse, jsonResponse } from "../../lib/mcp-helpers";
import { n8nPost } from "../../lib/n8n-client";

export function registerCalendarTools(server: McpServer): void {
  // ============================================================
  // Calendar — manage_calendar (get + create + update + delete)
  // ============================================================

  server.registerTool("manage_calendar", {
    description: "Unified Google Calendar tool. Action 'get' fetches upcoming events. Actions 'create', 'update', 'delete' manage events.",
    inputSchema: {
      action: z.enum(["get", "create", "update", "delete"]).default("get")
        .describe("What to do. Default: 'get' to fetch events."),
      // Get params
      hoursAhead: z.number().min(0).max(168).optional().describe("(get) Hours ahead to look. Default: 24. Set to 0 when using hoursBehind only."),
      hoursBehind: z.number().min(0).max(168).optional().describe("(get) Hours behind (in the past) to look. When specified, returns events from (now - hoursBehind) to now (or to now + hoursAhead if both specified). Default: 0 (no past events)."),
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
  }, async ({ action, hoursAhead, hoursBehind, includeAllDay, summary, start, end, location, description, allDay, eventId, calendar }) => {
    // Get mode
    if (action === "get") {
      const ahead = hoursAhead ?? (hoursBehind != null ? 0 : 24);
      const behind = hoursBehind ?? 0;
      const inclAllDay = includeAllDay ?? true;
      const now = Date.now();
      const timeMin = new Date(now - behind * 3600000).toISOString();
      const timeMax = new Date(now + ahead * 3600000).toISOString();
      const result = await n8nPost("calendar", { timeMin, timeMax, includeAllDay: inclAllDay });
      if (!result.ok) {
        if (result.data === null) return jsonResponse({ events: [], message: "No upcoming events" });
        return textResponse(`Calendar error: ${result.error}`);
      }
      const data = result.data as { events?: Array<{ start?: string; end?: string; summary?: string }>; count?: number } | null | undefined;
      if (data?.events) {
        data.events = data.events.filter((e) => {
          if (!inclAllDay && !e.start?.includes("T")) return false;
          const eventStart = e.start;
          if (!eventStart) return true;
          return eventStart >= timeMin && eventStart <= timeMax;
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
}
