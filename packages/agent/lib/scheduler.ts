/**
 * Scheduler — reads tasks from SQLite and fires them via dispatch.
 */

import { BRIEF_TYPE_MAP, buildBrief } from "./briefs";
import { EDITH_TIMEZONE, IS_CLOUD } from "./config";
import { kvGet, kvSet } from "./db";
import { dispatchToClaude, Priority } from "./dispatch";
import { edithLog } from "./edith-logger";
import { claimTask } from "./schedule-coordinator";
import { isUserIdle } from "./screenpipe";
import { hasDueReminders, loadSchedule } from "./storage";
import { fmtErr } from "./util";

/** Tasks that require local machine access and should not run in cloud mode. */
const CLOUD_SKIPPED_TASKS = new Set(["proactive-check"]);

export interface ScheduleState {
	lastFired: Record<string, string>;
}

function loadScheduleState(): ScheduleState {
	const raw = kvGet("schedule_state");
	if (!raw) return { lastFired: {} };
	try {
		return JSON.parse(raw);
	} catch {
		return { lastFired: {} };
	}
}

function saveScheduleState(state: ScheduleState): void {
	kvSet("schedule_state", JSON.stringify(state));
}

/** Convert a Date to user's local timezone components. */
function toLocalTime(date: Date): {
	hours: number;
	minutes: number;
	dayOfWeek: number;
	dayOfMonth: number;
	month: number;
	year: number;
} {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: EDITH_TIMEZONE,
		hour: "numeric",
		minute: "numeric",
		weekday: "short",
		day: "numeric",
		month: "numeric",
		year: "numeric",
		hour12: false,
	});
	const parts = fmt.formatToParts(date);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
	const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	return {
		hours: Number(get("hour")),
		minutes: Number(get("minute")),
		dayOfWeek: dayMap[get("weekday")] ?? 0,
		dayOfMonth: Number(get("day")),
		month: Number(get("month")),
		year: Number(get("year")),
	};
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
	// Use user's local timezone for all time comparisons (fixes cloud UTC issue)
	const local = toLocalTime(now);
	const dow = local.dayOfWeek;
	const dom = local.dayOfMonth;
	const month = local.month;

	// Day-of-week filter (applies to all task types)
	if (entry.daysOfWeek && !entry.daysOfWeek.includes(dow)) return false;

	// Month filter (for quarterly/annual tasks)
	if (entry.months && !entry.months.includes(month)) return false;

	// Day-of-month filter (for monthly/quarterly/annual tasks)
	if (entry.dayOfMonth && dom !== entry.dayOfMonth) return false;

	// Check quiet hours for interval tasks
	if (entry.intervalMinutes && isQuietHours(local.hours, entry.quietStart, entry.quietEnd)) {
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

	const h = local.hours;
	const m = local.minutes;
	const nowMinutes = h * 60 + m;
	const targetMinutes = targetHour * 60 + targetMinute;

	// Must be at or past target time, within a 30-minute window
	if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 30) return false;

	// Check if already fired today (in user's local timezone)
	if (lastFiredTime > 0) {
		const lastLocal = toLocalTime(new Date(lastFiredTime));
		if (
			lastLocal.year === local.year &&
			lastLocal.month === local.month &&
			lastLocal.dayOfMonth === local.dayOfMonth
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
		// Skip tasks that require local machine access in cloud mode
		if (IS_CLOUD && CLOUD_SKIPPED_TASKS.has(entry.name)) continue;

		if (!shouldFire(entry, now, state)) continue;

		// Skip interval tasks when user is idle — except proactive-check which
		// works the task queue regardless of keyboard activity. Window tasks
		// (morning/midday/evening) always fire since they run once at a fixed time.
		if (entry.intervalMinutes && entry.name !== "proactive-check") {
			if (userIdle === null) userIdle = await isUserIdle();
			if (userIdle) {
				edithLog.info("scheduler_skipped_idle", {
					task: entry.name,
					intervalMinutes: entry.intervalMinutes,
				});
				continue;
			}
		}

		// Cross-instance coordination: for window-based tasks (fired once per day),
		// claim via shared Postgres before dispatching. First instance wins.
		if (!entry.intervalMinutes) {
			const dateStr = now.toISOString().slice(0, 10);
			if (!claimTask(entry.name, dateStr)) {
				state.lastFired[entry.name] = now.toISOString();
				saveScheduleState(state);
				continue;
			}
		}

		const lastFired = state.lastFired[entry.name];
		edithLog.info("scheduler_firing", {
			task: entry.name,
			briefType: BRIEF_TYPE_MAP[entry.name] ?? "scheduled",
			lastFired: lastFired ?? "never",
			sinceLastMs: lastFired ? Date.now() - new Date(lastFired).getTime() : null,
		});

		// Use brief types for known tasks, generic scheduled brief for custom ones
		const briefType = BRIEF_TYPE_MAP[entry.name];
		let prompt: string;

		if (briefType) {
			prompt = await buildBrief(briefType);
		} else {
			prompt = await buildBrief("scheduled", { prompt: entry.prompt, taskName: entry.name });
		}

		// Pre-check: skip check-reminders dispatch if no reminders are due.
		// Saves ~$27/day by avoiding 288 unnecessary LLM calls.
		if (entry.name === "check-reminders" && !hasDueReminders()) {
			edithLog.debug("scheduler_skipped_no_due_reminders", { task: entry.name });
			state.lastFired[entry.name] = now.toISOString();
			saveScheduleState(state);
			continue;
		}

		// Empty brief = heuristics decided to skip (e.g. proactive-check with no triggers)
		if (!prompt.trim()) {
			edithLog.info("scheduler_skipped_no_triggers", {
				task: entry.name,
				briefType: briefType ?? "scheduled",
			});
			state.lastFired[entry.name] = now.toISOString();
			saveScheduleState(state);
			continue;
		}

		// Wrap dispatch in a timeout so a hung task can't block the entire scheduler.
		// The dispatch has its own internal timeout (QUERY_TIMEOUT_MS) but if the
		// Agent SDK process never starts, that timeout may not fire.
		const SCHEDULER_DISPATCH_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
		try {
			const result = await Promise.race([
				dispatchToClaude(prompt, {
					resume: false,
					label: entry.name,
					skipIfBusy: true,
					briefType: briefType ?? "scheduled",
					priority: Priority.P3_BACKGROUND,
				}),
				new Promise<string>((resolve) =>
					setTimeout(() => {
						edithLog.warn("scheduler_dispatch_timeout", {
							task: entry.name,
							timeoutMs: SCHEDULER_DISPATCH_TIMEOUT_MS,
						});
						resolve("");
					}, SCHEDULER_DISPATCH_TIMEOUT_MS)
				),
			]);

			// Save state after dispatch so failed/skipped tasks can retry next tick
			if (result) {
				state.lastFired[entry.name] = now.toISOString();
				saveScheduleState(state);
			}
		} catch (err) {
			edithLog.error("scheduler_dispatch_error", {
				task: entry.name,
				error: fmtErr(err),
			});
		}
		// Always mark as fired to prevent rapid-retry loops on persistent failures
		state.lastFired[entry.name] = now.toISOString();
		saveScheduleState(state);
	}
}
