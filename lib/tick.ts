/**
 * Scheduler tick — signals, triggers, and inbox processing.
 * Extracted from edith.ts setInterval callback for clarity.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { CHAT_ID, STATE_DIR, INBOX_DIR } from "./config";
import { logEvent } from "./state";
import { dispatchToClaude } from "./dispatch";
import { buildBrief, BRIEF_TYPE_MAP } from "./briefs";
import { runScheduler } from "./scheduler";
import { fmtErr } from "./util";

const SIGNAL_RESTART = join(STATE_DIR, ".signal-restart");
const SIGNAL_PAUSE = join(STATE_DIR, ".signal-pause");
const TRIGGERS_DIR = join(STATE_DIR, "triggers");

export interface TickState {
  paused: boolean;
}

/**
 * Check signal files. Returns "restart" | "pause" | null.
 */
function checkSignals(state: TickState): "restart" | "pause" | null {
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

/**
 * Process dashboard trigger files (manual task fire from dashboard).
 */
async function processTriggers(): Promise<void> {
  try {
    if (!existsSync(TRIGGERS_DIR)) return;
    for (const f of readdirSync(TRIGGERS_DIR)) {
      const fp = join(TRIGGERS_DIR, f);
      console.log(`[edith] Dashboard trigger: ${f}`);
      logEvent("dashboard_trigger", { task: f });
      const briefType = BRIEF_TYPE_MAP[f];
      const prompt = briefType ? await buildBrief(briefType as any) : await buildBrief("scheduled", { prompt: `/${f}`, taskName: f });
      dispatchToClaude(prompt, { resume: false, label: f, skipIfBusy: false, briefType: (briefType ?? "scheduled") as any })
        .then(() => { try { unlinkSync(fp); } catch {} })
        .catch((err) => {
          console.error(`[edith] Trigger dispatch error:`, fmtErr(err));
          try { unlinkSync(fp); } catch {};
        });
    }
  } catch {}
}

/**
 * Process dashboard inbox messages.
 */
async function processInbox(): Promise<void> {
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
          const brief = await buildBrief("message" as any, { message: msg.text, chatId: String(CHAT_ID) });
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

/**
 * Full scheduler tick — check signals, process triggers/inbox, run scheduler.
 */
export async function schedulerTick(state: TickState): Promise<void> {
  const signal = checkSignals(state);
  if (signal === "restart") process.exit(0);
  if (signal === "pause" || state.paused) return;

  await processTriggers();
  await processInbox();
  await runScheduler();
}
