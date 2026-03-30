/**
 * Activity log — source-agnostic record of what Randy was doing.
 *
 * L1 snapshots: appended every 10 min by proactive-check / midday-check.
 * L2 daily summary: appended by evening-wrap at end of day.
 *
 * Files live at ~/.edith/activity/YYYY-MM-DD.md and are never rotated.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./config";

const ACTIVITY_DIR = join(STATE_DIR, "activity");

function ensureDir(): void {
  if (!existsSync(ACTIVITY_DIR)) mkdirSync(ACTIVITY_DIR, { recursive: true });
}

function dateStr(date: Date): string {
  // Local date in YYYY-MM-DD format
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function timeStr(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Get the file path for a given day's activity log. */
export function getActivityFile(date: Date = new Date()): string {
  return join(ACTIVITY_DIR, `${dateStr(date)}.md`);
}

/** Append an L1 snapshot to today's activity file. */
export function appendActivity(summary: string): void {
  if (!summary.trim()) return;
  ensureDir();
  const now = new Date();
  const file = getActivityFile(now);
  const block = `\n## ${timeStr(now)}\n${summary.trim()}\n`;
  appendFileSync(file, block, "utf-8");
}

/** Read a single day's activity log. Returns empty string if no file. */
export function readActivity(date: Date = new Date()): string {
  const file = getActivityFile(date);
  if (!existsSync(file)) return "";
  try { return readFileSync(file, "utf-8"); } catch { return ""; }
}

/**
 * Read recent activity — L2 daily summaries from the last N days.
 * Falls back to full L1 content if no L2 summary section exists.
 */
export function getRecentActivity(days: number = 7): string {
  ensureDir();
  const results: string[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const content = readActivity(date);
    if (!content.trim()) continue;

    const ds = dateStr(date);

    // Try to extract just the L2 summary section
    const summaryMatch = content.match(/## Daily Summary\n([\s\S]*?)(?=\n## |\s*$)/);
    if (summaryMatch) {
      results.push(`### ${ds}\n${summaryMatch[1].trim()}`);
    } else {
      // No L2 yet (today, or evening-wrap hasn't run) — include full L1
      results.push(`### ${ds}\n${content.trim()}`);
    }
  }

  return results.length > 0 ? results.join("\n\n") : "No activity data for this period.";
}
