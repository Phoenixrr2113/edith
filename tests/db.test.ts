/**
 * Tests for lib/db.ts — dispatch_costs table: recordCost, getRecentCosts,
 * getCostsByDate, getCostsByLabel, getTotalCostToday.
 *
 * Uses openDatabase(pathOverride) to isolate from ~/.edith/edith.db.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	openDatabase,
	recordCost,
	getRecentCosts,
	getCostsByDate,
	getCostsByLabel,
	getTotalCostToday,
	closeDb,
} from "../lib/db";

// Force an isolated temp DB before any test runs
const tempDir = join(tmpdir(), `edith-db-test-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });
openDatabase(join(tempDir, "test.db"));

afterAll(() => {
	closeDb();
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {}
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
		const aIdx = rows.findIndex((r) => r.label === "test-order-a");
		const bIdx = rows.findIndex((r) => r.label === "test-order-b");
		expect(bIdx).toBeLessThan(aIdx);
	});
});

describe("getCostsByDate", () => {
	test("returns rows for today", () => {
		recordCost({ label: "test-date-today", usd: 0.005, turns: 2, duration_ms: 800 });
		const rows = getCostsByDate();
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

	test("returns a non-negative number", () => {
		const total = getTotalCostToday();
		expect(total).toBeGreaterThanOrEqual(0);
	});
});
