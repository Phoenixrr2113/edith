/**
 * Shared state, config, and persistence for Edith.
 * All file paths, env vars, and read/write helpers live here.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { CHAT_ID, STATE_DIR } from "./config";
import { kvGet, kvSet, openDatabase, upsertSql } from "./db";

const USER_ID = Number(process.env.TELEGRAM_USER_ID ?? "0");
export const ALLOWED_CHATS = new Set([CHAT_ID, USER_ID].filter(Boolean));

export const PROJECT_ROOT = join(import.meta.dir, "..");
export const PROMPTS_DIR = join(PROJECT_ROOT, "prompts");
export const SYSTEM_PROMPT_FILE = join(PROMPTS_DIR, "system.md");
export const MCP_CONFIG = join(PROJECT_ROOT, ".mcp.json");

// --- Init ---
mkdirSync(STATE_DIR, { recursive: true });

// --- Mutable state ---
export let offset = 0;
{
	const raw = kvGet("tg_offset");
	if (raw) offset = Number(raw);
}

export let sessionId = "";
try {
	const db = openDatabase();
	const row = db.get<{ value: string }>("SELECT value FROM sessions WHERE key = ?", ["session_id"]);
	if (row) sessionId = row.value;
} catch {}

export function saveOffset(newOffset: number): void {
	offset = newOffset;
	kvSet("tg_offset", String(newOffset));
}

export function saveSession(id: string): void {
	sessionId = id;
	const db = openDatabase();
	db.run(upsertSql("sessions", "key", ["key", "value"]), ["session_id", id]);
}

export function clearSession(): void {
	sessionId = "";
	try {
		const db = openDatabase();
		db.run("DELETE FROM sessions WHERE key = ?", ["session_id"]);
	} catch {}
}

// --- Event logging (delegated to edith-logger) ---
export { rotateEvents } from "./edith-logger";

import { edithLog } from "./edith-logger";

// --- Dead-letter queue ---
export interface DeadLetter {
	ts: string;
	chatId: number;
	message: string;
	error: string;
}

export function saveDeadLetter(chatId: number, message: string, error: string): void {
	const ts = new Date().toISOString();
	const msg = message.slice(0, 500);
	const err = error.slice(0, 300);
	const db = openDatabase();
	db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
		ts,
		chatId,
		msg,
		err,
	]);
	edithLog.warn("dead_letter", {
		chatId,
		message: message.slice(0, 100),
		error: error.slice(0, 200),
	});
}

export function loadDeadLetters(): DeadLetter[] {
	const db = openDatabase();
	type DLRow = { ts: string; chat_id: number; message: string; error: string };
	return db
		.all<DLRow>("SELECT ts, chat_id, message, error FROM dead_letters ORDER BY id")
		.map((r) => ({ ts: r.ts, chatId: r.chat_id, message: r.message, error: r.error }));
}

export function clearDeadLetters(): void {
	try {
		const db = openDatabase();
		db.run("DELETE FROM dead_letters");
	} catch {}
}
