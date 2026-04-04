import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAT_ID, TWILIO_SMS_FROM, TWILIO_WA_FROM } from "../../agent/lib/config";
import { edithLog } from "../../agent/lib/edith-logger";
import { sendEmail } from "../../agent/lib/gmail";
import { textResponse } from "../../agent/lib/mcp-helpers";
import { showDialog, showNotification } from "../../agent/lib/notify";
import { pushNotification } from "../../agent/lib/ntfy";
import { evaluateOutboundMessage } from "../../agent/lib/sentinel";
import { sendMessage, sendPhoto, tgCall } from "../../agent/lib/telegram";
import { sendTwilio } from "../../agent/lib/twilio";
import { fmtErr } from "../../agent/lib/util";

const ALLOWED_CHAT = CHAT_ID;

export function registerMessagingTools(server: McpServer): void {
	// ============================================================
	// Telegram — send_message (text, image, reaction)
	// ============================================================

	server.registerTool(
		"send_message",
		{
			description:
				"Send a message to Randy via Telegram. Supports text, images, emoji reactions, or text+image together. chat_id is optional — defaults to Randy's chat.",
			inputSchema: {
				chat_id: z.coerce
					.number()
					.optional()
					.describe("Telegram chat ID (optional — defaults to Randy's chat)"),
				text: z.string().optional().describe("Message text to send"),
				image: z
					.string()
					.optional()
					.describe("Base64 data URL (data:image/png;base64,...) to send as photo"),
				emoji: z.string().optional().describe("Emoji to react with (instead of text/image)"),
				message_id: z.number().optional().describe("Message ID to react to (required with emoji)"),
			},
		},
		async ({ chat_id: rawChatId, text, image, emoji, message_id }) => {
			const chat_id = rawChatId ?? CHAT_ID;
			if (!chat_id) return textResponse("No chat_id provided and TELEGRAM_CHAT_ID not set.");
			if (ALLOWED_CHAT && chat_id !== ALLOWED_CHAT)
				return textResponse(`Blocked: chat_id ${chat_id} not authorized.`);

			// Emoji reaction
			if (emoji) {
				if (!message_id) return textResponse("Reactions require message_id");
				try {
					await tgCall("setMessageReaction", {
						chat_id,
						message_id,
						reaction: [{ type: "emoji", emoji }],
					});
				} catch {}
				return textResponse("Reacted");
			}

			// Image (with optional caption)
			if (image) {
				try {
					await sendPhoto(chat_id, image, text);
					edithLog.info("image_sent", { chatId: chat_id, caption: text?.slice(0, 100) });
					return textResponse("Image sent");
				} catch (err) {
					return textResponse(`Failed to send image: ${fmtErr(err)}`);
				}
			}

			// Text only
			if (!text) return textResponse("Missing text, image, or emoji");
			await sendMessage(chat_id, text);
			edithLog.info("message_sent", { chatId: chat_id, text });

			// Sentinel: fire-and-forget quality evaluation
			evaluateOutboundMessage(text, "message", { chatId: chat_id }).catch(() => {});

			return textResponse("Sent");
		}
	);

	// ============================================================
	// Notifications — send_notification (all channels + desktop)
	// ============================================================

	server.registerTool(
		"send_notification",
		{
			description:
				"Send a notification via any channel. Channels: push (ntfy.sh — any device), telegram, whatsapp, sms, email, slack, discord (remote), desktop (macOS toast), dialog (macOS modal that blocks and returns which button was clicked).",
			inputSchema: {
				channel: z
					.enum([
						"push",
						"whatsapp",
						"sms",
						"slack",
						"email",
						"discord",
						"telegram",
						"desktop",
						"dialog",
					])
					.describe("Delivery channel"),
				recipient: z
					.string()
					.optional()
					.describe(
						"Recipient — phone for WhatsApp/SMS, email for email, chat_id for Telegram. Not needed for desktop/dialog."
					),
				text: z.string().describe("Message or notification body"),
				title: z.string().optional().describe("Title (for desktop/dialog notifications)"),
				subject: z.string().optional().describe("Subject line (for email)"),
				buttons: z
					.array(z.string())
					.min(1)
					.max(3)
					.optional()
					.describe("Button labels for dialog channel (max 3). Returns which was clicked."),
			},
		},
		async ({ channel, recipient, text, title, subject, buttons }) => {
			const log = () =>
				edithLog.info("notification_sent", {
					channel,
					recipient: recipient?.slice(0, 30),
					text: text.slice(0, 100),
				});

			// Push notification via ntfy.sh (works on any device)
			if (channel === "push") {
				const ok = await pushNotification(title ?? "Edith", text, { priority: 3 });
				if (ok) {
					log();
					return textResponse("Push notification sent via ntfy");
				}
				return textResponse("Push notification failed — is NTFY_TOPIC configured?");
			}

			// Desktop toast notification
			if (channel === "desktop") {
				try {
					await showNotification(title ?? "Edith", text);
					edithLog.info("desktop_notification", { title, body: text.slice(0, 100) });
					return textResponse("Notification shown");
				} catch (err) {
					return textResponse(`Notification failed: ${fmtErr(err)}`);
				}
			}

			// Modal dialog (blocks, returns button clicked)
			if (channel === "dialog") {
				try {
					const clicked = await showDialog(title ?? "Edith", text, buttons ?? ["OK"]);
					edithLog.info("desktop_dialog", { title, clicked });
					return textResponse(`Button clicked: ${clicked}`);
				} catch (err) {
					return textResponse(`Dialog failed: ${fmtErr(err)}`);
				}
			}

			// Telegram
			if (channel === "telegram") {
				const chatId = Number(recipient) || CHAT_ID;
				try {
					await sendMessage(chatId, text);
					log();
					return textResponse("Telegram sent");
				} catch (err) {
					return textResponse(`Telegram failed: ${fmtErr(err)}`);
				}
			}

			// WhatsApp (Twilio)
			if (channel === "whatsapp") {
				if (!recipient) return textResponse("WhatsApp requires a recipient phone number");
				const to = recipient.startsWith("whatsapp:") ? recipient : `whatsapp:${recipient}`;
				const result = await sendTwilio(to, text, TWILIO_WA_FROM);
				if (result.ok) {
					log();
					return textResponse(`WhatsApp sent (SID: ${result.sid})`);
				}
				return textResponse(`WhatsApp failed: ${result.error}`);
			}

			// SMS (Twilio)
			if (channel === "sms") {
				if (!recipient) return textResponse("SMS requires a recipient phone number");
				const result = await sendTwilio(recipient, text, TWILIO_SMS_FROM);
				if (result.ok) {
					log();
					return textResponse(`SMS sent (SID: ${result.sid})`);
				}
				return textResponse(`SMS failed: ${result.error}`);
			}

			// Email — direct Gmail API
			if (channel === "email") {
				if (!recipient) return textResponse("Email requires a recipient");
				try {
					await sendEmail(recipient, subject || "Message from Edith", text);
					log();
					return textResponse(`Email sent to ${recipient}`);
				} catch (err) {
					return textResponse(`Email failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			// Slack, Discord — not yet supported
			if (!recipient) return textResponse(`${channel} requires a recipient`);
			return textResponse(
				`${channel} notifications are not configured. Set up Slack/Discord webhooks to enable this channel.`
			);
		}
	);
}
