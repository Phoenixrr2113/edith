/**
 * Database abstraction layer for Edith.
 *
 * Local: bun:sqlite (synchronous, zero-dependency)
 * Cloud: Neon Postgres via @neondatabase/serverless
 *
 * Detection: DATABASE_URL env var → Postgres, otherwise → SQLite
 *
 * All callers use synchronous methods. For Postgres, we use Neon's HTTP driver
 * wrapped with synchronous Bun helpers (the queries are small and fast, ~5-20ms).
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

// --- Neon Postgres backend ---

/**
 * Neon Postgres backend via HTTP API.
 *
 * Uses Neon's HTTP SQL endpoint directly (same protocol as @neondatabase/serverless).
 * Synchronous via Bun.spawnSync + curl — keeps the EdithDB interface sync.
 * Queries are small CRUD on config tables, so ~10-20ms per query is fine.
 */
function createNeonDB(): EdithDB {
	// Convert SQLite ?-style params to Postgres $1-style
	function pgParams(sql: string): string {
		let i = 0;
		return sql.replace(/\?/g, () => `$${++i}`);
	}

	// Neon HTTP query endpoint
	// DATABASE_URL: postgres://user:pass@host/dbname?sslmode=require
	const connUrl = new URL(DATABASE_URL);
	const neonHost = connUrl.hostname; // e.g. ep-cool-rain-123456.us-east-2.aws.neon.tech
	const httpUrl = `https://${neonHost}/sql`;

	function neonQuery(sql: string, params: unknown[] = []): Record<string, unknown>[] {
		const pgSql = pgParams(sql);
		const res = fetchSync(httpUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Neon-Connection-String": DATABASE_URL,
			},
			body: JSON.stringify({ query: pgSql, params }),
		});

		if (!res.ok) {
			throw new Error(`Neon query failed (${res.status}): ${res.body}`);
		}

		const data = JSON.parse(res.body);
		// Neon HTTP response: { rows: [...], rowAsArray: false, fields: [...] }
		// When rowAsArray is false (default), rows are already objects
		if (!data.rows) return [];
		return data.rows as Record<string, unknown>[];
	}

	return {
		dialect: "postgres" as const,
		get<T>(sql: string, params?: unknown[]): T | null {
			const rows = neonQuery(sql, params);
			return (rows[0] as T) ?? null;
		},
		all<T>(sql: string, params?: unknown[]): T[] {
			return neonQuery(sql, params) as T[];
		},
		run(sql: string, params?: unknown[]): void {
			neonQuery(sql, params);
		},
		exec(sql: string): void {
			// Split on semicolons for multi-statement DDL
			const statements = sql
				.split(";")
				.map((s) => s.trim())
				.filter(Boolean);
			for (const stmt of statements) {
				neonQuery(stmt);
			}
		},
		transaction<T>(fn: () => T): T {
			// Neon HTTP driver doesn't support multi-statement transactions.
			// For Edith's use case (config upserts), this is fine — each operation
			// is idempotent. If we need real transactions, switch to WebSocket mode.
			return fn();
		},
		close(): void {
			// HTTP-based, no connection to close
		},
	};
}

/**
 * Synchronous HTTP POST using Bun subprocess with native fetch.
 * Spawns a tiny Bun script that does the async fetch and prints the result.
 * No external dependencies (curl, wget) needed.
 */
function fetchSync(
	url: string,
	opts: { method: string; headers: Record<string, string>; body: string }
): {
	ok: boolean;
	status: number;
	body: string;
} {
	// Build a self-contained script that Bun can execute
	const script = `
		const r = await fetch(${JSON.stringify(url)}, {
			method: ${JSON.stringify(opts.method)},
			headers: ${JSON.stringify(opts.headers)},
			body: ${JSON.stringify(opts.body)},
		});
		const t = await r.text();
		process.stdout.write(JSON.stringify({ s: r.status, b: t }));
	`;

	const proc = Bun.spawnSync({
		cmd: ["bun", "-e", script],
		stdout: "pipe",
		stderr: "pipe",
	});

	if (proc.exitCode !== 0) {
		const stderr = proc.stderr.toString();
		throw new Error(`Neon fetch failed: ${stderr}`);
	}

	const result = JSON.parse(proc.stdout.toString()) as { s: number; b: string };
	return { ok: result.s >= 200 && result.s < 300, status: result.s, body: result.b };
}

// --- Public API ---

/** Open (or return cached) the shared Edith database. */
export function openDatabase(pathOverride?: string): EdithDB {
	if (_db && !pathOverride) return _db;

	let db: EdithDB;
	if (isPostgres && !pathOverride) {
		db = createNeonDB();
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
