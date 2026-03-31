/**
 * Pre-wake context gathering — fetch calendar and email BEFORE waking Edith.
 * This gives Edith context without needing tool calls, saving turns and time.
 * Used only for boot/morning briefs as a head start before Claude is live.
 */
import { n8nPost } from "./n8n-client";
import { fmtErr } from "./util";

/**
 * Fetch today's calendar events via n8n.
 */
async function getCalendarEvents(): Promise<string> {
  try {
    const result = await n8nPost("calendar", { hoursAhead: 16, includeAllDay: true });
    if (!result.ok || !result.data) return "";
    if (typeof result.data === "string") return "";

    type CalendarEvent = { start?: string; end?: string; summary?: string; title?: string; location?: string };
    const events: CalendarEvent[] = Array.isArray(result.data) ? result.data as CalendarEvent[] : [result.data as CalendarEvent];
    if (events.length === 0) return "";

    return events.map((e) => {
      const start = e.start ? new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "all-day";
      const end = e.end ? new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "";
      const time = end ? `${start}–${end}` : start;
      return `- ${time}: ${e.summary ?? e.title ?? "Untitled"}${e.location ? ` (${e.location})` : ""}`;
    }).join("\n");
  } catch (err) {
    console.error("[prewake] Calendar fetch failed:", fmtErr(err));
    return "";
  }
}

/**
 * Fetch recent emails via n8n (lightweight preview — full scan done by Claude via Gmail MCP).
 */
async function getRecentEmails(): Promise<string> {
  try {
    const result = await n8nPost("gmail", { hoursBack: 12, unreadOnly: false, maxResults: 20 });
    if (!result.ok || !result.data) return "";
    if (typeof result.data === "string") return "";

    type EmailEntry = { from?: string; sender?: string; subject?: string; snippet?: string; date?: string };
    type EmailResponse = { emails?: EmailEntry[] };
    const emailData = result.data as EmailEntry[] | EmailResponse | EmailEntry;
    const emails: EmailEntry[] = Array.isArray(emailData)
      ? emailData
      : (emailData as EmailResponse).emails ?? [emailData as EmailEntry];
    if (emails.length === 0) return "";

    return emails.map((e) => {
      const from = e.from ?? e.sender ?? "";
      const subject = e.subject ?? "";
      const snippet = e.snippet?.slice(0, 120) ?? "";
      const date = e.date ? new Date(e.date).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      if (from || subject) {
        return `- ${date} | ${from} | ${subject}`;
      }
      return `- ${snippet}`;
    }).join("\n");
  } catch (err) {
    console.error("[prewake] Email fetch failed:", fmtErr(err));
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
