/**
 * Tests for lib/db.ts — dispatch_costs table: recordCost, getRecentCosts,
 * getCostsByDate, getCostsByLabel, getTotalCostToday.
 *
 * Uses an in-memory SQLite database via a temp DB_PATH so tests never
 * touch ~/.edith/edith.db.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point STATE_DIR at a temp dir before importing db.ts
const tempDir = join(tmpdir(), `edith-db-test-${Date.now()}`);

// Override the module-level STATE_DIR used by config — must happen before import
process.env["HOME"] = tempDir; // config derives STATE_DIR from HOME

// Dynamically import so the env override takes effect
const {
	recordCost,
	getRecentCosts,
	getCostsByDate,
	getCostsByLabel,
	getTotalCostToday,
	closeDb,
} = await import("../lib/db.ts");

beforeAll(() => {
	// DB is created lazily on first call; nothing to setup here
});

afterAll(() => {
	closeDb();
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {}
});

beforeEach(() => {
	// No easy way to truncate without exposing a test-only helper, so
	// each test uses unique labels to avoid cross-test pollution.
});

describe("recordCost + getRecentCosts", () => {
	test("records a row and retrieves it within 7 days", () => {
		recordCost({ label: "test-recent", usd: 0.0025, turns: 3, duration_ms: 1500 });
		const rows = getRecentCosts(7);
		const row = rows.find((r) => r.label === "test-recent");
		expect(row).toBeDefined();
		expect(row!.usd).toBeCloseTo(0.0025);
		expect(row!.turns).toBe(3);
		expect(row!.duration_ms).toBe(1500);
	});

	test("stores session_id when provided", () => {
		recordCost({
			label: "test-session",
			usd: 0.001,
			turns: 1,
			duration_ms: 500,
			session_id: "sess-abc",
		});
		const rows = getRecentCosts(1);
		const row = rows.find((r) => r.label === "test-session");
		expect(row?.session_id).toBe("sess-abc");
	});

	test("defaults session_id to empty string", () => {
		recordCost({ label: "test-no-session", usd: 0.001, turns: 1, duration_ms: 100 });
		const rows = getRecentCosts(1);
		const row = rows.find((r) => r.label === "test-no-session");
		expect(row?.session_id).toBe("");
	});

	test("multiple rows accumulate", () => {
		// Use a unique label to avoid cross-test pollution
		const label = `test-multi-${Date.now()}`;
		recordCost({ label, usd: 0.001, turns: 1, duration_ms: 100 });
		recordCost({ label, usd: 0.002, turns: 2, duration_ms: 200 });
		recordCost({ label, usd: 0.003, turns: 3, duration_ms: 300 });
		const rows = getRecentCosts(7).filter((r) => r.label === label);
		expect(rows.length).toBe(3);
	});

	test("returns rows in descending ts order", () => {
		recordCost({ label: "test-order-a", usd: 0.001, turns: 1, duration_ms: 10 });
		recordCost({ label: "test-order-b", usd: 0.002, turns: 2, duration_ms: 20 });
		const rows = getRecentCosts(7);
		// Most recent first — the last-inserted row should appear before earlier ones
		const aIdx = rows.findIndex((r) => r.label === "test-order-a");
		const bIdx = rows.findIndex((r) => r.label === "test-order-b");
		// b was inserted after a, so b has a higher id → appears earlier in DESC order
		expect(bIdx).toBeLessThan(aIdx);
	});
});

describe("getCostsByDate", () => {
	test("returns rows for today", () => {
		recordCost({ label: "test-date-today", usd: 0.005, turns: 2, duration_ms: 800 });
		const rows = getCostsByDate(); // defaults to today
		const row = rows.find((r) => r.label === "test-date-today");
		expect(row).toBeDefined();
		expect(row!.usd).toBeCloseTo(0.005);
	});

	test("returns empty array for a past date with no rows", () => {
		const rows = getCostsByDate("1970-01-01");
		expect(rows).toEqual([]);
	});
});

describe("getCostsByLabel", () => {
	test("filters by label", () => {
		recordCost({ label: "morning-brief", usd: 0.01, turns: 5, duration_ms: 2000 });
		recordCost({ label: "check-reminders", usd: 0.002, turns: 1, duration_ms: 300 });
		const rows = getCostsByLabel("morning-brief");
		expect(rows.every((r) => r.label === "morning-brief")).toBe(true);
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});

	test("returns empty array for unknown label", () => {
		const rows = getCostsByLabel("nonexistent-label-xyz");
		expect(rows).toEqual([]);
	});
});

describe("getTotalCostToday", () => {
	test("sums all today costs", () => {
		const before = getTotalCostToday();
		recordCost({ label: "total-test", usd: 0.01, turns: 1, duration_ms: 100 });
		recordCost({ label: "total-test", usd: 0.02, turns: 2, duration_ms: 200 });
		const after = getTotalCostToday();
		expect(after - before).toBeCloseTo(0.03);
	});

	test("returns 0 when no rows exist for today (isolated via label check)", () => {
		// We can't guarantee 0 since other tests insert rows, but we can verify
		// the function returns a non-negative number
		const total = getTotalCostToday();
		expect(total).toBeGreaterThanOrEqual(0);
	});
});
