/**
 * Pre-wake context gathering — fetch calendar and email BEFORE waking Edith.
 * This gives Edith context without needing tool calls, saving turns and time.
 * Used only for boot/morning briefs as a head start before Claude is live.
 */

import { edithLog } from "./edith-logger";
import { getEvents } from "./gcal";
import { searchEmails } from "./gmail";
import { fmtErr } from "./util";

/**
 * Fetch today's calendar events via Google Calendar API.
 */
async function getCalendarEvents(): Promise<string> {
	try {
		const now = Date.now();
		const timeMin = new Date(now).toISOString();
		const timeMax = new Date(now + 16 * 3600_000).toISOString();
		const events = await getEvents({ timeMin, timeMax, includeAllDay: true });
		if (events.length === 0) return "";

		return events
			.map((e) => {
				const start = e.start
					? new Date(e.start).toLocaleTimeString("en-US", {
							hour: "2-digit",
							minute: "2-digit",
							timeZone: "America/New_York",
						})
					: "all-day";
				const end = e.end
					? new Date(e.end).toLocaleTimeString("en-US", {
							hour: "2-digit",
							minute: "2-digit",
							timeZone: "America/New_York",
						})
					: "";
				const time = end ? `${start}–${end}` : start;
				return `- ${time}: ${e.summary}${e.location ? ` (${e.location})` : ""}`;
			})
			.join("\n");
	} catch (err) {
		edithLog.error("prewake_calendar_failed", { error: fmtErr(err) });
		return "";
	}
}

/**
 * Fetch recent emails via Gmail API (lightweight preview — full scan done by Claude via Gmail MCP).
 */
async function getRecentEmails(): Promise<string> {
	try {
		const result = await searchEmails({ hoursBack: 12, unreadOnly: false, maxResults: 20 });
		if (result.emails.length === 0) return "";

		return result.emails
			.map((e) => {
				const date = e.date
					? new Date(e.date).toLocaleString("en-US", {
							timeZone: "America/New_York",
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})
					: "";
				return `- ${date} | ${e.from} | ${e.subject}`;
			})
			.join("\n");
	} catch (err) {
		edithLog.error("prewake_email_failed", { error: fmtErr(err) });
		return "";
	}
}

/**
 * Gather all pre-wake context into a markdown string.
 * Returns empty string if nothing was fetched.
 */
export async function gatherPrewakeContext(): Promise<string> {
	const [calendar, email] = await Promise.all([getCalendarEvents(), getRecentEmails()]);

	const sections: string[] = [];

	if (calendar) {
		sections.push(`### Calendar (Today)\n${calendar}`);
	}

	if (email) {
		sections.push(`### Recent Emails\n${email}`);
	}

	return sections.join("\n\n");
}
