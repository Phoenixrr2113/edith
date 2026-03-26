/**
 * Centralized configuration — all env vars and derived constants in one place.
 */
import { join } from "path";

// --- Paths ---
export const STATE_DIR = join(process.env.HOME ?? "~", ".edith");
export const SCHEDULE_FILE = join(STATE_DIR, "schedule.json");
export const LOCATIONS_FILE = join(STATE_DIR, "locations.json");
export const REMINDERS_FILE = join(STATE_DIR, "reminders.json");
export const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
export const TASKBOARD_FILE = join(STATE_DIR, "taskboard.md");
export const SESSION_FILE = join(STATE_DIR, "session-id");
export const PID_FILE = join(STATE_DIR, "edith.pid");
export const DEAD_LETTER_FILE = join(STATE_DIR, "dead-letters.json");
export const INBOX_DIR = join(STATE_DIR, "inbox");

// --- Telegram ---
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
export const CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID ?? "0");
export const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID ?? "";
export const SMS_BOT_ID = process.env.TELEGRAM_SMS_BOT_ID ?? "";

// --- Twilio ---
export const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
export const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
export const TWILIO_WA_FROM = process.env.TWILIO_WHATSAPP_FROM ?? "";
export const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM ?? "";

// --- n8n ---
export const N8N_URL = process.env.N8N_URL ?? "http://localhost:5679";

// --- Google ---
export const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";

// --- Misc ---
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
export const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BACKOFF_SCHEDULE = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
