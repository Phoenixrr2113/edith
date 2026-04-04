/**
 * Shared load/save for schedule, locations, and reminders.
 * Database is the sole store (SQLite local, Postgres cloud).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { openDatabase, upsertSql } from "./db";
import { edithLog } from "./edith-logger";
import type { LocationEntry, Reminder, ScheduleEntry } from "./mcp-types";

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
	{ name: "weekend-brief", prompt: "/weekend-brief", hour: 9, minute: 3, daysOfWeek: [0, 6] },
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
		intervalMinutes: 5,
		quietStart: 21,
		quietEnd: 7,
	},
	{ name: "weekly-review", prompt: "/weekly-review", hour: 17, minute: 0, daysOfWeek: [0] },
	{ name: "monthly-review", prompt: "/monthly-review", hour: 9, minute: 30, dayOfMonth: 1 },
	{
		name: "quarterly-review",
		prompt: "/quarterly-review",
		hour: 10,
		minute: 0,
		dayOfMonth: 1,
		months: [1, 4, 7, 10],
	},
];

// --- Schedule ---

export function loadSchedule(): ScheduleEntry[] {
	const db = openDatabase();
	const rows = db.all<{ name: string; data: string }>("SELECT name, data FROM schedule");
	const schedule: ScheduleEntry[] = rows.map((r) => JSON.parse(r.data) as ScheduleEntry);

	if (schedule.length === 0) {
		saveSchedule(DEFAULT_SCHEDULE);
		edithLog.info("storage_seeded_default_schedule", {});
		return [...DEFAULT_SCHEDULE];
	}

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
	const sql = upsertSql("schedule", "name", ["name", "data"]);
	const existingNames = new Set(
		db.all<{ name: string }>("SELECT name FROM schedule").map((r) => r.name)
	);
	const newNames = new Set(entries.map((e) => e.name));

	db.transaction(() => {
		for (const name of existingNames) {
			if (!newNames.has(name)) db.run("DELETE FROM schedule WHERE name = ?", [name]);
		}
		for (const entry of entries) {
			db.run(sql, [entry.name, JSON.stringify(entry)]);
		}
	});
}

// --- Locations ---

export function loadLocations(): LocationEntry[] {
	const db = openDatabase();
	return db
		.all<{ name: string; label: string; lat: number; lon: number; radius_meters: number }>(
			"SELECT name, label, lat, lon, radius_meters FROM locations"
		)
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
	const sql = upsertSql("locations", "name", ["name", "label", "lat", "lon", "radius_meters"]);
	const existingNames = new Set(
		db.all<{ name: string }>("SELECT name FROM locations").map((r) => r.name)
	);
	const newNames = new Set(locations.map((l) => l.name));

	db.transaction(() => {
		for (const name of existingNames) {
			if (!newNames.has(name)) db.run("DELETE FROM locations WHERE name = ?", [name]);
		}
		for (const loc of locations) {
			db.run(sql, [loc.name, loc.label, loc.lat, loc.lon, loc.radiusMeters ?? 500]);
		}
	});
}

// --- Reminders ---

/** Quick check: are there any unfired time-based reminders due now or in the past? */
export function hasDueReminders(): boolean {
	const db = openDatabase();
	const now = new Date().toISOString();
	const row = db.get<{ count: number }>(
		"SELECT COUNT(*) as count FROM reminders WHERE type = 'time' AND fired = 0 AND fire_at <= ?",
		[now]
	);
	return (row?.count ?? 0) > 0;
}

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
		.all<ReminderRow>(
			"SELECT id, text, type, location, radius_meters, fire_at, fired, created FROM reminders"
		)
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

// --- Edith Tasks (self-scheduling task queue) ---

export interface EdithTask {
	id: string;
	text: string;
	prompt?: string;
	status: "pending" | "in_progress" | "done" | "failed";
	dueAt?: string;
	createdBy?: string;
	context?: string;
	createdAt: string;
	updatedAt: string;
}

export function createEdithTask(
	task: Omit<EdithTask, "id" | "createdAt" | "updatedAt" | "status">
): EdithTask {
	const db = openDatabase();
	const now = new Date().toISOString();
	const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const full: EdithTask = { ...task, id, status: "pending", createdAt: now, updatedAt: now };
	db.run(
		"INSERT INTO edith_tasks (id, text, prompt, status, due_at, created_by, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			full.id,
			full.text,
			full.prompt ?? null,
			full.status,
			full.dueAt ?? null,
			full.createdBy ?? null,
			full.context ?? null,
			full.createdAt,
			full.updatedAt,
		]
	);
	return full;
}

export function listEdithTasks(status?: string): EdithTask[] {
	const db = openDatabase();
	type Row = {
		id: string;
		text: string;
		prompt: string | null;
		status: string;
		due_at: string | null;
		created_by: string | null;
		context: string | null;
		created_at: string;
		updated_at: string;
	};
	const sql = status
		? "SELECT * FROM edith_tasks WHERE status = ? ORDER BY due_at ASC, created_at ASC"
		: "SELECT * FROM edith_tasks WHERE status != 'done' ORDER BY due_at ASC, created_at ASC";
	const params = status ? [status] : [];
	return db.all<Row>(sql, params).map((r) => ({
		id: r.id,
		text: r.text,
		prompt: r.prompt ?? undefined,
		status: r.status as EdithTask["status"],
		dueAt: r.due_at ?? undefined,
		createdBy: r.created_by ?? undefined,
		context: r.context ?? undefined,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}

export function updateEdithTask(
	id: string,
	updates: Partial<Pick<EdithTask, "status" | "text" | "prompt" | "context">>
): void {
	const db = openDatabase();
	const now = new Date().toISOString();
	const sets: string[] = ["updated_at = ?"];
	const params: unknown[] = [now];
	if (updates.status !== undefined) {
		sets.push("status = ?");
		params.push(updates.status);
	}
	if (updates.text !== undefined) {
		sets.push("text = ?");
		params.push(updates.text);
	}
	if (updates.prompt !== undefined) {
		sets.push("prompt = ?");
		params.push(updates.prompt);
	}
	if (updates.context !== undefined) {
		sets.push("context = ?");
		params.push(updates.context);
	}
	params.push(id);
	db.run(`UPDATE edith_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** Get the next pending task that's due (or has no due date). */
export function getNextPendingTask(): EdithTask | null {
	const db = openDatabase();
	const now = new Date().toISOString();
	type Row = {
		id: string;
		text: string;
		prompt: string | null;
		status: string;
		due_at: string | null;
		created_by: string | null;
		context: string | null;
		created_at: string;
		updated_at: string;
	};
	const row = db.get<Row>(
		"SELECT * FROM edith_tasks WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?) ORDER BY due_at ASC, created_at ASC LIMIT 1",
		[now]
	);
	if (!row) return null;
	return {
		id: row.id,
		text: row.text,
		prompt: row.prompt ?? undefined,
		status: row.status as EdithTask["status"],
		dueAt: row.due_at ?? undefined,
		createdBy: row.created_by ?? undefined,
		context: row.context ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Check if there are any pending tasks due now. */
export function hasPendingTasks(): boolean {
	const db = openDatabase();
	const now = new Date().toISOString();
	const row = db.get<{ count: number }>(
		"SELECT COUNT(*) as count FROM edith_tasks WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?)",
		[now]
	);
	return (row?.count ?? 0) > 0;
}

export function saveReminders(reminders: Reminder[]): void {
	const db = openDatabase();
	const sql = upsertSql("reminders", "id", [
		"id",
		"text",
		"type",
		"location",
		"radius_meters",
		"fire_at",
		"fired",
		"created",
	]);
	const existingIds = new Set(db.all<{ id: string }>("SELECT id FROM reminders").map((r) => r.id));
	const newIds = new Set(reminders.map((r) => r.id));

	db.transaction(() => {
		for (const id of existingIds) {
			if (!newIds.has(id)) db.run("DELETE FROM reminders WHERE id = ?", [id]);
		}
		for (const r of reminders) {
			db.run(sql, [
				r.id,
				r.text,
				r.type,
				r.location ?? null,
				r.radiusMeters ?? null,
				r.fireAt ?? null,
				r.fired ? 1 : 0,
				r.created,
			]);
		}
	});
}
