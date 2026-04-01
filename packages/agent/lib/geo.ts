/**
 * Geofence utilities — haversine distance, reminder checking, location transitions.
 */

import type { LocationEntry, Reminder } from "../mcp/types";
import { openDatabase, upsertSql } from "./db";
import { loadLocations, loadReminders, saveReminders } from "./storage";

export type { LocationEntry, Reminder };

export interface LocationTransition {
	type: "arrived" | "departed";
	locationName: string;
	locationLabel: string;
}

/** Haversine distance between two lat/lon points in meters. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Check unfired location reminders against current position. */
export function checkLocationReminders(
	lat: number,
	lon: number
): { reminder: Reminder; locationLabel: string }[] {
	const locations = loadLocations();
	const reminders = loadReminders();
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

/** Check unfired time-based reminders. */
export function checkTimeReminders(): Reminder[] {
	const reminders = loadReminders();
	const now = Date.now();
	return reminders.filter(
		(r) => !r.fired && r.type === "time" && r.fireAt && new Date(r.fireAt).getTime() <= now
	);
}

/** Mark reminders as fired. */
export function markFired(ids: string[]): void {
	const reminders = loadReminders();
	for (const r of reminders) {
		if (ids.includes(r.id)) r.fired = true;
	}
	saveReminders(reminders);
}

// --- Location transition detection (stateful, persisted to SQLite) ---

function _loadGeoState(): string | null {
	try {
		const db = openDatabase();
		const row = db.get<{ value: string | null }>("SELECT value FROM geo_state WHERE key = ?", [
			"current_location",
		]);
		return row?.value ?? null;
	} catch {
		return null;
	}
}

function _saveGeoState(name: string | null): void {
	try {
		const db = openDatabase();
		db.run(upsertSql("geo_state", "key", ["key", "value"]), ["current_location", name]);
	} catch {}
}

let currentLocationName: string | null = _loadGeoState();
let initialized = currentLocationName !== null; // if we have a persisted value, skip silent init

/** Detect arrive/depart events when Randy moves between named locations. */
export function checkLocationTransitions(lat: number, lon: number): LocationTransition[] {
	const locations = loadLocations();
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
		_saveGeoState(newName);
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
	_saveGeoState(newName);
	return transitions;
}
