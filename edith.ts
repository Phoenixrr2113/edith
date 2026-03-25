/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Responsibilities:
 *   1. Poll Telegram → dispatch messages to Claude (main session, --resume)
 *   2. Run scheduled tasks → dispatch to Claude (throwaway sessions)
 *   3. Manage taskboard (shared context file between sessions)
 *   4. Handle location/time reminders locally (no Claude needed)
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> claude -p --resume $SESSION ──> send_message tool ──> Telegram
 *   Timer    ──> edith.ts ──> claude -p (ephemeral)       ──> taskboard / send_message tool
 */
import { spawn } from "child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import {
  checkLocationReminders,
  checkLocationTransitions,
  checkTimeReminders,
  markFired,
} from "./channel/geo.ts";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID ?? "0");
const SMS_BOT_ID = process.env.TELEGRAM_SMS_BOT_ID ?? "";
const INBOX_DIR = join(process.env.HOME ?? "~", ".edith", "inbox");
const STATE_DIR = join(process.env.HOME ?? "~", ".edith");
const OFFSET_FILE = join(STATE_DIR, "tg-offset");
const SESSION_FILE = join(STATE_DIR, "session-id");
const TASKBOARD_FILE = join(STATE_DIR, "taskboard.md");
const SCHEDULE_STATE_FILE = join(STATE_DIR, "schedule-state.json");
const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
const PID_FILE = join(STATE_DIR, "edith.pid");
const PROJECT_ROOT = import.meta.dir;
const PROMPTS_DIR = join(PROJECT_ROOT, "prompts");
const SYSTEM_PROMPT_FILE = join(PROMPTS_DIR, "system.md");
const DEAD_LETTER_FILE = join(STATE_DIR, "dead-letters.jsonl");
const POLL_INTERVAL_MS = 3_000;
const SCHEDULE_CHECK_MS = 60_000;
const EVENTS_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// Write PID file so dashboard can check if we're alive
writeFileSync(PID_FILE, String(process.pid), "utf-8");

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ============================================================
// Event logging — structured JSONL for the dashboard
// ============================================================
interface EdithEvent {
  ts: string;
  type: string;
  [key: string]: any;
}

// Active Claude processes — tracked for dashboard visibility
interface ActiveProcess {
  pid: number;
  label: string;
  startedAt: string;
  prompt: string;
}

const activeProcesses: Map<number, ActiveProcess> = new Map();

function logEvent(type: string, data: Record<string, any> = {}): void {
  const event: EdithEvent = { ts: new Date().toISOString(), type, ...data };
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n", "utf-8");
  } catch {}
}

function rotateEvents(): void {
  if (!existsSync(EVENTS_FILE)) return;
  try {
    const stat = statSync(EVENTS_FILE);
    // Only rotate if file is over 1MB
    if (stat.size < 1_000_000) return;

    const lines = readFileSync(EVENTS_FILE, "utf-8").split("\n").filter(Boolean);
    const cutoff = Date.now() - EVENTS_MAX_AGE_MS;
    const recent = lines.filter((line) => {
      try {
        const e = JSON.parse(line);
        return new Date(e.ts).getTime() > cutoff;
      } catch { return false; }
    });
    writeFileSync(EVENTS_FILE, recent.join("\n") + "\n", "utf-8");
  } catch {}
}

// Export active processes for dashboard
function writeActiveProcesses(): void {
  const procs = Array.from(activeProcesses.values());
  try {
    writeFileSync(join(STATE_DIR, "active-processes.json"), JSON.stringify(procs, null, 2), "utf-8");
  } catch {}
}

// ============================================================
// Prompt templates — all prompts live in prompts/ for easy editing
// ============================================================
function loadPrompt(name: string, vars: Record<string, string | number> = {}): string {
  const path = join(PROMPTS_DIR, `${name}.md`);
  let content = readFileSync(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, String(value));
  }
  return content.trim();
}

// ============================================================
// Persistent state
// ============================================================
let offset = 0;
if (existsSync(OFFSET_FILE)) {
  try { offset = Number(readFileSync(OFFSET_FILE, "utf-8").trim()); } catch {}
}

let sessionId = "";
if (existsSync(SESSION_FILE)) {
  try { sessionId = readFileSync(SESSION_FILE, "utf-8").trim(); } catch {}
}

function saveOffset(): void {
  writeFileSync(OFFSET_FILE, String(offset), "utf-8");
}

function saveSession(id: string): void {
  sessionId = id;
  writeFileSync(SESSION_FILE, id, "utf-8");
}

// ============================================================
// Dead-letter queue — messages that failed dispatch even after retry
// ============================================================
interface DeadLetter {
  ts: string;
  chatId: number;
  message: string;
  error: string;
}

function saveDeadLetter(chatId: number, message: string, error: string): void {
  const entry: DeadLetter = { ts: new Date().toISOString(), chatId, message: message.slice(0, 500), error: error.slice(0, 300) };
  appendFileSync(DEAD_LETTER_FILE, JSON.stringify(entry) + "\n", "utf-8");
  logEvent("dead_letter", { chatId, message: message.slice(0, 100), error: error.slice(0, 200) });
  console.log(`[edith] Dead-lettered message: "${message.slice(0, 80)}..."`);
}

function loadDeadLetters(): DeadLetter[] {
  if (!existsSync(DEAD_LETTER_FILE)) return [];
  try {
    return readFileSync(DEAD_LETTER_FILE, "utf-8")
      .split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function clearDeadLetters(): void {
  try { unlinkSync(DEAD_LETTER_FILE); } catch {}
}

// ============================================================
// Taskboard — shared context between main session and scheduled tasks
// ============================================================
function readTaskboard(): string {
  if (!existsSync(TASKBOARD_FILE)) return "";
  try { return readFileSync(TASKBOARD_FILE, "utf-8"); } catch { return ""; }
}

function getRecentTaskboardEntries(): string {
  const content = readTaskboard();
  if (!content.trim()) return "";

  // Parse entries by ## headers with timestamps, keep last 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const sections = content.split(/(?=^## )/m);
  const recent = sections.filter((section) => {
    const match = section.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/);
    if (!match) return false;
    return new Date(match[1]).getTime() > cutoff;
  });

  return recent.length > 0 ? recent.join("\n") : "";
}

function rotateTaskboard(): void {
  const content = readTaskboard();
  if (!content.trim()) return;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const sections = content.split(/(?=^## )/m);

  // Keep recent entries
  const recent = sections.filter((section) => {
    const match = section.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/);
    if (!match) return true; // Keep non-timestamped sections
    return new Date(match[1]).getTime() > cutoff;
  });

  // Deduplicate repetitive check-reminders entries — keep only the latest
  const deduped: string[] = [];
  let lastReminder: string | null = null;
  for (const section of recent) {
    if (section.includes("— check-reminders")) {
      lastReminder = section; // Keep overwriting — only the last one survives
    } else {
      // Flush the last reminder before adding a non-reminder section
      if (lastReminder) {
        deduped.push(lastReminder);
        lastReminder = null;
      }
      deduped.push(section);
    }
  }
  // Don't forget the trailing reminder
  if (lastReminder) deduped.push(lastReminder);

  const trimmed = deduped.join("\n").trim();
  writeFileSync(TASKBOARD_FILE, trimmed ? `# Taskboard\n\n${trimmed}\n` : "# Taskboard\n", "utf-8");
}

// ============================================================
// Telegram helpers
// ============================================================
async function tgCall(method: string, body?: Record<string, any>): Promise<any> {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4096) {
    chunks.push(text.slice(i, i + 4096));
  }
  for (const chunk of chunks) {
    await tgCall("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "Markdown" });
  }
}

const recentlyIgnored = new Set<number>();

async function sendTyping(chatId: number): Promise<void> {
  try {
    await tgCall("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {}
}

async function transcribeAudio(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", "whisper-large-v3");

  // Try Groq first (free), fall back to OpenAI
  const providers = [
    { url: "https://api.groq.com/openai/v1/audio/transcriptions", key: process.env.GROQ_API_KEY },
    { url: "https://api.openai.com/v1/audio/transcriptions", key: process.env.OPENAI_API_KEY },
  ];

  for (const { url, key } of providers) {
    if (!key) continue;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        return data.text ?? "";
      }
    } catch {}
  }
  return "";
}

async function downloadFile(fileId: string, ext: string): Promise<string> {
  const fileInfo = await tgCall("getFile", { file_id: fileId });
  const filePath = fileInfo.file_path;
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const localPath = join(INBOX_DIR, `${Date.now()}.${ext}`);
  writeFileSync(localPath, Buffer.from(buf));
  return localPath;
}

// ============================================================
// Claude dispatch — with queue for messages that arrive while busy
// ============================================================
let busy = false;

interface DispatchJob {
  prompt: string;
  opts: DispatchOptions;
  resolve: (result: string) => void;
}

const dispatchQueue: DispatchJob[] = [];

interface DispatchOptions {
  resume?: boolean;  // Use main session (default: true)
  label?: string;    // Log label
  chatId?: number;   // Send typing indicator while processing
  skipIfBusy?: boolean; // Skip instead of queue (for scheduled tasks)
}

async function dispatchToClaude(prompt: string, opts: DispatchOptions = {}): Promise<string> {
  const { resume = true, label = "dispatch" } = opts;

  if (busy) {
    if (opts.skipIfBusy) {
      console.log(`[edith:${label}] Skipped — Claude is busy`);
      logEvent("dispatch_skipped", { label, reason: "busy" });
      return "";
    }
    console.log(`[edith:${label}] Queued (Claude is busy, ${dispatchQueue.length} in queue)`);
    logEvent("dispatch_queued", { label, queueSize: dispatchQueue.length + 1 });
    return new Promise((resolve) => {
      dispatchQueue.push({ prompt, opts, resolve });
    });
  }
  busy = true;
  const startTime = Date.now();
  let typingInterval: ReturnType<typeof setInterval> | null = null;

  try {
    const args = [
      "-p", prompt,
      "--permission-mode", "bypassPermissions",
      "--mcp-config", ".mcp.json",
      "--output-format", "json",
      "--append-system-prompt-file", SYSTEM_PROMPT_FILE,
    ];

    if (resume && sessionId) {
      args.push("--resume", sessionId);
    }

    console.log(`[edith:${label}] Dispatching (session: ${resume && sessionId ? sessionId.slice(0, 8) : "ephemeral"})...`);
    logEvent("dispatch_start", { label, session: resume ? sessionId : "ephemeral", prompt: prompt.slice(0, 200) });

    // Send typing indicator every 5s while processing
    const typingChatId = opts.chatId ?? CHAT_ID;
    if (typingChatId) {
      sendTyping(typingChatId);
      typingInterval = setInterval(() => sendTyping(typingChatId), 5_000);
    }

    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn("claude", args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Track active process
      const procPid = proc.pid ?? 0;
      activeProcesses.set(procPid, {
        pid: procPid,
        label,
        startedAt: new Date().toISOString(),
        prompt: prompt.slice(0, 200),
      });
      writeActiveProcesses();

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code: number | null) => {
        activeProcesses.delete(procPid);
        writeActiveProcesses();

        const durationMs = Date.now() - startTime;
        if (code !== 0) {
          console.error(`[edith:${label}] Claude exited with code ${code}`);
          if (stderr) console.error(`[edith:${label}] stderr: ${stderr.slice(0, 500)}`);
          logEvent("dispatch_error", { label, exitCode: code, durationMs, error: stderr.slice(0, 300) });
        } else {
          logEvent("dispatch_end", { label, durationMs, exitCode: 0 });
        }
        resolve(stdout);
      });

      proc.on("error", (err) => {
        activeProcesses.delete(procPid);
        writeActiveProcesses();
        logEvent("dispatch_error", { label, error: err.message });
        reject(err);
      });

      proc.stdin.end();
    });

    // Extract session ID and cost for main session continuity
    if (resume) {
      try {
        const json = JSON.parse(result);

        // Detect corrupted session — API errors on resume mean the session history is broken
        if (json.is_error && json.result?.includes("API Error") && sessionId) {
          console.error(`[edith:${label}] Session corrupted (API rejected history), resetting...`);
          logEvent("session_reset", { label, reason: json.result.slice(0, 200) });
          sessionId = "";
          try { unlinkSync(SESSION_FILE); } catch {}
          // Retry once with a fresh session
          return dispatchToClaude(prompt, { ...opts, resume: true, label });
        }

        if (json.session_id && json.session_id !== sessionId) {
          saveSession(json.session_id);
          console.log(`[edith:${label}] New session: ${json.session_id}`);
        }
        if (json.total_cost_usd) {
          logEvent("cost", { label, usd: json.total_cost_usd, tokens: json.usage?.input_tokens });
        }
      } catch {}
    }

    return result;
  } catch (err) {
    console.error(`[edith:${label}] Error:`, err instanceof Error ? err.message : err);
    logEvent("dispatch_error", { label, error: err instanceof Error ? err.message : String(err) });
    return "";
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    busy = false;

    // Process next item in queue
    if (dispatchQueue.length > 0) {
      const next = dispatchQueue.shift()!;
      console.log(`[edith] Processing queued job (${dispatchQueue.length} remaining)`);
      dispatchToClaude(next.prompt, next.opts).then(next.resolve);
    }
  }
}

// ============================================================
// Scheduler — reads tasks from ~/.edith/schedule.json (managed via MCP tools)
// ============================================================
const SCHEDULE_FILE = join(STATE_DIR, "schedule.json");

interface ScheduleEntry {
  name: string;
  prompt: string;
  hour?: number;
  minute?: number;
  intervalMinutes?: number;
}

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 },
  { name: "midday-check", prompt: "/midday-check", hour: 12, minute: 7 },
  { name: "evening-wrap", prompt: "/evening-wrap", hour: 16, minute: 53 },
  { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 },
];

function loadSchedule(): ScheduleEntry[] {
  if (!existsSync(SCHEDULE_FILE)) {
    // Seed defaults on first run
    writeFileSync(SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULE, null, 2), "utf-8");
    console.log("[edith] Seeded default schedule to", SCHEDULE_FILE);
    return DEFAULT_SCHEDULE;
  }
  try { return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8")); } catch { return []; }
}

interface ScheduleState {
  lastFired: Record<string, string>; // name -> ISO timestamp
}

function loadScheduleState(): ScheduleState {
  if (!existsSync(SCHEDULE_STATE_FILE)) return { lastFired: {} };
  try { return JSON.parse(readFileSync(SCHEDULE_STATE_FILE, "utf-8")); } catch { return { lastFired: {} }; }
}

function saveScheduleState(state: ScheduleState): void {
  writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function shouldFire(entry: ScheduleEntry, now: Date, state: ScheduleState): boolean {
  const lastFired = state.lastFired[entry.name];
  const lastFiredTime = lastFired ? new Date(lastFired).getTime() : 0;

  if (entry.intervalMinutes) {
    return (now.getTime() - lastFiredTime) >= entry.intervalMinutes * 60 * 1000;
  }

  // Daily: fire if it's the right time and hasn't fired this minute
  const h = now.getHours();
  const m = now.getMinutes();
  if (h !== (entry.hour ?? -1) || m !== (entry.minute ?? -1)) return false;

  if (lastFiredTime > 0) {
    const lastDate = new Date(lastFiredTime);
    if (
      lastDate.getFullYear() === now.getFullYear() &&
      lastDate.getMonth() === now.getMonth() &&
      lastDate.getDate() === now.getDate() &&
      lastDate.getHours() === h &&
      lastDate.getMinutes() === m
    ) {
      return false;
    }
  }

  return true;
}

async function runScheduler(): Promise<void> {
  const now = new Date();
  const schedule = loadSchedule();
  const state = loadScheduleState();

  for (const entry of schedule) {
    if (!shouldFire(entry, now, state)) continue;

    console.log(`[edith:scheduler] Firing ${entry.name}`);
    logEvent("schedule_fire", { task: entry.name, prompt: entry.prompt });
    state.lastFired[entry.name] = now.toISOString();
    saveScheduleState(state);

    const prompt = loadPrompt("scheduled-task", {
      prompt: entry.prompt,
      time: now.toLocaleString(),
      taskboardPath: TASKBOARD_FILE,
      timestamp: now.toISOString(),
      taskName: entry.name,
      chatId: CHAT_ID,
    });

    await dispatchToClaude(prompt, { resume: false, label: entry.name, skipIfBusy: true });
  }
}

// ============================================================
// Telegram polling loop
// ============================================================
async function poll(): Promise<void> {
  console.log("[edith] Starting Telegram poll loop...");
  let consecutiveErrors = 0;
  const BACKOFF_SCHEDULE = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]; // 5s → 5min

  while (true) {
    try {
      const updates = await tgCall("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "edited_message"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        saveOffset();

        const msg = update.message ?? update.edited_message;
        if (!msg) continue;

        const chatId = msg.chat?.id;
        if (!chatId) continue;

        // Security: Only process messages from Randy's chat
        if (chatId !== CHAT_ID) {
          // Suppress repeated logs for known bots/users
          if (!recentlyIgnored.has(chatId)) {
            console.log(`[edith] Ignoring message from unauthorized chat: ${chatId}`);
            recentlyIgnored.add(chatId);
            setTimeout(() => recentlyIgnored.delete(chatId), 60_000);
          }
          continue;
        }

        await sendTyping(chatId);
        logEvent("message_received", { chatId, type: msg.location ? "location" : msg.voice ? "voice" : msg.photo ? "photo" : "text", text: (msg.text ?? "").slice(0, 200) });

        // Location update — handle locally, notify Claude only on transitions
        if (msg.location) {
          const { latitude: lat, longitude: lon } = msg.location;

          const locReminders = checkLocationReminders(lat, lon);
          for (const { reminder, locationLabel } of locReminders) {
            await sendMessage(chatId, `📍 *Reminder* (near ${locationLabel})\n\n${reminder.text}`);
          }
          if (locReminders.length > 0) {
            markFired(locReminders.map((t) => t.reminder.id));
          }

          const timeReminders = checkTimeReminders();
          for (const r of timeReminders) {
            await sendMessage(chatId, `⏰ *Reminder*\n\n${r.text}`);
          }
          if (timeReminders.length > 0) {
            markFired(timeReminders.map((r) => r.id));
          }

          const transitions = checkLocationTransitions(lat, lon);
          if (transitions.length > 0) {
            const desc = transitions.map((t) => {
              const emoji = t.type === "arrived" ? "📍" : "🚗";
              return `${emoji} ${t.type === "arrived" ? "Arrived at" : "Left"} ${t.locationLabel}`;
            }).join(". ");
            await dispatchToClaude(
              loadPrompt("location-update", { description: desc, lat, lon, chatId }),
              { label: "location" }
            );
          }
          continue;
        }

        // Voice note — download and transcribe
        if (msg.voice || msg.audio) {
          const fileId = (msg.voice ?? msg.audio).file_id;
          const localPath = await downloadFile(fileId, "ogg");
          const transcription = await transcribeAudio(localPath);
          const content = transcription
            ? `[Voice note from Randy] "${transcription}"`
            : `[Voice note from Randy] Audio file saved at: ${localPath}. Could not transcribe.`;
          logEvent("voice_transcribed", { path: localPath, text: transcription.slice(0, 200) });
          await dispatchToConversation(chatId, msg.message_id, content);
          continue;
        }

        // Photo
        if (msg.photo && msg.photo.length > 0) {
          const largest = msg.photo[msg.photo.length - 1];
          const localPath = await downloadFile(largest.file_id, "jpg");
          const caption = msg.caption ?? "";
          await dispatchToConversation(chatId, msg.message_id,
            `[Photo from Randy]${caption ? ` Caption: ${caption}.` : ""} Image saved at: ${localPath}.`
          );
          continue;
        }

        // Text message
        if (msg.text) {
          const isSms = SMS_BOT_ID && String(msg.from?.id) === SMS_BOT_ID;
          const source = isSms ? "SMS" : "Telegram";
          await dispatchToConversation(chatId, msg.message_id,
            `[Message from Randy via ${source}] ${msg.text}`
          );
        }
      }
      consecutiveErrors = 0; // Reset on successful poll
    } catch (err) {
      consecutiveErrors++;
      const backoff = BACKOFF_SCHEDULE[Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1)];
      console.error(`[edith] Poll error (${consecutiveErrors}x, backoff ${backoff / 1000}s):`, err instanceof Error ? err.message : err);
      logEvent("poll_error", { error: err instanceof Error ? err.message : String(err), consecutiveErrors, backoffMs: backoff });
      await Bun.sleep(backoff);
      continue;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Dispatch a conversation message to the main Claude session.
 * Injects recent taskboard entries as context.
 */
async function dispatchToConversation(chatId: number, messageId: number, message: string, retryCount = 0): Promise<void> {
  const taskboardContext = getRecentTaskboardEntries();
  const contextBlock = taskboardContext
    ? `[Recent taskboard context]\n${taskboardContext}\n[End taskboard context]`
    : "";

  const prompt = loadPrompt("message", {
    message,
    taskboardContext: contextBlock,
    chatId,
  });
  const result = await dispatchToClaude(prompt, { resume: true, label: "message", chatId });

  // Check if dispatch failed (empty result or error)
  let failed = false;
  let errorMsg = "";
  try {
    const json = JSON.parse(result);
    if (json.is_error) {
      failed = true;
      errorMsg = json.result?.slice(0, 300) ?? "unknown error";
    }
  } catch {
    if (!result.trim()) {
      failed = true;
      errorMsg = "empty response from claude";
    }
  }

  if (failed) {
    if (retryCount < 2) {
      const delay = (retryCount + 1) * 3000;
      console.log(`[edith] Message dispatch failed, retrying in ${delay / 1000}s (attempt ${retryCount + 2}/3)...`);
      logEvent("dispatch_retry", { label: "message", attempt: retryCount + 2, error: errorMsg });
      await Bun.sleep(delay);
      return dispatchToConversation(chatId, messageId, message, retryCount + 1);
    }
    // All retries exhausted — dead-letter it
    saveDeadLetter(chatId, message, errorMsg);
  }
}

// ============================================================
// Bootstrap
// ============================================================
async function bootstrap(): Promise<void> {
  // Rotate taskboard on startup
  rotateTaskboard();

  if (!sessionId) {
    console.log("[edith] Bootstrapping new Claude session...");
    await dispatchToClaude(
      loadPrompt("bootstrap"),
      { resume: true, label: "bootstrap" }
    );
    console.log("[edith] Bootstrap complete.");
  } else {
    console.log(`[edith] Resuming session: ${sessionId}`);
  }

  // Replay dead-lettered messages from previous failed session
  const deadLetters = loadDeadLetters();
  if (deadLetters.length > 0) {
    console.log(`[edith] Replaying ${deadLetters.length} dead-lettered message(s)...`);
    logEvent("dead_letter_replay", { count: deadLetters.length });
    for (const dl of deadLetters) {
      console.log(`[edith] Replaying: "${dl.message.slice(0, 60)}..."`);
      await dispatchToConversation(dl.chatId, 0, dl.message);
    }
    clearDeadLetters();
    console.log("[edith] Dead-letter replay complete.");
  }
}

// ============================================================
// Caffeinate — prevent macOS idle sleep while Edith is running
// ============================================================
let caffeinateProc: ReturnType<typeof spawn> | null = null;

function startCaffeinate(): void {
  try {
    caffeinateProc = spawn("caffeinate", ["-dis"], {
      stdio: "ignore",
    });
    console.log(`[edith] caffeinate started (pid ${caffeinateProc.pid}) — preventing display, idle, and system sleep`);
    caffeinateProc.on("error", () => {
      console.warn("[edith] caffeinate not available — system may sleep");
    });
  } catch {
    console.warn("[edith] caffeinate not available — system may sleep");
  }
}

function stopCaffeinate(): void {
  if (caffeinateProc) {
    caffeinateProc.kill();
    caffeinateProc = null;
    console.log("[edith] caffeinate stopped");
  }
}

process.on("SIGINT", () => { stopCaffeinate(); process.exit(0); });
process.on("SIGTERM", () => { stopCaffeinate(); process.exit(0); });

// ============================================================
// Start
// ============================================================
console.log("[edith] Edith is starting up...");
rotateEvents();
logEvent("startup", { pid: process.pid, sessionId: sessionId || "new" });
startCaffeinate();
await bootstrap();

// Start scheduler (check every 60s)
setInterval(() => {
  runScheduler().catch((err) => {
    console.error("[edith:scheduler] Error:", err instanceof Error ? err.message : err);
  });
}, SCHEDULE_CHECK_MS);

// Run scheduler once immediately on startup
runScheduler().catch((err) => {
  console.error("[edith:scheduler] Error:", err instanceof Error ? err.message : err);
});

// Start polling
poll();
