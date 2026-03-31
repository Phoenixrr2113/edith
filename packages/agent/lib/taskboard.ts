/**
 * Taskboard — shared context file between main session and scheduled tasks.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASKBOARD_ARCHIVE_DIR, TASKBOARD_FILE } from "./config";

export function readTaskboard(): string {
	if (!existsSync(TASKBOARD_FILE)) return "";
	try {
		return readFileSync(TASKBOARD_FILE, "utf-8");
	} catch {
		return "";
	}
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

export function archiveTaskboardEntries(
	expiredSections: string[],
	archiveDir: string = TASKBOARD_ARCHIVE_DIR
): void {
	// Filter to only sections with timestamps (skip header-only sections)
	const toArchive = expiredSections.filter((section) =>
		section.match(/^## \d{4}-\d{2}-\d{2}T[\d:.+-]+Z?/)
	);
	if (toArchive.length === 0) return;

	mkdirSync(archiveDir, { recursive: true });

	// Group by YYYY-MM so entries land in the right monthly file
	const byMonth = new Map<string, string[]>();
	for (const section of toArchive) {
		const match = section.match(/^## (\d{4}-\d{2})-\d{2}T/);
		const month = match ? match[1] : new Date().toISOString().slice(0, 7);
		const list = byMonth.get(month) ?? [];
		list.push(section.trim());
		byMonth.set(month, list);
	}

	for (const [month, sections] of byMonth) {
		const archiveFile = join(archiveDir, `${month}.md`);
		const date = sections[0].match(/^## (\d{4}-\d{2}-\d{2})/)?.[1] ?? month;
		const header = `\n## ${date}\n\n`;
		appendFileSync(archiveFile, `${header + sections.join("\n\n")}\n`, "utf-8");
	}
}

export function rotateTaskboard(): void {
	const content = readTaskboard();
	if (!content.trim()) return;

	const cutoff = Date.now() - 12 * 60 * 60 * 1000;
	const sections = content.split(/(?=^## )/m);

	const expired: string[] = [];
	const recent = sections.filter((section) => {
		const match = section.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/);
		if (!match) return true;
		const isRecent = new Date(match[1]).getTime() > cutoff;
		if (!isRecent) expired.push(section);
		return isRecent;
	});

	// Archive expired entries before discarding them
	if (expired.length > 0) archiveTaskboardEntries(expired);

	// Deduplicate check-reminders — keep only the latest
	const deduped: string[] = [];
	let lastReminder: string | null = null;
	for (const section of recent) {
		if (section.includes("— check-reminders")) {
			lastReminder = section;
		} else {
			if (lastReminder) {
				deduped.push(lastReminder);
				lastReminder = null;
			}
			deduped.push(section);
		}
	}
	if (lastReminder) deduped.push(lastReminder);

	const trimmed = deduped.join("\n").trim();
	writeFileSync(TASKBOARD_FILE, trimmed ? `# Taskboard\n\n${trimmed}\n` : "# Taskboard\n", "utf-8");
}

export function getTaskboardArchive(month?: string): string {
	const target = month ?? new Date().toISOString().slice(0, 7);
	const archiveFile = join(TASKBOARD_ARCHIVE_DIR, `${target}.md`);
	if (!existsSync(archiveFile)) return "";
	try {
		return readFileSync(archiveFile, "utf-8");
	} catch {
		return "";
	}
}
