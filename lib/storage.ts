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

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  // Weekday work briefs (Mon-Fri)
  { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3, daysOfWeek: [1, 2, 3, 4, 5] },
  { name: "midday-check", prompt: "/midday-check", hour: 12, minute: 7, daysOfWeek: [1, 2, 3, 4, 5] },
  { name: "evening-wrap", prompt: "/evening-wrap", hour: 16, minute: 53, daysOfWeek: [1, 2, 3, 4, 5] },
  // Weekend brief (Sat-Sun)
  { name: "weekend-brief", prompt: "/weekend-brief", hour: 9, minute: 3, daysOfWeek: [0, 6] },
  // Always-on (every day)
  { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5, quietStart: 22, quietEnd: 7 },
  { name: "proactive-check", prompt: "/proactive-check", intervalMinutes: 10, quietStart: 21, quietEnd: 7 },
  // Weekly review (Sunday evening)
  { name: "weekly-review", prompt: "/weekly-review", hour: 17, minute: 0, daysOfWeek: [0] },
  // Monthly review (1st of each month)
  { name: "monthly-review", prompt: "/monthly-review", hour: 9, minute: 30, dayOfMonth: 1 },
  // Quarterly review (1st of Jan, Apr, Jul, Oct)
  { name: "quarterly-review", prompt: "/quarterly-review", hour: 10, minute: 0, dayOfMonth: 1, months: [1, 4, 7, 10] },
];

export function loadSchedule(): ScheduleEntry[] {
  const schedule = loadJson<ScheduleEntry[]>(SCHEDULE_FILE, []);
  if (schedule.length === 0) {
    saveSchedule(DEFAULT_SCHEDULE);
    console.log("[storage] Seeded default schedule to", SCHEDULE_FILE);
    return [...DEFAULT_SCHEDULE];
  }
  // Ensure new default tasks get added to existing schedules
  let updated = false;
  for (const def of DEFAULT_SCHEDULE) {
    if (!schedule.some((s) => s.name === def.name)) {
      schedule.push(def);
      updated = true;
      console.log(`[storage] Added missing default task: ${def.name}`);
    }
  }
  if (updated) saveSchedule(schedule);
  return schedule;
}

export function saveSchedule(entries: ScheduleEntry[]): void {
  saveJson(SCHEDULE_FILE, entries);
}

export function loadLocations(): LocationEntry[] {
  const raw = loadJson<{ locations?: LocationEntry[] } | LocationEntry[]>(LOCATIONS_FILE, { locations: [] });
  return (raw as { locations?: LocationEntry[] }).locations ?? (raw as LocationEntry[]) ?? [];
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
