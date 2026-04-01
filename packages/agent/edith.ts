/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> Agent SDK query() ──> MCP tools ──> Telegram
 *   Timer    ──> edith.ts ──> Agent SDK query() ──> taskboard / MCP tools
 *
 * All logic is in lib/ modules. This file is just the startup + poll loop.
 */
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

// =============================================================================
// LAYER 2: TypeScript-level singleton lock
// openSync with 'wx' (O_CREAT | O_EXCL) is atomic — only one process succeeds.
// Catches direct `bun edith.ts` calls that bypass launch-edith.sh.
// =============================================================================
const LOCK_FILE = join(process.env.HOME ?? "/tmp", ".edith", "edith.ts.lock");
let lockFd: number | null = null;
try {
	lockFd = openSync(LOCK_FILE, "wx");
} catch {
	// Lock exists — check if stale (process died without cleanup)
	try {
		const lockAge = Date.now() - statSync(LOCK_FILE).mtimeMs;
		if (lockAge > 300_000) {
			// Older than 5 min — stale, reclaim it
			unlinkSync(LOCK_FILE);
			lockFd = openSync(LOCK_FILE, "wx");
		} else {
			console.error("[edith] Another instance is already running. Exiting.");
			process.exit(0); // exit 0 so launchd doesn't restart
		}
	} catch {
		console.error("[edith] Another instance is already running. Exiting.");
		process.exit(0);
	}
}

function releaseLock() {
	try {
		if (lockFd !== null) closeSync(lockFd);
	} catch {}
	try {
		unlinkSync(LOCK_FILE);
	} catch {}
}
process.on("exit", releaseLock);

// --- Log to file + console ---
const LOG_FILE = process.env.EDITH_LOG_FILE;
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;

// biome-ignore lint/suspicious/noExplicitAny: console overrides require any[]
function writeLog(_level: string, args: any[]) {
	const line = `[${new Date().toISOString().slice(11, 19)}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
	if (LOG_FILE)
		try {
			appendFileSync(LOG_FILE, `${line}\n`);
		} catch {}
}

// biome-ignore lint/suspicious/noExplicitAny: console overrides require any[]
console.log = (...args: any[]) => {
	_origLog(...args);
	writeLog("info", args);
};
// biome-ignore lint/suspicious/noExplicitAny: console overrides require any[]
console.error = (...args: any[]) => {
	_origErr(...args);
	writeLog("error", args);
};
console.warn = (...args: any[]) => {
	_origWarn(...args);
	writeLog("warn", args);
};

import { buildBrief } from "./lib/briefs";
import { startCaffeinate, stopCaffeinate } from "./lib/caffeinate";
import {
	BACKOFF_SCHEDULE,
	TELEGRAM_BOT_TOKEN as BOT_TOKEN,
	CHAT_ID,
	INBOX_DIR,
	INBOX_MAX_AGE_MS,
	PID_FILE,
	POLL_INTERVAL_MS,
	SCHEDULE_CHECK_MS,
	SMS_BOT_ID,
} from "./lib/config";
import { dispatchQueue, dispatchToClaude, dispatchToConversation, Priority } from "./lib/dispatch";
import { edithLog, pingHeartbeat, rotateEvents } from "./lib/edith-logger";
import { handleLocation, handlePhoto, handleText, handleVoice } from "./lib/handlers";
import { SIGNAL_FRESH } from "./lib/ipc";
import { runScheduler } from "./lib/scheduler";
import { getActiveQuery } from "./lib/session";
import {
	ALLOWED_CHATS,
	clearDeadLetters,
	clearSession,
	loadDeadLetters,
	offset,
	saveDeadLetter,
	saveOffset,
	sessionId,
} from "./lib/state";
import { rotateTaskboard } from "./lib/taskboard";
import { sendTyping, tgCall } from "./lib/telegram";
import { schedulerTick, type TickState } from "./lib/tick";
import { fmtErr } from "./lib/util";

let paused = false;

if (!BOT_TOKEN) {
	edithLog.fatal("config_missing", { key: "TELEGRAM_BOT_TOKEN" });
	process.exit(1);
}

// --- .env permission check ---
const ENV_FILE = join(import.meta.dir, ".env");
if (existsSync(ENV_FILE)) {
	const envMode = statSync(ENV_FILE).mode & 0o777;
	if (envMode & 0o044) {
		edithLog.warn("env_permission_insecure", { mode: envMode.toString(8) });
		try {
			chmodSync(ENV_FILE, 0o600);
		} catch (e) {
			edithLog.error("env_chmod_failed", { error: fmtErr(e) });
		}
	}
}

// Write PID file so dashboard can check if we're alive
writeFileSync(PID_FILE, String(process.pid), "utf-8");

// ============================================================
// Telegram polling loop
// ============================================================
const recentlyIgnored = new Set<number>();
let currentOffset = offset;

async function poll(): Promise<void> {
	edithLog.info("telegram_poll_start", {});
	let consecutiveErrors = 0;

	while (true) {
		try {
			const updates = (await tgCall("getUpdates", {
				offset: currentOffset,
				timeout: 30,
				allowed_updates: ["message", "edited_message"],
			})) as Array<Record<string, any>>;

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
						edithLog.warn("unauthorized_chat_ignored", { chatId });
						recentlyIgnored.add(chatId);
						setTimeout(() => recentlyIgnored.delete(chatId), 60_000);
					}
					continue;
				}

				await sendTyping(chatId);
				if (paused) {
					paused = false;
					edithLog.info("unpaused_by_message", {});
				}
				// Skip logging raw location updates — they fire frequently from live location sharing
				// and create massive log spam. Geofence transitions are logged inside handleLocation.
				if (!msg.location) {
					const msgType = msg.voice ? "voice" : msg.photo ? "photo" : "text";
					const msgPreview = msg.text?.slice(0, 80) ?? msg.caption?.slice(0, 80) ?? "";
					edithLog.info("message_received", {
						chatId,
						type: msgType,
						source: isSmsBot ? "sms_relay" : "randy",
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
					await handlePhoto(
						chatId,
						msg.message_id,
						msg.photo[msg.photo.length - 1].file_id,
						msg.caption ?? ""
					);
					continue;
				}
				if (msg.text) {
					await handleText(chatId, msg.message_id, msg.text, isSmsBot);
				}
			}
			consecutiveErrors = 0;
		} catch (err) {
			consecutiveErrors++;
			const backoff =
				BACKOFF_SCHEDULE[Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1)];
			edithLog.error("poll_error", {
				error: fmtErr(err),
				consecutiveErrors,
				backoffMs: backoff,
			});
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
		edithLog.info("signal_fresh_session", {});
		clearSession();
		try {
			unlinkSync(SIGNAL_FRESH);
		} catch {}
	}

	if (!sessionId) {
		edithLog.info("bootstrap_start", {});
		const bootBrief = await buildBrief("boot");
		await dispatchToClaude(bootBrief, {
			resume: true,
			label: "bootstrap",
			briefType: "boot",
			priority: Priority.P0_CRITICAL,
		});
		edithLog.info("bootstrap_complete", {});
	} else {
		edithLog.info("session_resume", { sessionId });
	}

	// Replay dead-lettered messages
	const deadLetters = loadDeadLetters();
	if (deadLetters.length > 0) {
		edithLog.info("dead_letter_replay", { count: deadLetters.length });
		for (const dl of deadLetters) {
			edithLog.info("dead_letter_replaying", { preview: dl.message.slice(0, 60) });
			try {
				await dispatchToConversation(dl.chatId, 0, dl.message);
			} catch (err) {
				edithLog.error("dead_letter_replay_failed", { error: fmtErr(err) });
				saveDeadLetter(dl.chatId, dl.message, `replay failed: ${err}`);
			}
		}
		clearDeadLetters();
		edithLog.info("dead_letter_replay_complete", {});
	}
}

// ============================================================
// Graceful shutdown
// ============================================================
async function gracefulShutdown(): Promise<void> {
	// Close active Agent SDK query if running
	const activeQuery = getActiveQuery();
	if (activeQuery) {
		edithLog.info("shutdown_closing_session", {});
		try {
			activeQuery.close();
		} catch {}
	}

	if (dispatchQueue.length > 0) {
		edithLog.info("shutdown_draining_queue", { count: dispatchQueue.length });
		for (const job of dispatchQueue.drainAll()) {
			saveDeadLetter((job.opts.chatId as number) ?? CHAT_ID, job.prompt, "shutdown_drain");
		}
	}
	stopCaffeinate();
	// Flush buffered logs before exit
	await edithLog.flush();
	try {
		unlinkSync(PID_FILE);
	} catch {}
	process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ============================================================
// Global error handlers
// ============================================================
process.on("uncaughtException", (err: Error) => {
	edithLog.fatal("uncaught_exception", { error: err.message, err });
	gracefulShutdown();
});

process.on("unhandledRejection", (reason: unknown) => {
	edithLog.error("unhandled_rejection", {
		error: reason instanceof Error ? reason.message : String(reason),
		...(reason instanceof Error ? { err: reason } : {}),
	});
});

// ============================================================
// Start
// ============================================================
edithLog.info("startup_begin", {
	betterstack: !!process.env.BETTERSTACK_SOURCE_TOKEN,
});
rotateEvents();

// Seed Google OAuth tokens from env vars into SQLite
import { seedTokensFromEnv } from "./lib/google-auth";

try {
	seedTokensFromEnv();
} catch (err) {
	edithLog.warn("oauth_seed_failed", { error: fmtErr(err) });
}

// Clean up old inbox files (older than 7 days)
try {
	const now = Date.now();
	if (existsSync(INBOX_DIR)) {
		for (const f of readdirSync(INBOX_DIR)) {
			const fp = join(INBOX_DIR, f);
			try {
				if (now - statSync(fp).mtimeMs > INBOX_MAX_AGE_MS) unlinkSync(fp);
			} catch {}
		}
	}
} catch {}

edithLog.info("startup", { pid: process.pid, sessionId: sessionId || "new" });
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
		edithLog.error("scheduler_tick_error", { error: fmtErr(err) });
	} finally {
		schedulerRunning = false;
	}
}, SCHEDULE_CHECK_MS);

runScheduler().catch((err) => edithLog.error("scheduler_run_error", { error: fmtErr(err) }));

// Start polling
poll().catch((err) => {
	edithLog.fatal("poll_loop_crashed", { error: fmtErr(err) });
	process.exit(1);
});
