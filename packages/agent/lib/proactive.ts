/**
 * Proactive intervention tracker — cooldowns, rate limits, quiet hours.
 * Prevents notification fatigue while allowing Edith to act without being asked.
 */
import {
	PROACTIVE_COOLDOWN_MINUTES,
	PROACTIVE_MAX_PER_HOUR,
	PROACTIVE_QUIET_END,
	PROACTIVE_QUIET_START,
} from "./config";
import { kvGet, openDatabase } from "./db";

interface Intervention {
	timestamp: string;
	category: string;
	message: string;
}

interface ProactiveConfig {
	maxPerHour: number;
	cooldownMinutes: number;
	quietHoursStart: number; // 24h format
	quietHoursEnd: number;
}

const DEFAULT_CONFIG: ProactiveConfig = {
	maxPerHour: PROACTIVE_MAX_PER_HOUR,
	cooldownMinutes: PROACTIVE_COOLDOWN_MINUTES,
	quietHoursStart: PROACTIVE_QUIET_START,
	quietHoursEnd: PROACTIVE_QUIET_END,
};

function loadInterventions(): Intervention[] {
	try {
		const db = openDatabase();
		type Row = { ts: string; category: string; message: string };
		const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		return db
			.query<Row, [string]>(
				"SELECT ts, category, message FROM proactive_state WHERE ts > ? ORDER BY ts"
			)
			.all(cutoff)
			.map((r) => ({ timestamp: r.ts, category: r.category, message: r.message }));
	} catch {
		return [];
	}
}

function appendIntervention(category: string, message: string): void {
	try {
		const db = openDatabase();
		const ts = new Date().toISOString();
		db.run("INSERT INTO proactive_state (ts, category, message) VALUES (?, ?, ?)", [
			ts,
			category,
			message,
		]);
		// Prune rows older than 24h
		const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		db.run("DELETE FROM proactive_state WHERE ts <= ?", [cutoff]);
	} catch {}
}

/**
 * Check if a proactive intervention is allowed right now.
 */
export function canIntervene(category?: string): { allowed: boolean; reason?: string } {
	// Check proactive toggle
	const enabledRaw = kvGet("proactive_enabled");
	if (enabledRaw === "false") {
		return { allowed: false, reason: "proactive disabled" };
	}

	const config = DEFAULT_CONFIG;
	const now = new Date();
	const hour = now.getHours();

	// Quiet hours
	if (config.quietHoursStart > config.quietHoursEnd) {
		// Wraps midnight (e.g. 22–8)
		if (hour >= config.quietHoursStart || hour < config.quietHoursEnd) {
			return { allowed: false, reason: "quiet hours" };
		}
	} else {
		if (hour >= config.quietHoursStart && hour < config.quietHoursEnd) {
			return { allowed: false, reason: "quiet hours" };
		}
	}

	const interventions = loadInterventions();
	const oneHourAgo = now.getTime() - 60 * 60 * 1000;

	// Rate limit: max interventions per hour
	const recentCount = interventions.filter(
		(i) => new Date(i.timestamp).getTime() > oneHourAgo
	).length;
	if (recentCount >= config.maxPerHour) {
		return { allowed: false, reason: `rate limit (${recentCount}/${config.maxPerHour} this hour)` };
	}

	// Cooldown per category
	if (category) {
		const cooldownMs = config.cooldownMinutes * 60 * 1000;
		const lastSameCategory = interventions
			.filter((i) => i.category === category)
			.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

		if (
			lastSameCategory &&
			now.getTime() - new Date(lastSameCategory.timestamp).getTime() < cooldownMs
		) {
			return { allowed: false, reason: `cooldown (${category})` };
		}
	}

	return { allowed: true };
}

/**
 * Record that an intervention was made.
 */
export function recordIntervention(category: string, message: string): void {
	appendIntervention(category, message.slice(0, 200));
}

/**
 * Get recent intervention history (for Claude to check what it already suggested).
 */
export function getInterventionHistory(hours: number = 4): Intervention[] {
	try {
		const db = openDatabase();
		type Row = { ts: string; category: string; message: string };
		const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
		return db
			.query<Row, [string]>(
				"SELECT ts, category, message FROM proactive_state WHERE ts > ? ORDER BY ts DESC"
			)
			.all(cutoff)
			.map((r) => ({ timestamp: r.ts, category: r.category, message: r.message }));
	} catch {
		return [];
	}
}
