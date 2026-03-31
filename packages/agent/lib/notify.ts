/**
 * Desktop notifications and dialogs.
 * Notifications use terminal-notifier (click opens dashboard).
 * Dialogs use osascript (modal, blocks until button clicked).
 */

const DASHBOARD_URL = `http://localhost:${process.env.DASHBOARD_PORT ?? 3456}`;

/** Sanitize text for AppleScript strings — strip anything that could break out. */
function sanitize(s: string): string {
	return s
		.replace(/[\\"`${}()]/g, "")
		.replace(/[\n\r]/g, " ")
		.slice(0, 500);
}

/**
 * Show a macOS Notification Center toast (non-blocking).
 * Clicking opens the Edith dashboard.
 */
export async function showNotification(title: string, body: string): Promise<void> {
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
 */
export async function showDialog(
	title: string,
	body: string,
	buttons: string[] = ["OK"]
): Promise<string> {
	if (!buttons.length) buttons = ["OK"];
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
 */
export async function showAlert(message: string): Promise<void> {
	const safeMsg = sanitize(message);
	const proc = Bun.spawn(["osascript", "-e", `display alert "${safeMsg}"`]);
	await proc.exited;
}
