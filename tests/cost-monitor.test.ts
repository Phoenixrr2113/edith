/**
 * Tests for lib/cost-monitor.ts — checkCostBudget() and checkDailyCostLimit().
 *
 * Uses openDatabase(pathOverride) to isolate from ~/.edith/edith.db.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must set env BEFORE importing modules that read it at load time
process.env["TELEGRAM_CHAT_ID"] = "0"; // no-op Telegram calls
process.env["DAILY_COST_LIMIT_USD"] = "1"; // low limit so tests can trip it

import { openDatabase, recordCost, closeDb } from "../lib/db";
import { checkCostBudget, checkDailyCostLimit, _resetAlertFlag } from "../lib/cost-monitor";

// Force an isolated temp DB
const tempDir = join(tmpdir(), `edith-cost-monitor-test-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });
openDatabase(join(tempDir, "test.db"));

afterAll(() => {
	closeDb();
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {}
});

beforeEach(() => {
	_resetAlertFlag();
});

describe("checkCostBudget", () => {
	test("returns a structurally valid budget status", () => {
		const status = checkCostBudget();
		expect(typeof status.budget).toBe("number");
		expect(status.budget).toBeGreaterThan(0);
		expect(typeof status.totalToday).toBe("number");
		expect(typeof status.overBudget).toBe("boolean");
		expect(typeof status.percentUsed).toBe("number");
		expect(status.overBudget).toBe(status.totalToday > status.budget);
	});

	test("detects over-budget after recording costs that exceed the budget", () => {
		const before = checkCostBudget();
		const excess = before.budget + 1;
		recordCost({ label: "cost-monitor-over", usd: excess, turns: 5, duration_ms: 2000 });
		const after = checkCostBudget();
		expect(after.overBudget).toBe(true);
		expect(after.totalToday).toBeGreaterThan(after.budget);
		expect(after.percentUsed).toBeGreaterThan(100);
	});
});

describe("checkDailyCostLimit", () => {
	test("does not throw when called", async () => {
		await expect(checkDailyCostLimit()).resolves.toBeUndefined();
	});

	test("second call on the same day is deduplicated silently", async () => {
		await checkDailyCostLimit();
		await checkDailyCostLimit();
	});
});
