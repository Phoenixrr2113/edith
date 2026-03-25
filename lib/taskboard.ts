/**
 * Taskboard — shared context file between main session and scheduled tasks.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { TASKBOARD_FILE } from "./state";

export function readTaskboard(): string {
  if (!existsSync(TASKBOARD_FILE)) return "";
  try { return readFileSync(TASKBOARD_FILE, "utf-8"); } catch { return ""; }
}

export function getRecentTaskboardEntries(): string {
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

export function rotateTaskboard(): void {
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
  writeFileSync(TASKBOARD_FILE, trimmed ? `# Taskboard\n\n${trimmed}\n` : "# Taskboard\n", "utf-8");
}
