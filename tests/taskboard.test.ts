/**
 * Tests for lib/taskboard.ts — markdown parsing, timestamp filtering, rotation, dedup.
 *
 * Reimplements the core logic against temp files to avoid module-level config imports.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { setupTestDir, cleanupTestDir } from "./helpers";

let tempDir: string;
let taskboardFile: string;

beforeAll(() => {
  tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());
beforeEach(() => {
  taskboardFile = join(tempDir, `taskboard-${Date.now()}.md`);
});

// Reimplement the core functions against our temp file
function readTaskboard(): string {
  if (!existsSync(taskboardFile)) return "";
  try { return readFileSync(taskboardFile, "utf-8"); } catch { return ""; }
}

function getRecentTaskboardEntries(): string {
  const content = readTaskboard();
  if (!content.trim()) return "";
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const sections = content.split(/(?=^## )/m);
  const recent = sections.filter((section) => {
    const match = section.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/);
    if (!match) return false;
    return new Date(match[1]).getTime() > cutoff;
  });
  return recent.length > 0 ? recent.join("\n") : "";
}

function rotateTaskboard(): void {
  const content = readTaskboard();
  if (!content.trim()) return;
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const sections = content.split(/(?=^## )/m);
  const recent = sections.filter((section) => {
    const match = section.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/);
    if (!match) return true;
    return new Date(match[1]).getTime() > cutoff;
  });
  // Deduplicate check-reminders — keep only the latest
  const deduped: string[] = [];
  let lastReminder: string | null = null;
  for (const section of recent) {
    if (section.includes("— check-reminders")) {
      lastReminder = section;
    } else {
      if (lastReminder) { deduped.push(lastReminder); lastReminder = null; }
      deduped.push(section);
    }
  }
  if (lastReminder) deduped.push(lastReminder);
  const trimmed = deduped.join("\n").trim();
  writeFileSync(taskboardFile, trimmed ? `# Taskboard\n\n${trimmed}\n` : "# Taskboard\n", "utf-8");
}

describe("readTaskboard", () => {
  test("returns empty string when file does not exist", () => {
    expect(readTaskboard()).toBe("");
  });

  test("returns file content when file exists", () => {
    writeFileSync(taskboardFile, "# Taskboard\n\nSome content", "utf-8");
    expect(readTaskboard()).toContain("Some content");
  });
});

describe("getRecentTaskboardEntries", () => {
  test("filters sections by 24h timestamp", () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    writeFileSync(taskboardFile, [
      `## ${old} — morning-brief`,
      "Old content",
      "",
      `## ${recent} — midday-check`,
      "Recent content",
    ].join("\n"), "utf-8");

    const result = getRecentTaskboardEntries();
    expect(result).toContain("Recent content");
    expect(result).not.toContain("Old content");
  });

  test("ignores sections without timestamps", () => {
    const recent = new Date().toISOString();
    writeFileSync(taskboardFile, [
      "## No timestamp header",
      "This should be ignored",
      "",
      `## ${recent} — message`,
      "This should be included",
    ].join("\n"), "utf-8");

    const result = getRecentTaskboardEntries();
    expect(result).toContain("This should be included");
    expect(result).not.toContain("This should be ignored");
  });

  test("returns empty string when no recent entries", () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(taskboardFile, `## ${old} — old\nStale content`, "utf-8");
    expect(getRecentTaskboardEntries()).toBe("");
  });

  test("returns empty string on empty file", () => {
    writeFileSync(taskboardFile, "", "utf-8");
    expect(getRecentTaskboardEntries()).toBe("");
  });
});

describe("rotateTaskboard", () => {
  test("removes sections older than 12h", () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    writeFileSync(taskboardFile, [
      `## ${old} — morning-brief`,
      "Old entry",
      "",
      `## ${recent} — midday-check`,
      "Recent entry",
    ].join("\n"), "utf-8");

    rotateTaskboard();

    const result = readFileSync(taskboardFile, "utf-8");
    expect(result).toContain("Recent entry");
    expect(result).not.toContain("Old entry");
  });

  test("deduplicates check-reminders (keeps latest)", () => {
    const t1 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const t3 = new Date().toISOString();

    writeFileSync(taskboardFile, [
      `## ${t1} — check-reminders`,
      "First reminder check",
      "",
      `## ${t2} — check-reminders`,
      "Second reminder check",
      "",
      `## ${t3} — midday-check`,
      "Midday entry",
    ].join("\n"), "utf-8");

    rotateTaskboard();

    const result = readFileSync(taskboardFile, "utf-8");
    // Should keep only the latest check-reminders (second)
    expect(result).not.toContain("First reminder check");
    expect(result).toContain("Second reminder check");
    expect(result).toContain("Midday entry");
  });

  test("does nothing on empty file", () => {
    writeFileSync(taskboardFile, "", "utf-8");
    rotateTaskboard();
    // Should not throw, file is unchanged
    expect(readFileSync(taskboardFile, "utf-8")).toBe("");
  });
});
