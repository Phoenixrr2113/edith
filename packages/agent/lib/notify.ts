/**
 * Desktop notifications and dialogs.
 * Notifications use terminal-notifier (click opens dashboard).
 * Dialogs use osascript (modal, blocks until button clicked).
 *
 * In cloud mode, these are no-ops — notifications route through ntfy.sh
 * or Telegram instead (see capability-router.ts).
 */

import { IS_CLOUD } from "./config";

const DASHBOARD_URL = `http://localhost:${process.env.DASHBOARD_PORT ?? 3456}`;

/** Sanitize text for AppleScript strings — strip anything that could break out. */
function sanitize(s: string): string {
	return s
		.replace(/[\\"`${}()]/g, "")
		.replace(/[\n\r]/g, " ")
		.slice(0, 500);
}

/**
 * Show a notification toast.
 * Local: macOS Notification Center via terminal-notifier.
 * Cloud: ntfy.sh push notification (reaches any device).
 */
export async function showNotification(title: string, body: string): Promise<void> {
	if (IS_CLOUD) {
		const { pushNotification } = await import("./ntfy");
		await pushNotification(title, body, { priority: 3 });
		return;
	}
	const proc = Bun.spawn([
		"terminal-notifier",
		"-title",
		title,
		"-message",
		body,
		"-open",
		DASHBOARD_URL,
	]);
	await proc.exited;
}

/**
 * Show a modal dialog with buttons. Returns the button text that was clicked.
 * Returns first button text in cloud mode (no dialog shown).
 */
export async function showDialog(
	title: string,
	body: string,
	buttons: string[] = ["OK"]
): Promise<string> {
	if (!buttons.length) buttons = ["OK"];
	if (IS_CLOUD) {
		// Dialogs need interaction — send high-priority push + return default button
		const { pushNotification } = await import("./ntfy");
		await pushNotification(title, body, { priority: 5, tags: ["question"] });
		return buttons[0];
	}
	const safeBody = sanitize(body);
	const safeTitle = sanitize(title);
	const buttonList = buttons.map((b) => `"${sanitize(b)}"`).join(", ");
	const defaultButton = `"${sanitize(buttons[buttons.length - 1])}"`;

	const proc = Bun.spawn([
		"osascript",
		"-e",
		`display dialog "${safeBody}" buttons {${buttonList}} default button ${defaultButton} with title "${safeTitle}"`,
	]);
	const output = await new Response(proc.stdout).text();
	await proc.exited;

	const match = output.match(/button returned:(.+)/);
	return match?.[1]?.trim() ?? buttons[0];
}

/**
 * Show a simple alert (modal, single OK button).
 * No-op in cloud mode.
 */
export async function showAlert(message: string): Promise<void> {
	if (IS_CLOUD) {
		const { pushNotification } = await import("./ntfy");
		await pushNotification("Edith Alert", message, { priority: 4, tags: ["warning"] });
		return;
	}
	const safeMsg = sanitize(message);
	const proc = Bun.spawn(["osascript", "-e", `display alert "${safeMsg}"`]);
	await proc.exited;
}
