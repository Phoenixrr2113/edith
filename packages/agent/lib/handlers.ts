/**
 * Telegram message handlers — extracted from edith.ts poll() for testability.
 */

import { buildBrief } from "./briefs";
import { CHAT_ID } from "./config";
import { dispatchToClaude, dispatchToConversation } from "./dispatch";
import { edithLog } from "./edith-logger";
import {
	checkLocationReminders,
	checkLocationTransitions,
	checkTimeReminders,
	markFired,
} from "./geo";
import { canIntervene } from "./proactive";
import { logEvent } from "./state";
import { downloadFile, sendMessage, transcribeAudio } from "./telegram";
import { fmtErr } from "./util";

/** Handle a location update message. */
export async function handleLocation(chatId: number, lat: number, lon: number): Promise<void> {
	const locReminders = checkLocationReminders(lat, lon);
	for (const { reminder, locationLabel } of locReminders) {
		await sendMessage(chatId, `📍 *Reminder* (near ${locationLabel})\n\n${reminder.text}`);
	}
	if (locReminders.length > 0) {
		markFired(locReminders.map((t) => t.reminder.id));
	}

	const timeReminders = checkTimeReminders();
	for (const r of timeReminders) {
		await sendMessage(chatId, `⏰ *Reminder*\n\n${r.text}`);
	}
	if (timeReminders.length > 0) {
		markFired(timeReminders.map((r) => r.id));
	}

	const transitions = checkLocationTransitions(lat, lon);
	if (transitions.length > 0) {
		const gate = canIntervene("location-transition");
		if (gate.allowed) {
			const desc = transitions
				.map((t) => {
					const emoji = t.type === "arrived" ? "📍" : "🚗";
					return `${emoji} ${t.type === "arrived" ? "Arrived at" : "Left"} ${t.locationLabel}`;
				})
				.join(". ");
			const brief = await buildBrief("location", {
				description: desc,
				lat: String(lat),
				lon: String(lon),
				chatId: String(chatId),
			});
			await dispatchToClaude(brief, { label: "location", briefType: "location" });
		} else {
			edithLog.info("location_transition_skipped", { reason: gate.reason });
		}
	}
}

/** Handle a voice/audio message. */
export async function handleVoice(
	chatId: number,
	messageId: number,
	fileId: string
): Promise<void> {
	try {
		const localPath = await downloadFile(fileId, "ogg");
		const transcription = await transcribeAudio(localPath);
		const content = transcription
			? `[Voice note from Randy] "${transcription}"`
			: `[Voice note from Randy] Audio file saved at: ${localPath}. Could not transcribe.`;
		logEvent("voice_transcribed", { path: localPath, text: (transcription ?? "").slice(0, 200) });
		await dispatchToConversation(chatId, messageId, content);
	} catch (err) {
		edithLog.error("voice_processing_failed", { message: fmtErr(err) });
		await dispatchToConversation(
			chatId,
			messageId,
			`[Voice note from Randy] Failed to download/transcribe. Error: ${fmtErr(err)}`
		);
	}
}

/** Handle a photo message. */
export async function handlePhoto(
	chatId: number,
	messageId: number,
	fileId: string,
	caption: string
): Promise<void> {
	try {
		const localPath = await downloadFile(fileId, "jpg");
		await dispatchToConversation(
			chatId,
			messageId,
			`[Photo from Randy]${caption ? ` Caption: ${caption}.` : ""} Image saved at: ${localPath}.`
		);
	} catch (err) {
		edithLog.error("photo_processing_failed", { message: fmtErr(err) });
		await dispatchToConversation(
			chatId,
			messageId,
			`[Photo from Randy] Failed to download. Error: ${fmtErr(err)}`
		);
	}
}

/** Handle a text message (direct or SMS relay). */
export async function handleText(
	chatId: number,
	messageId: number,
	text: string,
	isSmsBot: boolean
): Promise<void> {
	if (isSmsBot) {
		await dispatchToConversation(
			chatId,
			messageId,
			`[Incoming SMS forwarded by relay bot]\n${text}\n\n[Triage this: store any new contacts/context in Cognee. If it needs Randy's attention, summarize and forward via send_message. If it's spam/verification codes, ignore silently. Chat ID: ${CHAT_ID}]`
		);
	} else {
		await dispatchToConversation(chatId, messageId, `[Message from Randy via Telegram] ${text}`);
	}
}
