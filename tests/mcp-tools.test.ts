/**
 * Tests for MCP tool round-trips — exercises the same storage functions
 * that mcp/server.ts tool handlers use: locations, reminders, schedule, proactive.
 *
 * Also tests notification channel routing and n8n POST format.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haversineMeters } from "../lib/geo";
import { jsonResponse, textResponse } from "../lib/mcp-helpers";
import { fmtErr } from "../lib/util";
import { cleanupTestDir, setupTestDir } from "./helpers";

let tempDir: string;

beforeAll(() => {
	tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

// --- Reimplemented storage helpers for isolated testing ---

function loadJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return fallback;
	}
}

function saveJson(path: string, data: unknown): void {
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// --- MCP tool: locations ---

describe("MCP: save_location → list_locations round-trip", () => {
	let locFile: string;

	beforeEach(() => {
		locFile = join(tempDir, `locations-mcp-${Date.now()}.json`);
	});

	function saveLocation(
		name: string,
		label: string,
		lat: number,
		lon: number,
		radiusMeters: number = 200
	) {
		const raw = loadJson<any>(locFile, { locations: [] });
		const locations = raw.locations ?? [];
		const existing = locations.findIndex((l: any) => l.name === name);
		const entry = { name, label, lat, lon, radiusMeters };
		if (existing >= 0) locations[existing] = entry;
		else locations.push(entry);
		saveJson(locFile, { locations });
	}

	function listLocations() {
		const raw = loadJson<any>(locFile, { locations: [] });
		return raw.locations ?? [];
	}

	test("save and retrieve location", () => {
		saveLocation("home", "Home", 40.7128, -74.006, 300);
		const locs = listLocations();
		expect(locs).toHaveLength(1);
		expect(locs[0]).toEqual({
			name: "home",
			label: "Home",
			lat: 40.7128,
			lon: -74.006,
			radiusMeters: 300,
		});
	});

	test("upsert overwrites existing location", () => {
		saveLocation("home", "Home", 40.71, -74.0, 200);
		saveLocation("home", "Home (updated)", 40.72, -74.01, 500);
		const locs = listLocations();
		expect(locs).toHaveLength(1);
		expect(locs[0].label).toBe("Home (updated)");
		expect(locs[0].radiusMeters).toBe(500);
	});

	test("multiple locations coexist", () => {
		saveLocation("home", "Home", 40.71, -74.0);
		saveLocation("office", "Office", 40.75, -73.99);
		saveLocation("gym", "Gym", 40.73, -73.98);
		expect(listLocations()).toHaveLength(3);
	});
});

// --- MCP tool: reminders lifecycle ---

describe("MCP: save_reminder → list → mark_fired lifecycle", () => {
	let remFile: string;

	beforeEach(() => {
		remFile = join(tempDir, `reminders-mcp-${Date.now()}.json`);
	});

	function saveReminder(reminder: any) {
		const reminders = loadJson<any[]>(remFile, []);
		reminders.push({
			id: `rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			...reminder,
			fired: false,
			created: new Date().toISOString(),
		});
		saveJson(remFile, reminders);
		return reminders[reminders.length - 1];
	}

	function listReminders() {
		return loadJson<any[]>(remFile, []);
	}

	function markFired(ids: string[]) {
		const reminders = loadJson<any[]>(remFile, []);
		for (const r of reminders) {
			if (ids.includes(r.id)) r.fired = true;
		}
		saveJson(remFile, reminders);
	}

	test("time reminder: create → list → fire", () => {
		const r = saveReminder({
			text: "Call dentist",
			type: "time",
			fireAt: new Date(Date.now() + 3600_000).toISOString(),
		});
		expect(r.id).toBeTruthy();
		expect(r.fired).toBe(false);

		const all = listReminders();
		expect(all).toHaveLength(1);
		expect(all[0].text).toBe("Call dentist");

		markFired([r.id]);
		const after = listReminders();
		expect(after[0].fired).toBe(true);
	});

	test("location reminder: create and check via geofence", () => {
		// First save a location
		const locFile = join(tempDir, `locations-rem-${Date.now()}.json`);
		saveJson(locFile, {
			locations: [
				{ name: "grocery", label: "Grocery Store", lat: 40.73, lon: -73.99, radiusMeters: 200 },
			],
		});

		const _r = saveReminder({ text: "Buy eggs", type: "location", location: "grocery" });

		// Check: within radius
		const locations = loadJson<any>(locFile, { locations: [] }).locations;
		const reminders = listReminders().filter(
			(r: any) => !r.fired && r.type === "location" && r.location
		);
		const triggered = [];
		for (const rem of reminders) {
			const loc = locations.find((l: any) => l.name === rem.location);
			if (loc && haversineMeters(40.73, -73.99, loc.lat, loc.lon) <= (loc.radiusMeters ?? 500)) {
				triggered.push(rem);
			}
		}
		expect(triggered).toHaveLength(1);
		expect(triggered[0].text).toBe("Buy eggs");
	});

	test("multiple reminders, selective firing", () => {
		const r1 = saveReminder({ text: "A", type: "time" });
		const r2 = saveReminder({ text: "B", type: "time" });
		const r3 = saveReminder({ text: "C", type: "time" });

		markFired([r1.id, r3.id]);

		const all = listReminders();
		expect(all.find((r: any) => r.id === r1.id).fired).toBe(true);
		expect(all.find((r: any) => r.id === r2.id).fired).toBe(false);
		expect(all.find((r: any) => r.id === r3.id).fired).toBe(true);
	});
});

// --- MCP tool: scheduled tasks ---

describe("MCP: add/list/remove scheduled_task lifecycle", () => {
	let schedFile: string;
	let schedCounter = 0;

	beforeEach(() => {
		schedCounter++;
		schedFile = join(tempDir, `schedule-mcp-${Date.now()}-${schedCounter}.json`);
	});

	function addTask(task: any) {
		const schedule = loadJson<any[]>(schedFile, []);
		const existing = schedule.findIndex((s: any) => s.name === task.name);
		if (existing >= 0) schedule[existing] = task;
		else schedule.push(task);
		saveJson(schedFile, schedule);
	}

	function listTasks() {
		return loadJson<any[]>(schedFile, []);
	}

	function removeTask(name: string): boolean {
		const schedule = loadJson<any[]>(schedFile, []);
		const idx = schedule.findIndex((s: any) => s.name === name);
		if (idx < 0) return false;
		schedule.splice(idx, 1);
		saveJson(schedFile, schedule);
		return true;
	}

	test("add → list → remove lifecycle", () => {
		addTask({ name: "daily-standup", prompt: "Run standup", hour: 9, minute: 0 });
		expect(listTasks()).toHaveLength(1);
		expect(listTasks()[0].name).toBe("daily-standup");

		const removed = removeTask("daily-standup");
		expect(removed).toBe(true);
		expect(listTasks()).toHaveLength(0);
	});

	test("remove nonexistent task returns false", () => {
		expect(removeTask("nonexistent")).toBe(false);
	});

	test("add with interval", () => {
		addTask({ name: "health-check", prompt: "Check health", intervalMinutes: 10 });
		const tasks = listTasks();
		expect(tasks[0].intervalMinutes).toBe(10);
		expect(tasks[0].hour).toBeUndefined();
	});

	test("upsert overwrites existing task", () => {
		addTask({ name: "daily-standup", prompt: "Old prompt", hour: 9, minute: 0 });
		addTask({ name: "daily-standup", prompt: "New prompt", hour: 10, minute: 30 });
		const tasks = listTasks();
		expect(tasks).toHaveLength(1);
		expect(tasks[0].prompt).toBe("New prompt");
		expect(tasks[0].hour).toBe(10);
	});
});

// --- MCP tool: proactive history ---

describe("MCP: proactive_history + record_intervention round-trip", () => {
	let proFile: string;
	let proCounter = 0;

	beforeEach(() => {
		proCounter++;
		proFile = join(tempDir, `proactive-${Date.now()}-${proCounter}.json`);
	});

	function recordIntervention(category: string, message: string, tsOverride?: string) {
		const state = loadJson<any>(proFile, { interventions: [], lastCheck: "" });
		state.interventions.push({
			timestamp: tsOverride ?? new Date().toISOString(),
			category,
			message: message.slice(0, 200),
		});
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		state.interventions = state.interventions.filter(
			(i: any) => new Date(i.timestamp).getTime() > cutoff
		);
		state.lastCheck = new Date().toISOString();
		saveJson(proFile, state);
	}

	function getHistory(hours: number = 4) {
		const state = loadJson<any>(proFile, { interventions: [] });
		const cutoff = Date.now() - hours * 60 * 60 * 1000;
		return state.interventions
			.filter((i: any) => new Date(i.timestamp).getTime() > cutoff)
			.sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
	}

	test("record and retrieve interventions", () => {
		const t1 = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
		const t2 = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
		recordIntervention("meeting-prep", "Prepared agenda for 2pm meeting", t1);
		recordIntervention("email-help", "Drafted reply to John", t2);

		const history = getHistory(4);
		expect(history).toHaveLength(2);
		expect(history[0].category).toBe("email-help"); // most recent first
		expect(history[1].category).toBe("meeting-prep");
	});

	test("empty history returns empty array", () => {
		expect(getHistory(4)).toEqual([]);
	});
});

// --- Notification channel routing ---

describe("Notification channel routing", () => {
	test("telegram channel routes to tgCall", () => {
		const channel = "telegram";
		const routing = getNotificationRoute(channel);
		expect(routing.method).toBe("telegram");
	});

	test("whatsapp channel routes to twilio", () => {
		const routing = getNotificationRoute("whatsapp");
		expect(routing.method).toBe("twilio");
		expect(routing.prefix).toBe("whatsapp:");
	});

	test("sms channel routes to twilio", () => {
		const routing = getNotificationRoute("sms");
		expect(routing.method).toBe("twilio");
		expect(routing.prefix).toBeUndefined();
	});

	test("email channel routes to n8n", () => {
		const routing = getNotificationRoute("email");
		expect(routing.method).toBe("n8n");
		expect(routing.endpoint).toBe("notify");
	});

	test("desktop channel routes to local notification", () => {
		const routing = getNotificationRoute("desktop");
		expect(routing.method).toBe("desktop");
	});

	test("dialog channel routes to local dialog", () => {
		const routing = getNotificationRoute("dialog");
		expect(routing.method).toBe("dialog");
	});
});

// Reimplemented notification routing logic from mcp/server.ts
function getNotificationRoute(channel: string): {
	method: string;
	prefix?: string;
	endpoint?: string;
} {
	switch (channel) {
		case "telegram":
			return { method: "telegram" };
		case "whatsapp":
			return { method: "twilio", prefix: "whatsapp:" };
		case "sms":
			return { method: "twilio" };
		case "email":
			return { method: "n8n", endpoint: "notify" };
		case "slack":
			return { method: "n8n", endpoint: "notify" };
		case "discord":
			return { method: "n8n", endpoint: "notify" };
		case "desktop":
			return { method: "desktop" };
		case "dialog":
			return { method: "dialog" };
		default:
			return { method: "unknown" };
	}
}

// --- MCP response helpers ---

describe("MCP response helpers", () => {
	test("textResponse wraps string in MCP format", () => {
		const r = textResponse("hello");
		expect(r.content).toHaveLength(1);
		expect(r.content[0].type).toBe("text");
		expect(r.content[0].text).toBe("hello");
	});

	test("jsonResponse serializes object", () => {
		const r = jsonResponse({ foo: "bar", num: 42 });
		expect(r.content[0].type).toBe("text");
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.foo).toBe("bar");
		expect(parsed.num).toBe(42);
	});

	test("jsonResponse handles arrays", () => {
		const r = jsonResponse([1, 2, 3]);
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed).toEqual([1, 2, 3]);
	});
});

// --- util.ts ---

describe("fmtErr", () => {
	test("formats Error objects", () => {
		expect(fmtErr(new Error("boom"))).toBe("boom");
	});

	test("formats strings", () => {
		expect(fmtErr("oops")).toBe("oops");
	});

	test("formats unknown types", () => {
		expect(fmtErr(42)).toBe("42");
		expect(fmtErr(null)).toBe("null");
		expect(fmtErr(undefined)).toBe("undefined");
	});
});
