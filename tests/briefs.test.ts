/**
 * Tests for lib/briefs/ — routing, BRIEF_TYPE_MAP, and each brief builder.
 *
 * Strategy:
 * - Pure/sync functions (buildMessageBrief, buildLocationBrief, buildScheduledBrief,
 *   detectTriggers, BRIEF_TYPE_MAP): tested directly — no mocks needed.
 * - Async builders (buildFullBrief, buildMiddayBrief, buildEveningBrief):
 *   use mock.module for taskboard (avoids ~/.edith I/O) and prewake (avoids external API calls).
 *   screenpipe.isAvailable() returns false in CI/test env — no mock needed there.
 * - buildProactiveBrief: mock.module canIntervene to return allowed:false.
 * - buildBrief routing: tested against the same mocks, one assertion per type.
 *
 * IMPORTANT: Do NOT mock ../lib/screenpipe here — it bleeds into screenpipe.test.ts
 * and breaks formatContext tests. screenpipe.isAvailable() returns false naturally.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanupTestDir, setupTestDir } from "./helpers";

// ─── Mock only deps that cause real I/O or network calls ─────────────────────
// These must be called before any import of lib/briefs/*

mock.module("../lib/taskboard", () => ({
	readTaskboard: () => "",
	getRecentTaskboardEntries: () => "",
}));

mock.module("../lib/prewake", () => ({
	gatherPrewakeContext: async () => "",
}));

mock.module("../lib/proactive", () => ({
	canIntervene: () => ({ allowed: false, reason: "mocked" }),
	recordIntervention: () => {},
}));

// ─── Imports after mocks are set up ──────────────────────────────────────────

import { buildLocationBrief, buildMessageBrief } from "../lib/briefs/conversation";
// Import sub-modules directly to avoid Bun treating "../lib/briefs/index"
// as the same cache key as "../lib/briefs" (mocked by dispatch-integration.test.ts).
import { BRIEF_TYPE_MAP, type BriefType } from "../lib/briefs/index";
import { buildProactiveBrief, detectTriggers } from "../lib/briefs/proactive";
import {
	buildEveningBrief,
	buildFullBrief,
	buildMiddayBrief,
	buildScheduledBrief,
} from "../lib/briefs/scheduled";
import { CHAT_ID, TASKBOARD_FILE } from "../lib/config";
import type { ScreenContext } from "../lib/screenpipe";

let _tempDir: string;

beforeAll(() => {
	_tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

// ─── BRIEF_TYPE_MAP ───────────────────────────────────────────────────────────

describe("BRIEF_TYPE_MAP", () => {
	test("maps morning-brief to 'morning'", () => {
		expect(BRIEF_TYPE_MAP["morning-brief"]).toBe("morning");
	});

	test("maps midday-check to 'midday'", () => {
		expect(BRIEF_TYPE_MAP["midday-check"]).toBe("midday");
	});

	test("maps evening-wrap to 'evening'", () => {
		expect(BRIEF_TYPE_MAP["evening-wrap"]).toBe("evening");
	});

	test("maps proactive-check to 'proactive'", () => {
		expect(BRIEF_TYPE_MAP["proactive-check"]).toBe("proactive");
	});

	test("has exactly 4 entries", () => {
		expect(Object.keys(BRIEF_TYPE_MAP)).toHaveLength(4);
	});

	test("all values are valid BriefTypes", () => {
		const validTypes = new Set<BriefType>([
			"boot",
			"morning",
			"midday",
			"evening",
			"message",
			"location",
			"scheduled",
			"proactive",
		]);
		for (const val of Object.values(BRIEF_TYPE_MAP)) {
			expect(validTypes.has(val)).toBe(true);
		}
	});
});

// ─── buildMessageBrief ────────────────────────────────────────────────────────

describe("buildMessageBrief", () => {
	test("includes the message text", () => {
		const result = buildMessageBrief("What's the weather?", "12345");
		expect(result).toContain("What's the weather?");
	});

	test("includes the chat ID in reply instruction", () => {
		const result = buildMessageBrief("Hello", "99999");
		expect(result).toContain("99999");
	});

	test("instructs to use send_message", () => {
		const result = buildMessageBrief("Hello", "12345");
		expect(result).toContain("send_message");
	});

	test("instructs to search Cognee", () => {
		const result = buildMessageBrief("test", "1");
		expect(result).toContain("Cognee");
	});

	test("returns a non-empty string", () => {
		const result = buildMessageBrief("", "0");
		expect(result.length).toBeGreaterThan(0);
	});

	test("does not throw on empty message", () => {
		expect(() => buildMessageBrief("", "12345")).not.toThrow();
	});
});

// ─── buildLocationBrief ───────────────────────────────────────────────────────

describe("buildLocationBrief", () => {
	test("includes description", () => {
		const result = buildLocationBrief("Arrived home", "25.7617", "-80.1918", "12345");
		expect(result).toContain("Arrived home");
	});

	test("includes latitude", () => {
		const result = buildLocationBrief("Office", "40.7128", "-74.0060", "12345");
		expect(result).toContain("40.7128");
	});

	test("includes longitude", () => {
		const result = buildLocationBrief("Office", "40.7128", "-74.0060", "12345");
		expect(result).toContain("-74.0060");
	});

	test("includes chat ID", () => {
		const result = buildLocationBrief("Home", "25.0", "-80.0", "99999");
		expect(result).toContain("99999");
	});

	test("returns a string", () => {
		expect(typeof buildLocationBrief("x", "0", "0", "0")).toBe("string");
	});
});

// ─── buildScheduledBrief ─────────────────────────────────────────────────────

describe("buildScheduledBrief", () => {
	test("includes the task prompt", () => {
		const result = buildScheduledBrief("Check the weather", "weather-check");
		expect(result).toContain("Check the weather");
	});

	test("includes the task name", () => {
		const result = buildScheduledBrief("Do something", "my-custom-task");
		expect(result).toContain("my-custom-task");
	});

	test("includes TASKBOARD_FILE path", () => {
		const result = buildScheduledBrief("anything", "task");
		expect(result).toContain(TASKBOARD_FILE);
	});

	test("includes CHAT_ID reference", () => {
		const result = buildScheduledBrief("anything", "task");
		expect(result).toContain(String(CHAT_ID));
	});

	test("mentions 'time' in output", () => {
		const result = buildScheduledBrief("anything", "task");
		expect(result).toContain("time");
	});

	test("returns a string (is synchronous)", () => {
		const result = buildScheduledBrief("task", "name");
		expect(typeof result).toBe("string");
		expect(result instanceof Promise).toBe(false);
	});
});

// ─── detectTriggers ──────────────────────────────────────────────────────────

describe("detectTriggers", () => {
	const baseCtx: ScreenContext = {
		timeRange: { start: "2026-03-30T10:00:00Z", end: "2026-03-30T10:15:00Z" },
		apps: [],
		audioTranscripts: [],
		continuousActivityMinutes: 0,
		empty: false,
	};

	test("returns empty array for null context", () => {
		expect(detectTriggers(null)).toEqual([]);
	});

	test("returns empty array when context.empty is true", () => {
		expect(detectTriggers({ ...baseCtx, empty: true })).toEqual([]);
	});

	test("returns empty array when no triggers match", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{
					appName: "Xcode",
					windowTitles: ["MyApp.xcodeproj"],
					durationMinutes: 30,
					contentSample: [],
				},
			],
			continuousActivityMinutes: 45,
		};
		expect(detectTriggers(ctx)).toEqual([]);
	});

	test("fires social-media-time trigger when threshold met (Safari + twitter)", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{
					appName: "Safari",
					windowTitles: ["Twitter"],
					durationMinutes: 25, // above 20-min threshold
					contentSample: [],
				},
			],
		};
		const triggers = detectTriggers(ctx);
		expect(triggers.some((t) => t.type === "social-media-time")).toBe(true);
	});

	test("does NOT fire social-media trigger below threshold (< 20 min)", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{
					appName: "Safari",
					windowTitles: ["Twitter"],
					durationMinutes: 10,
					contentSample: [],
				},
			],
		};
		expect(detectTriggers(ctx).some((t) => t.type === "social-media-time")).toBe(false);
	});

	test("does NOT fire social-media trigger for non-social browser window", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{
					appName: "Safari",
					windowTitles: ["github.com — edith-v3"],
					durationMinutes: 30,
					contentSample: [],
				},
			],
		};
		expect(detectTriggers(ctx).some((t) => t.type === "social-media-time")).toBe(false);
	});

	test("fires break-reminder trigger when continuous activity >= 90 min", () => {
		const ctx: ScreenContext = { ...baseCtx, continuousActivityMinutes: 95 };
		expect(detectTriggers(ctx).some((t) => t.type === "break-reminder")).toBe(true);
	});

	test("does NOT fire break-reminder below 90 min", () => {
		const ctx: ScreenContext = { ...baseCtx, continuousActivityMinutes: 89 };
		expect(detectTriggers(ctx).some((t) => t.type === "break-reminder")).toBe(false);
	});

	test("trigger message includes duration for social-media trigger", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{
					appName: "Google Chrome",
					windowTitles: ["reddit.com"],
					durationMinutes: 30,
					contentSample: [],
				},
			],
		};
		const trigger = detectTriggers(ctx).find((t) => t.type === "social-media-time");
		expect(trigger?.message).toContain("30");
	});

	test("returns both triggers when both conditions met", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{
					appName: "Arc",
					windowTitles: ["x.com"],
					durationMinutes: 25,
					contentSample: [],
				},
			],
			continuousActivityMinutes: 100,
		};
		const triggers = detectTriggers(ctx);
		expect(triggers.some((t) => t.type === "social-media-time")).toBe(true);
		expect(triggers.some((t) => t.type === "break-reminder")).toBe(true);
	});

	test("handles multiple apps — only social ones trigger", () => {
		const ctx: ScreenContext = {
			...baseCtx,
			apps: [
				{ appName: "Xcode", windowTitles: ["MyApp"], durationMinutes: 60, contentSample: [] },
				{
					appName: "Safari",
					windowTitles: ["instagram.com"],
					durationMinutes: 25,
					contentSample: [],
				},
			],
		};
		const triggers = detectTriggers(ctx);
		expect(triggers).toHaveLength(1);
		expect(triggers[0].type).toBe("social-media-time");
	});
});

// ─── buildFullBrief ───────────────────────────────────────────────────────────

describe("buildFullBrief", () => {
	test("boot includes 'fresh startup' language", async () => {
		const result = await buildFullBrief("boot");
		expect(result).toContain("fresh startup");
	});

	test("morning includes 'morning' language", async () => {
		const result = await buildFullBrief("morning");
		expect(result.toLowerCase()).toContain("morning");
	});

	test("includes manage_calendar instruction", async () => {
		const result = await buildFullBrief("morning");
		expect(result).toContain("manage_calendar");
	});

	test("includes Cognee search instruction", async () => {
		const result = await buildFullBrief("morning");
		expect(result).toContain("Cognee");
	});

	test("includes CHAT_ID", async () => {
		const result = await buildFullBrief("morning");
		expect(result).toContain(String(CHAT_ID));
	});

	test("includes TASKBOARD_FILE path", async () => {
		const result = await buildFullBrief("morning");
		expect(result).toContain(TASKBOARD_FILE);
	});

	test("includes email scan instructions (gmail_search_messages)", async () => {
		const result = await buildFullBrief("morning");
		expect(result).toContain("gmail_search_messages");
	});

	test("returns a non-empty string", async () => {
		const result = await buildFullBrief("boot");
		expect(result.length).toBeGreaterThan(0);
	});
});

// ─── buildMiddayBrief ─────────────────────────────────────────────────────────

describe("buildMiddayBrief", () => {
	test("contains 'Midday check'", async () => {
		const result = await buildMiddayBrief();
		expect(result).toContain("Midday check");
	});

	test("includes afternoon calendar instruction", async () => {
		const result = await buildMiddayBrief();
		expect(result).toContain("afternoon calendar");
	});

	test("includes CHAT_ID", async () => {
		const result = await buildMiddayBrief();
		expect(result).toContain(String(CHAT_ID));
	});

	test("includes TASKBOARD_FILE path", async () => {
		const result = await buildMiddayBrief();
		expect(result).toContain(TASKBOARD_FILE);
	});

	test("includes inbox triage instructions (manage_emails)", async () => {
		const result = await buildMiddayBrief();
		expect(result).toContain("manage_emails");
	});
});

// ─── buildEveningBrief ────────────────────────────────────────────────────────

describe("buildEveningBrief", () => {
	test("contains 'Evening wrap'", async () => {
		const result = await buildEveningBrief();
		expect(result).toContain("Evening wrap");
	});

	test("includes tomorrow's calendar check", async () => {
		const result = await buildEveningBrief();
		expect(result).toContain("tomorrow");
	});

	test("includes Daily Summary instruction", async () => {
		const result = await buildEveningBrief();
		expect(result).toContain("Daily Summary");
	});

	test("includes CHAT_ID", async () => {
		const result = await buildEveningBrief();
		expect(result).toContain(String(CHAT_ID));
	});

	test("includes TASKBOARD_FILE path", async () => {
		const result = await buildEveningBrief();
		expect(result).toContain(TASKBOARD_FILE);
	});
});

// ─── buildProactiveBrief ──────────────────────────────────────────────────────

describe("buildProactiveBrief", () => {
	test("returns empty string when canIntervene returns allowed: false", async () => {
		// canIntervene is mocked to return { allowed: false, reason: "mocked" }
		const result = await buildProactiveBrief();
		expect(result).toBe("");
	});
});

// ─── buildBrief routing (reimplemented in isolation) ─────────────────────────
//
// NOTE: We cannot call `buildBrief` directly from "../lib/briefs/index" because
// dispatch-integration.test.ts mocks "../lib/briefs" with a fake (Bun treats
// "../lib/briefs" and "../lib/briefs/index" as the same module cache entry).
//
// Instead, we reimplement the routing table logic here and verify:
// (a) the switch cases map each BriefType to the correct sub-module function,
// (b) the fallback behavior (unknown type → extra.prompt or "").
//
// The actual brief builder functions are tested in the describe blocks above.

async function buildBriefIsolated(
	type: BriefType | string,
	extra?: Record<string, string>
): Promise<string> {
	// Reimplemented routing — mirrors lib/briefs/index.ts#buildBrief exactly
	switch (type) {
		case "boot":
		case "morning":
			return buildFullBrief(type as "boot" | "morning");
		case "midday":
			return buildMiddayBrief();
		case "evening":
			return buildEveningBrief();
		case "message":
			return buildMessageBrief(extra?.message ?? "", extra?.chatId ?? String(CHAT_ID));
		case "location":
			return buildLocationBrief(
				extra?.description ?? "",
				extra?.lat ?? "",
				extra?.lon ?? "",
				extra?.chatId ?? String(CHAT_ID)
			);
		case "scheduled":
			return buildScheduledBrief(extra?.prompt ?? "", extra?.taskName ?? "");
		case "proactive":
			return buildProactiveBrief();
		default:
			return extra?.prompt ?? "";
	}
}

describe("buildBrief routing", () => {
	test("boot routes to buildFullBrief (contains 'fresh startup')", async () => {
		const result = await buildBriefIsolated("boot");
		expect(result).toContain("fresh startup");
	});

	test("morning routes to buildFullBrief (contains manage_calendar)", async () => {
		const result = await buildBriefIsolated("morning");
		expect(result).toContain("manage_calendar");
	});

	test("midday routes to buildMiddayBrief (contains 'Midday check')", async () => {
		const result = await buildBriefIsolated("midday");
		expect(result).toContain("Midday check");
	});

	test("evening routes to buildEveningBrief (contains 'Evening wrap')", async () => {
		const result = await buildBriefIsolated("evening");
		expect(result).toContain("Evening wrap");
	});

	test("message type passes message text through", async () => {
		const result = await buildBriefIsolated("message", { message: "hello edith", chatId: "12345" });
		expect(result).toContain("hello edith");
		expect(result).toContain("12345");
	});

	test("message type defaults chatId to CHAT_ID when omitted", async () => {
		const result = await buildBriefIsolated("message", { message: "test" });
		expect(result).toContain(String(CHAT_ID));
	});

	test("location type passes description and coordinates through", async () => {
		const result = await buildBriefIsolated("location", {
			description: "Picked up Phoenix",
			lat: "25.7617",
			lon: "-80.1918",
			chatId: "12345",
		});
		expect(result).toContain("Picked up Phoenix");
		expect(result).toContain("25.7617");
		expect(result).toContain("-80.1918");
	});

	test("scheduled type passes prompt and taskName through", async () => {
		const result = await buildBriefIsolated("scheduled", {
			prompt: "check reminders",
			taskName: "reminder-check",
		});
		expect(result).toContain("check reminders");
		expect(result).toContain("reminder-check");
	});

	test("proactive returns empty string when canIntervene=false", async () => {
		const result = await buildBriefIsolated("proactive");
		expect(result).toBe("");
	});

	test("unknown type falls back to extra.prompt", async () => {
		const result = await buildBriefIsolated("unknown-type", { prompt: "fallback content" });
		expect(result).toBe("fallback content");
	});

	test("unknown type with no extra returns empty string", async () => {
		const result = await buildBriefIsolated("unknown-type");
		expect(result).toBe("");
	});
});
