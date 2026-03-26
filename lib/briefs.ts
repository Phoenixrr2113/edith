/**
 * Brief templates — different context for different wake reasons.
 * Each brief type provides the right amount of context for its purpose.
 */
import { readTaskboard, getRecentTaskboardEntries } from "./taskboard";
import { gatherPrewakeContext } from "./prewake";
import { CHAT_ID } from "./config";
import { TASKBOARD_FILE } from "./config";
import { isAvailable as screenpipeAvailable, getContext as getScreenContext, formatContext } from "./screenpipe";
import { summarizeScreenContext } from "./gemini";
import { processAudioTranscripts } from "./audio-extract";

export type BriefType = "boot" | "morning" | "midday" | "evening" | "message" | "location" | "scheduled" | "proactive";

/** Map task names to brief types for known scheduled tasks. */
export const BRIEF_TYPE_MAP: Record<string, BriefType> = {
  "morning-brief": "morning",
  "midday-check": "midday",
  "evening-wrap": "evening",
  "proactive-check": "proactive",
};

/**
 * Build the prompt for a given wake reason.
 */
export async function buildBrief(type: BriefType, extra?: Record<string, string>): Promise<string> {
  switch (type) {
    case "boot":
    case "morning":
      return buildFullBrief(type);
    case "midday":
      return buildMiddayBrief();
    case "evening":
      return buildEveningBrief();
    case "message":
      return buildMessageBrief(extra?.message ?? "", extra?.chatId ?? String(CHAT_ID));
    case "location":
      return buildLocationBrief(extra?.description ?? "", extra?.lat ?? "", extra?.lon ?? "", extra?.chatId ?? String(CHAT_ID));
    case "scheduled":
      return buildScheduledBrief(extra?.prompt ?? "", extra?.taskName ?? "");
    case "proactive":
      return buildProactiveBrief();
    default:
      return extra?.prompt ?? "";
  }
}

async function buildFullBrief(type: "boot" | "morning"): Promise<string> {
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
    `\nOrient yourself: search Cognee for relevant context, check calendar (manage_calendar action=get, hoursAhead=16, includeAllDay=true), check email (manage_emails action=get, maxResults=10), check reminders.`,
    `For anything you find, think: what would a brilliant human assistant do with this? Research deeply before acting.`,
    `After checking email, clean the inbox: archive newsletters, promos, automated notifications, shipping updates, and social media alerts. Trash obvious spam. Keep emails from real people, calendar invites, active projects, and anything financial/legal. Use manage_emails with operations array for efficiency. Report what you cleaned, not what you found.`,
    `Store genuinely new knowledge in Cognee. Write findings to taskboard at ${TASKBOARD_FILE}.`,
    `Send Randy ONE short message (3-5 lines) with what you DID, not what you FOUND. Chat ID: ${CHAT_ID}.`,
  );

  return sections.join("\n");
}

async function buildMiddayBrief(): Promise<string> {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const taskboard = getRecentTaskboardEntries();
  const screen = await gatherScreenContext();

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
    `\nScan for changes since morning: new emails (manage_emails action=get, maxResults=10), afternoon calendar (manage_calendar action=get, hoursAhead=8, includeAllDay=true), reminders.`,
    `If a meeting is < 4h away, prep now. Advance any deadline work. Draft replies for actionable emails.`,
    `\n## Inbox Triage`,
    `After scanning emails, clean the inbox using manage_emails with operations array:`,
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

async function buildEveningBrief(): Promise<string> {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const taskboard = readTaskboard();

  const sections: string[] = [
    `Evening wrap-up. Current time: ${time}`,
  ];

  if (taskboard.trim()) {
    sections.push(`\n## Today's Taskboard\n${taskboard}`);
  }

  sections.push(
    `\nReview today (taskboard). Check tomorrow's calendar (manage_calendar action=get, hoursAhead=24, includeAllDay=true).`,
    `For tomorrow's events: research context, prep materials. If deadline < 48h, do as much work as possible now.`,
    `Final inbox sweep: archive any remaining noise from today. Only keep emails that need action tomorrow. Use manage_emails with operations array.`,
    `Store new knowledge in Cognee. Write summary to taskboard at ${TASKBOARD_FILE}.`,
    `Only message Randy if tomorrow needs his attention tonight. Respect family time. Chat ID: ${CHAT_ID}.`,
  );

  return sections.join("\n");
}

function buildMessageBrief(message: string, chatId: string): string {
  const taskboard = getRecentTaskboardEntries();
  const contextBlock = taskboard
    ? `\n[Recent taskboard context]\n${taskboard}\n[End taskboard context]\n`
    : "";

  return `${message}\n${contextBlock}\nBefore responding:\n1. Search Cognee for relevant context about this topic\n2. If this is a task, DO it — don't describe what you'd do\n3. If you learn new info (people, decisions, preferences), store it in Cognee\n\n[Reply using the send_message tool with chat_id ${chatId}. Keep it under 5 lines unless more detail is needed.]`;
}

function buildLocationBrief(description: string, lat: string, lon: string, chatId: string): string {
  return `[Location update] ${description}. Coordinates: ${lat}, ${lon}. Chat ID: ${chatId}. Note this for context.`;
}

/**
 * Gather screen context and summarize via Gemini Flash-Lite.
 * Raw screenpipe data → Gemini (cheap) → concise summary for Claude (subscription).
 */
async function gatherScreenContext(minutes: number = 15, processAudio: boolean = false): Promise<string> {
  try {
    if (!(await screenpipeAvailable())) return "";
    const ctx = await getScreenContext(minutes);
    if (ctx.empty) return "";
    const raw = formatContext(ctx);
    const summary = await summarizeScreenContext(ctx, raw);

    if (processAudio && ctx.audioTranscripts.length > 0) {
      processAudioTranscripts(ctx.audioTranscripts)
        .then((k) => { if (k) console.log(`[proactive] Audio processed: [${k.type}] ${k.summary.slice(0, 60)}`); })
        .catch(() => {});
    }

    return summary;
  } catch {
    return "";
  }
}

async function buildProactiveBrief(): Promise<string> {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  // Fetch screen context (wide window for session detection)
  const screen = await gatherScreenContext(180, true);

  const taskboard = getRecentTaskboardEntries();

  const sections: string[] = [
    `Proactive check. Current time: ${time}`,
  ];

  if (screen) {
    sections.push(`\n## What Randy Is Doing\n${screen}`);
  }

  if (taskboard.trim()) {
    sections.push(`\n## Recent Taskboard\n${taskboard}`);
  }

  sections.push(
    `\n## Detection Rules`,
    `Check these in order. Act on the FIRST one that applies, then exit.`,
    ``,
    `**Time blindness** — Meeting/event in <15 min (manage_calendar action=get) and no prep activity visible → send_notification channel=desktop with meeting details`,
    `**Marathon session** — "Continuous activity" above shows 90+ min → send_notification channel=desktop suggesting a break. Be warm, not naggy.`,
    `**Stuck** — Error messages, stack traces, or same terminal output visible for a long time → offer debugging help via send_message`,
    `**Eating** — Current time is 11am-2pm or 5pm-8pm AND 4+ hours of continuous activity with no food-related apps → gentle nudge via send_notification channel=desktop`,
    `**Actionable email** — If you can see email content on screen that looks like it needs a reply → offer to draft via send_message`,
    ``,
    `Before acting: check proactive_history to avoid repeating yourself.`,
    `After acting: call record_intervention with the category.`,
    `If nothing matches — exit silently. Do NOT message "nothing to report".`,
    `Chat ID: ${CHAT_ID}.`,
  );

  return sections.join("\n");
}

function buildScheduledBrief(prompt: string, taskName: string): string {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  return `Run this task: ${prompt}\n\nCurrent time: ${time}.\n\nIf you have findings worth recording, write them to the taskboard at ${TASKBOARD_FILE}. Use this format:\n## ${new Date().toISOString()} — ${taskName}\n<your findings here>\n\nIf something needs Randy's attention, also use send_message (chat_id: ${CHAT_ID}).\nIf nothing is actionable and nothing to report, do NOT write to the taskboard and do NOT message. Silent exit.`;
}
