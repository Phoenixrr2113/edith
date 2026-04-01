/**
 * Shared load/save for schedule, locations, and reminders.
 * SQLite is the sole store.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LocationEntry, Reminder, ScheduleEntry } from "../mcp/types";
import { openDatabase } from "./db";
import { edithLog } from "./edith-logger";

// --- Generic helpers ---

export function loadJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return fallback;
	}
}

export function saveJson(path: string, data: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmp, path);
}

// --- Typed wrappers ---

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
	// Weekday work briefs (Mon-Fri)
	{
		name: "morning-brief",
		prompt: "/morning-brief",
		hour: 8,
		minute: 3,
		daysOfWeek: [1, 2, 3, 4, 5],
	},
	{
		name: "midday-check",
		prompt: "/midday-check",
		hour: 12,
		minute: 7,
		daysOfWeek: [1, 2, 3, 4, 5],
	},
	{
		name: "evening-wrap",
		prompt: "/evening-wrap",
		hour: 16,
		minute: 53,
		daysOfWeek: [1, 2, 3, 4, 5],
	},
	// Weekend brief (Sat-Sun)
	{ name: "weekend-brief", prompt: "/weekend-brief", hour: 9, minute: 3, daysOfWeek: [0, 6] },
	// Always-on (every day)
	{
		name: "check-reminders",
		prompt: "/check-reminders",
		intervalMinutes: 5,
		quietStart: 22,
		quietEnd: 7,
	},
	{
		name: "proactive-check",
		prompt: "/proactive-check",
		intervalMinutes: 10,
		quietStart: 21,
		quietEnd: 7,
	},
	// Weekly review (Sunday evening)
	{ name: "weekly-review", prompt: "/weekly-review", hour: 17, minute: 0, daysOfWeek: [0] },
	// Monthly review (1st of each month)
	{ name: "monthly-review", prompt: "/monthly-review", hour: 9, minute: 30, dayOfMonth: 1 },
	// Quarterly review (1st of Jan, Apr, Jul, Oct)
	{
		name: "quarterly-review",
		prompt: "/quarterly-review",
		hour: 10,
		minute: 0,
		dayOfMonth: 1,
		months: [1, 4, 7, 10],
	},
];

// --- Schedule (SQLite primary) ---

export function loadSchedule(): ScheduleEntry[] {
	const db = openDatabase();
	const rows = db
		.query<{ name: string; data: string }, []>("SELECT name, data FROM schedule")
		.all();
	const schedule: ScheduleEntry[] = rows.map((r) => JSON.parse(r.data) as ScheduleEntry);

	if (schedule.length === 0) {
		saveSchedule(DEFAULT_SCHEDULE);
		edithLog.info("storage_seeded_default_schedule", {});
		return [...DEFAULT_SCHEDULE];
	}

	// Ensure new default tasks get added to existing schedules
	let updated = false;
	for (const def of DEFAULT_SCHEDULE) {
		if (!schedule.some((s) => s.name === def.name)) {
			schedule.push(def);
			updated = true;
			edithLog.info("storage_added_missing_task", { task: def.name });
		}
	}
	if (updated) saveSchedule(schedule);
	return schedule;
}

export function saveSchedule(entries: ScheduleEntry[]): void {
	const db = openDatabase();
	const upsert = db.prepare("INSERT OR REPLACE INTO schedule (name, data) VALUES (?, ?)");
	const del = db.prepare("DELETE FROM schedule WHERE name = ?");
	const existingNames = new Set(
		db
			.query<{ name: string }, []>("SELECT name FROM schedule")
			.all()
			.map((r) => r.name)
	);
	const newNames = new Set(entries.map((e) => e.name));

	db.transaction(() => {
		for (const name of existingNames) {
			if (!newNames.has(name)) del.run(name);
		}
		for (const entry of entries) {
			upsert.run(entry.name, JSON.stringify(entry));
		}
	})();
}

// --- Locations (SQLite primary) ---

export function loadLocations(): LocationEntry[] {
	const db = openDatabase();
	return db
		.query<{ name: string; label: string; lat: number; lon: number; radius_meters: number }, []>(
			"SELECT name, label, lat, lon, radius_meters FROM locations"
		)
		.all()
		.map((r) => ({
			name: r.name,
			label: r.label,
			lat: r.lat,
			lon: r.lon,
			radiusMeters: r.radius_meters,
		}));
}

export function saveLocations(locations: LocationEntry[]): void {
	const db = openDatabase();
	const upsert = db.prepare(
		"INSERT OR REPLACE INTO locations (name, label, lat, lon, radius_meters) VALUES (?, ?, ?, ?, ?)"
	);
	const del = db.prepare("DELETE FROM locations WHERE name = ?");
	const existingNames = new Set(
		db
			.query<{ name: string }, []>("SELECT name FROM locations")
			.all()
			.map((r) => r.name)
	);
	const newNames = new Set(locations.map((l) => l.name));

	db.transaction(() => {
		for (const name of existingNames) {
			if (!newNames.has(name)) del.run(name);
		}
		for (const loc of locations) {
			upsert.run(loc.name, loc.label, loc.lat, loc.lon, loc.radiusMeters ?? 500);
		}
	})();
}

// --- Reminders (SQLite primary) ---

export function loadReminders(): Reminder[] {
	const db = openDatabase();
	type ReminderRow = {
		id: string;
		text: string;
		type: string;
		location: string | null;
		radius_meters: number | null;
		fire_at: string | null;
		fired: number;
		created: string;
	};
	return db
		.query<ReminderRow, []>(
			"SELECT id, text, type, location, radius_meters, fire_at, fired, created FROM reminders"
		)
		.all()
		.map((r) => ({
			id: r.id,
			text: r.text,
			type: r.type as "time" | "location",
			location: r.location ?? undefined,
			radiusMeters: r.radius_meters ?? undefined,
			fireAt: r.fire_at ?? undefined,
			fired: r.fired === 1,
			created: r.created,
		}));
}

export function saveReminders(reminders: Reminder[]): void {
	const db = openDatabase();
	const upsert = db.prepare(`
      INSERT OR REPLACE INTO reminders (id, text, type, location, radius_meters, fire_at, fired, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
	const del = db.prepare("DELETE FROM reminders WHERE id = ?");
	const existingIds = new Set(
		db
			.query<{ id: string }, []>("SELECT id FROM reminders")
			.all()
			.map((r) => r.id)
	);
	const newIds = new Set(reminders.map((r) => r.id));

	db.transaction(() => {
		for (const id of existingIds) {
			if (!newIds.has(id)) del.run(id);
		}
		for (const r of reminders) {
			upsert.run(
				r.id,
				r.text,
				r.type,
				r.location ?? null,
				r.radiusMeters ?? null,
				r.fireAt ?? null,
				r.fired ? 1 : 0,
				r.created
			);
		}
	})();
}
