/**
 * Brief templates — different context for different wake reasons.
 * Each brief type provides the right amount of context for its purpose.
 */
import { readTaskboard, getRecentTaskboardEntries } from "./taskboard";
import { gatherPrewakeContext } from "./prewake";
import { CHAT_ID } from "./config";
import { TASKBOARD_FILE } from "./config";
import { isAvailable as screenpipeAvailable, getContext as getScreenContext, formatContext, type ScreenContext } from "./screenpipe";
import { appendActivity, readActivity, getActivityFile } from "./activity";
import { summarizeScreenContext } from "./gemini";
import { processAudioTranscripts } from "./audio-extract";
import { canIntervene } from "./proactive";

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

async function buildMiddayBrief(): Promise<string> {
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

async function buildEveningBrief(): Promise<string> {
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

    // Persist L1 snapshot to daily activity log
    appendActivity(summary);

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

// --- Proactive heuristic triggers ---

const SOCIAL_MEDIA_APPS = new Set([
  "Safari", "Google Chrome", "Firefox", "Arc",
]);
const SOCIAL_MEDIA_PATTERNS = /twitter|x\.com|reddit|facebook|instagram|tiktok|youtube|hacker\s?news|threads|bluesky|mastodon|linkedin.*feed/i;
const SOCIAL_MEDIA_THRESHOLD_MIN = 20;

interface ProactiveTrigger {
  type: string;
  message: string;
}

/**
 * Check screen context for known trigger patterns.
 * Returns triggers found, or empty array if nothing noteworthy.
 */
function detectTriggers(screenCtx: ScreenContext | null): ProactiveTrigger[] {
  const triggers: ProactiveTrigger[] = [];
  if (!screenCtx || screenCtx.empty) return triggers;

  // Trigger 1: Prolonged social media / doom-scrolling
  for (const app of screenCtx.apps) {
    if (!SOCIAL_MEDIA_APPS.has(app.appName)) continue;
    const socialTitles = app.windowTitles.filter(t => SOCIAL_MEDIA_PATTERNS.test(t));
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

async function buildProactiveBrief(): Promise<string> {
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
    `- Search Cognee for anything relevant to what's coming up (people, routines, preferences, family)`,
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
    `Use WebSearch if it would help — local events, restaurant ideas, weather, whatever's relevant. Use Cognee to remember what you know about the people and places in his life. Actually think about this.`,
    ``,
    `**Step 3 — Act or stay silent.** If you have something genuinely useful, reach out:`,
    `- Quick heads-up or suggestion → send_notification channel=desktop`,
    `- Something that needs a real response → send_message (chat_id: ${CHAT_ID})`,
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

function buildScheduledBrief(prompt: string, taskName: string): string {
  const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  return `Run this task: ${prompt}\n\nCurrent time: ${time}.\n\nIf you have findings worth recording, write them to the taskboard at ${TASKBOARD_FILE}. Use this format:\n## ${new Date().toISOString()} — ${taskName}\n<your findings here>\n\nIf something needs Randy's attention, also use send_message (chat_id: ${CHAT_ID}).\nIf nothing is actionable and nothing to report, do NOT write to the taskboard and do NOT message. Silent exit.`;
}
