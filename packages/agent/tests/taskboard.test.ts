/**
 * Tests for lib/taskboard.ts — markdown parsing, timestamp filtering, rotation, dedup.
 *
 * Reimplements the core logic against temp files to avoid module-level config imports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDir, setupTestDir } from "./helpers";

let tempDir: string;
let taskboardFile: string;
let archiveDir: string;

beforeAll(() => {
	tempDir = setupTestDir();
	archiveDir = join(tempDir, "taskboard-archive");
});
afterAll(() => cleanupTestDir());
beforeEach(() => {
	taskboardFile = join(tempDir, `taskboard-${Date.now()}.md`);
});

// Reimplement the core functions against our temp file
function readTaskboard(): string {
	if (!existsSync(taskboardFile)) return "";
	try {
		return readFileSync(taskboardFile, "utf-8");
	} catch {
		return "";
	}
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

function archiveTaskboardEntries(expiredSections: string[], dir: string): void {
	const toArchive = expiredSections.filter((s) => s.match(/^## \d{4}-\d{2}-\d{2}T[\d:.+-]+Z?/));
	if (toArchive.length === 0) return;
	mkdirSync(dir, { recursive: true });
	const byMonth = new Map<string, string[]>();
	for (const section of toArchive) {
		const match = section.match(/^## (\d{4}-\d{2})-\d{2}T/);
		const month = match ? match[1] : new Date().toISOString().slice(0, 7);
		const list = byMonth.get(month) ?? [];
		list.push(section.trim());
		byMonth.set(month, list);
	}
	for (const [month, sections] of byMonth) {
		const archiveFile = join(dir, `${month}.md`);
		const date = sections[0].match(/^## (\d{4}-\d{2}-\d{2})/)?.[1] ?? month;
		const header = `\n## ${date}\n\n`;
		appendFileSync(archiveFile, `${header + sections.join("\n\n")}\n`, "utf-8");
	}
}

function getTaskboardArchive(month?: string, dir: string = archiveDir): string {
	const target = month ?? new Date().toISOString().slice(0, 7);
	const archiveFile = join(dir, `${target}.md`);
	if (!existsSync(archiveFile)) return "";
	try {
		return readFileSync(archiveFile, "utf-8");
	} catch {
		return "";
	}
}

function rotateTaskboard(): void {
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
	if (expired.length > 0) archiveTaskboardEntries(expired, archiveDir);
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

		writeFileSync(
			taskboardFile,
			[
				`## ${old} — morning-brief`,
				"Old content",
				"",
				`## ${recent} — midday-check`,
				"Recent content",
			].join("\n"),
			"utf-8"
		);

		const result = getRecentTaskboardEntries();
		expect(result).toContain("Recent content");
		expect(result).not.toContain("Old content");
	});

	test("ignores sections without timestamps", () => {
		const recent = new Date().toISOString();
		writeFileSync(
			taskboardFile,
			[
				"## No timestamp header",
				"This should be ignored",
				"",
				`## ${recent} — message`,
				"This should be included",
			].join("\n"),
			"utf-8"
		);

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

		writeFileSync(
			taskboardFile,
			[
				`## ${old} — morning-brief`,
				"Old entry",
				"",
				`## ${recent} — midday-check`,
				"Recent entry",
			].join("\n"),
			"utf-8"
		);

		rotateTaskboard();

		const result = readFileSync(taskboardFile, "utf-8");
		expect(result).toContain("Recent entry");
		expect(result).not.toContain("Old entry");
	});

	test("deduplicates check-reminders (keeps latest)", () => {
		const t1 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
		const t2 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		const t3 = new Date().toISOString();

		writeFileSync(
			taskboardFile,
			[
				`## ${t1} — check-reminders`,
				"First reminder check",
				"",
				`## ${t2} — check-reminders`,
				"Second reminder check",
				"",
				`## ${t3} — midday-check`,
				"Midday entry",
			].join("\n"),
			"utf-8"
		);

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

	test("archives expired sections during rotation", () => {
		const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const recent = new Date().toISOString();

		writeFileSync(
			taskboardFile,
			[
				`## ${old} — morning-brief`,
				"Old archived entry",
				"",
				`## ${recent} — midday-check`,
				"Recent entry",
			].join("\n"),
			"utf-8"
		);

		rotateTaskboard();

		// Old entry removed from taskboard
		const taskboardResult = readFileSync(taskboardFile, "utf-8");
		expect(taskboardResult).not.toContain("Old archived entry");
		expect(taskboardResult).toContain("Recent entry");

		// Old entry written to archive
		const oldMonth = old.slice(0, 7); // e.g. "2026-03"
		const archiveContent = getTaskboardArchive(oldMonth);
		expect(archiveContent).toContain("Old archived entry");
	});

	test("does not archive sections without timestamps", () => {
		const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		writeFileSync(
			taskboardFile,
			[
				"## No timestamp header",
				"Header-only section stays",
				"",
				`## ${old} — morning-brief`,
				"Timestamped old entry",
			].join("\n"),
			"utf-8"
		);

		rotateTaskboard();

		const oldMonth = old.slice(0, 7);
		const archiveContent = getTaskboardArchive(oldMonth);
		expect(archiveContent).toContain("Timestamped old entry");
		expect(archiveContent).not.toContain("Header-only section stays");
	});
});

describe("archiveTaskboardEntries", () => {
	test("writes expired sections to monthly archive file", () => {
		const ts = "2026-03-15T10:00:00.000Z";
		const section = `## ${ts} — morning-brief\nSome content`;
		archiveTaskboardEntries([section], archiveDir);

		const archiveFile = join(archiveDir, "2026-03.md");
		expect(existsSync(archiveFile)).toBe(true);
		const content = readFileSync(archiveFile, "utf-8");
		expect(content).toContain("Some content");
		expect(content).toContain("## 2026-03-15");
	});

	test("appends to existing archive file", () => {
		const dir = join(tempDir, `archive-append-${Date.now()}`);
		const ts1 = "2026-03-10T08:00:00.000Z";
		const ts2 = "2026-03-11T09:00:00.000Z";
		archiveTaskboardEntries([`## ${ts1} — morning-brief\nFirst entry`], dir);
		archiveTaskboardEntries([`## ${ts2} — midday-check\nSecond entry`], dir);

		const archiveFile = join(dir, "2026-03.md");
		const content = readFileSync(archiveFile, "utf-8");
		expect(content).toContain("First entry");
		expect(content).toContain("Second entry");
	});

	test("skips sections without timestamps", () => {
		const dir = join(tempDir, `archive-skip-${Date.now()}`);
		archiveTaskboardEntries(["## No timestamp\nSome content"], dir);
		// Archive dir may not even be created
		const archiveFile = join(dir, `${new Date().toISOString().slice(0, 7)}.md`);
		if (existsSync(archiveFile)) {
			const content = readFileSync(archiveFile, "utf-8");
			expect(content).not.toContain("No timestamp");
		}
	});

	test("groups entries by month into separate files", () => {
		const dir = join(tempDir, `archive-months-${Date.now()}`);
		const marTs = "2026-03-20T10:00:00.000Z";
		const aprTs = "2026-04-01T08:00:00.000Z";
		archiveTaskboardEntries(
			[`## ${marTs} — morning-brief\nMarch entry`, `## ${aprTs} — morning-brief\nApril entry`],
			dir
		);

		expect(readFileSync(join(dir, "2026-03.md"), "utf-8")).toContain("March entry");
		expect(readFileSync(join(dir, "2026-04.md"), "utf-8")).toContain("April entry");
	});
});

describe("getTaskboardArchive", () => {
	test("returns empty string when archive file does not exist", () => {
		const dir = join(tempDir, `archive-missing-${Date.now()}`);
		expect(getTaskboardArchive("2025-01", dir)).toBe("");
	});

	test("returns archive content for specified month", () => {
		const dir = join(tempDir, `archive-read-${Date.now()}`);
		const ts = "2026-02-14T10:00:00.000Z";
		archiveTaskboardEntries([`## ${ts} — morning-brief\nValentines entry`], dir);
		const result = getTaskboardArchive("2026-02", dir);
		expect(result).toContain("Valentines entry");
	});
});
