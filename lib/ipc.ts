/**
 * IPC mechanisms — signal files, trigger files, inbox messages.
 *
 * Edith uses three file-based IPC channels:
 *   1. Signal files  (~/.edith/.signal-*)  — presence triggers a lifecycle action
 *   2. Trigger files (~/.edith/triggers/)  — presence fires a named scheduled task
 *   3. Inbox files   (~/.edith/inbox/)     — JSON messages from the dashboard
 *
 * A fourth IPC channel (in-process streamInput injection) lives in lib/session.ts
 * as it is tightly coupled to the Agent SDK query handle.
 *
 * sendIpc() writes a dashboard-style inbox message so external tools can enqueue
 * work without touching the Telegram poll loop.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { STATE_DIR, INBOX_DIR, CHAT_ID } from "./config";
import { logEvent } from "./state";
import { dispatchToClaude } from "./dispatch";
import { buildBrief, BRIEF_TYPE_MAP, type BriefType } from "./briefs";
import { fmtErr } from "./util";

// ── Signal file paths ──────────────────────────────────────────────────────────

export const SIGNAL_RESTART = join(STATE_DIR, ".signal-restart");
export const SIGNAL_PAUSE   = join(STATE_DIR, ".signal-pause");
export const SIGNAL_FRESH   = join(STATE_DIR, ".signal-fresh");

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
    console.log("[edith] Signal: restart requested.");
    try { unlinkSync(SIGNAL_RESTART); } catch {}
    logEvent("signal_restart", {});
    return "restart";
  }

  if (existsSync(SIGNAL_PAUSE)) {
    console.log("[edith] Signal: pause requested. Waiting for 'wake up' message...");
    try { unlinkSync(SIGNAL_PAUSE); } catch {}
    logEvent("signal_pause", {});
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
      console.log(`[edith] Dashboard trigger: ${f}`);
      logEvent("dashboard_trigger", { task: f });
      const briefType: BriefType | undefined = BRIEF_TYPE_MAP[f];
      const prompt = briefType
        ? await buildBrief(briefType)
        : await buildBrief("scheduled", { prompt: `/${f}`, taskName: f });
      dispatchToClaude(prompt, { resume: false, label: f, skipIfBusy: false, briefType: briefType ?? "scheduled" })
        .then(() => { try { unlinkSync(fp); } catch {} })
        .catch((err) => {
          console.error(`[edith] Trigger dispatch error:`, fmtErr(err));
          try { unlinkSync(fp); } catch {};
        });
    }
  } catch {}
}

// ── Inbox processing ───────────────────────────────────────────────────────────

/**
 * Process dashboard inbox messages (dashboard-*.json files in INBOX_DIR).
 */
export async function processInbox(): Promise<void> {
  try {
    if (!existsSync(INBOX_DIR)) return;
    for (const f of readdirSync(INBOX_DIR)) {
      if (!f.startsWith("dashboard-")) continue;
      const fp = join(INBOX_DIR, f);
      try {
        const msg = JSON.parse(readFileSync(fp, "utf-8"));
        if (msg.text?.trim()) {
          console.log(`[edith] Dashboard message: ${msg.text.slice(0, 80)}`);
          logEvent("dashboard_message", { text: msg.text.slice(0, 200) });
          const brief = await buildBrief("message", { message: msg.text, chatId: String(CHAT_ID) });
          dispatchToClaude(brief, { resume: true, label: "dashboard-msg", chatId: CHAT_ID })
            .then(() => { try { unlinkSync(fp); } catch {} })
            .catch((err) => {
              console.error(`[edith] Dashboard msg dispatch error:`, fmtErr(err));
              try { unlinkSync(fp); } catch {};
            });
        } else {
          try { unlinkSync(fp); } catch {};
        }
      } catch {}
    }
  } catch {}
}

// ── sendIpc ────────────────────────────────────────────────────────────────────

/**
 * Write a dashboard-style inbox message so external tools can enqueue work
 * without going through the Telegram poll loop.
 */
export async function sendIpc(message: string): Promise<void> {
  const fname = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const fp = join(INBOX_DIR, fname);
  writeFileSync(fp, JSON.stringify({ text: message, ts: new Date().toISOString() }), "utf-8");
  logEvent("ipc_send", { text: message.slice(0, 200) });
}
