/**
 * Gmail direct API client — lib/gmail.ts
 *
 * All calls go directly to the Gmail REST API via fetch.
 * No googleapis SDK dependency.
 *
 * Auth: OAuth2 access token via lib/google-auth.ts
 *       (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)
 */

import { getAccessToken } from "./google-auth";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmailMessage {
	id: string;
	subject: string;
	from: string;
	date: string;
	snippet: string;
	unread: boolean;
}

export interface EmailList {
	emails: EmailMessage[];
	count: number;
}

// ── Internals ─────────────────────────────────────────────────────────────────

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailFetch(
	path: string,
	options: RequestInit = {}
): Promise<Response> {
	const token = await getAccessToken();
	const url = `${GMAIL_API}${path}`;
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
	return res;
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
	return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function fetchMessage(id: string): Promise<EmailMessage> {
	const res = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
	if (!res.ok) {
		throw new Error(`Gmail messages.get failed (${res.status}): ${await res.text()}`);
	}
	const msg = (await res.json()) as {
		id: string;
		snippet: string;
		labelIds: string[];
		payload: { headers: Array<{ name: string; value: string }> };
	};
	const headers = msg.payload?.headers ?? [];
	return {
		id: msg.id,
		subject: headerValue(headers, "Subject") || "(no subject)",
		from: headerValue(headers, "From"),
		date: headerValue(headers, "Date"),
		snippet: msg.snippet ?? "",
		unread: (msg.labelIds ?? []).includes("UNREAD"),
	};
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SearchEmailsOptions {
	/** Maximum results to return. Default: 10, max: 50 */
	maxResults?: number;
	/** Only look at emails from the last N hours. Default: 4 */
	hoursBack?: number;
	/** Return only unread emails. Default: true */
	unreadOnly?: boolean;
	/** Raw Gmail query string (overrides hoursBack/unreadOnly if provided) */
	query?: string;
}

/**
 * List recent emails matching the given filters.
 * Fetches full headers for each matching message.
 */
export async function searchEmails(options: SearchEmailsOptions = {}): Promise<EmailList> {
	const maxResults = Math.min(options.maxResults ?? 10, 50);
	const hoursBack = options.hoursBack ?? 4;
	const unreadOnly = options.unreadOnly ?? true;

	let q = options.query ?? "";
	if (!q) {
		const after = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
		q = `after:${after}`;
		if (unreadOnly) q += " is:unread";
	}

	const params = new URLSearchParams({
		q,
		maxResults: String(maxResults),
	});

	const res = await gmailFetch(`/messages?${params.toString()}`);
	if (!res.ok) {
		throw new Error(`Gmail messages.list failed (${res.status}): ${await res.text()}`);
	}

	const data = (await res.json()) as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };
	const messageRefs = data.messages ?? [];

	// Fetch headers for each message in parallel (capped at maxResults)
	const emails = await Promise.all(messageRefs.slice(0, maxResults).map((m) => fetchMessage(m.id)));

	return { emails, count: emails.length };
}

/**
 * Archive an email (removes INBOX label).
 */
export async function archiveEmail(messageId: string): Promise<void> {
	const res = await gmailFetch(`/messages/${messageId}/modify`, {
		method: "POST",
		body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
	});
	if (!res.ok) {
		throw new Error(`Gmail archive failed (${res.status}): ${await res.text()}`);
	}
}

/**
 * Move an email to Trash.
 */
export async function trashEmail(messageId: string): Promise<void> {
	const res = await gmailFetch(`/messages/${messageId}/trash`, { method: "POST" });
	if (!res.ok) {
		throw new Error(`Gmail trash failed (${res.status}): ${await res.text()}`);
	}
}

/**
 * Mark an email as read (removes UNREAD label).
 */
export async function markAsRead(messageId: string): Promise<void> {
	const res = await gmailFetch(`/messages/${messageId}/modify`, {
		method: "POST",
		body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
	});
	if (!res.ok) {
		throw new Error(`Gmail markAsRead failed (${res.status}): ${await res.text()}`);
	}
}

/**
 * Add a label to an email. Label must already exist in Gmail.
 * Accepts either a label ID (e.g. "Label_123") or a display name (e.g. "Work").
 */
export async function addLabel(messageId: string, label: string): Promise<void> {
	const labelId = await resolveLabelId(label);
	const res = await gmailFetch(`/messages/${messageId}/modify`, {
		method: "POST",
		body: JSON.stringify({ addLabelIds: [labelId] }),
	});
	if (!res.ok) {
		throw new Error(`Gmail addLabel failed (${res.status}): ${await res.text()}`);
	}
}

/**
 * Remove a label from an email.
 */
export async function removeLabel(messageId: string, label: string): Promise<void> {
	const labelId = await resolveLabelId(label);
	const res = await gmailFetch(`/messages/${messageId}/modify`, {
		method: "POST",
		body: JSON.stringify({ removeLabelIds: [labelId] }),
	});
	if (!res.ok) {
		throw new Error(`Gmail removeLabel failed (${res.status}): ${await res.text()}`);
	}
}

// Label name → ID resolution (cached per process)
let _labelCache: Map<string, string> | null = null;

async function resolveLabelId(nameOrId: string): Promise<string> {
	// If it looks like an ID (starts with "Label_" or all caps system label), use as-is
	if (/^Label_\d+$/.test(nameOrId) || nameOrId === nameOrId.toUpperCase()) {
		return nameOrId;
	}

	if (!_labelCache) {
		const res = await gmailFetch("/labels");
		if (!res.ok) throw new Error(`Gmail labels.list failed (${res.status}): ${await res.text()}`);
		const data = (await res.json()) as { labels: Array<{ id: string; name: string }> };
		_labelCache = new Map(data.labels.map((l) => [l.name.toLowerCase(), l.id]));
	}

	const id = _labelCache.get(nameOrId.toLowerCase());
	if (!id) throw new Error(`Gmail label not found: "${nameOrId}"`);
	return id;
}

/**
 * Execute multiple email operations sequentially.
 * Returns how many succeeded.
 */
export interface BatchOperation {
	messageId: string;
	action: "archive" | "trash" | "markAsRead" | "addLabel" | "removeLabel";
	label?: string;
}

export async function batchManage(
	operations: BatchOperation[]
): Promise<{ success: boolean; count: number; errors: string[] }> {
	const errors: string[] = [];
	let count = 0;

	for (const op of operations) {
		try {
			await manageEmail(op.messageId, op.action, op.label);
			count++;
		} catch (err) {
			errors.push(`${op.messageId}/${op.action}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { success: errors.length === 0, count, errors };
}

/**
 * Perform a single action on one email.
 */
export async function manageEmail(
	messageId: string,
	action: "archive" | "trash" | "markAsRead" | "addLabel" | "removeLabel",
	label?: string
): Promise<void> {
	switch (action) {
		case "archive":
			return archiveEmail(messageId);
		case "trash":
			return trashEmail(messageId);
		case "markAsRead":
			return markAsRead(messageId);
		case "addLabel":
			if (!label) throw new Error("addLabel requires a label name");
			return addLabel(messageId, label);
		case "removeLabel":
			if (!label) throw new Error("removeLabel requires a label name");
			return removeLabel(messageId, label);
		default: {
			const _exhaustive: never = action;
			throw new Error(`Unknown action: ${_exhaustive}`);
		}
	}
}

/**
 * Send an email via Gmail.
 *
 * Builds a minimal RFC 2822 message and base64url-encodes it for the API.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
	const boundary = `edith_${Date.now()}`;
	const rfc2822 = [
		`To: ${to}`,
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
		`--${boundary}--`,
	].join("\r\n");

	// Base64url encode
	const encoded = btoa(unescape(encodeURIComponent(rfc2822)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	const res = await gmailFetch("/messages/send", {
		method: "POST",
		body: JSON.stringify({ raw: encoded }),
	});

	if (!res.ok) {
		throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
	}
}
