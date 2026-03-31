/**
 * Twilio API client — WhatsApp + SMS sending.
 */
import { TWILIO_SID, TWILIO_TOKEN } from "./config";

export async function sendTwilio(
	to: string,
	body: string,
	from: string
): Promise<{ ok: boolean; sid?: string; error?: string }> {
	if (!TWILIO_SID || !TWILIO_TOKEN) {
		return { ok: false, error: "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set in .env" };
	}
	if (!from) {
		return {
			ok: false,
			error: "No from number configured (TWILIO_WHATSAPP_FROM or TWILIO_SMS_FROM)",
		};
	}

	const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
	const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
	const params = new URLSearchParams({ To: to, From: from, Body: body });

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Basic ${auth}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: params.toString(),
	});

	const data = (await res.json()) as { sid?: string; message?: string };
	return res.ok
		? { ok: true, sid: data.sid }
		: { ok: false, error: data.message ?? `HTTP ${res.status}` };
}
