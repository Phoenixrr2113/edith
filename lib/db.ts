/**
 * SQLite persistence layer for Edith.
 * Uses bun:sqlite for zero-dependency local storage.
 *
 * Tables:
 *   dispatch_costs  — per-task cost tracking (one row per dispatchToClaude call)
 *   schedule        — scheduled tasks (replaces schedule.json)
 *   locations       — saved locations (replaces locations.json)
 *   reminders       — time/location reminders (replaces reminders.json)
 *   sessions        — current session state (replaces session-id file)
 *   dead_letters    — failed message queue (replaces dead-letters.json)
 *   proactive_state — recent interventions (replaces proactive-state.json)
 *   geo_state       — current location name (was in-memory only)
 *   migrations      — tracks which JSON → SQLite migrations have run
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEAD_LETTER_FILE, LOCATIONS_FILE, REMINDERS_FILE, SCHEDULE_FILE, STATE_DIR } from "./config";

// --- DB path ---
const DB_PATH = join(STATE_DIR, "edith.db");

// --- Singleton connection ---
let _db: Database | null = null;

/** Open (or return cached) the shared Edith database. */
export function openDatabase(): Database {
	if (_db) return _db;
	mkdirSync(STATE_DIR, { recursive: true });
	_db = new Database(DB_PATH, { create: true });
	_db.exec("PRAGMA journal_mode=WAL;");
	_db.exec("PRAGMA foreign_keys=ON;");
	applySchema(_db);
	return _db;
}

/** @internal backward-compat alias used by cost functions below */
function getDb(): Database {
	return openDatabase();
}

// --- Schema ---
function applySchema(db: Database): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_costs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      label       TEXT    NOT NULL,
      usd         REAL    NOT NULL,
      turns       INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      session_id  TEXT    NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_costs_ts    ON dispatch_costs(ts);
    CREATE INDEX IF NOT EXISTS idx_dispatch_costs_label ON dispatch_costs(label);

    CREATE TABLE IF NOT EXISTS schedule (
      name  TEXT PRIMARY KEY,
      data  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS locations (
      name          TEXT PRIMARY KEY,
      label         TEXT NOT NULL,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      radius_meters REAL NOT NULL DEFAULT 500
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id            TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('time','location')),
      location      TEXT,
      radius_meters REAL,
      fire_at       TEXT,
      fired         INTEGER NOT NULL DEFAULT 0,
      created       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dead_letters (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT    NOT NULL,
      chat_id INTEGER NOT NULL,
      message TEXT    NOT NULL,
      error   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proactive_state (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      category TEXT NOT NULL,
      message  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS geo_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

// ============================================================
// Migration helpers
// ============================================================

function _alreadyMigrated(db: Database, name: string): boolean {
	const row = db
		.query<{ name: string }, [string]>("SELECT name FROM migrations WHERE name = ?")
		.get(name);
	return row !== null;
}

function _markMigrated(db: Database, name: string): void {
	db.run("INSERT OR REPLACE INTO migrations (name, applied_at) VALUES (?, ?)", [
		name,
		new Date().toISOString(),
	]);
}

function _safeReadJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function _migrateLegacySchedule(db: Database): void {
	if (_alreadyMigrated(db, "schedule")) return;
	const entries = _safeReadJson<Array<Record<string, unknown>>>(SCHEDULE_FILE, []);
	if (entries.length === 0) {
		_markMigrated(db, "schedule");
		return;
	}
	const insert = db.prepare("INSERT OR IGNORE INTO schedule (name, data) VALUES (?, ?)");
	const batch = db.transaction((rows: Array<Record<string, unknown>>) => {
		for (const row of rows) {
			insert.run(String(row.name ?? ""), JSON.stringify(row));
		}
	});
	batch(entries);
	_markMigrated(db, "schedule");
	console.log(`[db] Migrated ${entries.length} schedule entries from JSON`);
}

function _migrateLegacyLocations(db: Database): void {
	if (_alreadyMigrated(db, "locations")) return;
	const raw = _safeReadJson<
		{ locations?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
	>(LOCATIONS_FILE, { locations: [] });
	const entries =
		(raw as { locations?: Array<Record<string, unknown>> }).locations ??
		(raw as Array<Record<string, unknown>>) ??
		[];
	if (entries.length === 0) {
		_markMigrated(db, "locations");
		return;
	}
	const insert = db.prepare(
		"INSERT OR IGNORE INTO locations (name, label, lat, lon, radius_meters) VALUES (?, ?, ?, ?, ?)"
	);
	const batch = db.transaction((rows: Array<Record<string, unknown>>) => {
		for (const row of rows) {
			insert.run(
				String(row.name ?? ""),
				String(row.label ?? row.name ?? ""),
				Number(row.lat ?? 0),
				Number(row.lon ?? 0),
				Number(row.radiusMeters ?? 500)
			);
		}
	});
	batch(entries);
	_markMigrated(db, "locations");
	console.log(`[db] Migrated ${entries.length} locations from JSON`);
}

function _migrateLegacyReminders(db: Database): void {
	if (_alreadyMigrated(db, "reminders")) return;
	const entries = _safeReadJson<Array<Record<string, unknown>>>(REMINDERS_FILE, []);
	if (entries.length === 0) {
		_markMigrated(db, "reminders");
		return;
	}
	const insert = db.prepare(`
    INSERT OR IGNORE INTO reminders (id, text, type, location, radius_meters, fire_at, fired, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
	const batch = db.transaction((rows: Array<Record<string, unknown>>) => {
		for (const row of rows) {
			insert.run(
				String(row.id ?? ""),
				String(row.text ?? ""),
				String(row.type ?? "time"),
				row.location != null ? String(row.location) : null,
				row.radiusMeters != null ? Number(row.radiusMeters) : null,
				row.fireAt != null ? String(row.fireAt) : null,
				row.fired ? 1 : 0,
				String(row.created ?? new Date().toISOString())
			);
		}
	});
	batch(entries);
	_markMigrated(db, "reminders");
	console.log(`[db] Migrated ${entries.length} reminders from JSON`);
}

function _migrateLegacyDeadLetters(db: Database): void {
	if (_alreadyMigrated(db, "dead_letters")) return;
	if (!existsSync(DEAD_LETTER_FILE)) {
		_markMigrated(db, "dead_letters");
		return;
	}
	let lines: string[] = [];
	try {
		lines = readFileSync(DEAD_LETTER_FILE, "utf-8").split("\n").filter(Boolean);
	} catch {
		_markMigrated(db, "dead_letters");
		return;
	}
	if (lines.length === 0) {
		_markMigrated(db, "dead_letters");
		return;
	}
	const insert = db.prepare(
		"INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)"
	);
	const batch = db.transaction((rawLines: string[]) => {
		for (const line of rawLines) {
			try {
				const row = JSON.parse(line) as Record<string, unknown>;
				insert.run(
					String(row.ts ?? new Date().toISOString()),
					Number(row.chatId ?? 0),
					String(row.message ?? ""),
					String(row.error ?? "")
				);
			} catch {}
		}
	});
	batch(lines);
	_markMigrated(db, "dead_letters");
	console.log(`[db] Migrated ${lines.length} dead letters from JSONL`);
}

/** Read existing JSON/file state and import into SQLite. Safe to call multiple times. */
export function migrateState(): void {
	const db = openDatabase();
	_migrateLegacySchedule(db);
	_migrateLegacyLocations(db);
	_migrateLegacyReminders(db);
	_migrateLegacyDeadLetters(db);
}

// --- Types ---
export interface DispatchCost {
	id: number;
	ts: string;
	label: string;
	usd: number;
	turns: number;
	duration_ms: number;
	session_id: string;
}

// --- Write ---

/** Record a cost entry after a completed dispatch. */
export function recordCost(params: {
	label: string;
	usd: number;
	turns: number;
	duration_ms: number;
	session_id?: string;
}): void {
	try {
		const db = getDb();
		const stmt = db.prepare(`
      INSERT INTO dispatch_costs (label, usd, turns, duration_ms, session_id)
      VALUES (?, ?, ?, ?, ?)
    `);
		stmt.run(params.label, params.usd, params.turns, params.duration_ms, params.session_id ?? "");
	} catch (err) {
		// Non-fatal — cost tracking should never crash dispatch
		console.error("[db:recordCost] Failed to record cost:", err);
	}
}

// --- Read ---

/** Return all cost rows from the last N days (default: 7). */
export function getRecentCosts(days = 7): DispatchCost[] {
	try {
		const db = getDb();
		const stmt = db.prepare<DispatchCost, [string]>(`
      SELECT id, ts, label, usd, turns, duration_ms, session_id
      FROM dispatch_costs
      WHERE ts >= datetime('now', ?)
      ORDER BY ts DESC
    `);
		return stmt.all(`-${days} days`);
	} catch (err) {
		console.error("[db:getRecentCosts] Failed to query costs:", err);
		return [];
	}
}

/** Return all cost rows for a given calendar date (YYYY-MM-DD, defaults to today). */
export function getCostsByDate(date?: string): DispatchCost[] {
	const d = date ?? new Date().toISOString().slice(0, 10);
	try {
		const db = getDb();
		const stmt = db.prepare<DispatchCost, [string]>(`
      SELECT id, ts, label, usd, turns, duration_ms, session_id
      FROM dispatch_costs
      WHERE ts LIKE ?
      ORDER BY ts DESC
    `);
		return stmt.all(`${d}%`);
	} catch (err) {
		console.error("[db:getCostsByDate] Failed to query costs:", err);
		return [];
	}
}

/** Return all cost rows for a given label. */
export function getCostsByLabel(label: string, days = 7): DispatchCost[] {
	try {
		const db = getDb();
		const stmt = db.prepare<DispatchCost, [string, string]>(`
      SELECT id, ts, label, usd, turns, duration_ms, session_id
      FROM dispatch_costs
      WHERE label = ? AND ts >= datetime('now', ?)
      ORDER BY ts DESC
    `);
		return stmt.all(label, `-${days} days`);
	} catch (err) {
		console.error("[db:getCostsByLabel] Failed to query costs:", err);
		return [];
	}
}

/** Return the total cost (USD) for today. */
export function getTotalCostToday(): number {
	try {
		const rows = getCostsByDate();
		return rows.reduce((sum, r) => sum + r.usd, 0);
	} catch {
		return 0;
	}
}

/** Close the database connection (used in tests / graceful shutdown). */
export function closeDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}
