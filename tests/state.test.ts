/**
 * Tests for lib/state.ts — event logging, dead letters, offsets, prompt templates.
 *
 * Since state.ts has module-level side effects (mkdirSync, reading offset/session files),
 * we test the core logic by reimplementing the same operations against temp files.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadJson, saveJson } from "../lib/storage";
import { cleanupTestDir, setupTestDir } from "./helpers";

let tempDir: string;

beforeAll(() => {
	tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

describe("event logging", () => {
	let eventsFile: string;
	let evtCounter = 0;

	beforeEach(() => {
		evtCounter++;
		eventsFile = join(tempDir, `events-${Date.now()}-${evtCounter}.jsonl`);
	});

	test("logEvent appends JSONL line with timestamp and type", () => {
		// Reimplement logEvent against temp file
		const logEvent = (type: string, data: Record<string, any> = {}) => {
			appendFileSync(
				eventsFile,
				`${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`,
				"utf-8"
			);
		};

		logEvent("test_event", { foo: "bar" });
		logEvent("another_event", { count: 42 });

		const lines = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);

		const first = JSON.parse(lines[0]);
		expect(first.type).toBe("test_event");
		expect(first.foo).toBe("bar");
		expect(first.ts).toBeTruthy();

		const second = JSON.parse(lines[1]);
		expect(second.type).toBe("another_event");
		expect(second.count).toBe(42);
	});

	test("rotateEvents prunes old lines when file > 1MB", () => {
		// Write a mix of old and recent events
		const oldTs = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago
		const recentTs = new Date().toISOString();

		// Write enough lines to exceed 1MB
		for (let i = 0; i < 8000; i++) {
			appendFileSync(
				eventsFile,
				`${JSON.stringify({ ts: oldTs, type: "old", padding: "x".repeat(120) })}\n`,
				"utf-8"
			);
		}
		for (let i = 0; i < 100; i++) {
			appendFileSync(eventsFile, `${JSON.stringify({ ts: recentTs, type: "recent" })}\n`, "utf-8");
		}

		const sizeBefore = statSync(eventsFile).size;
		expect(sizeBefore).toBeGreaterThan(1_000_000);

		// Reimplement rotateEvents
		const EVENTS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
		const lines = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
		const cutoff = Date.now() - EVENTS_MAX_AGE_MS;
		const recent = lines.filter((line) => {
			try {
				return new Date(JSON.parse(line).ts).getTime() > cutoff;
			} catch {
				return false;
			}
		});
		writeFileSync(eventsFile, `${recent.join("\n")}\n`, "utf-8");

		const linesAfter = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
		// Old lines should be pruned, only recent ones remain
		expect(linesAfter.length).toBeLessThanOrEqual(110); // ~100 recent + small margin
		expect(linesAfter.length).toBeGreaterThanOrEqual(90);
		// All remaining should be recent type
		for (const line of linesAfter) {
			expect(JSON.parse(line).type).toBe("recent");
		}
	});
});

describe("dead letter queue", () => {
	let dlFile: string;

	beforeEach(() => {
		dlFile = join(tempDir, `dead-letters-${Date.now()}.json`);
	});

	test("save / load / clear lifecycle", () => {
		// Save
		const entry = { ts: new Date().toISOString(), chatId: 123, message: "hello", error: "timeout" };
		appendFileSync(dlFile, `${JSON.stringify(entry)}\n`, "utf-8");

		// Load
		const loaded = readFileSync(dlFile, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(loaded).toHaveLength(1);
		expect(loaded[0].chatId).toBe(123);
		expect(loaded[0].message).toBe("hello");

		// Clear
		unlinkSync(dlFile);
		expect(existsSync(dlFile)).toBe(false);
	});

	test("multiple dead letters accumulate", () => {
		for (let i = 0; i < 3; i++) {
			appendFileSync(
				dlFile,
				`${JSON.stringify({ ts: new Date().toISOString(), chatId: i, message: `msg${i}`, error: "err" })}\n`,
				"utf-8"
			);
		}
		const loaded = readFileSync(dlFile, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(loaded).toHaveLength(3);
		expect(loaded[2].chatId).toBe(2);
	});
});

describe("offset persistence", () => {
	test("save and read offset", () => {
		const offsetFile = join(tempDir, "tg-offset");
		writeFileSync(offsetFile, "12345", "utf-8");
		const offset = Number(readFileSync(offsetFile, "utf-8").trim());
		expect(offset).toBe(12345);
	});
});

describe("session persistence", () => {
	test("save and clear session", () => {
		const sessionFile = join(tempDir, "session-id");
		writeFileSync(sessionFile, "abc-def-123", "utf-8");
		expect(readFileSync(sessionFile, "utf-8").trim()).toBe("abc-def-123");

		unlinkSync(sessionFile);
		expect(existsSync(sessionFile)).toBe(false);
	});
});

describe("prompt templates", () => {
	test("loadPrompt reads file and substitutes variables", () => {
		const promptFile = join(tempDir, "test-prompt.md");
		writeFileSync(promptFile, "Hello {{name}}, you have {{count}} items.", "utf-8");

		let content = readFileSync(promptFile, "utf-8");
		const vars: Record<string, string | number> = { name: "Randy", count: 5 };
		for (const [key, value] of Object.entries(vars)) {
			content = content.replaceAll(`{{${key}}}`, String(value));
		}

		expect(content.trim()).toBe("Hello Randy, you have 5 items.");
	});

	test("loadPrompt with no vars returns raw content", () => {
		const promptFile = join(tempDir, "raw-prompt.md");
		writeFileSync(promptFile, "No vars here, just text.", "utf-8");
		const content = readFileSync(promptFile, "utf-8").trim();
		expect(content).toBe("No vars here, just text.");
	});
});

describe("active processes", () => {
	test("write and read active processes", () => {
		const apFile = join(tempDir, "active-processes.json");

		const processes = [
			{
				pid: 1,
				label: "morning-brief",
				startedAt: new Date().toISOString(),
				prompt: "do morning stuff",
			},
			{ pid: 2, label: "message", startedAt: new Date().toISOString(), prompt: "handle user msg" },
		];
		saveJson(apFile, processes);

		const loaded = loadJson<typeof processes>(apFile, []);
		expect(loaded).toHaveLength(2);
		expect(loaded[0].label).toBe("morning-brief");
		expect(loaded[1].pid).toBe(2);
	});
});
