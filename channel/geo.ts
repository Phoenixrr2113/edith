/**
 * Geofence utilities — haversine distance, reminder checking, location transitions.
 * Ported from Edith v1 src/lib/geo.ts.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const REMINDERS_PATH = join(ROOT, "reminders.json");
const LOCATIONS_PATH = join(ROOT, "locations.json");

export interface LocationEntry {
  name: string;
  label: string;
  lat: number;
  lon: number;
  radiusMeters: number;
}

export interface Reminder {
  id: string;
  text: string;
  type: "location" | "time";
  location?: string;
  radiusMeters?: number;
  fireAt?: string;
  fired: boolean;
  created: string;
}

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

function loadLocations(): LocationEntry[] {
  if (!existsSync(LOCATIONS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LOCATIONS_PATH, "utf-8")).locations ?? [];
  } catch {
    return [];
  }
}

function loadReminders(): Reminder[] {
  if (!existsSync(REMINDERS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REMINDERS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveReminders(reminders: Reminder[]): void {
  writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2), "utf-8");
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

// --- Location transition detection (stateful) ---
let currentLocationName: string | null = null;
let initialized = false;

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
