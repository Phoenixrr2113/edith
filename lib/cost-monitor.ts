/**
 * Daily cost limit monitoring.
 *
 * Checks today's total spend against DAILY_COST_LIMIT_USD.
 * Sends a Telegram alert and logs to BetterStack when the limit is first crossed.
 * Alert fires at most once per calendar day (tracked via an in-memory flag reset at midnight).
 */
import { CHAT_ID, DAILY_COST_LIMIT_USD } from "./config";
import { getTotalCostToday } from "./db";
import { logger } from "./logger";
import { sendMessage } from "./telegram";

// --- In-memory dedup ---
/** Date string (YYYY-MM-DD) of the last day an alert was sent. Empty = never. */
let _alertSentDate = "";

/** Reset the alert flag — exported for testing. */
export function _resetAlertFlag(): void {
	_alertSentDate = "";
}

export interface CostBudgetStatus {
	overBudget: boolean;
	totalToday: number;
	budget: number;
	percentUsed: number;
}

/**
 * Returns the current cost-vs-budget status without sending any alerts.
 * Safe to call at any frequency.
 */
export function checkCostBudget(): CostBudgetStatus {
	const totalToday = getTotalCostToday();
	const budget = DAILY_COST_LIMIT_USD;
	const percentUsed = budget > 0 ? (totalToday / budget) * 100 : 0;
	const overBudget = totalToday > budget;
	return { overBudget, totalToday, budget, percentUsed };
}

/**
 * Checks the daily cost limit and fires a Telegram + BetterStack alert
 * if the limit is exceeded — at most once per calendar day.
 *
 * Called from lib/tick.ts on every scheduler tick (hourly gate is in the scheduler).
 */
export async function checkDailyCostLimit(): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);
	const { overBudget, totalToday, budget, percentUsed } = checkCostBudget();

	if (!overBudget) {
		// If we've rolled into a new day, reset the flag so tomorrow's alert can fire
		if (_alertSentDate && _alertSentDate !== today) {
			_alertSentDate = "";
		}
		return;
	}

	// Already alerted today — don't spam
	if (_alertSentDate === today) return;

	_alertSentDate = today;

	const msg =
		`⚠️ *Daily cost limit reached*\n` +
		`Spent: $${totalToday.toFixed(4)} / $${budget.toFixed(2)} (${percentUsed.toFixed(0)}%)\n` +
		`Non-critical background tasks will be skipped for the rest of today.`;

	logger.warn("[cost-monitor] Daily cost limit exceeded", {
		totalToday,
		budget,
		percentUsed: percentUsed.toFixed(1),
	});

	if (CHAT_ID) {
		try {
			await sendMessage(CHAT_ID, msg);
		} catch (err) {
			logger.error("[cost-monitor] Failed to send Telegram alert", { error: String(err) });
		}
	}
}
