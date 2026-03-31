/**
 * Scheduler — reads tasks from ~/.edith/schedule.json and fires them via dispatch.
 */

import { BRIEF_TYPE_MAP, buildBrief } from "./briefs";
import { dispatchToClaude } from "./dispatch";
import { isUserIdle } from "./screenpipe";
import { logEvent, SCHEDULE_STATE_FILE } from "./state";
import { loadJson, loadSchedule, saveJson } from "./storage";

export interface ScheduleState {
	lastFired: Record<string, string>;
}

function loadScheduleState(): ScheduleState {
	return loadJson<ScheduleState>(SCHEDULE_STATE_FILE, { lastFired: {} });
}

function saveScheduleState(state: ScheduleState): void {
	saveJson(SCHEDULE_STATE_FILE, state);
}

function isQuietHours(hour: number, quietStart?: number, quietEnd?: number): boolean {
	if (quietStart == null || quietEnd == null) return false;
	// Handles wrap past midnight: e.g., quietStart=21, quietEnd=7 means 9PM-7AM
	if (quietStart > quietEnd) {
		return hour >= quietStart || hour < quietEnd;
	}
	return hour >= quietStart && hour < quietEnd;
}

export function shouldFire(
	entry: {
		name: string;
		hour?: number;
		minute?: number;
		intervalMinutes?: number;
		quietStart?: number;
		quietEnd?: number;
		daysOfWeek?: number[];
		dayOfMonth?: number;
		months?: number[];
	},
	now: Date,
	state: ScheduleState
): boolean {
	const dow = now.getDay(); // 0=Sun, 6=Sat
	const dom = now.getDate();
	const month = now.getMonth() + 1; // 1-12

	// Day-of-week filter (applies to all task types)
	if (entry.daysOfWeek && !entry.daysOfWeek.includes(dow)) return false;

	// Month filter (for quarterly/annual tasks)
	if (entry.months && !entry.months.includes(month)) return false;

	// Day-of-month filter (for monthly/quarterly/annual tasks)
	if (entry.dayOfMonth && dom !== entry.dayOfMonth) return false;

	// Check quiet hours for interval tasks
	if (entry.intervalMinutes && isQuietHours(now.getHours(), entry.quietStart, entry.quietEnd)) {
		return false;
	}

	const lastFired = state.lastFired[entry.name];
	const lastFiredTime = lastFired ? new Date(lastFired).getTime() : 0;

	if (entry.intervalMinutes) {
		return now.getTime() - lastFiredTime >= entry.intervalMinutes * 60 * 1000;
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
		if (
			lastDate.getFullYear() === now.getFullYear() &&
			lastDate.getMonth() === now.getMonth() &&
			lastDate.getDate() === now.getDate()
		) {
			return false;
		}
	}
	return true;
}

export async function runScheduler(): Promise<void> {
	const now = new Date();
	const schedule = loadSchedule();
	const state = loadScheduleState();

	// Check idle once for all interval tasks this tick
	let userIdle: boolean | null = null;

	for (const entry of schedule) {
		if (!shouldFire(entry, now, state)) continue;

		// Skip interval tasks when user is idle — no point running proactive/reminder
		// checks if nobody is at the keyboard. Window tasks (morning/midday/evening)
		// always fire since they run once at a fixed time.
		if (entry.intervalMinutes) {
			if (userIdle === null) userIdle = await isUserIdle();
			if (userIdle) {
				console.log(`[edith:scheduler] Skipping ${entry.name} — user idle`);
				continue;
			}
		}

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

		// Empty brief = heuristics decided to skip (e.g. proactive-check with no triggers)
		if (!prompt.trim()) {
			console.log(`[scheduler] ${entry.name}: skipped (no triggers)`);
			state.lastFired[entry.name] = now.toISOString();
			saveScheduleState(state);
			continue;
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
