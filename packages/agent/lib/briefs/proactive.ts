/**
 * Proactive brief builder — depends on canIntervene, screenpipe, gemini.
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

	// Fetch raw screen context for heuristic check
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

	// If no triggers and no screen activity worth analyzing, skip dispatch entirely
	if (triggers.length === 0 && !screen) {
		return ""; // empty brief = skip dispatch
	}

	const taskboard = getRecentTaskboardEntries();

	const sections: string[] = [
		`Current time: ${time}`,
		``,
		`You are Randy's personal assistant. Think about the next few hours of his life.`,
		``,
		`**Step 1 — Gather context.** Do all of these:`,
		`- Pull today's calendar: manage_calendar action=get, hoursAhead=8, includeAllDay=true`,
		`- Search CodeGraph knowledge for anything relevant to what's coming up (people, routines, preferences, family)`,
		`- Check proactive_history to see what you've already told him recently`,
		``,
		`**Step 2 — Think.** With everything in front of you, reason about Randy's life right now:`,
		`- What's coming up and what does he need to be ready for it?`,
		`- What's happening with his family? School pickup, dinner, evening plans?`,
		`- Is there something nearby worth doing? A local event, a restaurant, an activity for Phoenix?`,
		`- Is he stuck, burnt out, forgetting to eat, or about to miss something?`,
		`- Is there an email or message he should know about?`,
		`- What would a thoughtful human assistant who genuinely cares about this person do right now?`,
		``,
		`Use WebSearch if it would help — local events, restaurant ideas, weather, whatever's relevant. Use CodeGraph knowledge to remember what you know about the people and places in his life. Actually think about this.`,
		``,
		`**Step 3 — Act or stay silent.** If you have something genuinely useful, reach out:`,
		`- Quick heads-up or suggestion → send_notification channel=desktop`,
		`- Something that needs a real response → send_message`,
		`- After acting: call record_intervention so you don't repeat yourself`,
		`- If you have nothing useful to add right now — exit silently. No "nothing to report."`,
	];

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
