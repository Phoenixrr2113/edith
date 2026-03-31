/**
 * Tests for lib/cost-monitor.ts — checkCostBudget() and checkDailyCostLimit().
 *
 * Uses a temp HOME dir so DB writes never touch ~/.edith/edith.db.
 * Telegram calls are intercepted by overriding CHAT_ID to 0.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate DB and suppress Telegram
const tempDir = join(tmpdir(), `edith-cost-monitor-test-${Date.now()}`);
process.env["HOME"] = tempDir;
process.env["TELEGRAM_CHAT_ID"] = "0"; // no-op Telegram calls
process.env["DAILY_COST_LIMIT_USD"] = "1"; // low limit so tests can trip it

const { checkCostBudget, checkDailyCostLimit, _resetAlertFlag } = await import(
	"../lib/cost-monitor.ts"
);
const { recordCost, closeDb } = await import("../lib/db.ts");

beforeAll(() => {
	// DB opened lazily
});

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
		// overBudget must be consistent with the numbers
		expect(status.overBudget).toBe(status.totalToday > status.budget);
	});

	test("detects over-budget after recording costs that exceed the budget", () => {
		const before = checkCostBudget();
		// Record an amount that definitely pushes us over regardless of starting total
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
		await checkDailyCostLimit(); // first call
		await checkDailyCostLimit(); // second call — should be a no-op
		// No assertion on Telegram (CHAT_ID=0), just verify no throw on either call
	});
});
