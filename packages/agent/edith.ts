/**
 * Edith — Persistent orchestrator for a Claude-powered personal assistant.
 *
 * Runs in two modes:
 *   Local (macOS): Telegram polling + caffeinate + launchd process management
 *   Cloud (Railway): Telegram webhook + HTTP health endpoint + WebSocket server
 *
 * Architecture:
 *   Telegram ──> edith.ts ──> Agent SDK query() ──> MCP tools ──> Telegram
 *   Timer    ──> edith.ts ──> Agent SDK query() ──> taskboard / MCP tools
 *   WebSocket ─> edith.ts ──> Agent SDK query() ──> WebSocket response (cloud only)
 */
import { appendFileSync, chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { buildBrief } from "./lib/briefs";
import { startCaffeinate } from "./lib/caffeinate";
import { TELEGRAM_BOT_TOKEN as BOT_TOKEN, IS_CLOUD, SCHEDULE_CHECK_MS } from "./lib/config";
import { dispatchToClaude, dispatchToConversation, Priority } from "./lib/dispatch";
import { edithLog, pingHeartbeat, rotateEvents } from "./lib/edith-logger";
import { startHttpServer } from "./lib/http-server";
import { SIGNAL_FRESH } from "./lib/ipc";
import { registerShutdownHandlers } from "./lib/shutdown";
import {
	clearDeadLetters,
	clearSession,
	loadDeadLetters,
	saveDeadLetter,
	sessionId,
} from "./lib/state";
import { rotateTaskboard } from "./lib/taskboard";
import { startPolling } from "./lib/telegram-polling";
import { processUpdate, setPaused } from "./lib/telegram-transport";
import { deregisterWebhook, registerWebhook } from "./lib/telegram-webhook";
import { schedulerTick, type TickState } from "./lib/tick";
import { fmtErr } from "./lib/util";

// ── Console overrides (file + stdout logging) ──────────────────────────────────
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

// ── Validate config ────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
	console.error("FATAL: TELEGRAM_BOT_TOKEN not set. Check your .env file.");
	edithLog.fatal("config_missing", { key: "TELEGRAM_BOT_TOKEN" });
	process.exit(1);
}

// .env permission check (skip in cloud — secrets come from Railway env vars)
if (!IS_CLOUD) {
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

// ── HTTP server + capability router (cloud only) ──────────────────────────────
let httpServer: ReturnType<typeof Bun.serve> | null = null;

if (IS_CLOUD) {
	const port = Number(process.env.PORT ?? 8080);
	httpServer = await startHttpServer(
		port,
		(await import("./lib/telegram-webhook")).WEBHOOK_SECRET,
		processUpdate
	);

	// Wire capability router to WebSocket transport
	const { getCloudRouter } = await import("./lib/capability-router");
	const { broadcastCapabilityRequest, connectedDeviceCount } = await import(
		"./lib/cloud-transport"
	);
	const cloudRouter = getCloudRouter();
	if (cloudRouter) {
		cloudRouter.wire({
			sendToDevices: broadcastCapabilityRequest,
			isDeviceConnected: () => connectedDeviceCount() > 0,
		});
	}
}

// ── Shutdown handlers ──────────────────────────────────────────────────────────
registerShutdownHandlers({ isCloud: IS_CLOUD, getHttpServer: () => httpServer });

// ── Bootstrap ──────────────────────────────────────────────────────────────────
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
		if (IS_CLOUD) {
			// Cloud: skip heavy bootstrap — morning brief runs on its own schedule.
			edithLog.info("bootstrap_skipped_cloud", {});
		} else {
			edithLog.info("bootstrap_start", {});
			const bootBrief = await buildBrief("boot");
			// Timeout bootstrap at 3 minutes — if it hangs, log and move on.
			// The scheduler and proactive loop will handle what bootstrap missed.
			const BOOTSTRAP_TIMEOUT_MS = 3 * 60 * 1000;
			const result = await Promise.race([
				dispatchToClaude(bootBrief, {
					resume: true,
					label: "bootstrap",
					briefType: "boot",
					priority: Priority.P0_CRITICAL,
				}),
				new Promise<string>((resolve) =>
					setTimeout(() => {
						edithLog.warn("bootstrap_timeout", { timeoutMs: BOOTSTRAP_TIMEOUT_MS });
						resolve("");
					}, BOOTSTRAP_TIMEOUT_MS)
				),
			]);
			edithLog.info("bootstrap_complete", { hadResult: !!result });
		}
	}

	const deadLetters = loadDeadLetters();
	if (deadLetters.length > 0) {
		edithLog.info("dead_letter_replay", { count: deadLetters.length });
		for (const dl of deadLetters) {
			edithLog.info("dead_letter_replaying", { preview: dl.message.slice(0, 60) });
			try {
				await dispatchToConversation(dl.chatId, 0, dl.message);
			} catch (err) {
				edithLog.error("dead_letter_replay_failed", {
					error: fmtErr(err),
					chatId: dl.chatId,
					messagePreview: dl.message.slice(0, 200),
				});
				saveDeadLetter(dl.chatId, dl.message, `replay failed: ${err}`);
			}
		}
		clearDeadLetters();
		edithLog.info("dead_letter_replay_complete", {});
	}
}

// ── Start ──────────────────────────────────────────────────────────────────────
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
	mode: IS_CLOUD ? "cloud" : "local",
	betterstack: !!process.env.BETTERSTACK_SOURCE_TOKEN,
});
if (!IS_CLOUD) startCaffeinate();

// Bootstrap runs in background — NEVER blocks the scheduler or Telegram.
// The old `await bootstrap()` hung 93% of the time (issue #161), preventing
// the scheduler, proactive loop, and message handling from ever starting.
bootstrap()
	.then(() => edithLog.info("bootstrap_background_done", {}))
	.catch((err) => edithLog.error("bootstrap_background_failed", { error: fmtErr(err) }));

// Scheduler tick — starts IMMEDIATELY, not after bootstrap
edithLog.info("scheduler_interval_set", { intervalMs: SCHEDULE_CHECK_MS });
const tickState: TickState = { paused: false };
let schedulerRunning = false;
let tickCount = 0;
setInterval(async () => {
	if (schedulerRunning) return;
	schedulerRunning = true;
	tickCount++;
	try {
		setPaused(tickState.paused);
		await schedulerTick(tickState);
		setPaused(tickState.paused);
		pingHeartbeat();
		// Heartbeat log every 10 ticks (~10 min) for observability
		if (tickCount % 10 === 0) {
			edithLog.info("scheduler_heartbeat", { tickCount });
		}
	} catch (err) {
		edithLog.error("scheduler_tick_error", { error: fmtErr(err) });
	} finally {
		schedulerRunning = false;
	}
}, SCHEDULE_CHECK_MS);

// Removed standalone runScheduler() call — the interval at line 198 handles it.
// The standalone call raced with the first interval tick, causing duplicate dispatches.

// Telegram: webhook (cloud) vs polling (local)
if (IS_CLOUD) {
	const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
		? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
		: `https://${process.env.RAILWAY_STATIC_URL ?? "localhost:8080"}`;
	registerWebhook(publicUrl).catch((err) => {
		edithLog.error("webhook_startup_failed", { error: fmtErr(err) });
	});
} else {
	deregisterWebhook()
		.then(() => {
			startPolling(processUpdate).catch((err) => {
				edithLog.fatal("poll_loop_crashed", { error: fmtErr(err) });
				process.exit(1);
			});
		})
		.catch(() => {
			startPolling(processUpdate).catch((err) => {
				edithLog.fatal("poll_loop_crashed", { error: fmtErr(err) });
				process.exit(1);
			});
		});
}
