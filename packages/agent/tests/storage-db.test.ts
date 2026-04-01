/**
 * Tests for lib/storage.ts database-backed functions.
 *
 * Strategy: Use openDatabase(tempPath) for direct DB operations,
 * but since loadSchedule/saveSchedule etc. call openDatabase() (no args)
 * which uses the singleton, we test them via direct DB queries on the
 * temp database instead.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, upsertSql } from "../lib/db";

const tempDbs: Array<{ close(): void }> = [];

function createTempDb() {
	const dir = mkdtempSync(join(tmpdir(), "edith-storage-test-"));
	const db = openDatabase(join(dir, "test.db"));
	tempDbs.push(db);
	return db;
}

afterEach(() => {
	for (const db of tempDbs) {
		try {
			db.close();
		} catch {}
	}
	tempDbs.length = 0;
});

describe("schedule persistence via DB", () => {
	test("schedule table starts empty", () => {
		const db = createTempDb();
		const rows = db.all("SELECT * FROM schedule");
		expect(rows).toEqual([]);
	});

	test("schedule upsert + read round-trip", () => {
		const db = createTempDb();
		const sql = upsertSql("schedule", "name", ["name", "data"]);
		const entry = { name: "test-task", prompt: "/test", hour: 10, minute: 0 };
		db.run(sql, ["test-task", JSON.stringify(entry)]);

		const rows = db.all<{ name: string; data: string }>("SELECT name, data FROM schedule");
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe("test-task");
		expect(JSON.parse(rows[0].data).hour).toBe(10);
	});

	test("schedule upsert overwrites existing entry", () => {
		const db = createTempDb();
		const sql = upsertSql("schedule", "name", ["name", "data"]);
		db.run(sql, ["task", JSON.stringify({ name: "task", hour: 8 })]);
		db.run(sql, ["task", JSON.stringify({ name: "task", hour: 12 })]);

		const rows = db.all<{ data: string }>("SELECT data FROM schedule WHERE name = ?", ["task"]);
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].data).hour).toBe(12);
	});

	test("schedule delete + re-insert in transaction", () => {
		const db = createTempDb();
		const sql = upsertSql("schedule", "name", ["name", "data"]);
		db.run(sql, ["keep", JSON.stringify({ name: "keep" })]);
		db.run(sql, ["remove", JSON.stringify({ name: "remove" })]);

		db.transaction(() => {
			db.run("DELETE FROM schedule WHERE name = ?", ["remove"]);
			db.run(sql, ["new", JSON.stringify({ name: "new" })]);
		});

		const names = db
			.all<{ name: string }>("SELECT name FROM schedule ORDER BY name")
			.map((r) => r.name);
		expect(names).toEqual(["keep", "new"]);
	});
});

describe("locations persistence via DB", () => {
	test("locations table starts empty", () => {
		const db = createTempDb();
		const rows = db.all("SELECT * FROM locations");
		expect(rows).toEqual([]);
	});

	test("locations upsert + read round-trip", () => {
		const db = createTempDb();
		const sql = upsertSql("locations", "name", ["name", "label", "lat", "lon", "radius_meters"]);
		db.run(sql, ["home", "Home", 27.33, -82.53, 200]);

		const rows = db.all<{ name: string; lat: number; radius_meters: number }>(
			"SELECT name, lat, radius_meters FROM locations"
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe("home");
		expect(rows[0].lat).toBe(27.33);
		expect(rows[0].radius_meters).toBe(200);
	});

	test("locations delete removes entry", () => {
		const db = createTempDb();
		const sql = upsertSql("locations", "name", ["name", "label", "lat", "lon", "radius_meters"]);
		db.run(sql, ["a", "A", 1, 2, 100]);
		db.run(sql, ["b", "B", 3, 4, 100]);
		db.run("DELETE FROM locations WHERE name = ?", ["b"]);

		const rows = db.all("SELECT * FROM locations");
		expect(rows).toHaveLength(1);
	});

	test("locations default radius_meters via schema", () => {
		const db = createTempDb();
		db.run("INSERT INTO locations (name, label, lat, lon) VALUES (?, ?, ?, ?)", ["x", "X", 0, 0]);
		const row = db.get<{ radius_meters: number }>(
			"SELECT radius_meters FROM locations WHERE name = ?",
			["x"]
		);
		expect(row!.radius_meters).toBe(500);
	});
});

describe("reminders persistence via DB", () => {
	test("reminders table starts empty", () => {
		const db = createTempDb();
		const rows = db.all("SELECT * FROM reminders");
		expect(rows).toEqual([]);
	});

	test("reminders upsert + read round-trip", () => {
		const db = createTempDb();
		const sql = upsertSql("reminders", "id", [
			"id",
			"text",
			"type",
			"location",
			"radius_meters",
			"fire_at",
			"fired",
			"created",
		]);
		const now = new Date().toISOString();
		db.run(sql, ["r1", "Buy milk", "time", null, null, now, 0, now]);

		const rows = db.all<{ id: string; text: string; type: string; fired: number }>(
			"SELECT id, text, type, fired FROM reminders"
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].text).toBe("Buy milk");
		expect(rows[0].type).toBe("time");
		expect(rows[0].fired).toBe(0);
	});

	test("reminders type constraint rejects invalid type", () => {
		const db = createTempDb();
		expect(() => {
			db.run("INSERT INTO reminders (id, text, type, fired, created) VALUES (?, ?, ?, ?, ?)", [
				"bad",
				"Bad",
				"invalid",
				0,
				new Date().toISOString(),
			]);
		}).toThrow();
	});

	test("reminders with location fields", () => {
		const db = createTempDb();
		const sql = upsertSql("reminders", "id", [
			"id",
			"text",
			"type",
			"location",
			"radius_meters",
			"fire_at",
			"fired",
			"created",
		]);
		const now = new Date().toISOString();
		db.run(sql, ["r2", "Check mail", "location", "home", 200, null, 0, now]);

		const row = db.get<{ location: string; radius_meters: number }>(
			"SELECT location, radius_meters FROM reminders WHERE id = ?",
			["r2"]
		);
		expect(row!.location).toBe("home");
		expect(row!.radius_meters).toBe(200);
	});

	test("reminders fired state persists", () => {
		const db = createTempDb();
		const sql = upsertSql("reminders", "id", [
			"id",
			"text",
			"type",
			"location",
			"radius_meters",
			"fire_at",
			"fired",
			"created",
		]);
		const now = new Date().toISOString();
		db.run(sql, ["r3", "Done", "time", null, null, now, 1, now]);

		const row = db.get<{ fired: number }>("SELECT fired FROM reminders WHERE id = ?", ["r3"]);
		expect(row!.fired).toBe(1);
	});
});

describe("dead_letters persistence via DB", () => {
	test("dead_letters auto-increments", () => {
		const db = createTempDb();
		const now = new Date().toISOString();
		db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
			now,
			123,
			"m1",
			"e1",
		]);
		db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
			now,
			123,
			"m2",
			"e2",
		]);

		const rows = db.all<{ id: number; message: string }>(
			"SELECT id, message FROM dead_letters ORDER BY id"
		);
		expect(rows).toHaveLength(2);
		expect(rows[1].id).toBeGreaterThan(rows[0].id);
	});

	test("dead_letters can be cleared", () => {
		const db = createTempDb();
		db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
			new Date().toISOString(),
			123,
			"msg",
			"err",
		]);
		db.run("DELETE FROM dead_letters");
		expect(db.all("SELECT * FROM dead_letters")).toEqual([]);
	});
});

describe("sessions persistence via DB", () => {
	test("session upsert + read", () => {
		const db = createTempDb();
		const sql = upsertSql("sessions", "key", ["key", "value"]);
		db.run(sql, ["session_id", "abc-123"]);
		const row = db.get<{ value: string }>("SELECT value FROM sessions WHERE key = ?", [
			"session_id",
		]);
		expect(row!.value).toBe("abc-123");
	});

	test("session delete", () => {
		const db = createTempDb();
		const sql = upsertSql("sessions", "key", ["key", "value"]);
		db.run(sql, ["session_id", "abc-123"]);
		db.run("DELETE FROM sessions WHERE key = ?", ["session_id"]);
		expect(db.get("SELECT * FROM sessions WHERE key = ?", ["session_id"])).toBeNull();
	});
});
