/**
 * SQLite persistence layer for Edith.
 * Uses bun:sqlite for zero-dependency local storage.
 *
 * Tables:
 *   schedule        — scheduled tasks
 *   locations       — saved locations
 *   reminders       — time/location reminders
 *   sessions        — current session state
 *   dead_letters    — failed message queue
 *   proactive_state — recent interventions
 *   geo_state       — current location name
 *   kv_state        — generic key-value store (tg offset, proactive config, schedule state, etc.)
 *   migrations      — tracks schema migrations
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config";

// --- DB path ---
const DB_PATH = join(STATE_DIR, "edith.db");

// --- Singleton connection ---
let _db: Database | null = null;

/** Open (or return cached) the shared Edith database.
 *  Pass `pathOverride` in tests to use an isolated DB file. */
export function openDatabase(pathOverride?: string): Database {
	if (_db) return _db;
	const dbPath = pathOverride ?? DB_PATH;
	const dbDir = pathOverride ? pathOverride.replace(/\/[^/]+$/, "") : STATE_DIR;
	mkdirSync(dbDir, { recursive: true });
	_db = new Database(dbPath, { create: true });
	_db.exec("PRAGMA journal_mode=WAL;");
	_db.exec("PRAGMA foreign_keys=ON;");
	applySchema(_db);
	return _db;
}

// --- Schema ---
function applySchema(db: Database): void {
	db.exec(`
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

    CREATE TABLE IF NOT EXISTS kv_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

// --- KV helpers ---

export function kvGet(key: string): string | null {
	const db = openDatabase();
	const row = db
		.query<{ value: string }, [string]>("SELECT value FROM kv_state WHERE key = ?")
		.get(key);
	return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
	const db = openDatabase();
	db.run("INSERT OR REPLACE INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)", [
		key,
		value,
		new Date().toISOString(),
	]);
}

/** Close the database connection (used in tests / graceful shutdown). */
export function closeDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}
