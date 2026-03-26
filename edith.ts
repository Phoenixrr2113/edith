/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> Agent SDK query() ──> MCP tools ──> Telegram
 *   Timer    ──> edith.ts ──> Agent SDK query() ──> taskboard / MCP tools
 *
 * All logic is in lib/ modules. This file is just the startup + poll loop.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync, readdirSync } from "fs";
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
  offset, saveOffset, sessionId, clearSession, logEvent, rotateEvents,
  loadDeadLetters, clearDeadLetters, saveDeadLetter,
} from "./lib/state";
import { STATE_DIR } from "./lib/config";
import { tgCall, sendMessage, sendTyping, downloadFile, transcribeAudio } from "./lib/telegram";
import { rotateTaskboard } from "./lib/taskboard";
import { dispatchToClaude, dispatchToConversation, dispatchQueue } from "./lib/dispatch";
import { runScheduler } from "./lib/scheduler";
import { startCaffeinate, stopCaffeinate } from "./lib/caffeinate";
import { getActiveQuery } from "./lib/session";
import { buildBrief } from "./lib/briefs";
import {
  checkLocationReminders,
  checkLocationTransitions,
  checkTimeReminders,
  markFired,
} from "./mcp/geo";

// --- Signal files ---
const SIGNAL_RESTART = join(STATE_DIR, ".signal-restart");
const SIGNAL_PAUSE = join(STATE_DIR, ".signal-pause");
const SIGNAL_FRESH = join(STATE_DIR, ".signal-fresh");
const TRIGGERS_DIR = join(STATE_DIR, "triggers");
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
        if (paused) { paused = false; console.log("[edith] Unpaused by incoming message."); }
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
            const brief = await buildBrief("location", { description: desc, lat: String(lat), lon: String(lon), chatId: String(chatId) });
            await dispatchToClaude(brief, { label: "location", briefType: "location" });
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
            logEvent("voice_transcribed", { path: localPath, text: (transcription ?? "").slice(0, 200) });
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

// Scheduler + signal file watcher
let schedulerRunning = false;
setInterval(async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
  // Check signal files
  if (existsSync(SIGNAL_RESTART)) {
    console.log("[edith] Signal: restart requested.");
    try { unlinkSync(SIGNAL_RESTART); } catch {}
    logEvent("signal_restart", {});
    process.exit(0); // launch-edith.sh auto-restarts
  }

  if (existsSync(SIGNAL_PAUSE)) {
    console.log("[edith] Signal: pause requested. Waiting for 'wake up' message...");
    try { unlinkSync(SIGNAL_PAUSE); } catch {}
    logEvent("signal_pause", {});
    paused = true;
    return;
  }

  if (paused) return;

  // Check for dashboard trigger files
  try {
    if (existsSync(TRIGGERS_DIR)) {
      for (const f of readdirSync(TRIGGERS_DIR)) {
        const fp = join(TRIGGERS_DIR, f);
        console.log(`[edith] Dashboard trigger: ${f}`);
        logEvent("dashboard_trigger", { task: f });
        // Fire the triggered task immediately
        const briefTypeMap: Record<string, string> = { "morning-brief": "morning", "midday-check": "midday", "evening-wrap": "evening" };
        const briefType = briefTypeMap[f];
        const prompt = briefType ? await buildBrief(briefType as any) : await buildBrief("scheduled", { prompt: `/${f}`, taskName: f });
        dispatchToClaude(prompt, { resume: false, label: f, skipIfBusy: false, briefType: (briefType ?? "scheduled") as any })
          .then(() => { try { unlinkSync(fp); } catch {} })
          .catch((err) => {
            console.error(`[edith] Trigger dispatch error:`, err instanceof Error ? err.message : err);
            try { unlinkSync(fp); } catch {} // Clean up even on failure to avoid infinite retries
          });
      }
    }
  } catch {}

  // Check for dashboard inbox messages
  try {
    if (existsSync(INBOX_DIR)) {
      for (const f of readdirSync(INBOX_DIR)) {
        if (!f.startsWith("dashboard-")) continue;
        const fp = join(INBOX_DIR, f);
        try {
          const msg = JSON.parse(readFileSync(fp, "utf-8"));
          if (msg.text?.trim()) {
            console.log(`[edith] Dashboard message: ${msg.text.slice(0, 80)}`);
            logEvent("dashboard_message", { text: msg.text.slice(0, 200) });
            const brief = await buildBrief("message" as any, { message: msg.text, chatId: String(CHAT_ID) });
            dispatchToClaude(brief, { resume: true, label: "dashboard-msg", chatId: CHAT_ID })
              .then(() => { try { unlinkSync(fp); } catch {} })
              .catch((err) => {
                console.error(`[edith] Dashboard msg dispatch error:`, err instanceof Error ? err.message : err);
                try { unlinkSync(fp); } catch {};
              });
          } else {
            try { unlinkSync(fp); } catch {} // Clean up empty/invalid messages
          }
        } catch {}
      }
    }
  } catch {}

  await runScheduler();
  } catch (err) {
    console.error("[edith:scheduler] Error:", err instanceof Error ? err.message : err);
  } finally {
    schedulerRunning = false;
  }
}, SCHEDULE_CHECK_MS);

runScheduler().catch((err) => console.error("[edith:scheduler] Error:", err instanceof Error ? err.message : err));

// Start polling
poll().catch((err) => { console.error("[edith] Poll loop crashed:", err); process.exit(1); });
