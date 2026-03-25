/**
 * Scheduler — reads tasks from ~/.edith/schedule.json and fires them via dispatch.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { SCHEDULE_FILE, SCHEDULE_STATE_FILE, TASKBOARD_FILE, CHAT_ID, logEvent, loadPrompt } from "./state";
import { dispatchToClaude } from "./dispatch";

interface ScheduleEntry {
  name: string;
  prompt: string;
  hour?: number;
  minute?: number;
  intervalMinutes?: number;
}

interface ScheduleState {
  lastFired: Record<string, string>;
}

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 },
  { name: "midday-check", prompt: "/midday-check", hour: 12, minute: 7 },
  { name: "evening-wrap", prompt: "/evening-wrap", hour: 16, minute: 53 },
  { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 },
];

function loadSchedule(): ScheduleEntry[] {
  if (!existsSync(SCHEDULE_FILE)) {
    writeFileSync(SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULE, null, 2), "utf-8");
    console.log("[edith] Seeded default schedule to", SCHEDULE_FILE);
    return DEFAULT_SCHEDULE;
  }
  try { return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8")); } catch { return []; }
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

  const h = now.getHours();
  const m = now.getMinutes();
  if (h !== (entry.hour ?? -1) || m !== (entry.minute ?? -1)) return false;

  if (lastFiredTime > 0) {
    const lastDate = new Date(lastFiredTime);
    if (lastDate.getFullYear() === now.getFullYear() && lastDate.getMonth() === now.getMonth() &&
        lastDate.getDate() === now.getDate() && lastDate.getHours() === h && lastDate.getMinutes() === m) {
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
    state.lastFired[entry.name] = now.toISOString();
    saveScheduleState(state);

    const prompt = loadPrompt("scheduled-task", {
      prompt: entry.prompt,
      time: now.toLocaleString(),
      taskboardPath: TASKBOARD_FILE,
      timestamp: now.toISOString(),
      taskName: entry.name,
      chatId: CHAT_ID,
    });

    await dispatchToClaude(prompt, { resume: false, label: entry.name, skipIfBusy: true });
  }
}
