/**
 * Shared JSON file load/save — used by MCP server and geo.ts.
 * Eliminates duplicate load/save functions across modules.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { SCHEDULE_FILE, LOCATIONS_FILE, REMINDERS_FILE } from "./config";
import type { ScheduleEntry, LocationEntry, Reminder } from "../mcp/types";

// --- Generic helpers ---

export function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

export function saveJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// --- Typed wrappers ---

export function loadSchedule(): ScheduleEntry[] {
  return loadJson<ScheduleEntry[]>(SCHEDULE_FILE, []);
}

export function saveSchedule(entries: ScheduleEntry[]): void {
  saveJson(SCHEDULE_FILE, entries);
}

export function loadLocations(): LocationEntry[] {
  const raw = loadJson<any>(LOCATIONS_FILE, { locations: [] });
  return raw.locations ?? raw ?? [];
}

export function saveLocations(locations: LocationEntry[]): void {
  saveJson(LOCATIONS_FILE, { locations });
}

export function loadReminders(): Reminder[] {
  return loadJson<Reminder[]>(REMINDERS_FILE, []);
}

export function saveReminders(reminders: Reminder[]): void {
  saveJson(REMINDERS_FILE, reminders);
}
