/**
 * Scheduler — reads tasks from ~/.edith/schedule.json and fires them via dispatch.
 */
import { SCHEDULE_STATE_FILE, logEvent } from "./state";
import { loadJson, saveJson, loadSchedule } from "./storage";
import { dispatchToClaude } from "./dispatch";
import { buildBrief, BRIEF_TYPE_MAP } from "./briefs";

interface ScheduleState {
  lastFired: Record<string, string>;
}

function loadScheduleState(): ScheduleState {
  return loadJson<ScheduleState>(SCHEDULE_STATE_FILE, { lastFired: {} });
}

function saveScheduleState(state: ScheduleState): void {
  saveJson(SCHEDULE_STATE_FILE, state);
}

function shouldFire(entry: { name: string; hour?: number; minute?: number; intervalMinutes?: number }, now: Date, state: ScheduleState): boolean {
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
