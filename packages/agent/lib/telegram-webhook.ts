/**
 * Telegram webhook registration helpers — used in cloud mode only.
 */

import { TELEGRAM_BOT_TOKEN as BOT_TOKEN } from "./config";
import { edithLog } from "./edith-logger";
import { tgCall } from "./telegram";
import { fmtErr } from "./util";

export const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? BOT_TOKEN?.slice(-20) ?? "";

/** Register webhook URL with Telegram. Deletes any existing webhook first. */
export async function registerWebhook(publicUrl: string): Promise<void> {
	const webhookUrl = `${publicUrl}/webhook/${WEBHOOK_SECRET}`;
	try {
		await tgCall("setWebhook", {
			url: webhookUrl,
			allowed_updates: ["message", "edited_message"],
			secret_token: WEBHOOK_SECRET,
		});
		edithLog.info("webhook_registered", { url: webhookUrl.replace(WEBHOOK_SECRET, "***") });
	} catch (err) {
		edithLog.error("webhook_registration_failed", { error: fmtErr(err) });
	}
}

/** Remove webhook so polling can resume (e.g., when switching back to local). */
export async function deregisterWebhook(): Promise<void> {
	try {
		await tgCall("deleteWebhook", {});
		edithLog.info("webhook_deregistered", {});
	} catch (err) {
		edithLog.error("webhook_deregistration_failed", { error: fmtErr(err) });
	}
}
