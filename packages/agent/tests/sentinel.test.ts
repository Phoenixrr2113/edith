/**
 * Tests for lib/sentinel.ts — local checks (format, dedup, timing, system health).
 *
 * Strategy: test the pure functions that don't need LLM calls or file I/O.
 * The LLM evaluation and event log reading are integration-level concerns.
 */
import { describe, expect, test } from "bun:test";
import { checkDedup, checkFormatRules, checkSystemHealth, checkTiming } from "../lib/sentinel";

// ─── checkFormatRules ─────────────────────────────────────────────────────────

describe("checkFormatRules", () => {
	test("passes clean, short message", () => {
		const msg = `📋 Midday Check — 12:07 PM EDT

• **Railway** deploy stable since morning
• Calendar clear this afternoon`;

		const issues = checkFormatRules(msg);
		expect(issues.filter((i) => i.type === "format" && i.severity === "high")).toHaveLength(0);
	});

	test("flags very long messages", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `• Line ${i + 1} content here`);
		const msg = lines.join("\n");

		const issues = checkFormatRules(msg);
		const lineIssue = issues.find((i) => i.description.includes("lines"));
		expect(lineIssue).toBeDefined();
		expect(lineIssue?.severity).toBe("high");
	});

	test("flags banned openers", () => {
		const msg = "Good morning Randy! Here's your update...";
		const issues = checkFormatRules(msg);
		const openerIssue = issues.find((i) => i.description.includes("banned opener"));
		expect(openerIssue).toBeDefined();
	});

	test("flags overly long bullets", () => {
		const msg = `📋 Update
• This is a very long bullet point that contains way too many words and should be shortened down significantly to improve readability`;

		const issues = checkFormatRules(msg);
		const bulletIssue = issues.find((i) => i.description.includes("Bullet has"));
		expect(bulletIssue).toBeDefined();
	});

	test("does not flag emoji header lines in line count", () => {
		const msg = `📋 Midday Check — 12:07 PM EDT

• Item one
• Item two
• Item three`;

		const issues = checkFormatRules(msg);
		const lineIssues = issues.filter((i) => i.description.includes("lines"));
		expect(lineIssues).toHaveLength(0);
	});
});

// ─── checkDedup ───────────────────────────────────────────────────────────────

describe("checkDedup", () => {
	test("detects duplicate phrases across messages", () => {
		const current = "Walgreens prescription is out of stock, need replacement pharmacy";
		const recent = ["[2026-04-01T08:03:00Z] message_sent: Walgreens prescription is out of stock"];

		const issues = checkDedup(current, recent);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0].type).toBe("dedup");
	});

	test("passes when no overlap", () => {
		const current = "Railway deploy looks stable now";
		const recent = ["[2026-04-01T08:03:00Z] message_sent: Walgreens prescription out of stock"];

		const issues = checkDedup(current, recent);
		expect(issues).toHaveLength(0);
	});

	test("passes with empty recent messages", () => {
		const issues = checkDedup("Any message here", []);
		expect(issues).toHaveLength(0);
	});
});

// ─── checkTiming ──────────────────────────────────────────────────────────────

describe("checkTiming", () => {
	test("flags morning-brief firing at wrong time", () => {
		// 3 PM is wrong for morning-brief
		const issues = checkTiming(
			"Morning brief content",
			"morning-brief",
			"2026-04-01T15:00:00.000Z", // 3 PM
			"America/New_York"
		);

		const timingIssue = issues.find((i) => i.type === "timing");
		expect(timingIssue).toBeDefined();
		expect(timingIssue?.severity).toBe("high");
	});

	test("passes morning-brief at correct time", () => {
		const issues = checkTiming(
			"Morning brief content",
			"morning-brief",
			"2026-04-01T08:03:00.000Z", // 8 AM
			"America/New_York"
		);

		const timingIssue = issues.find(
			(i) => i.type === "timing" && i.description.includes("fired at")
		);
		expect(timingIssue).toBeUndefined();
	});

	test("flags mismatched label in message text", () => {
		const issues = checkTiming(
			"📋 Midday Check — content here",
			"morning-brief", // label says morning but text says midday
			"2026-04-01T08:03:00.000Z",
			"America/New_York"
		);

		const labelIssue = issues.find(
			(i) => i.severity === "critical" && i.description.includes("wrong time-of-day label")
		);
		expect(labelIssue).toBeDefined();
	});

	test("ignores non-brief labels", () => {
		const issues = checkTiming(
			"Random message",
			"message",
			"2026-04-01T03:00:00.000Z", // 3 AM
			"America/New_York"
		);

		expect(issues).toHaveLength(0);
	});
});

// ─── checkSystemHealth ────────────────────────────────────────────────────────

describe("checkSystemHealth", () => {
	test("flags repeated errors", () => {
		const errors = Array.from(
			{ length: 10 },
			(_, i) => `[2026-04-01T12:0${i}:00Z] auth_device_secret_missing: rejecting all tokens`
		);

		const issues = checkSystemHealth(errors);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0].type).toBe("system_health");
		expect(issues[0].severity).toBe("critical"); // 10+ is critical
	});

	test("flags 5+ errors as high severity", () => {
		const errors = Array.from(
			{ length: 6 },
			(_, i) => `[2026-04-01T12:0${i}:00Z] dispatch_error: timeout`
		);

		const issues = checkSystemHealth(errors);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0].severity).toBe("high");
	});

	test("passes with few errors", () => {
		const errors = [
			"[2026-04-01T12:00:00Z] dispatch_error: timeout",
			"[2026-04-01T12:01:00Z] reflector_generation_failed: model unavailable",
		];

		const issues = checkSystemHealth(errors);
		expect(issues).toHaveLength(0);
	});

	test("passes with empty errors", () => {
		const issues = checkSystemHealth([]);
		expect(issues).toHaveLength(0);
	});
});
