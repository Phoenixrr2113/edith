/**
 * Tests for lib/db.ts — EdithDB interface, SQLite backend, KV helpers, upsert generation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, upsertSql } from "../lib/db";

// Each test gets an isolated temp database (not the singleton)
const tempDbs: Array<{ close(): void }> = [];

function createTempDb() {
	const dir = mkdtempSync(join(tmpdir(), "edith-db-test-"));
	const dbPath = join(dir, "test.db");
	const db = openDatabase(dbPath);
	tempDbs.push(db);
	return { db, dbPath, dir };
}

afterEach(() => {
	for (const db of tempDbs) {
		try {
			db.close();
		} catch {}
	}
	tempDbs.length = 0;
});

describe("EdithDB SQLite backend", () => {
	test("openDatabase creates database file and returns EdithDB", () => {
		const { db } = createTempDb();
		expect(db.dialect).toBe("sqlite");
		expect(db.get).toBeFunction();
		expect(db.all).toBeFunction();
		expect(db.run).toBeFunction();
		expect(db.exec).toBeFunction();
		expect(db.transaction).toBeFunction();
		expect(db.close).toBeFunction();
	});

	test("schema creates all expected tables", () => {
		const { db } = createTempDb();
		const tables = db
			.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.map((r) => r.name);
		expect(tables).toContain("schedule");
		expect(tables).toContain("locations");
		expect(tables).toContain("reminders");
		expect(tables).toContain("sessions");
		expect(tables).toContain("dead_letters");
		expect(tables).toContain("proactive_state");
		expect(tables).toContain("geo_state");
		expect(tables).toContain("kv_state");
		expect(tables).toContain("migrations");
	});

	test("get returns null for missing row", () => {
		const { db } = createTempDb();
		const row = db.get("SELECT value FROM kv_state WHERE key = ?", ["nonexistent"]);
		expect(row).toBeNull();
	});

	test("get returns row for existing data", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["test_key", "test_value"]);
		const row = db.get<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", ["test_key"]);
		expect(row).not.toBeNull();
		expect(row!.value).toBe("test_value");
	});

	test("all returns empty array for no matches", () => {
		const { db } = createTempDb();
		const rows = db.all("SELECT * FROM kv_state WHERE key = ?", ["nope"]);
		expect(rows).toEqual([]);
	});

	test("all returns multiple rows", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["a", "1"]);
		db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["b", "2"]);
		db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["c", "3"]);
		const rows = db.all<{ key: string }>("SELECT key FROM kv_state ORDER BY key");
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
	});

	test("run executes INSERT", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO sessions (key, value) VALUES (?, ?)", ["sid", "abc123"]);
		const row = db.get<{ value: string }>("SELECT value FROM sessions WHERE key = ?", ["sid"]);
		expect(row!.value).toBe("abc123");
	});

	test("run executes DELETE", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO sessions (key, value) VALUES (?, ?)", ["sid", "abc"]);
		db.run("DELETE FROM sessions WHERE key = ?", ["sid"]);
		const row = db.get("SELECT * FROM sessions WHERE key = ?", ["sid"]);
		expect(row).toBeNull();
	});

	test("run without params works", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO kv_state (key, value) VALUES ('x', 'y')");
		const row = db.get<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", ["x"]);
		expect(row!.value).toBe("y");
	});

	test("exec handles multi-statement SQL", () => {
		const { db } = createTempDb();
		db.exec(`
			INSERT INTO kv_state (key, value) VALUES ('m1', 'v1');
			INSERT INTO kv_state (key, value) VALUES ('m2', 'v2');
		`);
		const rows = db.all("SELECT * FROM kv_state");
		expect(rows).toHaveLength(2);
	});

	test("transaction commits on success", () => {
		const { db } = createTempDb();
		db.transaction(() => {
			db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["txn1", "a"]);
			db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["txn2", "b"]);
		});
		const rows = db.all("SELECT * FROM kv_state");
		expect(rows).toHaveLength(2);
	});

	test("transaction rolls back on error", () => {
		const { db } = createTempDb();
		try {
			db.transaction(() => {
				db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["will_rollback", "x"]);
				throw new Error("force rollback");
			});
		} catch {
			// expected
		}
		const row = db.get("SELECT * FROM kv_state WHERE key = ?", ["will_rollback"]);
		expect(row).toBeNull();
	});

	test("transaction returns value", () => {
		const { db } = createTempDb();
		const result = db.transaction(() => {
			db.run("INSERT INTO kv_state (key, value) VALUES (?, ?)", ["ret", "val"]);
			return 42;
		});
		expect(result).toBe(42);
	});

	test("close prevents further operations", () => {
		const { db } = createTempDb();
		db.close();
		expect(() => db.get("SELECT 1")).toThrow();
	});
});

describe("upsertSql", () => {
	test("generates SQLite INSERT OR REPLACE for single PK", () => {
		const { db } = createTempDb();
		const sql = upsertSql("kv_state", "key", ["key", "value"]);
		expect(sql).toBe("INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)");
	});

	test("generates SQLite INSERT OR REPLACE for composite PK", () => {
		const { db } = createTempDb();
		const sql = upsertSql("test_table", ["a", "b"], ["a", "b", "c"]);
		expect(sql).toBe("INSERT OR REPLACE INTO test_table (a, b, c) VALUES (?, ?, ?)");
	});

	test("upsert actually works with run()", () => {
		const { db } = createTempDb();
		const sql = upsertSql("kv_state", "key", ["key", "value"]);
		db.run(sql, ["upsert_test", "first"]);
		db.run(sql, ["upsert_test", "second"]);
		const row = db.get<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", [
			"upsert_test",
		]);
		expect(row!.value).toBe("second");
	});
});

describe("KV operations via direct DB", () => {
	test("kv read returns null for missing key", () => {
		const { db } = createTempDb();
		const row = db.get("SELECT value FROM kv_state WHERE key = ?", ["missing"]);
		expect(row).toBeNull();
	});

	test("kv write + read round-trip", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)", [
			"test",
			"hello",
			new Date().toISOString(),
		]);
		const row = db.get<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", ["test"]);
		expect(row!.value).toBe("hello");
	});

	test("kv upsert overwrites existing value", () => {
		const { db } = createTempDb();
		const sql = upsertSql("kv_state", "key", ["key", "value", "updated_at"]);
		db.run(sql, ["k", "first", new Date().toISOString()]);
		db.run(sql, ["k", "second", new Date().toISOString()]);
		const row = db.get<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", ["k"]);
		expect(row!.value).toBe("second");
	});

	test("kv stores updated_at timestamp", () => {
		const { db } = createTempDb();
		const now = new Date().toISOString();
		db.run("INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)", ["ts", "v", now]);
		const row = db.get<{ updated_at: string }>("SELECT updated_at FROM kv_state WHERE key = ?", [
			"ts",
		]);
		expect(row!.updated_at).toBe(now);
	});
});

describe("schema integrity", () => {
	test("reminders table enforces type check constraint", () => {
		const { db } = createTempDb();
		expect(() => {
			db.run("INSERT INTO reminders (id, text, type, created) VALUES (?, ?, ?, ?)", [
				"r1",
				"test",
				"invalid_type",
				new Date().toISOString(),
			]);
		}).toThrow();
	});

	test("dead_letters auto-increments id", () => {
		const { db } = createTempDb();
		db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
			new Date().toISOString(),
			123,
			"msg1",
			"err1",
		]);
		db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
			new Date().toISOString(),
			123,
			"msg2",
			"err2",
		]);
		const rows = db.all<{ id: number }>("SELECT id FROM dead_letters ORDER BY id");
		expect(rows).toHaveLength(2);
		expect(rows[1].id).toBeGreaterThan(rows[0].id);
	});
});
