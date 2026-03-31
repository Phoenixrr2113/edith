/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> Agent SDK query() ──> MCP tools ──> Telegram
 *   Timer    ──> edith.ts ──> Agent SDK query() ──> taskboard / MCP tools
 *
 * All logic is in lib/ modules. This file is just the startup + poll loop.
 */
import "./lib/telemetry";
import { existsSync, writeFileSync, appendFileSync, statSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";

// --- Log to file + console ---
const LOG_FILE = process.env.EDITH_LOG_FILE;
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;

function writeLog(level: string, args: any[]) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}`;
  if (LOG_FILE) try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

console.log = (...args: any[]) => { _origLog(...args); writeLog("info", args); };
console.error = (...args: any[]) => { _origErr(...args); writeLog("error", args); };
console.warn = (...args: any[]) => { _origWarn(...args); writeLog("warn", args); };
import {
  TELEGRAM_BOT_TOKEN as BOT_TOKEN, CHAT_ID, SMS_BOT_ID, INBOX_DIR, PID_FILE, STATE_DIR,
  BACKOFF_SCHEDULE, INBOX_MAX_AGE_MS, POLL_INTERVAL_MS, SCHEDULE_CHECK_MS,
} from "./lib/config";
import {
  ALLOWED_CHATS,
  offset, saveOffset, sessionId, clearSession, logEvent, rotateEvents,
  loadDeadLetters, clearDeadLetters, saveDeadLetter,
} from "./lib/state";
import { tgCall, sendTyping } from "./lib/telegram";
import { rotateTaskboard } from "./lib/taskboard";
import { dispatchToClaude, dispatchToConversation, dispatchQueue } from "./lib/dispatch";
import { runScheduler } from "./lib/scheduler";
import { startCaffeinate, stopCaffeinate } from "./lib/caffeinate";
import { getActiveQuery } from "./lib/session";
import { buildBrief } from "./lib/briefs";
import { fmtErr } from "./lib/util";
import { handleLocation, handleVoice, handlePhoto, handleText } from "./lib/handlers";
import { schedulerTick, type TickState } from "./lib/tick";
import { pingHeartbeat } from "./lib/logger";

// --- Signal files ---
const SIGNAL_FRESH = join(STATE_DIR, ".signal-fresh");
let paused = false;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// Write PID file so dashboard can check if we're alive
writeFileSync(PID_FILE, String(process.pid), "utf-8");

// ============================================================
// Telegram polling loop
// ============================================================
const recentlyIgnored = new Set<number>();
let currentOffset = offset;

async function poll(): Promise<void> {
  console.log("[edith] Starting Telegram poll loop...");
  let consecutiveErrors = 0;

  while (true) {
    try {
      const updates = await tgCall("getUpdates", {
        offset: currentOffset,
        timeout: 30,
        allowed_updates: ["message", "edited_message"],
      });

      for (const update of updates) {
        currentOffset = update.update_id + 1;
        saveOffset(currentOffset);

        const msg = update.message ?? update.edited_message;
        if (!msg) continue;

        const chatId = msg.chat?.id;
        if (!chatId) continue;

        // Security: Only process messages from Randy's authorized chats or the SMS bot
        const fromId = msg.from?.id;
        const isSmsBot = !!(SMS_BOT_ID && String(fromId) === SMS_BOT_ID);
        if (!ALLOWED_CHATS.has(chatId) && !isSmsBot) {
          if (!recentlyIgnored.has(chatId)) {
            console.log(`[edith] Ignoring message from unauthorized chat: ${chatId}`);
            recentlyIgnored.add(chatId);
            setTimeout(() => recentlyIgnored.delete(chatId), 60_000);
          }
          continue;
        }

        await sendTyping(chatId);
        if (paused) { paused = false; console.log("[edith] Unpaused by incoming message."); }
        // Skip logging raw location updates — they fire frequently from live location sharing
        // and create massive log spam. Geofence transitions are logged inside handleLocation.
        if (!msg.location) {
          const msgType = msg.voice ? "🎤 voice" : msg.photo ? "📸 photo" : "💬 text";
          const msgPreview = msg.text?.slice(0, 80) ?? (msg.caption?.slice(0, 80) ?? "");
          console.log(`[edith] ${msgType} from ${isSmsBot ? "SMS relay" : "Randy"}: ${msgPreview || "(no text)"}`);
          logEvent("message_received", {
            chatId,
            type: msg.voice ? "voice" : msg.photo ? "photo" : "text",
            text: (msg.text ?? "").slice(0, 200),
          });
        }

        // Dispatch to type-specific handler
        if (msg.location) {
          await handleLocation(chatId, msg.location.latitude, msg.location.longitude);
          continue;
        }
        if (msg.voice || msg.audio) {
          await handleVoice(chatId, msg.message_id, (msg.voice ?? msg.audio).file_id);
          continue;
        }
        if (msg.photo && msg.photo.length > 0) {
          await handlePhoto(chatId, msg.message_id, msg.photo[msg.photo.length - 1].file_id, msg.caption ?? "");
          continue;
        }
        if (msg.text) {
          await handleText(chatId, msg.message_id, msg.text, isSmsBot);
        }
      }
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      const backoff = BACKOFF_SCHEDULE[Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1)];
      console.error(`[edith] Poll error (${consecutiveErrors}x, backoff ${backoff / 1000}s):`, fmtErr(err));
      logEvent("poll_error", { error: fmtErr(err), consecutiveErrors, backoffMs: backoff });
      await Bun.sleep(backoff);
      continue;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

// ============================================================
// Bootstrap
// ============================================================
async function bootstrap(): Promise<void> {
  rotateTaskboard();

  // Check for signal files
  if (existsSync(SIGNAL_FRESH)) {
    console.log("[edith] Signal: fresh session requested. Clearing session.");
    clearSession();
    try { unlinkSync(SIGNAL_FRESH); } catch {}
  }

  if (!sessionId) {
    console.log("[edith] Bootstrapping new Claude session...");
    const bootBrief = await buildBrief("boot");
    await dispatchToClaude(bootBrief, { resume: true, label: "bootstrap", briefType: "boot" });
    console.log("[edith] Bootstrap complete.");
  } else {
    console.log(`[edith] Resuming session: ${sessionId}`);
  }

  // Replay dead-lettered messages
  const deadLetters = loadDeadLetters();
  if (deadLetters.length > 0) {
    console.log(`[edith] Replaying ${deadLetters.length} dead-lettered message(s)...`);
    logEvent("dead_letter_replay", { count: deadLetters.length });
    for (const dl of deadLetters) {
      console.log(`[edith] Replaying: "${dl.message.slice(0, 60)}..."`);
      try {
        await dispatchToConversation(dl.chatId, 0, dl.message);
      } catch (err) {
        console.error(`[edith] Dead-letter replay failed, re-queuing:`, err);
        saveDeadLetter(dl.chatId, dl.message, `replay failed: ${err}`);
      }
    }
    clearDeadLetters();
    console.log("[edith] Dead-letter replay complete.");
  }
}

// ============================================================
// Graceful shutdown
// ============================================================
function gracefulShutdown(): void {
  // Close active Agent SDK query if running
  const activeQuery = getActiveQuery();
  if (activeQuery) {
    console.log("[edith] Closing active Agent SDK session...");
    try { activeQuery.close(); } catch {}
  }

  if (dispatchQueue.length > 0) {
    console.log(`[edith] Draining ${dispatchQueue.length} queued message(s) to dead-letter...`);
    for (const job of dispatchQueue) {
      saveDeadLetter(job.opts.chatId ?? CHAT_ID, job.prompt, "shutdown_drain");
    }
    dispatchQueue.length = 0;
  }
  stopCaffeinate();
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ============================================================
// Start
// ============================================================
console.log("[edith] Edith is starting up...");
rotateEvents();

// Clean up old inbox files (older than 7 days)
try {
  const now = Date.now();
  if (existsSync(INBOX_DIR)) {
    for (const f of readdirSync(INBOX_DIR)) {
      const fp = join(INBOX_DIR, f);
      try { if (now - statSync(fp).mtimeMs > INBOX_MAX_AGE_MS) unlinkSync(fp); } catch {}
    }
  }
} catch {}

logEvent("startup", { pid: process.pid, sessionId: sessionId || "new" });
startCaffeinate();
await bootstrap();

// Scheduler + signal file watcher
const tickState: TickState = { paused: false };
let schedulerRunning = false;
setInterval(async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    // Share pause state with poll loop
    paused = tickState.paused;
    await schedulerTick(tickState);
    paused = tickState.paused;
    pingHeartbeat();
  } catch (err) {
    console.error("[edith:scheduler] Error:", fmtErr(err));
  } finally {
    schedulerRunning = false;
  }
}, SCHEDULE_CHECK_MS);

runScheduler().catch((err) => console.error("[edith:scheduler] Error:", fmtErr(err)));

// Start polling
poll().catch((err) => { console.error("[edith] Poll loop crashed:", err); process.exit(1); });
