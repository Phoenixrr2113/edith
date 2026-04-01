/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Runs in two modes:
 *   Local (macOS): Telegram polling + caffeinate + launchd process management
 *   Cloud (Railway): HTTP health endpoint + WebSocket server + optional Telegram polling
 *
 * Detection: RAILWAY_ENVIRONMENT env var (set automatically by Railway)
 *            or CLOUD_MODE=true for local testing of cloud mode
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> Agent SDK query() ──> MCP tools ──> Telegram
 *   Timer    ──> edith.ts ──> Agent SDK query() ──> taskboard / MCP tools
 *   WebSocket ─> edith.ts ──> Agent SDK query() ──> WebSocket response (cloud only)
 */
import { appendFileSync, chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Cloud mode detection (must be before imports that read STATE_DIR) ─────────
const isCloud =
	!!process.env.RAILWAY_ENVIRONMENT ||
	process.env.CLOUD_MODE === "true" ||
	process.env.CLOUD_MODE === "1";

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
// biome-ignore lint/suspicious/noExplicitAny: console overrides require any[]
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

// --- .env permission check (skip in cloud — secrets come from Railway env vars) ---
if (!isCloud) {
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
}

// ============================================================
// HTTP health + WebSocket server (cloud mode)
// ============================================================
let httpServer: ReturnType<typeof Bun.serve> | null = null;

if (isCloud) {
	const { authenticateUpgrade, makeWsMessage } = await import("./lib/cloud-transport");

	const HTTP_PORT = Number(process.env.PORT ?? 8080);
	// biome-ignore lint/suspicious/noExplicitAny: Bun WS type not yet publicly exported
	const connectedDevices = new Map<string, any>();

	httpServer = Bun.serve<import("./lib/cloud-transport").WsClientData>({
		port: HTTP_PORT,

		async fetch(req, srv) {
			const url = new URL(req.url);

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

			if (url.pathname === "/ws") {
				const deviceId = await authenticateUpgrade(req);
				if (!deviceId) return new Response("Unauthorized", { status: 401 });
				const upgraded = srv.upgrade(req, {
					data: { deviceId, connectedAt: Date.now(), lastPingAt: Date.now() },
				});
				return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
			}

			return new Response("Edith Cloud", { status: 200 });
		},

		websocket: {
			open(ws) {
				const { deviceId } = ws.data;
				connectedDevices.set(deviceId, ws);
				edithLog.info("device_connected", { deviceId, total: connectedDevices.size });
				ws.send(
					JSON.stringify(
						makeWsMessage<import("./lib/cloud-transport").WsConnectedMessage>({
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
					msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<
						string,
						unknown
					>;
				} catch {
					ws.send(
						JSON.stringify(
							makeWsMessage<import("./lib/cloud-transport").WsErrorMessage>({
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
					const input = msg as unknown as import("./lib/cloud-transport").WsInputMessage;
					edithLog.info("ws_device_input", {
						deviceId,
						preview: String(input.text).slice(0, 80),
					});
					dispatchToConversation(CHAT_ID, 0, input.text).catch((err) => {
						edithLog.error("ws_dispatch_failed", { deviceId, error: fmtErr(err) });
					});
					return;
				}

				edithLog.warn("ws_unhandled_message", { deviceId, messageType: msg.type });
			},

			close(ws, code, reason) {
				const { deviceId } = ws.data;
				connectedDevices.delete(deviceId);
				edithLog.info("device_disconnected", {
					deviceId,
					code,
					reason: reason?.toString(),
					remaining: connectedDevices.size,
				});
			},
		},
	});

	edithLog.info("http_server_listening", { port: HTTP_PORT });
}

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
				if (!msg.location) {
					const msgType = msg.voice ? "voice" : msg.photo ? "photo" : "text";
					edithLog.info("message_received", {
						chatId,
						type: msgType,
						source: isSmsBot ? "sms_relay" : "randy",
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

	if (!isCloud) stopCaffeinate();
	if (httpServer) httpServer.stop();
	await edithLog.flush();
	process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

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
	mode: isCloud ? "cloud" : "local",
	betterstack: !!process.env.BETTERSTACK_SOURCE_TOKEN,
});
rotateEvents();

import { rotateTranscripts } from "./lib/transcript";

rotateTranscripts();

import { seedTokensFromEnv } from "./lib/google-auth";

try {
	seedTokensFromEnv();
} catch (err) {
	edithLog.warn("oauth_seed_failed", { error: fmtErr(err) });
}

edithLog.info("startup", {
	pid: process.pid,
	sessionId: sessionId || "new",
	mode: isCloud ? "cloud" : "local",
});
if (!isCloud) startCaffeinate();
await bootstrap();

// Scheduler tick
const tickState: TickState = { paused: false };
let schedulerRunning = false;
setInterval(async () => {
	if (schedulerRunning) return;
	schedulerRunning = true;
	try {
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

// Telegram polling
// Cloud: disabled by default (local instance handles it). Enable with CLOUD_TELEGRAM_POLLING=true.
// Local: always enabled.
const shouldPollTelegram = isCloud ? process.env.CLOUD_TELEGRAM_POLLING === "true" : true;

if (shouldPollTelegram) {
	poll().catch((err) => {
		edithLog.fatal("poll_loop_crashed", { error: fmtErr(err) });
		process.exit(1);
	});
} else {
	edithLog.info("telegram_polling_disabled", {});
}
