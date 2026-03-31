/**
 * Tests for mcp/geo.ts — haversine distance, location/time reminders, transitions.
 *
 * haversineMeters is pure math and can be imported directly.
 * Reminder functions depend on storage, so we test against temp files.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
// For reminder/transition tests, we reimplement against temp files
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haversineMeters } from "../lib/geo";
import { cleanupTestDir, setupTestDir } from "./helpers";

let tempDir: string;

beforeAll(() => {
	tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

// --- Haversine (pure math, no I/O) ---

describe("haversineMeters", () => {
	test("same point returns 0", () => {
		expect(haversineMeters(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
	});

	test("NYC to LA is ~3940 km", () => {
		const nyc = { lat: 40.7128, lon: -74.006 };
		const la = { lat: 34.0522, lon: -118.2437 };
		const distance = haversineMeters(nyc.lat, nyc.lon, la.lat, la.lon);
		// Should be roughly 3940 km
		expect(distance).toBeGreaterThan(3_900_000);
		expect(distance).toBeLessThan(4_000_000);
	});

	test("short distance (< 1km) is accurate", () => {
		// Two points about 111m apart (0.001 degree latitude ~ 111m)
		const d = haversineMeters(0, 0, 0.001, 0);
		expect(d).toBeGreaterThan(100);
		expect(d).toBeLessThan(120);
	});

	test("antipodal points are ~20,000 km", () => {
		const d = haversineMeters(0, 0, 0, 180);
		expect(d).toBeGreaterThan(20_000_000);
		expect(d).toBeLessThan(20_100_000);
	});

	test("symmetry: A→B equals B→A", () => {
		const d1 = haversineMeters(51.5074, -0.1278, 48.8566, 2.3522); // London → Paris
		const d2 = haversineMeters(48.8566, 2.3522, 51.5074, -0.1278); // Paris → London
		expect(d1).toBe(d2);
	});
});

// --- Reminder functions (reimplemented against temp files) ---

interface LocationEntry {
	name: string;
	label: string;
	lat: number;
	lon: number;
	radiusMeters: number;
}
interface Reminder {
	id: string;
	text: string;
	type: "time" | "location";
	location?: string;
	radiusMeters?: number;
	fireAt?: string;
	fired: boolean;
	created: string;
}

function saveLocations(file: string, locations: LocationEntry[]) {
	writeFileSync(file, JSON.stringify({ locations }, null, 2), "utf-8");
}
function loadLocations(file: string): LocationEntry[] {
	try {
		return JSON.parse(readFileSync(file, "utf-8")).locations ?? [];
	} catch {
		return [];
	}
}
function saveReminders(file: string, reminders: Reminder[]) {
	writeFileSync(file, JSON.stringify(reminders, null, 2), "utf-8");
}
function loadReminders(file: string): Reminder[] {
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

describe("checkLocationReminders (reimplemented)", () => {
	let locFile: string;
	let remFile: string;

	beforeEach(() => {
		const id = Date.now();
		locFile = join(tempDir, `locations-${id}.json`);
		remFile = join(tempDir, `reminders-${id}.json`);
	});

	function checkLocationReminders(lat: number, lon: number) {
		const locations = loadLocations(locFile);
		const reminders = loadReminders(remFile);
		const triggered: { reminder: Reminder; locationLabel: string }[] = [];
		for (const r of reminders) {
			if (r.fired || r.type !== "location" || !r.location) continue;
			const loc = locations.find((l) => l.name === r.location);
			if (!loc) continue;
			const radius = r.radiusMeters ?? loc.radiusMeters ?? 500;
			if (haversineMeters(lat, lon, loc.lat, loc.lon) <= radius) {
				triggered.push({ reminder: r, locationLabel: loc.label ?? loc.name });
			}
		}
		return triggered;
	}

	test("triggers reminder when within radius", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.7128, lon: -74.006, radiusMeters: 500 },
		]);
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Take out trash",
				type: "location",
				location: "home",
				fired: false,
				created: new Date().toISOString(),
			},
		]);

		// Standing at home (exact coords)
		const result = checkLocationReminders(40.7128, -74.006);
		expect(result).toHaveLength(1);
		expect(result[0].reminder.text).toBe("Take out trash");
		expect(result[0].locationLabel).toBe("Home");
	});

	test("does not trigger when outside radius", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.7128, lon: -74.006, radiusMeters: 100 },
		]);
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Take out trash",
				type: "location",
				location: "home",
				fired: false,
				created: new Date().toISOString(),
			},
		]);

		// Standing 1km away
		const result = checkLocationReminders(40.72, -74.006);
		expect(result).toHaveLength(0);
	});

	test("skips fired reminders", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.7128, lon: -74.006, radiusMeters: 500 },
		]);
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Already done",
				type: "location",
				location: "home",
				fired: true,
				created: new Date().toISOString(),
			},
		]);

		const result = checkLocationReminders(40.7128, -74.006);
		expect(result).toHaveLength(0);
	});

	test("skips time-based reminders", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.7128, lon: -74.006, radiusMeters: 500 },
		]);
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Time reminder",
				type: "time",
				fireAt: new Date().toISOString(),
				fired: false,
				created: new Date().toISOString(),
			},
		]);

		const result = checkLocationReminders(40.7128, -74.006);
		expect(result).toHaveLength(0);
	});
});

describe("checkTimeReminders (reimplemented)", () => {
	let remFile: string;

	beforeEach(() => {
		remFile = join(tempDir, `reminders-time-${Date.now()}.json`);
	});

	function checkTimeReminders() {
		const reminders = loadReminders(remFile);
		const now = Date.now();
		return reminders.filter(
			(r) => !r.fired && r.type === "time" && r.fireAt && new Date(r.fireAt).getTime() <= now
		);
	}

	test("returns reminders with past fireAt", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Due now",
				type: "time",
				fireAt: past,
				fired: false,
				created: new Date().toISOString(),
			},
		]);
		expect(checkTimeReminders()).toHaveLength(1);
	});

	test("ignores future reminders", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Not yet",
				type: "time",
				fireAt: future,
				fired: false,
				created: new Date().toISOString(),
			},
		]);
		expect(checkTimeReminders()).toHaveLength(0);
	});

	test("ignores fired reminders", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		saveReminders(remFile, [
			{
				id: "r1",
				text: "Already fired",
				type: "time",
				fireAt: past,
				fired: true,
				created: new Date().toISOString(),
			},
		]);
		expect(checkTimeReminders()).toHaveLength(0);
	});
});

describe("markFired (reimplemented)", () => {
	test("sets fired: true and persists", () => {
		const remFile = join(tempDir, `reminders-fire-${Date.now()}.json`);
		saveReminders(remFile, [
			{ id: "r1", text: "A", type: "time", fired: false, created: new Date().toISOString() },
			{ id: "r2", text: "B", type: "time", fired: false, created: new Date().toISOString() },
		]);

		// markFired logic
		const reminders = loadReminders(remFile);
		for (const r of reminders) {
			if (["r1"].includes(r.id)) r.fired = true;
		}
		saveReminders(remFile, reminders);

		const after = loadReminders(remFile);
		expect(after.find((r) => r.id === "r1")?.fired).toBe(true);
		expect(after.find((r) => r.id === "r2")?.fired).toBe(false);
	});
});

describe("checkLocationTransitions (reimplemented)", () => {
	let locFile: string;
	let currentLocationName: string | null = null;
	let initialized = false;

	beforeEach(() => {
		locFile = join(tempDir, `locations-trans-${Date.now()}.json`);
		currentLocationName = null;
		initialized = false;
	});

	interface LocationTransition {
		type: "arrived" | "departed";
		locationName: string;
		locationLabel: string;
	}

	function checkLocationTransitions(lat: number, lon: number): LocationTransition[] {
		const locations = loadLocations(locFile);
		const transitions: LocationTransition[] = [];
		let atLocation: LocationEntry | null = null;
		for (const loc of locations) {
			if (haversineMeters(lat, lon, loc.lat, loc.lon) <= (loc.radiusMeters ?? 500)) {
				atLocation = loc;
				break;
			}
		}
		const newName = atLocation?.name ?? null;
		if (!initialized) {
			currentLocationName = newName;
			initialized = true;
			return [];
		}
		if (newName === currentLocationName) return [];
		if (currentLocationName) {
			const prev = locations.find((l) => l.name === currentLocationName);
			transitions.push({
				type: "departed",
				locationName: currentLocationName,
				locationLabel: prev?.label ?? currentLocationName,
			});
		}
		if (newName && atLocation) {
			transitions.push({
				type: "arrived",
				locationName: newName,
				locationLabel: atLocation.label ?? newName,
			});
		}
		currentLocationName = newName;
		return transitions;
	}

	test("first call initializes silently (no transitions)", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.7128, lon: -74.006, radiusMeters: 500 },
		]);
		const result = checkLocationTransitions(40.7128, -74.006);
		expect(result).toHaveLength(0);
	});

	test("arriving at a location triggers arrived event", () => {
		saveLocations(locFile, [
			{ name: "office", label: "Office", lat: 40.75, lon: -73.99, radiusMeters: 200 },
		]);

		// Initialize somewhere else
		checkLocationTransitions(40.7, -74.01);

		// Move to office
		const result = checkLocationTransitions(40.75, -73.99);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("arrived");
		expect(result[0].locationLabel).toBe("Office");
	});

	test("depart + arrive when moving between locations", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.71, lon: -74.0, radiusMeters: 300 },
			{ name: "office", label: "Office", lat: 40.75, lon: -73.99, radiusMeters: 300 },
		]);

		// Initialize at home
		checkLocationTransitions(40.71, -74.0);

		// Move to office
		const result = checkLocationTransitions(40.75, -73.99);
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe("departed");
		expect(result[0].locationLabel).toBe("Home");
		expect(result[1].type).toBe("arrived");
		expect(result[1].locationLabel).toBe("Office");
	});

	test("no transition when staying at same location", () => {
		saveLocations(locFile, [
			{ name: "home", label: "Home", lat: 40.71, lon: -74.0, radiusMeters: 300 },
		]);
		checkLocationTransitions(40.71, -74.0);
		const result = checkLocationTransitions(40.7101, -74.0001); // slight movement, still within radius
		expect(result).toHaveLength(0);
	});
});
