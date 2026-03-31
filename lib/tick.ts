/**
 * Scheduler tick — signals, triggers, and inbox processing.
 * Thin orchestrator: all IPC logic lives in lib/ipc.ts.
 */

import { checkSignals, processInbox, processTriggers, type TickState } from "./ipc";
import { runScheduler } from "./scheduler";

export type { TickState };

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
