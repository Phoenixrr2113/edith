/**
 * Scheduled brief builders — morning, midday, evening, and generic scheduled.
 * All depend on taskboard, prewake, screenpipe/gemini for context gathering.
 */

import { getActivityFile, readActivity } from "../activity";
import { CHAT_ID, TASKBOARD_FILE } from "../config";
import { gatherPrewakeContext } from "../prewake";
import { getRecentTaskboardEntries, readTaskboard } from "../taskboard";
import { gatherScreenContext } from "./proactive";

export async function buildFullBrief(type: "boot" | "morning"): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = readTaskboard();
	const prewake = await gatherPrewakeContext();

	const sections: string[] = [
		`You are Edith. This is a ${type === "boot" ? "fresh startup" : "morning"} session.`,
		`Current time: ${time}`,
	];

	if (prewake) {
		sections.push(`\n## Pre-gathered Context\n${prewake}`);
	}

	if (taskboard.trim()) {
		sections.push(`\n## Prior Taskboard\n${taskboard}`);
	}

	sections.push(
		`\nOrient yourself: search Cognee for relevant context, check calendar (manage_calendar action=get, hoursAhead=16, includeAllDay=true), check reminders.`,
		`\n## Email Scan`,
		`Use gmail_search_messages (maxResults=50) to get the last 50 emails. Review ALL of them — not just unread.`,
		`For anything you find, think: what would a brilliant human assistant do with this? Research deeply before acting.`,
		`Clean the inbox: archive newsletters, promos, automated notifications, shipping updates, and social media alerts. Trash obvious spam. Keep emails from real people, calendar invites, active projects, and anything financial/legal. Use manage_emails with operations array for efficiency. Report what you cleaned, not what you found.`,
		`Store genuinely new knowledge in Cognee. Write findings to taskboard at ${TASKBOARD_FILE}.`,
		`Send Randy ONE short message (3-5 lines) with what you DID, not what you FOUND. Chat ID: ${CHAT_ID}.`
	);

	return sections.join("\n");
}

export async function buildMiddayBrief(): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = getRecentTaskboardEntries();
	const screen = await gatherScreenContext(240);

	const sections: string[] = [`Midday check. Current time: ${time}`];

	if (screen) {
		sections.push(`\n## Current Screen Activity\n${screen}`);
	}

	if (taskboard.trim()) {
		sections.push(`\n## Today's Taskboard\n${taskboard}`);
	}

	sections.push(
		`\nScan for changes since morning: afternoon calendar (manage_calendar action=get, hoursAhead=8, includeAllDay=true), reminders.`,
		`\n## Email Scan`,
		`Use gmail_search_messages (maxResults=50) to get recent emails. Review ALL — not just unread.`,
		`If a meeting is < 4h away, prep now. Advance any deadline work. Draft replies for actionable emails.`,
		`\n## Inbox Triage`,
		`Clean the inbox using manage_emails with operations array:`,
		`- **Archive**: marketing, newsletters, automated notifications, shipping updates, social media alerts, subscription confirmations, promotional emails`,
		`- **Trash**: obvious spam that got past filters`,
		`- **Keep in inbox**: emails from real people expecting a reply, calendar invites needing action, emails about active projects/deadlines, anything financial or legal`,
		`- Mark cleaned emails as read. When uncertain, keep.`,
		`- Log cleanup to taskboard (e.g. "Archived 8 newsletters/promos, kept 2 actionable"). Do NOT message Randy about cleanup.`,
		`\nOnly message Randy if something needs his attention. Otherwise write to taskboard at ${TASKBOARD_FILE} and stay silent.`,
		`Chat ID: ${CHAT_ID}.`
	);

	return sections.join("\n");
}

export async function buildEveningBrief(): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = readTaskboard();
	const todayActivity = readActivity();
	const activityFile = getActivityFile();

	const sections: string[] = [`Evening wrap-up. Current time: ${time}`];

	if (taskboard.trim()) {
		sections.push(`\n## Today's Taskboard\n${taskboard}`);
	}

	if (todayActivity.trim()) {
		sections.push(`\n## Today's Activity Log\n${todayActivity}`);
	}

	sections.push(
		`\nReview today (taskboard + activity log). Check tomorrow's calendar (manage_calendar action=get, hoursAhead=24, includeAllDay=true).`,
		`For tomorrow's events: research context, prep materials. If deadline < 48h, do as much work as possible now.`,
		`Final inbox sweep: archive any remaining noise from today. Only keep emails that need action tomorrow. Use manage_emails with operations array.`,
		`Store new knowledge in Cognee. Write summary to taskboard at ${TASKBOARD_FILE}.`,
		`\n## Daily Summary`,
		`Write a "## Daily Summary" section at the end of today's activity log at ${activityFile}.`,
		`Summarize the day in 3-5 lines: what Randy worked on, key meetings/calls, decisions made, focus blocks. This is for future retrieval ("what did I do last week?").`,
		`\nOnly message Randy if tomorrow needs his attention tonight. Respect family time. Chat ID: ${CHAT_ID}.`
	);

	return sections.join("\n");
}

export async function buildWeekendBrief(): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = getRecentTaskboardEntries();

	const sections: string[] = [`Weekend brief. Current time: ${time}`];

	if (taskboard.trim()) {
		sections.push(`\n## Prior Taskboard\n${taskboard}`);
	}

	sections.push(
		`\nRun the weekend-brief skill. Gather context: search Cognee for Phoenix interests and family plans, check calendar (manage_calendar action=get, hoursAhead=48, includeAllDay=true), check reminders.`,
		`Research weekend activities for the family in Bradenton/Sarasota FL: Macaroni Kid, Facebook local groups, Visit Sarasota/Bradenton event calendars. Search for Phoenix interests: parkour, ninja warrior, STEM, outdoor, beach.`,
		`Check weather for today and tomorrow. Beach conditions: Anna Maria Island, Siesta Key, Lido Beach.`,
		`Create a Google Doc (manage_docs) with full weekend guide. Title: "Weekend Guide — [Dates]"`,
		`Send Randy a Telegram summary with weather, best Phoenix activity, Diana+Phoenix idea, beach conditions, one event. Chat ID: ${CHAT_ID}.`,
		`Write to taskboard at ${TASKBOARD_FILE}: ## ISO-timestamp — weekend-brief`
	);

	return sections.join("\n");
}

export async function buildWeeklyReviewBrief(): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = readTaskboard();
	const todayActivity = readActivity();

	const sections: string[] = [`Weekly review. Current time: ${time}`];

	if (taskboard.trim()) {
		sections.push(`\n## Current Taskboard\n${taskboard}`);
	}
	if (todayActivity.trim()) {
		sections.push(`\n## Recent Activity\n${todayActivity}`);
	}

	sections.push(
		`\nRun the weekly-review skill. Gather data: read taskboard archive at ~/.edith/taskboard-archive/, use get_activity with days=7, search Cognee for this week's decisions and people.`,
		`Look back at this week: what shipped, key meetings, family time with Phoenix/Diana, health signals, patterns.`,
		`Look ahead at next week: calendar (manage_calendar action=get, hoursAhead=168, includeAllDay=true), deadlines, meeting prep needed.`,
		`Create a Google Doc (manage_docs) titled "Week of [DATE] — Weekly Review" with full review.`,
		`Send Randy a Telegram summary (scorecard, win, gap, next week, open loop + Doc link). Chat ID: ${CHAT_ID}.`,
		`Store decisions and patterns in Cognee. Write to taskboard at ${TASKBOARD_FILE}: ## ISO-timestamp — weekly-review`
	);

	return sections.join("\n");
}

export async function buildMonthlyReviewBrief(): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = readTaskboard();

	const sections: string[] = [`Monthly review. Current time: ${time}`];

	if (taskboard.trim()) {
		sections.push(`\n## Current Taskboard\n${taskboard}`);
	}

	sections.push(
		`\nRun the monthly-review skill. Gather data: read taskboard archive at ~/.edith/taskboard-archive/YYYY-MM.md for this month, use get_activity with days=30, search Cognee for this month's decisions and patterns.`,
		`Pull cost data from ~/.edith/events.jsonl — sum Edith costs by label for the month.`,
		`Look at the life scorecard: Work, Family (Phoenix, Diana+Phoenix), Health/Fitness, Finances, Learning, Fun, Mental Health. Use ⬆️➡️⬇️ trend arrows.`,
		`Create a Google Doc (manage_docs) titled "Monthly Review — [MONTH YEAR]" with full review.`,
		`Send Randy a Telegram summary (scorecard on one line, win, gap, month focus, Phoenix note + Doc link). Chat ID: ${CHAT_ID}.`,
		`Store monthly summary and updated goals in Cognee. Write to taskboard at ${TASKBOARD_FILE}: ## ISO-timestamp — monthly-review`
	);

	return sections.join("\n");
}

export async function buildQuarterlyReviewBrief(): Promise<string> {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	const taskboard = readTaskboard();

	const sections: string[] = [`Quarterly review. Current time: ${time}`];

	if (taskboard.trim()) {
		sections.push(`\n## Current Taskboard\n${taskboard}`);
	}

	sections.push(
		`\nRun the quarterly-review skill. Gather data: search Cognee for decisions, milestones, patterns from the last 3 months, read taskboard archives for each month of the quarter, use get_activity with days=90.`,
		`This is a strategic review. Cover: Career & Projects, Family & Relationships, Health & Wellbeing, Finances, Edith Effectiveness.`,
		`Look at quarterly theme, 3 wins, 3 misses, lessons, what would you do differently.`,
		`Create a Google Doc (manage_docs) titled "Q[N] [YEAR] — Quarterly Review" with full strategic review.`,
		`Send Randy a Telegram summary (theme, win, miss, Q[N+1] focus, Phoenix trend + Doc link). Chat ID: ${CHAT_ID}.`,
		`Store quarterly milestone and updated trajectory in Cognee. Write to taskboard at ${TASKBOARD_FILE}: ## ISO-timestamp — quarterly-review`
	);

	return sections.join("\n");
}

export function buildScheduledBrief(prompt: string, taskName: string): string {
	const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
	return `Run this task: ${prompt}\n\nCurrent time: ${time}.\n\nIf you have findings worth recording, write them to the taskboard at ${TASKBOARD_FILE}. Use this format:\n## ${new Date().toISOString()} — ${taskName}\n<your findings here>\n\nIf something needs Randy's attention, also use send_message (chat_id: ${CHAT_ID}).\nIf nothing is actionable and nothing to report, do NOT write to the taskboard and do NOT message. Silent exit.`;
}
