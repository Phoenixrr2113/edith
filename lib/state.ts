/**
 * Shared state, config, and persistence for Edith.
 * All file paths, env vars, and read/write helpers live here.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

// --- Config (re-export from centralized config for backward compatibility) ---
export { CHAT_ID, TELEGRAM_BOT_TOKEN as BOT_TOKEN, TELEGRAM_USER_ID, SMS_BOT_ID,
         STATE_DIR, INBOX_DIR, EVENTS_FILE, SESSION_FILE, TASKBOARD_FILE,
         PID_FILE, DEAD_LETTER_FILE } from "./config";
import { CHAT_ID, STATE_DIR, EVENTS_FILE, SESSION_FILE, DEAD_LETTER_FILE, INBOX_DIR } from "./config";

const USER_ID = Number(process.env.TELEGRAM_USER_ID ?? "0");
export const ALLOWED_CHATS = new Set([CHAT_ID, USER_ID].filter(Boolean));

export const OFFSET_FILE = join(STATE_DIR, "tg-offset");
export const SCHEDULE_STATE_FILE = join(STATE_DIR, "schedule-state.json");
export const SCHEDULE_FILE = join(STATE_DIR, "schedule.json");

export const PROJECT_ROOT = join(import.meta.dir, "..");
export const PROMPTS_DIR = join(PROJECT_ROOT, "prompts");
export const SYSTEM_PROMPT_FILE = join(PROMPTS_DIR, "system.md");
export const MCP_CONFIG = join(PROJECT_ROOT, ".mcp.json");

export const POLL_INTERVAL_MS = 3_000;
export const SCHEDULE_CHECK_MS = 60_000;
export const EVENTS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

// --- Init ---
mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// --- Mutable state ---
export let offset = 0;
if (existsSync(OFFSET_FILE)) {
  try { offset = Number(readFileSync(OFFSET_FILE, "utf-8").trim()); } catch {}
}

export let sessionId = "";
if (existsSync(SESSION_FILE)) {
  try { sessionId = readFileSync(SESSION_FILE, "utf-8").trim(); } catch {}
}

export function saveOffset(newOffset: number): void {
  offset = newOffset;
  writeFileSync(OFFSET_FILE, String(newOffset), "utf-8");
}

export function saveSession(id: string): void {
  sessionId = id;
  writeFileSync(SESSION_FILE, id, "utf-8");
}

export function clearSession(): void {
  sessionId = "";
  try { unlinkSync(SESSION_FILE); } catch {}
}

// --- Event logging ---
export function logEvent(type: string, data: Record<string, any> = {}): void {
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n", "utf-8");
  } catch {}
}

export function rotateEvents(): void {
  if (!existsSync(EVENTS_FILE)) return;
  try {
    const stat = statSync(EVENTS_FILE);
    if (stat.size < 1_000_000) return;
    const lines = readFileSync(EVENTS_FILE, "utf-8").split("\n").filter(Boolean);
    const cutoff = Date.now() - EVENTS_MAX_AGE_MS;
    const recent = lines.filter((line) => {
      try { return new Date(JSON.parse(line).ts).getTime() > cutoff; } catch { return false; }
    });
    writeFileSync(EVENTS_FILE, recent.join("\n") + "\n", "utf-8");
  } catch {}
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
    writeFileSync(join(STATE_DIR, "active-processes.json"), JSON.stringify(Array.from(activeProcesses.values()), null, 2), "utf-8");
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
  const entry: DeadLetter = { ts: new Date().toISOString(), chatId, message: message.slice(0, 500), error: error.slice(0, 300) };
  appendFileSync(DEAD_LETTER_FILE, JSON.stringify(entry) + "\n", "utf-8");
  logEvent("dead_letter", { chatId, message: message.slice(0, 100), error: error.slice(0, 200) });
  console.log(`[edith] Dead-lettered message: "${message.slice(0, 80)}..."`);
}

export function loadDeadLetters(): DeadLetter[] {
  if (!existsSync(DEAD_LETTER_FILE)) return [];
  try {
    return readFileSync(DEAD_LETTER_FILE, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

export function clearDeadLetters(): void {
  try { unlinkSync(DEAD_LETTER_FILE); } catch {}
}

// --- Prompt templates ---
export function loadPrompt(name: string, vars: Record<string, string | number> = {}): string {
  const path = join(PROMPTS_DIR, `${name}.md`);
  let content = readFileSync(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, String(value));
  }
  return content.trim();
}
