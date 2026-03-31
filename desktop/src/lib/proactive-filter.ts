/**
 * ProactiveFilter — the "Bonzi test".
 *
 * Every proactive action must pass this filter before being shown to Randy.
 * The rule (from docs/screen-awareness.md):
 *   "Would Bonzi Buddy do this? Don't. Would a thoughtful EA? Do it."
 *
 * Scores actions 0-100 on three axes:
 *   urgency       (0-40) — how time-sensitive is this?
 *   novelty       (0-40) — has Randy seen this recently?
 *   actionability (0-20) — is there something concrete Randy can do?
 *
 * Sensitivity thresholds:
 *   conservative (default) — 70  (only genuinely useful interruptions pass)
 *   balanced               — 50
 *   aggressive             — 30  (most non-obvious suggestions pass)
 *
 * Issue: SCREEN-BONZI-101
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type BonziSensitivity = "conservative" | "balanced" | "aggressive";

export interface BonziAction {
	/** Logical category of the action (e.g. "meeting-prep", "deadline", "suggestion") */
	category: string;
	/** Human-readable description of what would be shown to Randy */
	description: string;
	/**
	 * Urgency score pre-calculated by the caller (0-40).
	 * 0 = purely cosmetic / informational
	 * 40 = time-critical (meeting starts in 2 min, deadline in < 1h)
	 */
	urgency: number;
	/**
	 * Optional: ISO timestamp of the last time an action in this category
	 * was shown. Used for novelty scoring.
	 */
	lastShownAt?: string;
	/**
	 * Optional: whether this action has a concrete next step.
	 * true  → actionability score = 20
	 * false → actionability score = 0
	 * omitted → moderate score (10)
	 */
	hasConcreteAction?: boolean;
}

export interface BonziVerdict {
	/** Whether the action should be shown. */
	passes: boolean;
	/** Human-readable explanation of the decision. */
	reason: string;
	/** Composite score (0-100). */
	score: number;
	/** The threshold that was applied. */
	threshold: number;
}

// ── Sensitivity → threshold mapping ──────────────────────────────────────────

const THRESHOLD: Record<BonziSensitivity, number> = {
	conservative: 70,
	balanced: 50,
	aggressive: 30,
};

// ── Category hard-rules ───────────────────────────────────────────────────────

/**
 * Categories that are NEVER shown regardless of score.
 * These are classic Bonzi moves: stating the obvious.
 */
const ALWAYS_BLOCKED_CATEGORIES: string[] = [
	"obvious", // "you're in VS Code"
	"idle-reminder", // "you've been on Twitter" without a concrete suggestion
	"status", // pure status announcements
];

/**
 * Categories that ALWAYS pass (time-critical, cannot be suppressed).
 * Score check is skipped for these.
 */
const ALWAYS_ALLOWED_CATEGORIES: string[] = [
	"emergency",
	"calendar-imminent", // meeting starts ≤ 5 min
];

// ── Repeat suppression ────────────────────────────────────────────────────────

/** How long (ms) before the same category can fire again (default 30 min). */
const DEFAULT_REPEAT_GAP_MS = 30 * 60 * 1000;

// ── ProactiveFilter class ─────────────────────────────────────────────────────

export class ProactiveFilter {
	private sensitivity: BonziSensitivity;
	/** In-memory record of the last time each category was shown (ISO string). */
	private lastShown: Map<string, number> = new Map();

	constructor(sensitivity: BonziSensitivity = "conservative") {
		this.sensitivity = sensitivity;
	}

	/**
	 * Change the sensitivity level at runtime.
	 */
	setSensitivity(level: BonziSensitivity): void {
		this.sensitivity = level;
	}

	getSensitivity(): BonziSensitivity {
		return this.sensitivity;
	}

	/**
	 * The Bonzi test.
	 *
	 * Returns a BonziVerdict. When `passes` is false, log the result and discard
	 * the action. When `passes` is true, show it — and call `markShown()` after
	 * delivery so the repeat suppression window resets.
	 */
	evaluate(action: BonziAction): BonziVerdict {
		const threshold = THRESHOLD[this.sensitivity];

		// Hard block
		if (ALWAYS_BLOCKED_CATEGORIES.includes(action.category)) {
			return {
				passes: false,
				reason: `Category "${action.category}" is always blocked (Bonzi move).`,
				score: 0,
				threshold,
			};
		}

		// Hard allow
		if (ALWAYS_ALLOWED_CATEGORIES.includes(action.category)) {
			return {
				passes: true,
				reason: `Category "${action.category}" bypasses Bonzi test (time-critical).`,
				score: 100,
				threshold,
			};
		}

		// Score calculation
		const urgencyScore = this._urgencyScore(action);
		const noveltyScore = this._noveltyScore(action);
		const actionabilityScore = this._actionabilityScore(action);
		const score = urgencyScore + noveltyScore + actionabilityScore;

		if (score >= threshold) {
			return {
				passes: true,
				reason: `Score ${score} >= threshold ${threshold} (urgency=${urgencyScore}, novelty=${noveltyScore}, actionability=${actionabilityScore}).`,
				score,
				threshold,
			};
		}

		return {
			passes: false,
			reason: `Score ${score} < threshold ${threshold} — suppressed (urgency=${urgencyScore}, novelty=${noveltyScore}, actionability=${actionabilityScore}).`,
			score,
			threshold,
		};
	}

	/**
	 * Record that an action in `category` was shown now.
	 * Call this after successfully delivering the action to Randy.
	 */
	markShown(category: string): void {
		this.lastShown.set(category, Date.now());
	}

	// ── Scoring helpers ────────────────────────────────────────────────────────

	private _urgencyScore(action: BonziAction): number {
		// Clamp caller-supplied urgency to [0, 40]
		return Math.min(40, Math.max(0, action.urgency));
	}

	private _noveltyScore(action: BonziAction): number {
		// Use the in-memory map first, then fall back to caller-supplied lastShownAt
		const lastMs =
			this.lastShown.get(action.category) ??
			(action.lastShownAt ? new Date(action.lastShownAt).getTime() : null);

		if (lastMs === null) {
			// Never shown — maximum novelty
			return 40;
		}

		const ageMs = Date.now() - lastMs;

		if (ageMs < 5 * 60 * 1000) {
			// < 5 min ago — near-zero novelty
			return 0;
		}
		if (ageMs < DEFAULT_REPEAT_GAP_MS) {
			// 5–30 min ago — partial credit, linear interpolation
			const fraction = (ageMs - 5 * 60 * 1000) / (DEFAULT_REPEAT_GAP_MS - 5 * 60 * 1000);
			return Math.round(fraction * 20); // max 20 during cooldown
		}

		// > 30 min — full novelty
		return 40;
	}

	private _actionabilityScore(action: BonziAction): number {
		if (action.hasConcreteAction === true) return 20;
		if (action.hasConcreteAction === false) return 0;
		// Omitted — moderate
		return 10;
	}
}

// ── Module-level singleton + convenience export ───────────────────────────────

/** Shared filter instance. Sensitivity defaults to conservative. */
export const proactiveFilter = new ProactiveFilter("conservative");

/**
 * Convenience wrapper around the shared filter.
 * Logs suppressed actions to console.info for threshold tuning.
 *
 * @example
 * const verdict = passesBonziTest({
 *   category: 'meeting-prep',
 *   description: 'Prepped talking points for 2pm call with Chris',
 *   urgency: 30,
 *   hasConcreteAction: true,
 * });
 * if (verdict.passes) showNotification(...);
 */
export function passesBonziTest(action: BonziAction): BonziVerdict {
	const verdict = proactiveFilter.evaluate(action);

	if (!verdict.passes) {
		console.info("[bonzi-suppressed]", {
			category: action.category,
			score: verdict.score,
			threshold: verdict.threshold,
			reason: verdict.reason,
		});
	}

	return verdict;
}

/**
 * Change the global Bonzi sensitivity level.
 *
 * @param level  'conservative' (default, threshold 70) |
 *               'balanced' (50) | 'aggressive' (30)
 */
export function setBonziSensitivity(level: BonziSensitivity): void {
	proactiveFilter.setSensitivity(level);
}
