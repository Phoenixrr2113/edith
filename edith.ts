/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> claude -p --resume $SESSION ──> send_message tool ──> Telegram
 *   Timer    ──> edith.ts ──> claude -p (ephemeral)       ──> taskboard / send_message tool
 *
 * All logic is in lib/ modules. This file is just the startup + poll loop.
 */
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
  BOT_TOKEN, CHAT_ID, SMS_BOT_ID, ALLOWED_CHATS,
  INBOX_DIR, PID_FILE, SCHEDULE_CHECK_MS, POLL_INTERVAL_MS,
  offset, saveOffset, sessionId, logEvent, rotateEvents,
  loadPrompt, loadDeadLetters, clearDeadLetters, saveDeadLetter,
} from "./lib/state";
import { tgCall, sendMessage, sendTyping, downloadFile, transcribeAudio } from "./lib/telegram";
import { rotateTaskboard } from "./lib/taskboard";
import { dispatchToClaude, dispatchToConversation, dispatchQueue } from "./lib/dispatch";
import { runScheduler } from "./lib/scheduler";
import { startCaffeinate, stopCaffeinate } from "./lib/caffeinate";
import {
  checkLocationReminders,
  checkLocationTransitions,
  checkTimeReminders,
  markFired,
} from "./mcp/geo";

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
  const BACKOFF_SCHEDULE = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

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
        const isSmsBot = SMS_BOT_ID && String(fromId) === SMS_BOT_ID;
        if (!ALLOWED_CHATS.has(chatId) && !isSmsBot) {
          if (!recentlyIgnored.has(chatId)) {
            console.log(`[edith] Ignoring message from unauthorized chat: ${chatId}`);
            recentlyIgnored.add(chatId);
            setTimeout(() => recentlyIgnored.delete(chatId), 60_000);
          }
          continue;
        }

        await sendTyping(chatId);
        const msgType = msg.location ? "📍 location" : msg.voice ? "🎤 voice" : msg.photo ? "📸 photo" : "💬 text";
        const msgPreview = msg.text?.slice(0, 80) ?? (msg.caption?.slice(0, 80) ?? "");
        console.log(`[edith] ${msgType} from ${isSmsBot ? "SMS relay" : "Randy"}: ${msgPreview || "(no text)"}`);
        logEvent("message_received", {
          chatId,
          type: msg.location ? "location" : msg.voice ? "voice" : msg.photo ? "photo" : "text",
          text: (msg.text ?? "").slice(0, 200),
        });

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

        // Voice note
        if (msg.voice || msg.audio) {
          try {
            const fileId = (msg.voice ?? msg.audio).file_id;
            const localPath = await downloadFile(fileId, "ogg");
            const transcription = await transcribeAudio(localPath);
            const content = transcription
              ? `[Voice note from Randy] "${transcription}"`
              : `[Voice note from Randy] Audio file saved at: ${localPath}. Could not transcribe.`;
            logEvent("voice_transcribed", { path: localPath, text: transcription.slice(0, 200) });
            await dispatchToConversation(chatId, msg.message_id, content);
          } catch (err) {
            console.error("[edith] Voice note processing failed:", err instanceof Error ? err.message : err);
            await dispatchToConversation(chatId, msg.message_id,
              `[Voice note from Randy] Failed to download/transcribe. Error: ${err instanceof Error ? err.message : err}`
            );
          }
          continue;
        }

        // Photo
        if (msg.photo && msg.photo.length > 0) {
          try {
            const largest = msg.photo[msg.photo.length - 1];
            const localPath = await downloadFile(largest.file_id, "jpg");
            const caption = msg.caption ?? "";
            await dispatchToConversation(chatId, msg.message_id,
              `[Photo from Randy]${caption ? ` Caption: ${caption}.` : ""} Image saved at: ${localPath}.`
            );
          } catch (err) {
            console.error("[edith] Photo processing failed:", err instanceof Error ? err.message : err);
            await dispatchToConversation(chatId, msg.message_id,
              `[Photo from Randy] Failed to download. Error: ${err instanceof Error ? err.message : err}`
            );
          }
          continue;
        }

        // Text message
        if (msg.text) {
          if (isSmsBot) {
            // SMS relay — these are forwarded texts from other people, not from Randy
            await dispatchToConversation(chatId, msg.message_id,
              `[Incoming SMS forwarded by relay bot]\n${msg.text}\n\n[Triage this: store any new contacts/context in Cognee. If it needs Randy's attention, summarize and forward via send_message. If it's spam/verification codes, ignore silently. Chat ID: ${CHAT_ID}]`
            );
          } else {
            await dispatchToConversation(chatId, msg.message_id,
              `[Message from Randy via Telegram] ${msg.text}`
            );
          }
        }
      }
      consecutiveErrors = 0;
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

// ============================================================
// Bootstrap
// ============================================================
async function bootstrap(): Promise<void> {
  rotateTaskboard();

  if (!sessionId) {
    console.log("[edith] Bootstrapping new Claude session...");
    await dispatchToClaude(loadPrompt("bootstrap"), { resume: true, label: "bootstrap" });
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
      await dispatchToConversation(dl.chatId, 0, dl.message);
    }
    clearDeadLetters();
    console.log("[edith] Dead-letter replay complete.");
  }
}

// ============================================================
// Graceful shutdown
// ============================================================
function gracefulShutdown(): void {
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
  const INBOX_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (existsSync(INBOX_DIR)) {
    for (const f of readdirSync(INBOX_DIR)) {
      const fp = join(INBOX_DIR, f);
      try { if (now - statSync(fp).mtimeMs > INBOX_MAX_AGE) unlinkSync(fp); } catch {}
    }
  }
} catch {}

logEvent("startup", { pid: process.pid, sessionId: sessionId || "new" });
startCaffeinate();
await bootstrap();

// Scheduler
setInterval(() => {
  runScheduler().catch((err) => console.error("[edith:scheduler] Error:", err instanceof Error ? err.message : err));
}, SCHEDULE_CHECK_MS);

runScheduler().catch((err) => console.error("[edith:scheduler] Error:", err instanceof Error ? err.message : err));

// Start polling
poll();
