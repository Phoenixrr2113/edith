/**
 * ntfy.sh push notification client.
 *
 * ntfy.sh is an open-source push notification service that works on any device
 * (iOS, Android, macOS, web browser) via simple HTTP POST. No SDK needed.
 *
 * Self-hostable: docker run -p 80:80 binwiederhier/ntfy
 */

import { edithLog } from "./edith-logger";

const NTFY_SERVER = process.env.NTFY_SERVER ?? "https://ntfy.sh";
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "";

export interface NtfyAction {
	action: "view" | "http" | "broadcast";
	label: string;
	url?: string;
	clear?: boolean;
}

export interface PushOptions {
	/** 1=min, 2=low, 3=default, 4=high, 5=urgent */
	priority?: 1 | 2 | 3 | 4 | 5;
	/** Emoji tags (e.g. ["calendar", "warning"]) */
	tags?: string[];
	/** URL to open when notification is tapped */
	click?: string;
	/** Action buttons */
	actions?: NtfyAction[];
}

/**
 * Send a push notification via ntfy.sh.
 * Returns true on success, false on failure.
 */
export async function pushNotification(
	title: string,
	body: string,
	opts: PushOptions = {}
): Promise<boolean> {
	if (!NTFY_TOPIC) {
		edithLog.warn("ntfy_no_topic", { title, hint: "Set NTFY_TOPIC env var" });
		return false;
	}

	const url = `${NTFY_SERVER}/${NTFY_TOPIC}`;
	const headers: Record<string, string> = {
		Title: title,
	};

	if (opts.priority) headers.Priority = String(opts.priority);
	if (opts.tags?.length) headers.Tags = opts.tags.join(",");
	if (opts.click) headers.Click = opts.click;
	if (opts.actions?.length) {
		headers.Actions = opts.actions
			.map((a) => {
				const parts = [a.action, a.label];
				if (a.url) parts.push(a.url);
				if (a.clear) parts.push("clear=true");
				return parts.join(", ");
			})
			.join("; ");
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(10_000),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			edithLog.warn("ntfy_send_failed", { status: res.status, response: text.slice(0, 200) });
			return false;
		}

		edithLog.info("ntfy_sent", { title, priority: opts.priority ?? 3 });
		return true;
	} catch (err) {
		edithLog.warn("ntfy_send_error", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/** Check if ntfy is configured (topic set). */
export function isNtfyConfigured(): boolean {
	return !!NTFY_TOPIC;
}
