/**
 * Proactive brief builder — checks task queue, calendar, and screen context.
 * Primary trigger: pending tasks in edith_tasks. Secondary: screen heuristics.
 * Also exports detectTriggers and gatherScreenContext for unit testing and reuse.
 */

import { appendActivity } from "../activity";
import { processAudioTranscripts } from "../audio-extract";
import { edithLog } from "../edith-logger";
import { summarizeScreenContext } from "../gemini";
import { canIntervene, recordIntervention } from "../proactive";
import {
	formatContext,
	getContext as getScreenContext,
	type ScreenContext,
	isAvailable as screenpipeAvailable,
} from "../screenpipe";
import { getNextPendingTask, hasPendingTasks, listEdithTasks, updateEdithTask } from "../storage";
import { getRecentTaskboardEntries } from "../taskboard";

// --- Proactive heuristic triggers ---

const SOCIAL_MEDIA_APPS = new Set(["Safari", "Google Chrome", "Firefox", "Arc"]);
const SOCIAL_MEDIA_PATTERNS =
	/twitter|x\.com|reddit|facebook|instagram|tiktok|youtube|hacker\s?news|threads|bluesky|mastodon|linkedin.*feed/i;
const SOCIAL_MEDIA_THRESHOLD_MIN = 20;

interface ProactiveTrigger {
	type: string;
	message: string;
}

/**
 * Check screen context for known trigger patterns.
 * Returns triggers found, or empty array if nothing noteworthy.
 */
export function detectTriggers(screenCtx: ScreenContext | null): ProactiveTrigger[] {
	const triggers: ProactiveTrigger[] = [];
	if (!screenCtx || screenCtx.empty) return triggers;

	// Trigger 1: Prolonged social media / doom-scrolling
	for (const app of screenCtx.apps) {
		if (!SOCIAL_MEDIA_APPS.has(app.appName)) continue;
		const socialTitles = app.windowTitles.filter((t) => SOCIAL_MEDIA_PATTERNS.test(t));
		if (socialTitles.length > 0 && app.durationMinutes >= SOCIAL_MEDIA_THRESHOLD_MIN) {
			triggers.push({
				type: "social-media-time",
				message: `Randy has been on social media (${socialTitles[0]}) for ${Math.round(app.durationMinutes)} minutes`,
			});
		}
	}

	// Trigger 2: Continuous screen time without a break
	if (screenCtx.continuousActivityMinutes >= 90) {
		triggers.push({
			type: "break-reminder",
			message: `Randy has been at the screen for ${Math.round(screenCtx.continuousActivityMinutes)} minutes without a break`,
		});
	}

	return triggers;
}

/**
 * Gather screen context and summarize via Gemini Flash-Lite.
 * Raw screenpipe data → Gemini (cheap) → concise summary for Claude (subscription).
 */
export async function gatherScreenContext(
	minutes: number = 15,
	processAudio: boolean = false
): Promise<string> {
	try {
		if (!(await screenpipeAvailable())) return "";
		const ctx = await getScreenContext(minutes);
		if (ctx.empty) return "";
		const raw = formatContext(ctx);
		const summary = await summarizeScreenContext(ctx, raw);

		// Persist L1 snapshot to daily activity log
		appendActivity(summary);

		if (processAudio && ctx.audioTranscripts.length > 0) {
			processAudioTranscripts(ctx.audioTranscripts)
				.then((k) => {
					if (k)
						edithLog.info("proactive_audio_processed", {
							type: k.type,
							summary: k.summary.slice(0, 60),
						});
				})
				.catch(() => {});
		}

		return summary;
	} catch {
		return "";
	}
}

export async function buildProactiveBrief(): Promise<string> {
	// Gate: check if intervention is even allowed before doing any work
	const gate = canIntervene();
	if (!gate.allowed) {
		return ""; // empty brief = skip dispatch
	}

	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

	// Check for pending tasks — this is the PRIMARY trigger now
	const pendingTasks = hasPendingTasks();
	const nextTask = pendingTasks ? getNextPendingTask() : null;
	const allPending = pendingTasks ? listEdithTasks("pending") : [];

	// Claim the task immediately so the next cycle doesn't re-dispatch it
	if (nextTask) {
		updateEdithTask(nextTask.id, { status: "in_progress" });
		recordIntervention("task-execution", nextTask.text.slice(0, 200));
	}

	// Fetch raw screen context for heuristic check (secondary trigger)
	let rawCtx: ScreenContext | null = null;
	try {
		if (await screenpipeAvailable()) {
			rawCtx = await getScreenContext(15);
		}
	} catch {}

	// Run heuristic triggers on raw context
	const triggers = detectTriggers(rawCtx);

	// Record each heuristic trigger so the cooldown gate sees them
	for (const t of triggers) {
		recordIntervention(t.type, t.message);
	}

	// Summarize screen context (also persists to activity log)
	const screen = await gatherScreenContext(15, true);

	// Fire if: pending tasks exist OR screen triggers detected OR screen activity
	if (!pendingTasks && triggers.length === 0 && !screen) {
		return ""; // nothing to do
	}

	const taskboard = getRecentTaskboardEntries();

	const sections: string[] = [
		`Current time: ${time}`,
		``,
		`You are Randy's personal assistant. You have pending work to do.`,
	];

	// Primary: work the task queue
	if (nextTask) {
		sections.push(
			``,
			`## 🎯 Task to Execute`,
			``,
			`You created this task for yourself. Now execute it.`,
			``,
			`- **Task:** ${nextTask.text}`,
			`- **ID:** ${nextTask.id}`,
			nextTask.context ? `- **Context:** ${nextTask.context}` : "",
			nextTask.createdBy ? `- **Created by:** ${nextTask.createdBy}` : "",
			nextTask.prompt ? `- **Instructions:** ${nextTask.prompt}` : "",
			``,
			`**Execute this task now.** Use browser automation, CLI tools, web search, APIs — whatever gets it done.`,
			`- If simple and reversible → do it silently, then mark done via update_edith_task`,
			`- If it needs Randy's approval → send_message with one-line ask, mark in_progress`,
			`- If it fails → mark failed via update_edith_task with context explaining why`,
			``,
			`After completing this task, check if there are more pending tasks via list_edith_tasks.`
		);

		if (allPending.length > 1) {
			sections.push(
				``,
				`### Other pending tasks (${allPending.length - 1} more):`,
				...allPending
					.filter((t) => t.id !== nextTask.id)
					.slice(0, 5)
					.map((t) => `- ${t.text}${t.dueAt ? ` (due: ${t.dueAt})` : ""}`)
			);
		}
	}

	// Secondary: think about Randy's life
	if (!nextTask || triggers.length > 0) {
		sections.push(
			``,
			`## 🔍 Proactive Check`,
			``,
			`Think about the next few hours of Randy's life:`,
			`- Pull today's calendar: manage_calendar action=get, hoursAhead=8, includeAllDay=true`,
			`- Check for meetings < 2h away that need prep`,
			`- Check for deadlines < 24h that need work`,
			`- Search CodeGraph knowledge for anything relevant`,
			``,
			`**Act or stay silent.** If you find something actionable:`,
			`- Can do now → do it, then send_message with what you did`,
			`- Needs more time → create_edith_task for later`,
			`- Needs Randy's input → send_message with one-line ask`,
			`- Nothing useful → exit silently. No "nothing to report."`
		);
	}

	if (triggers.length > 0) {
		sections.push(`\n## ⚡ Triggered Heuristics`);
		sections.push(`These patterns were detected locally. You should address them:`);
		for (const t of triggers) {
			sections.push(`- **${t.type}**: ${t.message}`);
		}
	}

	if (screen) {
		sections.push(`\n## What Randy Is Doing Right Now\n${screen}`);
	}

	if (taskboard.trim()) {
		sections.push(`\n## Recent Context\n${taskboard}`);
	}

	return sections.join("\n");
}
