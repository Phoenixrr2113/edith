/**
 * Tests for Edith's self-scheduling task queue — edith_tasks table CRUD and task lifecycle.
 *
 * Uses direct DB access (like db.test.ts) to avoid singleton issues.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type EdithDB, openDatabase } from "../lib/db";

// --- Reimplemented CRUD against temp DB (avoids singleton) ---

interface EdithTask {
	id: string;
	text: string;
	prompt?: string;
	status: "pending" | "in_progress" | "done" | "failed";
	dueAt?: string;
	createdBy?: string;
	context?: string;
	createdAt: string;
	updatedAt: string;
}

type TaskRow = {
	id: string;
	text: string;
	prompt: string | null;
	status: string;
	due_at: string | null;
	created_by: string | null;
	context: string | null;
	created_at: string;
	updated_at: string;
};

function rowToTask(r: TaskRow): EdithTask {
	return {
		id: r.id,
		text: r.text,
		prompt: r.prompt ?? undefined,
		status: r.status as EdithTask["status"],
		dueAt: r.due_at ?? undefined,
		createdBy: r.created_by ?? undefined,
		context: r.context ?? undefined,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

function createTask(
	db: EdithDB,
	task: { text: string; prompt?: string; dueAt?: string; context?: string; createdBy?: string }
): EdithTask {
	const now = new Date().toISOString();
	const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	db.run(
		"INSERT INTO edith_tasks (id, text, prompt, status, due_at, created_by, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			id,
			task.text,
			task.prompt ?? null,
			"pending",
			task.dueAt ?? null,
			task.createdBy ?? null,
			task.context ?? null,
			now,
			now,
		]
	);
	return {
		id,
		text: task.text,
		prompt: task.prompt,
		status: "pending",
		dueAt: task.dueAt,
		createdBy: task.createdBy,
		context: task.context,
		createdAt: now,
		updatedAt: now,
	};
}

function listTasks(db: EdithDB, status?: string): EdithTask[] {
	const sql = status
		? "SELECT * FROM edith_tasks WHERE status = ? ORDER BY due_at ASC, created_at ASC"
		: "SELECT * FROM edith_tasks WHERE status != 'done' ORDER BY due_at ASC, created_at ASC";
	return db.all<TaskRow>(sql, status ? [status] : []).map(rowToTask);
}

function updateTask(
	db: EdithDB,
	id: string,
	updates: Partial<Pick<EdithTask, "status" | "context">>
): void {
	const now = new Date().toISOString();
	const sets: string[] = ["updated_at = ?"];
	const params: unknown[] = [now];
	if (updates.status) {
		sets.push("status = ?");
		params.push(updates.status);
	}
	if (updates.context !== undefined) {
		sets.push("context = ?");
		params.push(updates.context);
	}
	params.push(id);
	db.run(`UPDATE edith_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}

function getNextPending(db: EdithDB): EdithTask | null {
	const now = new Date().toISOString();
	const row = db.get<TaskRow>(
		"SELECT * FROM edith_tasks WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?) ORDER BY due_at ASC, created_at ASC LIMIT 1",
		[now]
	);
	return row ? rowToTask(row) : null;
}

function hasPending(db: EdithDB): boolean {
	const now = new Date().toISOString();
	const row = db.get<{ count: number }>(
		"SELECT COUNT(*) as count FROM edith_tasks WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?)",
		[now]
	);
	return (row?.count ?? 0) > 0;
}

// --- Test infrastructure ---

const tempDbs: Array<{ db: EdithDB; dir: string }> = [];

function createTempDb() {
	const dir = mkdtempSync(join(tmpdir(), "edith-tasks-test-"));
	const dbPath = join(dir, "test.db");
	const db = openDatabase(dbPath);
	tempDbs.push({ db, dir });
	return db;
}

afterEach(() => {
	for (const { db, dir } of tempDbs) {
		try {
			db.close();
		} catch {}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
	tempDbs.length = 0;
});

// --- Tests ---

describe("createTask", () => {
	test("creates a task with all fields", () => {
		const db = createTempDb();
		const task = createTask(db, {
			text: "Submit CFP for Applied AI Conf",
			prompt: "Go to sessionize.com and submit",
			dueAt: "2026-04-05T23:59:00Z",
			context: "Found during morning brief",
			createdBy: "morning-brief",
		});

		expect(task.id).toStartWith("task_");
		expect(task.text).toBe("Submit CFP for Applied AI Conf");
		expect(task.status).toBe("pending");
		expect(task.dueAt).toBe("2026-04-05T23:59:00Z");
		expect(task.createdBy).toBe("morning-brief");
	});

	test("creates a task with minimal fields", () => {
		const db = createTempDb();
		const task = createTask(db, { text: "Check email" });

		expect(task.id).toStartWith("task_");
		expect(task.status).toBe("pending");
		expect(task.dueAt).toBeUndefined();
	});

	test("generates unique IDs", () => {
		const db = createTempDb();
		const t1 = createTask(db, { text: "task 1" });
		const t2 = createTask(db, { text: "task 2" });
		expect(t1.id).not.toBe(t2.id);
	});
});

describe("listTasks", () => {
	test("returns all non-done tasks by default", () => {
		const db = createTempDb();
		createTask(db, { text: "pending task" });
		const done = createTask(db, { text: "done task" });
		updateTask(db, done.id, { status: "done" });

		const tasks = listTasks(db);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].text).toBe("pending task");
	});

	test("filters by status", () => {
		const db = createTempDb();
		createTask(db, { text: "pending" });
		const ip = createTask(db, { text: "in progress" });
		updateTask(db, ip.id, { status: "in_progress" });

		expect(listTasks(db, "pending")).toHaveLength(1);
		expect(listTasks(db, "in_progress")).toHaveLength(1);
	});

	test("orders by due_at ascending", () => {
		const db = createTempDb();
		createTask(db, { text: "later", dueAt: "2026-04-10T00:00:00Z" });
		createTask(db, { text: "sooner", dueAt: "2026-04-05T00:00:00Z" });

		const tasks = listTasks(db);
		expect(tasks[0].text).toBe("sooner");
		expect(tasks[1].text).toBe("later");
	});
});

describe("updateTask", () => {
	test("updates status", () => {
		const db = createTempDb();
		const task = createTask(db, { text: "do thing" });
		updateTask(db, task.id, { status: "done" });

		const tasks = listTasks(db, "done");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].status).toBe("done");
	});

	test("updates context", () => {
		const db = createTempDb();
		const task = createTask(db, { text: "do thing" });
		updateTask(db, task.id, { context: "Failed because CAPTCHA" });

		const tasks = listTasks(db);
		expect(tasks[0].context).toBe("Failed because CAPTCHA");
	});
});

describe("getNextPending", () => {
	test("returns null when no tasks", () => {
		const db = createTempDb();
		expect(getNextPending(db)).toBeNull();
	});

	test("returns task with no due date (always ready)", () => {
		const db = createTempDb();
		createTask(db, { text: "no deadline" });
		const next = getNextPending(db);
		expect(next).not.toBeNull();
		expect(next!.text).toBe("no deadline");
	});

	test("returns overdue task", () => {
		const db = createTempDb();
		createTask(db, { text: "overdue", dueAt: "2020-01-01T00:00:00Z" });
		const next = getNextPending(db);
		expect(next!.text).toBe("overdue");
	});

	test("skips future tasks", () => {
		const db = createTempDb();
		createTask(db, { text: "future", dueAt: "2030-12-31T23:59:59Z" });
		expect(getNextPending(db)).toBeNull();
	});

	test("picks earliest due first", () => {
		const db = createTempDb();
		createTask(db, { text: "later", dueAt: "2020-06-01T00:00:00Z" });
		createTask(db, { text: "earlier", dueAt: "2020-01-01T00:00:00Z" });
		expect(getNextPending(db)!.text).toBe("earlier");
	});

	test("skips non-pending tasks", () => {
		const db = createTempDb();
		const task = createTask(db, { text: "already done" });
		updateTask(db, task.id, { status: "done" });
		expect(getNextPending(db)).toBeNull();
	});
});

describe("hasPending", () => {
	test("false when empty", () => {
		const db = createTempDb();
		expect(hasPending(db)).toBe(false);
	});

	test("true with no-deadline task", () => {
		const db = createTempDb();
		createTask(db, { text: "ready" });
		expect(hasPending(db)).toBe(true);
	});

	test("false with only future tasks", () => {
		const db = createTempDb();
		createTask(db, { text: "future", dueAt: "2030-12-31T23:59:59Z" });
		expect(hasPending(db)).toBe(false);
	});

	test("false when all done", () => {
		const db = createTempDb();
		const task = createTask(db, { text: "done" });
		updateTask(db, task.id, { status: "done" });
		expect(hasPending(db)).toBe(false);
	});
});

describe("task lifecycle", () => {
	test("create → in_progress → done", () => {
		const db = createTempDb();
		const task = createTask(db, {
			text: "Register for Tampa Bay Tech Week",
			createdBy: "morning-brief",
			context: "Free event, April 7-12",
		});

		expect(task.status).toBe("pending");
		expect(hasPending(db)).toBe(true);

		const next = getNextPending(db);
		expect(next!.id).toBe(task.id);

		updateTask(db, task.id, { status: "in_progress" });
		expect(getNextPending(db)).toBeNull();

		updateTask(db, task.id, { status: "done", context: "Registered successfully" });
		expect(hasPending(db)).toBe(false);

		const done = listTasks(db, "done");
		expect(done).toHaveLength(1);
		expect(done[0].context).toBe("Registered successfully");
	});

	test("failed task visible but not picked up", () => {
		const db = createTempDb();
		const task = createTask(db, { text: "Submit CFP" });
		updateTask(db, task.id, { status: "failed", context: "CAPTCHA" });

		const tasks = listTasks(db); // non-done includes failed
		expect(tasks).toHaveLength(1);
		expect(tasks[0].status).toBe("failed");

		expect(getNextPending(db)).toBeNull(); // not picked up
	});
});

describe("schema", () => {
	test("edith_tasks table exists with correct columns", () => {
		const db = createTempDb();
		const row = db.get<{ count: number }>("SELECT COUNT(*) as count FROM edith_tasks");
		expect(row?.count).toBe(0);
	});

	test("status CHECK constraint rejects invalid values", () => {
		const db = createTempDb();
		expect(() => {
			db.run(
				"INSERT INTO edith_tasks (id, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				["test", "test", "invalid_status", new Date().toISOString(), new Date().toISOString()]
			);
		}).toThrow();
	});
});
