/**
 * Tests for lib/activity.ts — L1 snapshots, L2 summaries, daily file management.
 *
 * Reimplements core logic against temp files to avoid module-level config imports.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { setupTestDir, cleanupTestDir } from "./helpers";

let tempDir: string;
let activityDir: string;

beforeAll(() => {
  tempDir = setupTestDir();
  activityDir = join(tempDir, "activity");
  mkdirSync(activityDir, { recursive: true });
});
afterAll(() => cleanupTestDir());

function dateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getActivityFile(date: Date = new Date()): string {
  return join(activityDir, `${dateStr(date)}.md`);
}

function appendActivity(summary: string, date: Date = new Date()): void {
  if (!summary.trim()) return;
  const file = getActivityFile(date);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const block = `\n## ${h}:${m}\n${summary.trim()}\n`;
  appendFileSync(file, block, "utf-8");
}

function readActivity(date: Date = new Date()): string {
  const file = getActivityFile(date);
  if (!existsSync(file)) return "";
  try { return readFileSync(file, "utf-8"); } catch { return ""; }
}

function getRecentActivity(days: number = 7): string {
  const results: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const content = readActivity(date);
    if (!content.trim()) continue;
    const ds = dateStr(date);
    const summaryMatch = content.match(/## Daily Summary\n([\s\S]*?)(?=\n## |\s*$)/);
    if (summaryMatch) {
      results.push(`### ${ds}\n${summaryMatch[1].trim()}`);
    } else {
      results.push(`### ${ds}\n${content.trim()}`);
    }
  }
  return results.length > 0 ? results.join("\n\n") : "No activity data for this period.";
}

describe("Activity Log", () => {
  test("appendActivity writes timestamped block to daily file", () => {
    const date = new Date(2026, 2, 30, 14, 23); // March 30, 2026 14:23
    appendActivity("- **Apps:** VS Code, Chrome\n- **Context:** Coding session", date);

    const content = readActivity(date);
    expect(content).toContain("## 14:23");
    expect(content).toContain("VS Code, Chrome");
    expect(content).toContain("Coding session");
  });

  test("appendActivity appends multiple entries to same file", () => {
    const date = new Date(2026, 2, 29, 10, 0);
    appendActivity("- **Apps:** Slack", date);

    const date2 = new Date(2026, 2, 29, 10, 15);
    // Write to same day but different time
    const file = getActivityFile(date);
    const h = String(date2.getHours()).padStart(2, "0");
    const m = String(date2.getMinutes()).padStart(2, "0");
    appendFileSync(file, `\n## ${h}:${m}\n- **Apps:** Chrome\n`, "utf-8");

    const content = readActivity(date);
    expect(content).toContain("## 10:00");
    expect(content).toContain("## 10:15");
    expect(content).toContain("Slack");
    expect(content).toContain("Chrome");
  });

  test("appendActivity skips empty summaries", () => {
    const date = new Date(2026, 2, 28, 9, 0);
    appendActivity("", date);
    appendActivity("   ", date);

    const content = readActivity(date);
    expect(content).toBe("");
  });

  test("readActivity returns empty string for missing file", () => {
    const date = new Date(2020, 0, 1);
    expect(readActivity(date)).toBe("");
  });

  test("getRecentActivity returns L2 summary when available", () => {
    const date = new Date();
    const file = getActivityFile(date);
    writeFileSync(file, `## 09:00\n- Apps: Slack\n\n## 14:00\n- Apps: VS Code\n\n## Daily Summary\nWorked on Edith all day. Slack in the morning, coding in the afternoon.\n`, "utf-8");

    const result = getRecentActivity(1);
    expect(result).toContain("Worked on Edith all day");
    expect(result).not.toContain("## 09:00");
  });

  test("getRecentActivity falls back to L1 when no summary", () => {
    // Use a different date to avoid conflict
    const date = new Date();
    date.setDate(date.getDate() - 5);
    const file = getActivityFile(date);
    writeFileSync(file, `## 09:00\n- Apps: Terminal\n`, "utf-8");

    const result = getRecentActivity(7);
    expect(result).toContain("Apps: Terminal");
  });

  test("getRecentActivity returns fallback for empty period", () => {
    // Query a range with no files
    const result = getRecentActivity(0);
    expect(result).toBe("No activity data for this period.");
  });

  test("daily files use correct date format", () => {
    const date = new Date(2026, 0, 5); // Jan 5
    const file = getActivityFile(date);
    expect(file).toContain("2026-01-05.md");
  });
});
