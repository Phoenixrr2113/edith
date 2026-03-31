/**
 * Edith Cloud — Railway entrypoint.
 *
 * Identical to edith.ts orchestration but with cloud-appropriate services:
 *   - No caffeinate (macOS-only)
 *   - No fswatch / auto-restart (Railway handles process management)
 *   - No local dashboard.ts (no browser environment)
 *   - No screenpipe (requires local display)
 *   - Adds: HTTP health endpoint on PORT (required by Railway)
 *   - Adds: WebSocket server for desktop app connections (lib/cloud-transport.ts)
 *   - Keeps: Telegram polling, scheduler, dispatch, MCP tools
 *
 * Deploy: CMD ["bun", "run", "edith-cloud.ts"]
 * Detect: RAILWAY_ENVIRONMENT env var (set automatically by Railway)
 *         or CLOUD_MODE=true for local testing
 */
import "./lib/telemetry";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ── Log to stdout (Railway captures stdout/stderr) ────────────────────────────
const LOG_FILE = process.env.EDITH_LOG_FILE;
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;

function writeLog(_level: string, args: unknown[]) {
	const line = `[${new Date().toISOString().slice(11, 19)}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
	if (LOG_FILE) {
		try {
			appendFileSync(LOG_FILE, `${line}\n`);
		} catch {}
	}
}

console.log = (...args: unknown[]) => {
	_origLog(...args);
	writeLog("info", args);
};
console.error = (...args: unknown[]) => {
	_origErr(...args);
	writeLog("error", args);
};
console.warn = (...args: unknown[]) => {
	_origWarn(...args);
	writeLog("warn", args);
};

import { buildBrief } from "./lib/briefs";
import {
	authenticateUpgrade,
	makeWsMessage,
	type WsClientData,
	type WsConnectedMessage,
	type WsErrorMessage,
	type WsInputMessage,
} from "./lib/cloud-transport";
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
import { dispatchQueue, dispatchToClaude, dispatchToConversation } from "./lib/dispatch";
import { handleLocation, handlePhoto, handleText, handleVoice } from "./lib/handlers";
import { SIGNAL_FRESH } from "./lib/ipc";
import { pingHeartbeat } from "./lib/logger";
import { runScheduler } from "./lib/scheduler";
import { getActiveQuery } from "./lib/session";
import {
	ALLOWED_CHATS,
	clearDeadLetters,
	clearSession,
	loadDeadLetters,
	logEvent,
	offset,
	rotateEvents,
	saveDeadLetter,
	saveOffset,
	sessionId,
} from "./lib/state";
import { rotateTaskboard } from "./lib/taskboard";
import { sendTyping, tgCall } from "./lib/telegram";
import { schedulerTick, type TickState } from "./lib/tick";
import { fmtErr } from "./lib/util";

// ── Cloud mode check ──────────────────────────────────────────────────────────
const isCloud =
	!!process.env.RAILWAY_ENVIRONMENT ||
	process.env.CLOUD_MODE === "true" ||
	process.env.CLOUD_MODE === "1";

console.log(`[edith-cloud] Starting in ${isCloud ? "CLOUD (Railway)" : "local cloud-mode"} mode`);

if (!BOT_TOKEN) {
	console.error("TELEGRAM_BOT_TOKEN not set");
	process.exit(1);
}

// ── .env permission check (skip in cloud — secrets come from Railway env vars) ─
if (!isCloud) {
	const ENV_FILE = join(import.meta.dir, ".env");
	if (existsSync(ENV_FILE)) {
		const envMode = statSync(ENV_FILE).mode & 0o777;
		if (envMode & 0o044) {
			console.warn(
				`[edith-cloud] WARNING: .env is world/group-readable (mode ${envMode.toString(8)}). Fixing to 600.`
			);
			try {
				chmodSync(ENV_FILE, 0o600);
			} catch (e) {
				console.error("[edith-cloud] Could not chmod .env:", e);
			}
		}
	}
}

// Ensure state directory exists
// In Railway: use /data (persistent volume) when available, else HOME
const STATE_DIR_OVERRIDE = isCloud && existsSync("/data") ? "/data/.edith" : undefined;

if (STATE_DIR_OVERRIDE) {
	try {
		mkdirSync(STATE_DIR_OVERRIDE, { recursive: true });
		process.env.EDITH_STATE_DIR = STATE_DIR_OVERRIDE;
		console.log(`[edith-cloud] State directory: ${STATE_DIR_OVERRIDE}`);
	} catch (e) {
		console.warn("[edith-cloud] Could not create /data/.edith, falling back to HOME:", e);
	}
}

// Write PID file
writeFileSync(PID_FILE, String(process.pid), "utf-8");

// ── HTTP health + WebSocket server ────────────────────────────────────────────
const HTTP_PORT = Number(process.env.PORT ?? 8080);

/**
 * Connected device registry.
 * Key: deviceId — Value: Bun ServerWebSocket<WsClientData>
 */
// biome-ignore lint/suspicious/noExplicitAny: Bun WS type not yet publicly exported
const connectedDevices = new Map<string, any>();

const server = Bun.serve<WsClientData>({
	port: HTTP_PORT,

	async fetch(req, srv) {
		const url = new URL(req.url);

		// ── Health check (Railway polls this) ────────────────────────────────
		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					status: "ok",
					uptime: Math.floor(process.uptime()),
					devices: connectedDevices.size,
					ts: Date.now(),
				}),
				{ headers: { "Content-Type": "application/json" } }
			);
		}

		// ── WebSocket upgrade for desktop app ────────────────────────────────
		if (url.pathname === "/ws") {
			const deviceId = await authenticateUpgrade(req);
			if (!deviceId) {
				return new Response("Unauthorized", { status: 401 });
			}
			const upgraded = srv.upgrade(req, {
				data: { deviceId, connectedAt: Date.now(), lastPingAt: Date.now() },
			});
			if (!upgraded) {
				return new Response("WebSocket upgrade failed", { status: 500 });
			}
			return undefined;
		}

		return new Response("Edith Cloud", { status: 200 });
	},

	websocket: {
		open(ws) {
			const { deviceId } = ws.data;
			connectedDevices.set(deviceId, ws);
			console.log(`[cloud-ws] Device connected: ${deviceId} (total: ${connectedDevices.size})`);
			logEvent("device_connected", { deviceId });

			ws.send(
				JSON.stringify(
					makeWsMessage<WsConnectedMessage>({
						type: "connected",
						deviceId,
						serverVersion: "3.0.0",
					})
				)
			);
		},

		message(ws, raw) {
			ws.data.lastPingAt = Date.now();
			const { deviceId } = ws.data;

			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>;
			} catch {
				ws.send(
					JSON.stringify(
						makeWsMessage<WsErrorMessage>({
							type: "error",
							code: "BAD_MESSAGE",
							message: "Invalid JSON",
						})
					)
				);
				return;
			}

			if (msg.type === "ping") {
				ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
				return;
			}

			if (msg.type === "input") {
				const input = msg as unknown as WsInputMessage;
				console.log(`[cloud-ws] Input from device ${deviceId}: ${String(input.text).slice(0, 80)}`);
				dispatchToConversation(CHAT_ID, 0, input.text).catch((err) => {
					console.error("[cloud-ws] Failed to dispatch device input:", err);
				});
				return;
			}

			if (msg.type === "sync-request") {
				// TODO(TAURI-SYNC-118): build and send full SyncPayload
				console.log(`[cloud-ws] Sync request from device ${deviceId}`);
				return;
			}

			console.warn(`[cloud-ws] Unhandled message type from ${deviceId}: ${msg.type}`);
		},

		close(ws, code, reason) {
			const { deviceId } = ws.data;
			connectedDevices.delete(deviceId);
			console.log(
				`[cloud-ws] Device disconnected: ${deviceId} (code ${code}) — remaining: ${connectedDevices.size}`
			);
			logEvent("device_disconnected", { deviceId, code, reason: reason?.toString() });
		},

		// Note: Bun's WebSocketHandler does not expose an `error` callback;
		// per-socket errors are surfaced as close events with a non-normal code.
	},
});

console.log(`[edith-cloud] HTTP server listening on port ${HTTP_PORT}`);

// ── Telegram polling loop ─────────────────────────────────────────────────────
const recentlyIgnored = new Set<number>();
let currentOffset = offset;

async function poll(): Promise<void> {
	console.log("[edith-cloud] Starting Telegram poll loop...");
	let consecutiveErrors = 0;

	while (true) {
		try {
			const updates = (await tgCall("getUpdates", {
				offset: currentOffset,
				timeout: 30,
				allowed_updates: ["message", "edited_message"],
			})) as Array<Record<string, unknown>>;

			for (const update of updates) {
				const updateId = update.update_id as number;
				currentOffset = updateId + 1;
				saveOffset(currentOffset);

				const msg = (update.message ?? update.edited_message) as
					| Record<string, unknown>
					| undefined;
				if (!msg) continue;

				const chatId = (msg.chat as Record<string, unknown>)?.id as number | undefined;
				if (!chatId) continue;

				const fromId = (msg.from as Record<string, unknown>)?.id;
				const isSmsBot = !!(SMS_BOT_ID && String(fromId) === SMS_BOT_ID);
				if (!ALLOWED_CHATS.has(chatId) && !isSmsBot) {
					if (!recentlyIgnored.has(chatId)) {
						console.log(`[edith-cloud] Ignoring message from unauthorized chat: ${chatId}`);
						recentlyIgnored.add(chatId);
						setTimeout(() => recentlyIgnored.delete(chatId), 60_000);
					}
					continue;
				}

				await sendTyping(chatId);

				if (!msg.location) {
					const msgType = msg.voice ? "voice" : msg.photo ? "photo" : "text";
					const msgPreview = String(msg.text ?? msg.caption ?? "").slice(0, 80);
					console.log(
						`[edith-cloud] ${msgType} from ${isSmsBot ? "SMS relay" : "Randy"}: ${msgPreview || "(no text)"}`
					);
					logEvent("message_received", {
						chatId,
						type: msgType,
						text: String(msg.text ?? "").slice(0, 200),
					});
				}

				const location = msg.location as Record<string, number> | undefined;
				if (location) {
					await handleLocation(chatId, location.latitude, location.longitude);
					continue;
				}
				const voice = (msg.voice ?? msg.audio) as Record<string, string> | undefined;
				if (voice) {
					await handleVoice(chatId, msg.message_id as number, voice.file_id);
					continue;
				}
				const photos = msg.photo as Array<Record<string, unknown>> | undefined;
				if (photos && photos.length > 0) {
					await handlePhoto(
						chatId,
						msg.message_id as number,
						(photos[photos.length - 1] as Record<string, string>).file_id,
						String(msg.caption ?? "")
					);
					continue;
				}
				if (msg.text) {
					await handleText(chatId, msg.message_id as number, msg.text as string, isSmsBot);
				}
			}
			consecutiveErrors = 0;
		} catch (err) {
			consecutiveErrors++;
			const backoff =
				BACKOFF_SCHEDULE[Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1)];
			console.error(
				`[edith-cloud] Poll error (${consecutiveErrors}x, backoff ${backoff / 1000}s):`,
				fmtErr(err)
			);
			logEvent("poll_error", { error: fmtErr(err), consecutiveErrors, backoffMs: backoff });
			await Bun.sleep(backoff);
			continue;
		}

		await Bun.sleep(POLL_INTERVAL_MS);
	}
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
	rotateTaskboard();

	if (existsSync(SIGNAL_FRESH)) {
		console.log("[edith-cloud] Signal: fresh session requested. Clearing session.");
		clearSession();
		try {
			unlinkSync(SIGNAL_FRESH);
		} catch {}
	}

	if (!sessionId) {
		console.log("[edith-cloud] Bootstrapping new Claude session...");
		const bootBrief = await buildBrief("boot");
		await dispatchToClaude(bootBrief, { resume: true, label: "bootstrap", briefType: "boot" });
		console.log("[edith-cloud] Bootstrap complete.");
	} else {
		console.log(`[edith-cloud] Resuming session: ${sessionId}`);
	}

	const deadLetters = loadDeadLetters();
	if (deadLetters.length > 0) {
		console.log(`[edith-cloud] Replaying ${deadLetters.length} dead-lettered message(s)...`);
		logEvent("dead_letter_replay", { count: deadLetters.length });
		for (const dl of deadLetters) {
			console.log(`[edith-cloud] Replaying: "${dl.message.slice(0, 60)}..."`);
			try {
				await dispatchToConversation(dl.chatId, 0, dl.message);
			} catch (err) {
				console.error("[edith-cloud] Dead-letter replay failed, re-queuing:", err);
				saveDeadLetter(dl.chatId, dl.message, `replay failed: ${err}`);
			}
		}
		clearDeadLetters();
		console.log("[edith-cloud] Dead-letter replay complete.");
	}
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
import * as Sentry from "@sentry/bun";

async function gracefulShutdown(): Promise<void> {
	const activeQuery = getActiveQuery();
	if (activeQuery) {
		console.log("[edith-cloud] Closing active Agent SDK session...");
		try {
			activeQuery.close();
		} catch {}
	}

	if (dispatchQueue.length > 0) {
		console.log(
			`[edith-cloud] Draining ${dispatchQueue.length} queued message(s) to dead-letter...`
		);
		for (const job of dispatchQueue) {
			saveDeadLetter(job.opts.chatId ?? CHAT_ID, job.prompt, "shutdown_drain");
		}
		dispatchQueue.length = 0;
	}

	server.stop();
	await Sentry.close(2000);
	try {
		unlinkSync(PID_FILE);
	} catch {}
	process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

process.on("uncaughtException", (err: Error) => {
	console.error("[edith-cloud] Uncaught exception:", err);
	Sentry.captureException(err);
	gracefulShutdown();
});

process.on("unhandledRejection", (reason: unknown) => {
	console.error("[edith-cloud] Unhandled promise rejection:", reason);
	if (reason instanceof Error) {
		Sentry.captureException(reason);
	} else {
		Sentry.captureMessage(`Unhandled rejection: ${String(reason)}`, { level: "error" });
	}
});

// ── Start ─────────────────────────────────────────────────────────────────────
console.log("[edith-cloud] Edith Cloud is starting up...");
rotateEvents();

import { seedTokensFromEnv } from "./lib/google-auth";

try {
	seedTokensFromEnv();
} catch (err) {
	console.warn("[edith-cloud] Failed to seed OAuth tokens:", err);
}

// Clean up old inbox files
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

logEvent("startup", { pid: process.pid, sessionId: sessionId || "new", mode: "cloud" });

// NOTE: caffeinate, dashboard, fswatch, screenpipe — all skipped in cloud mode

await bootstrap();

const tickState: TickState = { paused: false };
let schedulerRunning = false;
setInterval(async () => {
	if (schedulerRunning) return;
	schedulerRunning = true;
	try {
		await schedulerTick(tickState);
		pingHeartbeat();
	} catch (err) {
		console.error("[edith-cloud:scheduler] Error:", fmtErr(err));
	} finally {
		schedulerRunning = false;
	}
}, SCHEDULE_CHECK_MS);

runScheduler().catch((err) => console.error("[edith-cloud:scheduler] Error:", fmtErr(err)));

poll().catch((err) => {
	console.error("[edith-cloud] Poll loop crashed:", err);
	process.exit(1);
});
