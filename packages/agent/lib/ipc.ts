/**
 * IPC mechanisms — signal files and trigger files.
 *
 * Edith uses two file-based IPC channels:
 *   1. Signal files  (.state/.signal-*)  — presence triggers a lifecycle action
 *   2. Trigger files (.state/triggers/)  — presence fires a named scheduled task
 *
 * A third IPC channel (in-process streamInput injection) lives in lib/session.ts
 * as it is tightly coupled to the Agent SDK query handle.
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_TYPE_MAP, type BriefType, buildBrief } from "./briefs";
import { STATE_DIR } from "./config";
import { dispatchToClaude, Priority } from "./dispatch";
import { edithLog } from "./edith-logger";
import { fmtErr } from "./util";

// ── Signal file paths ──────────────────────────────────────────────────────────

export const SIGNAL_RESTART = join(STATE_DIR, ".signal-restart");
export const SIGNAL_PAUSE = join(STATE_DIR, ".signal-pause");
export const SIGNAL_FRESH = join(STATE_DIR, ".signal-fresh");

// ── Triggers directory ─────────────────────────────────────────────────────────

export const TRIGGERS_DIR = join(STATE_DIR, "triggers");

// ── TickState (shared with lib/tick.ts) ───────────────────────────────────────

export interface TickState {
	paused: boolean;
}

// ── Signal checking ────────────────────────────────────────────────────────────

/**
 * Inspect signal files. Returns "restart" | "pause" | null and mutates
 * state.paused when a pause signal is detected.
 */
export function checkSignals(state: TickState): "restart" | "pause" | null {
	if (existsSync(SIGNAL_RESTART)) {
		edithLog.info("signal_restart_requested", {});
		try {
			unlinkSync(SIGNAL_RESTART);
		} catch {}
		edithLog.info("signal_restart", {});
		return "restart";
	}

	if (existsSync(SIGNAL_PAUSE)) {
		edithLog.info("signal_pause_requested", {});
		try {
			unlinkSync(SIGNAL_PAUSE);
		} catch {}
		edithLog.info("signal_pause", {});
		state.paused = true;
		return "pause";
	}

	return null;
}

// ── Trigger processing ─────────────────────────────────────────────────────────

/**
 * Process dashboard trigger files (manual task fire from dashboard).
 * Each file in TRIGGERS_DIR is named after a task; its presence fires that task.
 */
export async function processTriggers(): Promise<void> {
	try {
		if (!existsSync(TRIGGERS_DIR)) return;
		for (const f of readdirSync(TRIGGERS_DIR)) {
			const fp = join(TRIGGERS_DIR, f);
			edithLog.info("dashboard_trigger_received", { task: f });
			edithLog.info("dashboard_trigger", { task: f });
			const briefType: BriefType | undefined = BRIEF_TYPE_MAP[f];
			const prompt = briefType
				? await buildBrief(briefType)
				: await buildBrief("scheduled", { prompt: `/${f}`, taskName: f });
			dispatchToClaude(prompt, {
				resume: false,
				label: f,
				skipIfBusy: false,
				briefType: briefType ?? "scheduled",
				priority: Priority.P2_INTERACTIVE,
			})
				.then(() => {
					try {
						unlinkSync(fp);
					} catch {}
				})
				.catch((err) => {
					edithLog.error("trigger_dispatch_error", { task: f, error: fmtErr(err) });
					try {
						unlinkSync(fp);
					} catch {}
				});
		}
	} catch {}
}
