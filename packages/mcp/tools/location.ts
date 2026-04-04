import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResponse } from "../../agent/lib/mcp-helpers";
import {
	loadLocations,
	loadReminders,
	saveLocations,
	saveReminders,
} from "../../agent/lib/storage";
import type { LocationEntry, Reminder } from "../../agent/lib/mcp-types";

export function registerLocationTools(server: McpServer): void {
	// ============================================================
	// Locations
	// ============================================================

	server.registerTool(
		"save_location",
		{
			description: "Save a named location for geofencing and location-based reminders",
			inputSchema: {
				name: z.string().describe("Unique location key (e.g. 'home', 'office')"),
				label: z.string().describe("Human-readable label"),
				lat: z.number().min(-90).max(90).describe("Latitude"),
				lon: z.number().min(-180).max(180).describe("Longitude"),
				radiusMeters: z
					.number()
					.min(50)
					.max(50000)
					.default(200)
					.describe("Geofence radius in meters"),
			},
		},
		async ({ name: locName, label, lat, lon, radiusMeters }) => {
			const locations = loadLocations();
			const existing = locations.findIndex((l) => l.name === locName);
			const entry: LocationEntry = { name: locName, label, lat, lon, radiusMeters };
			if (existing >= 0) locations[existing] = entry;
			else locations.push(entry);
			saveLocations(locations);
			return textResponse(`Saved location: ${label} (${locName})`);
		}
	);

	server.registerTool(
		"list_locations",
		{
			description: "List all saved locations",
		},
		async () => {
			const locations = loadLocations();
			if (locations.length === 0) return textResponse("No saved locations.");
			const lines = locations.map(
				(l) => `- ${l.name}: ${l.label} (${l.lat}, ${l.lon}) r=${l.radiusMeters}m`
			);
			return textResponse(lines.join("\n"));
		}
	);

	// ============================================================
	// Reminders
	// ============================================================

	server.registerTool(
		"save_reminder",
		{
			description:
				"Create a reminder. Use type 'time' with fireAt, or type 'location' with a location name.",
			inputSchema: {
				text: z.string().describe("Reminder text"),
				type: z.enum(["time", "location"]).describe("'time' or 'location'"),
				fireAt: z.string().optional().describe("ISO timestamp for time-based reminders"),
				location: z.string().optional().describe("Location name for location-based reminders"),
			},
		},
		async ({ text, type, fireAt, location }) => {
			const reminder: Reminder = {
				id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				text,
				type,
				fired: false,
				created: new Date().toISOString(),
			};
			if (type === "time") {
				if (!fireAt) return textResponse("Time-based reminders require fireAt");
				const parsed = new Date(fireAt);
				if (Number.isNaN(parsed.getTime()))
					return textResponse(`Invalid fireAt: "${fireAt}". Use ISO 8601.`);
				if (parsed.getTime() < Date.now())
					return textResponse(`fireAt is in the past: "${fireAt}"`);
				reminder.fireAt = parsed.toISOString();
			} else if (type === "location") {
				if (!location) return textResponse("Location-based reminders require location name");
				reminder.location = location;
			}
			const reminders = loadReminders();
			reminders.push(reminder);
			saveReminders(reminders);
			return textResponse(`Reminder saved: ${reminder.id}`);
		}
	);

	server.registerTool(
		"list_reminders",
		{
			description: "List all reminders (both fired and unfired)",
			inputSchema: {
				showFired: z.boolean().default(false).describe("Include already-fired reminders"),
			},
		},
		async ({ showFired }) => {
			const reminders = loadReminders();
			const filtered = showFired ? reminders : reminders.filter((r) => !r.fired);
			if (filtered.length === 0) return textResponse("No active reminders.");
			const lines = filtered.map((r) => {
				const s = r.fired ? "✓" : "○";
				return r.type === "time"
					? `${s} [${r.id}] ${r.text} — ${r.fireAt}`
					: `${s} [${r.id}] ${r.text} — at ${r.location}`;
			});
			return textResponse(lines.join("\n"));
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
				if (ids.includes(r.id) && !r.fired) {
					r.fired = true;
					count++;
				}
			}
			saveReminders(reminders);
			return textResponse(`Marked ${count} reminder(s) as fired`);
		}
	);
}
