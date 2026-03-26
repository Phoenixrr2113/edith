/**
 * Scheduler — reads tasks from ~/.edith/schedule.json and fires them via dispatch.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { SCHEDULE_FILE, SCHEDULE_STATE_FILE, logEvent } from "./state";
import { dispatchToClaude } from "./dispatch";
import { buildBrief, type BriefType } from "./briefs";
import type { ScheduleEntry } from "../mcp/types";

interface ScheduleState {
  lastFired: Record<string, string>;
}

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 },
  { name: "midday-check", prompt: "/midday-check", hour: 12, minute: 7 },
  { name: "evening-wrap", prompt: "/evening-wrap", hour: 16, minute: 53 },
  { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 },
  { name: "proactive-check", prompt: "/proactive-check", intervalMinutes: 3 },
];

/** Map task names to brief types for known tasks. */
const BRIEF_TYPE_MAP: Record<string, BriefType> = {
  "morning-brief": "morning",
  "midday-check": "midday",
  "evening-wrap": "evening",
  "proactive-check": "proactive",
};

function loadSchedule(): ScheduleEntry[] {
  if (!existsSync(SCHEDULE_FILE)) {
    writeFileSync(SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULE, null, 2), "utf-8");
    console.log("[edith] Seeded default schedule to", SCHEDULE_FILE);
    return DEFAULT_SCHEDULE;
  }
  try {
    const schedule: ScheduleEntry[] = JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8"));
    // Ensure new default tasks get added to existing schedules
    let updated = false;
    for (const def of DEFAULT_SCHEDULE) {
      if (!schedule.some((s) => s.name === def.name)) {
        schedule.push(def);
        updated = true;
        console.log(`[edith] Added missing default task: ${def.name}`);
      }
    }
    if (updated) writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), "utf-8");
    return schedule;
  } catch { return []; }
}

function loadScheduleState(): ScheduleState {
  if (!existsSync(SCHEDULE_STATE_FILE)) return { lastFired: {} };
  try { return JSON.parse(readFileSync(SCHEDULE_STATE_FILE, "utf-8")); } catch { return { lastFired: {} }; }
}

function saveScheduleState(state: ScheduleState): void {
  writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function shouldFire(entry: ScheduleEntry, now: Date, state: ScheduleState): boolean {
  const lastFired = state.lastFired[entry.name];
  const lastFiredTime = lastFired ? new Date(lastFired).getTime() : 0;

  if (entry.intervalMinutes) {
    return (now.getTime() - lastFiredTime) >= entry.intervalMinutes * 60 * 1000;
  }

  // Window-based: fire if we're at or past the target time today and haven't fired today
  const targetHour = entry.hour ?? -1;
  const targetMinute = entry.minute ?? 0;
  if (targetHour < 0) return false;

  const h = now.getHours();
  const m = now.getMinutes();
  const nowMinutes = h * 60 + m;
  const targetMinutes = targetHour * 60 + targetMinute;

  // Must be at or past target time, within a 30-minute window
  if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 30) return false;

  // Check if already fired today
  if (lastFiredTime > 0) {
    const lastDate = new Date(lastFiredTime);
    if (lastDate.getFullYear() === now.getFullYear() && lastDate.getMonth() === now.getMonth() &&
        lastDate.getDate() === now.getDate()) {
      return false;
    }
  }
  return true;
}

export async function runScheduler(): Promise<void> {
  const now = new Date();
  const schedule = loadSchedule();
  const state = loadScheduleState();

  for (const entry of schedule) {
    if (!shouldFire(entry, now, state)) continue;

    console.log(`[edith:scheduler] Firing ${entry.name}`);
    logEvent("schedule_fire", { task: entry.name, prompt: entry.prompt });

    // Use brief types for known tasks, generic scheduled brief for custom ones
    const briefType = BRIEF_TYPE_MAP[entry.name];
    let prompt: string;

    if (briefType) {
      prompt = await buildBrief(briefType);
    } else {
      prompt = await buildBrief("scheduled", { prompt: entry.prompt, taskName: entry.name });
    }

    const result = await dispatchToClaude(prompt, {
      resume: false,
      label: entry.name,
      skipIfBusy: true,
      briefType: briefType ?? "scheduled",
    });

    // Save state after dispatch so failed/skipped tasks can retry next tick
    if (result) {
      state.lastFired[entry.name] = now.toISOString();
      saveScheduleState(state);
    }
  }
}
