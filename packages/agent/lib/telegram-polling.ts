/**
 * Telegram getUpdates polling loop — used in local mode only.
 */

import { BACKOFF_SCHEDULE, POLL_INTERVAL_MS } from "./config";
import { edithLog } from "./edith-logger";
import { offset, saveOffset } from "./state";
import { tgCall } from "./telegram";
import { fmtErr } from "./util";

let currentOffset = offset;

export async function startPolling(
	onUpdate: (update: Record<string, unknown>) => Promise<void>
): Promise<void> {
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
				await onUpdate(update);
			}
			consecutiveErrors = 0;
		} catch (err) {
			consecutiveErrors++;
			const backoff =
				BACKOFF_SCHEDULE[Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1)];
			const errStr = fmtErr(err);
			edithLog.error("poll_error", {
				error: errStr,
				consecutiveErrors,
				backoffMs: backoff,
				hint: errStr.includes("Conflict")
					? "Another bot instance is polling — check for duplicate local/cloud processes"
					: undefined,
			});
			await Bun.sleep(backoff);
			continue;
		}

		await Bun.sleep(POLL_INTERVAL_MS);
	}
}
