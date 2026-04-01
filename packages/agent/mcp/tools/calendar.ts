import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { edithLog } from "../../lib/edith-logger";
import { createEvent, deleteEvent, getEvents, updateEvent } from "../../lib/gcal";
import { jsonResponse, textResponse } from "../../lib/mcp-helpers";

export function registerCalendarTools(server: McpServer): void {
	// ============================================================
	// Calendar — manage_calendar (get + create + update + delete)
	// ============================================================

	server.registerTool(
		"manage_calendar",
		{
			description:
				"Unified Google Calendar tool. Action 'get' fetches upcoming events. Actions 'create', 'update', 'delete' manage events.",
			inputSchema: {
				action: z
					.enum(["get", "create", "update", "delete"])
					.default("get")
					.describe("What to do. Default: 'get' to fetch events."),
				// Get params
				hoursAhead: z
					.number()
					.min(0)
					.max(168)
					.optional()
					.describe(
						"(get) Hours ahead to look. Default: 24. Set to 0 when using hoursBehind only."
					),
				hoursBehind: z
					.number()
					.min(0)
					.max(168)
					.optional()
					.describe(
						"(get) Hours behind (in the past) to look. When specified, returns events from (now - hoursBehind) to now (or to now + hoursAhead if both specified). Default: 0 (no past events)."
					),
				includeAllDay: z
					.boolean()
					.optional()
					.describe("(get) Include all-day events. Default: true"),
				// Create/update params
				summary: z.string().optional().describe("(create/update) Event title"),
				start: z.string().optional().describe("(create/update) Start time ISO 8601"),
				end: z.string().optional().describe("(create/update) End time ISO 8601"),
				location: z.string().optional().describe("(create/update) Event location"),
				description: z.string().optional().describe("(create/update) Event description"),
				allDay: z.boolean().optional().describe("(create) All-day event flag"),
				// Update/delete params
				eventId: z
					.string()
					.optional()
					.describe("(update/delete) Calendar event ID from a previous get"),
				calendar: z
					.string()
					.optional()
					.describe("Calendar ID. Default: randyrowanwilson@gmail.com"),
			},
		},
		async ({
			action,
			hoursAhead,
			hoursBehind,
			includeAllDay,
			summary,
			start,
			end,
			location,
			description,
			allDay,
			eventId,
			calendar,
		}) => {
			// Get mode
			if (action === "get") {
				const ahead = hoursAhead ?? (hoursBehind != null ? 0 : 24);
				const behind = hoursBehind ?? 0;
				const inclAllDay = includeAllDay ?? true;
				const now = Date.now();
				const timeMin = new Date(now - behind * 3600_000).toISOString();
				const timeMax = new Date(now + ahead * 3600_000).toISOString();

				try {
					const events = await getEvents({
						calendarId: calendar,
						timeMin,
						timeMax,
						includeAllDay: inclAllDay,
					});
					return jsonResponse({ events, count: events.length });
				} catch (err) {
					return textResponse(
						`Calendar error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// Create
			if (action === "create") {
				if (!summary) return textResponse("create requires a summary (event title)");
				if (!start) return textResponse("create requires a start time");
				try {
					const event = await createEvent({
						calendarId: calendar,
						summary,
						start,
						end,
						description,
						location,
						allDay,
					});
					edithLog.info("calendar_created", { summary, start });
					return jsonResponse(event);
				} catch (err) {
					return textResponse(
						`Calendar create error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// Update
			if (action === "update") {
				if (!eventId) return textResponse("update requires an eventId");
				try {
					const event = await updateEvent({
						calendarId: calendar,
						eventId,
						summary,
						start,
						end,
						description,
						location,
					});
					edithLog.info("calendar_updated", { eventId, summary });
					return jsonResponse(event);
				} catch (err) {
					return textResponse(
						`Calendar update error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// Delete
			if (action === "delete") {
				if (!eventId) return textResponse("delete requires an eventId");
				try {
					await deleteEvent({ calendarId: calendar, eventId });
					edithLog.info("calendar_deleted", { eventId });
					return textResponse(`Deleted event: ${eventId}`);
				} catch (err) {
					return textResponse(
						`Calendar delete error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			return textResponse(`Unknown action: ${action}`);
		}
	);
}
