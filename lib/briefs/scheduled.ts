/**
 * Scheduled brief builders — morning, midday, evening, and generic scheduled.
 * All depend on taskboard, prewake, screenpipe/gemini for context gathering.
 */
import { readTaskboard, getRecentTaskboardEntries } from "../taskboard";
import { gatherPrewakeContext } from "../prewake";
import { CHAT_ID, TASKBOARD_FILE } from "../config";
import { readActivity, getActivityFile } from "../activity";
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
    `Send Randy ONE short message (3-5 lines) with what you DID, not what you FOUND. Chat ID: ${CHAT_ID}.`,
  );

  return sections.join("\n");
}

export async function buildMiddayBrief(): Promise<string> {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const taskboard = getRecentTaskboardEntries();
  const screen = await gatherScreenContext(240);

  const sections: string[] = [
    `Midday check. Current time: ${time}`,
  ];

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
    `Chat ID: ${CHAT_ID}.`,
  );

  return sections.join("\n");
}

export async function buildEveningBrief(): Promise<string> {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const taskboard = readTaskboard();
  const todayActivity = readActivity();
  const activityFile = getActivityFile();

  const sections: string[] = [
    `Evening wrap-up. Current time: ${time}`,
  ];

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
    `\nOnly message Randy if tomorrow needs his attention tonight. Respect family time. Chat ID: ${CHAT_ID}.`,
  );

  return sections.join("\n");
}

export function buildScheduledBrief(prompt: string, taskName: string): string {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  return `Run this task: ${prompt}\n\nCurrent time: ${time}.\n\nIf you have findings worth recording, write them to the taskboard at ${TASKBOARD_FILE}. Use this format:\n## ${new Date().toISOString()} — ${taskName}\n<your findings here>\n\nIf something needs Randy's attention, also use send_message (chat_id: ${CHAT_ID}).\nIf nothing is actionable and nothing to report, do NOT write to the taskboard and do NOT message. Silent exit.`;
}
