/**
 * Pre-wake context gathering — fetch calendar and email BEFORE waking Edith.
 * This gives Edith context without needing tool calls, saving turns and time.
 */
import { n8nPost } from "./n8n-client";

/**
 * Fetch today's calendar events via n8n.
 */
async function getCalendarEvents(): Promise<string> {
  try {
    const result = await n8nPost("calendar", { hoursAhead: 16, includeAllDay: true });
    if (!result.ok || !result.data) return "";
    if (typeof result.data === "string") return "";

    const events = Array.isArray(result.data) ? result.data : [result.data];
    if (events.length === 0) return "";

    return events.map((e: any) => {
      const start = e.start ? new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "all-day";
      const end = e.end ? new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "";
      const time = end ? `${start}–${end}` : start;
      return `- ${time}: ${e.summary ?? e.title ?? "Untitled"}${e.location ? ` (${e.location})` : ""}`;
    }).join("\n");
  } catch (err) {
    console.error("[prewake] Calendar fetch failed:", err instanceof Error ? err.message : err);
    return "";
  }
}

/**
 * Fetch recent emails via n8n.
 */
async function getRecentEmails(): Promise<string> {
  try {
    const result = await n8nPost("gmail", { hoursBack: 12, unreadOnly: false, maxResults: 8 });
    if (!result.ok || !result.data) return "";
    if (typeof result.data === "string") return "";

    const emails = Array.isArray(result.data) ? result.data : [result.data];
    if (emails.length === 0) return "";

    return emails.map((e: any) => {
      const from = e.from ?? e.sender ?? "Unknown";
      const subject = e.subject ?? "(no subject)";
      const date = e.date ? new Date(e.date).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      return `- ${date} | ${from} | ${subject}`;
    }).join("\n");
  } catch (err) {
    console.error("[prewake] Email fetch failed:", err instanceof Error ? err.message : err);
    return "";
  }
}

/**
 * Gather all pre-wake context into a markdown string.
 * Returns empty string if nothing was fetched.
 */
export async function gatherPrewakeContext(): Promise<string> {
  const [calendar, email] = await Promise.all([
    getCalendarEvents(),
    getRecentEmails(),
  ]);

  const sections: string[] = [];

  if (calendar) {
    sections.push(`### Calendar (Today)\n${calendar}`);
  }

  if (email) {
    sections.push(`### Recent Emails\n${email}`);
  }

  return sections.join("\n\n");
}
