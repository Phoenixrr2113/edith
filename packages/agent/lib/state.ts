/**
 * Shared state, config, and persistence for Edith.
 * All file paths, env vars, and read/write helpers live here.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CHAT_ID, DEAD_LETTER_FILE, INBOX_DIR, SESSION_FILE, STATE_DIR } from "./config";
import { openDatabase } from "./db";
import { saveJson } from "./storage";

const USER_ID = Number(process.env.TELEGRAM_USER_ID ?? "0");
export const ALLOWED_CHATS = new Set([CHAT_ID, USER_ID].filter(Boolean));

export const OFFSET_FILE = join(STATE_DIR, "tg-offset");
export const SCHEDULE_STATE_FILE = join(STATE_DIR, "schedule-state.json");

export const PROJECT_ROOT = join(import.meta.dir, "..");
export const PROMPTS_DIR = join(PROJECT_ROOT, "prompts");
export const SYSTEM_PROMPT_FILE = join(PROMPTS_DIR, "system.md");
export const MCP_CONFIG = join(PROJECT_ROOT, ".mcp.json");

// --- Init ---
mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// --- Mutable state ---
export let offset = 0;
if (existsSync(OFFSET_FILE)) {
	try {
		offset = Number(readFileSync(OFFSET_FILE, "utf-8").trim());
	} catch {}
}

export let sessionId = "";
// Load from SQLite first, fall back to file
try {
	const db = openDatabase();
	const row = db
		.query<{ value: string }, [string]>("SELECT value FROM sessions WHERE key = ?")
		.get("session_id");
	if (row) sessionId = row.value;
} catch {
	if (existsSync(SESSION_FILE)) {
		try {
			sessionId = readFileSync(SESSION_FILE, "utf-8").trim();
		} catch {}
	}
}

export function saveOffset(newOffset: number): void {
	offset = newOffset;
	const tmp = `${OFFSET_FILE}.tmp`;
	writeFileSync(tmp, String(newOffset), "utf-8");
	renameSync(tmp, OFFSET_FILE);
}

export function saveSession(id: string): void {
	sessionId = id;
	try {
		const db = openDatabase();
		db.run("INSERT OR REPLACE INTO sessions (key, value) VALUES (?, ?)", ["session_id", id]);
	} catch {
		// fallback to file
		const tmp = `${SESSION_FILE}.tmp`;
		writeFileSync(tmp, id, "utf-8");
		renameSync(tmp, SESSION_FILE);
	}
}

export function clearSession(): void {
	sessionId = "";
	try {
		const db = openDatabase();
		db.run("DELETE FROM sessions WHERE key = ?", ["session_id"]);
	} catch {}
	try {
		unlinkSync(SESSION_FILE);
	} catch {}
}

// --- Event logging (delegated to edith-logger for stack trace capture) ---
export { edithLog, rotateEvents } from "./edith-logger";

import { edithLog } from "./edith-logger";

// biome-ignore lint/suspicious/noExplicitAny: logEvent data values are untyped by design
export function logEvent(type: string, data: Record<string, any> = {}): void {
	edithLog.event(type, data);
}

// --- Active processes (for dashboard) ---
export interface ActiveProcess {
	pid: number;
	label: string;
	startedAt: string;
	prompt: string;
}

export const activeProcesses: Map<number, ActiveProcess> = new Map();

export function writeActiveProcesses(): void {
	try {
		saveJson(join(STATE_DIR, "active-processes.json"), Array.from(activeProcesses.values()));
	} catch {}
}

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
	try {
		const db = openDatabase();
		db.run("INSERT INTO dead_letters (ts, chat_id, message, error) VALUES (?, ?, ?, ?)", [
			ts,
			chatId,
			msg,
			err,
		]);
	} catch {
		// fallback to file
		const entry: DeadLetter = { ts, chatId, message: msg, error: err };
		appendFileSync(DEAD_LETTER_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	}
	logEvent("dead_letter", { chatId, message: message.slice(0, 100), error: error.slice(0, 200) });
	edithLog.warn("dead_letter_saved", { chatId, preview: message.slice(0, 80) });
}

export function loadDeadLetters(): DeadLetter[] {
	try {
		const db = openDatabase();
		type DLRow = { ts: string; chat_id: number; message: string; error: string };
		return db
			.query<DLRow, []>("SELECT ts, chat_id, message, error FROM dead_letters ORDER BY id")
			.all()
			.map((r) => ({ ts: r.ts, chatId: r.chat_id, message: r.message, error: r.error }));
	} catch {
		// fallback to file
		if (!existsSync(DEAD_LETTER_FILE)) return [];
		try {
			return readFileSync(DEAD_LETTER_FILE, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	}
}

export function clearDeadLetters(): void {
	try {
		const db = openDatabase();
		db.run("DELETE FROM dead_letters");
	} catch {}
	try {
		unlinkSync(DEAD_LETTER_FILE);
	} catch {}
}
