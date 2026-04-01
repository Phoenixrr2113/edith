/**
 * Neon Postgres backend for EdithDB.
 *
 * Uses Neon's HTTP SQL endpoint directly (same protocol as @neondatabase/serverless).
 * Synchronous via Bun subprocess with native fetch — no external deps needed.
 * Queries are small CRUD on config tables, so ~10-20ms per query is fine.
 */
import type { EdithDB } from "./db";

/**
 * Create a Neon Postgres EdithDB backend.
 * @param databaseUrl — Postgres connection string (e.g. postgres://user:pass@host/db?sslmode=require)
 */
export function createNeonDB(databaseUrl: string): EdithDB {
	// Convert SQLite ?-style params to Postgres $1-style
	function pgParams(sql: string): string {
		let i = 0;
		return sql.replace(/\?/g, () => `$${++i}`);
	}

	const connUrl = new URL(databaseUrl);
	const neonHost = connUrl.hostname;
	const httpUrl = `https://${neonHost}/sql`;

	function neonQuery(sql: string, params: unknown[] = []): Record<string, unknown>[] {
		const pgSql = pgParams(sql);
		const res = fetchSync(httpUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Neon-Connection-String": databaseUrl,
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
