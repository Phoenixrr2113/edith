/**
 * Schedule Coordinator — prevents duplicate task firing across local & cloud instances.
 *
 * Both instances share the same Postgres DB (via DATABASE_URL).
 * Before dispatching a window-based task, each instance attempts an atomic INSERT.
 * First writer wins (PRIMARY KEY constraint); second sees the conflict and skips.
 *
 * If the DB call fails, falls back gracefully (allows firing with a warning).
 */
import { INSTANCE_ID } from "./config";
import { openDatabase } from "./db";
import { edithLog } from "./edith-logger";

let _schemaApplied = false;

const CLAIMS_SCHEMA = `CREATE TABLE IF NOT EXISTS scheduler_claims (
  task       TEXT NOT NULL,
  fire_date  TEXT NOT NULL,
  instance   TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (task, fire_date)
)`;

function ensureSchema(): void {
	if (_schemaApplied) return;
	try {
		const db = openDatabase();
		db.exec(CLAIMS_SCHEMA);
		_schemaApplied = true;
	} catch (err) {
		edithLog.warn("coordinator_schema_failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Attempt to claim a scheduled task for a given date.
 *
 * @returns true if this instance claimed it (proceed to fire),
 *          false if another instance already claimed it (skip).
 */
export function claimTask(task: string, date: string): boolean {
	ensureSchema();

	const db = openDatabase();

	try {
		// Atomic INSERT — ON CONFLICT DO NOTHING means second writer silently skips.
		// Then SELECT to see who owns the claim.
		const insertSql =
			db.dialect === "postgres"
				? "INSERT INTO scheduler_claims (task, fire_date, instance, claimed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (task, fire_date) DO NOTHING"
				: "INSERT OR IGNORE INTO scheduler_claims (task, fire_date, instance, claimed_at) VALUES (?, ?, ?, ?)";

		const selectSql =
			db.dialect === "postgres"
				? "SELECT instance FROM scheduler_claims WHERE task = $1 AND fire_date = $2"
				: "SELECT instance FROM scheduler_claims WHERE task = ? AND fire_date = ?";

		db.run(insertSql, [task, date, INSTANCE_ID, new Date().toISOString()]);

		const row = db.get<{ instance: string }>(selectSql, [task, date]);

		if (row && row.instance !== INSTANCE_ID) {
			edithLog.info("scheduler_claimed_elsewhere", {
				task,
				date,
				claimedBy: row.instance,
				thisInstance: INSTANCE_ID,
			});
			return false;
		}

		edithLog.info("scheduler_claim_acquired", { task, date, instance: INSTANCE_ID });
		return true;
	} catch (err) {
		// DB error — fall back to firing (better to double-fire than never fire)
		edithLog.warn("coordinator_claim_failed", {
			task,
			date,
			error: err instanceof Error ? err.message : String(err),
			fallback: "fire",
		});
		return true;
	}
}
