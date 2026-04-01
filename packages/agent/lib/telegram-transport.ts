/**
 * Shared Telegram update processing — used by both polling and webhook modes.
 */

import { SMS_BOT_ID } from "./config";
import { edithLog } from "./edith-logger";
import { handleLocation, handlePhoto, handleText, handleVoice } from "./handlers";
import { ALLOWED_CHATS } from "./state";
import { sendTyping } from "./telegram";

let paused = false;
const recentlyIgnored = new Set<number>();

export function setPaused(value: boolean): void {
	paused = value;
}

export function getPaused(): boolean {
	return paused;
}

export async function processUpdate(update: Record<string, unknown>): Promise<void> {
	const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
	if (!msg) return;

	const chatId = (msg.chat as Record<string, unknown>)?.id as number | undefined;
	if (!chatId) return;

	const fromId = (msg.from as Record<string, unknown>)?.id;
	const isSmsBot = !!(SMS_BOT_ID && String(fromId) === SMS_BOT_ID);
	if (!ALLOWED_CHATS.has(chatId) && !isSmsBot) {
		if (!recentlyIgnored.has(chatId)) {
			edithLog.warn("unauthorized_chat_ignored", { chatId });
			recentlyIgnored.add(chatId);
			setTimeout(() => recentlyIgnored.delete(chatId), 60_000);
		}
		return;
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
		return;
	}
	const voice = (msg.voice ?? msg.audio) as Record<string, string> | undefined;
	if (voice) {
		await handleVoice(chatId, msg.message_id as number, voice.file_id);
		return;
	}
	const photos = msg.photo as Array<Record<string, unknown>> | undefined;
	if (photos && photos.length > 0) {
		await handlePhoto(
			chatId,
			msg.message_id as number,
			(photos[photos.length - 1] as Record<string, string>).file_id,
			String(msg.caption ?? "")
		);
		return;
	}
	if (msg.text) {
		await handleText(chatId, msg.message_id as number, msg.text as string, isSmsBot);
	}
}
