/**
 * SMS utilities — spam filtering and message parsing for relay bot messages.
 *
 * The relay bot sends messages in this format:
 *   [UnknownReceive SMS]
 *   From: +18005551234
 *   Content: The actual message text here
 *   Time: 31/Mar/2026 18:15:47 GMT-04:00
 *
 * Messages may be nested (relay wrapping another relay) and/or duplicated.
 */

import { edithLog } from "./edith-logger";

// ── Spam detection ───────────────────────────────────────────────────────────

/** Patterns that indicate marketing/spam SMS. Case-insensitive. */
const SPAM_PATTERNS = [
	/\d+%\s*off/i, // "15% off", "50% OFF"
	/\bcode\s+[A-Z]{4,}/i, // "code TRYSTICKS", "code SAVE20"
	/\bcoupon\b/i,
	/\bpromo\b/i,
	/\bunsubscribe\b/i,
	/\bopt.?out\b/i,
	/\breply\s+stop\b/i,
	/\bstop\s+to\s+(cancel|end|quit)/i,
	/\bfree\s+(trial|gift|shipping)/i,
	/\blimited\s+time/i,
	/\bact\s+now\b/i,
	/\bonce\s+they'?re\s+gone/i,
	/\bclaim\s+(your|now|this)/i,
	/\bwinner\b/i,
	/\bcongrat(s|ulations)\b.*\b(won|prize|reward)/i,
	/\bverification\s+code\b/i,
	/\byour\s+code\s+is\b/i,
	/\bone-time\s+(code|password|passcode)\b/i,
];

/** Shortcode numbers (5-6 digits) are almost always automated/marketing. */
const SHORTCODE_RE = /^\+?1?\d{5,6}$/;

/**
 * Returns true if the SMS text looks like spam/marketing/verification code.
 * Designed for high precision (few false positives) — when in doubt, returns false.
 */
export function isSmsSpam(text: string, senderNumber?: string): boolean {
	// Shortcode senders are almost always automated
	if (senderNumber && SHORTCODE_RE.test(senderNumber.replace(/\D/g, ""))) {
		return true;
	}

	// Check content patterns
	let matchCount = 0;
	for (const pattern of SPAM_PATTERNS) {
		if (pattern.test(text)) {
			matchCount++;
			if (matchCount >= 2) return true; // 2+ matches = very likely spam
		}
	}

	return false;
}

// ── Message parsing ──────────────────────────────────────────────────────────

export interface ParsedSms {
	from: string;
	content: string;
	timestamp?: string;
}

/**
 * Parse the relay bot's raw text format into structured fields.
 * Handles nested [UnknownReceive SMS] wrappers and extracts the innermost message.
 * Returns null if the format is unrecognizable.
 */
export function parseSmsRelay(raw: string): ParsedSms | null {
	// Find the innermost "From:" + "Content:" block
	const fromMatch = raw.match(/From:\s*(\+?\d[\d\s-]+)/g);
	const contentMatch = raw.match(/Content:\s*([\s\S]*?)(?=\nTime:|$)/g);
	const timeMatch = raw.match(/Time:\s*(.+)/);

	if (!fromMatch || !contentMatch) return null;

	// Use the last (innermost) From and Content to handle nesting
	const from = fromMatch[fromMatch.length - 1].replace(/^From:\s*/, "").trim();

	// Get the last content block, strip any nested [UnknownReceive SMS] headers
	let content = contentMatch[contentMatch.length - 1].replace(/^Content:\s*/, "").trim();
	// Remove any nested relay wrappers from the content
	content = content.replace(/\[UnknownReceive SMS\]\s*/g, "").trim();

	const timestamp = timeMatch ? timeMatch[1].trim() : undefined;

	return { from, content, timestamp };
}

/**
 * Deduplicate by checking if the same content appears multiple times in the relay message.
 * Returns the deduplicated content.
 */
export function deduplicateSmsContent(raw: string): string {
	const parsed = parseSmsRelay(raw);
	if (parsed) {
		return parsed.content;
	}
	return raw;
}

/**
 * Process an incoming SMS relay message. Returns null if spam (should be silently dropped).
 * Otherwise returns a clean, structured message for Claude to triage.
 */
export function processSmsRelay(raw: string): string | null {
	const parsed = parseSmsRelay(raw);

	if (parsed) {
		// Check spam before dispatching to Claude
		if (isSmsSpam(parsed.content, parsed.from)) {
			edithLog.info("sms_spam_filtered", {
				from: parsed.from,
				preview: parsed.content.slice(0, 80),
			});
			return null;
		}

		// Return clean, structured format
		const parts = [`[SMS from ${parsed.from}]`, parsed.content];
		if (parsed.timestamp) parts.push(`(${parsed.timestamp})`);
		return parts.join("\n");
	}

	// Unparseable — pass through but still check for spam
	if (isSmsSpam(raw)) {
		edithLog.info("sms_spam_filtered", { preview: raw.slice(0, 80) });
		return null;
	}

	return raw;
}
