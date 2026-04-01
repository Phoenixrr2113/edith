/**
 * Scheduler tick — signals, triggers, and scheduled task dispatch.
 * Thin orchestrator: all IPC logic lives in lib/ipc.ts.
 */

import { checkSignals, processTriggers, type TickState } from "./ipc";
import { runScheduler } from "./scheduler";

export type { TickState };

/**
 * Full scheduler tick — check signals, process triggers, run scheduler.
 */
export async function schedulerTick(state: TickState): Promise<void> {
	const signal = checkSignals(state);
	if (signal === "restart") process.exit(0);
	if (signal === "pause" || state.paused) return;

	await processTriggers();
	await runScheduler();
}
