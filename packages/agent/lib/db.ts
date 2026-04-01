/**
 * Database abstraction layer for Edith.
 *
 * Local: bun:sqlite (synchronous, zero-dependency)
 * Cloud: Neon Postgres via HTTP API (see db-neon.ts)
 *
 * Detection: DATABASE_URL env var → Postgres, otherwise → SQLite
 *
 * Tables:
 *   schedule, locations, reminders, sessions, dead_letters,
 *   proactive_state, geo_state, kv_state, migrations, oauth_tokens
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config";

// --- Types ---

/** Minimal database interface used by all Edith modules. */
export interface EdithDB {
	get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
	all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
	run(sql: string, params?: unknown[]): void;
	exec(sql: string): void;
	transaction<T>(fn: () => T): T;
	close(): void;
	/** "sqlite" or "postgres" — callers use this for dialect-specific SQL */
	readonly dialect: "sqlite" | "postgres";
}

// --- Backend detection ---

const DATABASE_URL = process.env.DATABASE_URL ?? "";
export const isPostgres = DATABASE_URL.startsWith("postgres");

// --- Singleton ---
let _db: EdithDB | null = null;

// --- SQLite backend ---

function createSqliteDB(pathOverride?: string): EdithDB {
	const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
	const dbPath = pathOverride ?? join(STATE_DIR, "edith.db");
	const dbDir = pathOverride ? pathOverride.replace(/\/[^/]+$/, "") : STATE_DIR;
	mkdirSync(dbDir, { recursive: true });
	const sqlite = new Database(dbPath, { create: true });
	sqlite.exec("PRAGMA journal_mode=WAL;");
	sqlite.exec("PRAGMA foreign_keys=ON;");

	return {
		dialect: "sqlite" as const,
		get<T>(sql: string, params?: unknown[]): T | null {
			const p = (params ?? []) as import("bun:sqlite").SQLQueryBindings[];
			return (sqlite.query(sql).get(...p) as T) ?? null;
		},
		all<T>(sql: string, params?: unknown[]): T[] {
			const p = (params ?? []) as import("bun:sqlite").SQLQueryBindings[];
			return sqlite.query(sql).all(...p) as T[];
		},
		run(sql: string, params?: unknown[]): void {
			if (params && params.length > 0) {
				sqlite.query(sql).run(...(params as import("bun:sqlite").SQLQueryBindings[]));
			} else {
				sqlite.run(sql);
			}
		},
		exec(sql: string): void {
			sqlite.exec(sql);
		},
		transaction<T>(fn: () => T): T {
			return sqlite.transaction(fn)();
		},
		close(): void {
			sqlite.close();
		},
	};
}

// --- Public API ---

/** Open (or return cached) the shared Edith database. */
export function openDatabase(pathOverride?: string): EdithDB {
	if (_db && !pathOverride) return _db;

	let db: EdithDB;
	if (isPostgres && !pathOverride) {
		const { createNeonDB } = require("./db-neon") as typeof import("./db-neon");
		db = createNeonDB(DATABASE_URL);
	} else {
		db = createSqliteDB(pathOverride);
	}

	applySchema(db);

	if (!pathOverride) _db = db;
	return db;
}

// --- Schema ---

const SQLITE_SCHEMA = `
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
`;

const POSTGRES_SCHEMA = `
    CREATE TABLE IF NOT EXISTS schedule (
      name  TEXT PRIMARY KEY,
      data  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS locations (
      name          TEXT PRIMARY KEY,
      label         TEXT NOT NULL,
      lat           DOUBLE PRECISION NOT NULL,
      lon           DOUBLE PRECISION NOT NULL,
      radius_meters DOUBLE PRECISION NOT NULL DEFAULT 500
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id            TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('time','location')),
      location      TEXT,
      radius_meters DOUBLE PRECISION,
      fire_at       TEXT,
      fired         INTEGER NOT NULL DEFAULT 0,
      created       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dead_letters (
      id      SERIAL PRIMARY KEY,
      ts      TEXT    NOT NULL,
      chat_id INTEGER NOT NULL,
      message TEXT    NOT NULL,
      error   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_state (
      id       SERIAL PRIMARY KEY,
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
`;

function applySchema(db: EdithDB): void {
	db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
}

// --- Upsert helper ---

/**
 * Generate an upsert statement that works for both SQLite and Postgres.
 * SQLite: INSERT OR REPLACE INTO ...
 * Postgres: INSERT INTO ... ON CONFLICT (pk) DO UPDATE SET ...
 */
export function upsertSql(table: string, pk: string | string[], columns: string[]): string {
	const db = openDatabase();
	const pks = Array.isArray(pk) ? pk : [pk];
	const placeholders = columns.map(() => "?").join(", ");
	const colList = columns.join(", ");

	if (db.dialect === "postgres") {
		const updateCols = columns
			.filter((c) => !pks.includes(c))
			.map((c) => `${c} = EXCLUDED.${c}`)
			.join(", ");
		const conflictCols = pks.join(", ");
		return updateCols
			? `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`
			: `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO NOTHING`;
	}
	return `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`;
}

// --- KV helpers ---

export function kvGet(key: string): string | null {
	const db = openDatabase();
	const row = db.get<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", [key]);
	return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
	const db = openDatabase();
	db.run(upsertSql("kv_state", "key", ["key", "value", "updated_at"]), [
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
