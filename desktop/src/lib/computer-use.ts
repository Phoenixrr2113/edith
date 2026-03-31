/**
 * computer-use.ts — Desktop automation via Tauri shell commands.
 *
 * ComputerUse wraps macOS automation tools (cliclick, osascript) exposed
 * through the Tauri shell plugin to provide click, type, key-press, app-launch,
 * and screenshot capabilities.
 *
 * Safety model:
 *   - Permission is requested from the user before each session (or action).
 *   - A visual "in control" indicator is communicated via callbacks.
 *   - Auto-release after CONTROL_TIMEOUT_MS of inactivity.
 *   - Escape key (handled at app level) calls release().
 *
 * Wire-up: ws-client 'computer_use' messages dispatch to executeAction().
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ComputerActionType = "click" | "type" | "press" | "launch" | "screenshot" | "move";

export interface ClickAction {
	type: "click";
	x: number;
	y: number;
	/** Mouse button: left (default), right, double */
	button?: "left" | "right" | "double";
}

export interface MoveAction {
	type: "move";
	x: number;
	y: number;
}

export interface TypeAction {
	type: "type";
	text: string;
}

export interface PressAction {
	type: "press";
	/** Key name, e.g. "return", "escape", "cmd+c", "tab" */
	key: string;
}

export interface LaunchAction {
	type: "launch";
	/** App name or bundle ID, e.g. "Safari" or "com.apple.safari" */
	app: string;
}

export interface ScreenshotAction {
	type: "screenshot";
}

export type ComputerAction =
	| ClickAction
	| MoveAction
	| TypeAction
	| PressAction
	| LaunchAction
	| ScreenshotAction;

export interface ComputerUseResult {
	success: boolean;
	/** Base64 PNG for screenshot actions */
	screenshotData?: string;
	error?: string;
}

export interface ComputerUseOptions {
	/** Called to request user confirmation before taking control */
	requestPermission?: (action: ComputerAction) => Promise<boolean>;
	/** Called when Edith takes/releases control */
	onControlChange?: (inControl: boolean) => void;
	/** Auto-release timeout in ms (default: 30_000) */
	controlTimeoutMs?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTROL_TIMEOUT_MS = 30_000;

// ── ComputerUse ───────────────────────────────────────────────────────────────

export class ComputerUse {
	private opts: Required<ComputerUseOptions>;
	private _inControl = false;
	private _permissionGranted = false;
	private _releaseTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: ComputerUseOptions = {}) {
		this.opts = {
			requestPermission: options.requestPermission ?? (() => Promise.resolve(false)),
			onControlChange: options.onControlChange ?? (() => {}),
			controlTimeoutMs: options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS,
		};
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	get inControl(): boolean {
		return this._inControl;
	}

	/**
	 * Execute a ComputerAction.
	 *
	 * On first call per session, prompts the user for permission.
	 * Subsequent calls reuse the granted permission until release() or timeout.
	 *
	 * Returns ComputerUseResult — never throws (errors surface via .error field).
	 */
	async executeAction(action: ComputerAction): Promise<ComputerUseResult> {
		// Request permission if not already granted
		if (!this._permissionGranted) {
			const granted = await this.opts.requestPermission(action);
			if (!granted) {
				return { success: false, error: "Permission denied by user" };
			}
			this._permissionGranted = true;
		}

		// Signal that Edith is in control
		if (!this._inControl) {
			this._inControl = true;
			this.opts.onControlChange(true);
		}

		// Reset the auto-release timer on each action
		this._resetReleaseTimer();

		try {
			return await this._dispatch(action);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[ComputerUse] Action failed:", action.type, message);
			return { success: false, error: message };
		}
	}

	/**
	 * Release control immediately. Clears permission — next action requires
	 * a fresh confirmation.
	 */
	release(): void {
		this._clearReleaseTimer();
		this._permissionGranted = false;
		if (this._inControl) {
			this._inControl = false;
			this.opts.onControlChange(false);
		}
	}

	// ── Private: dispatch ──────────────────────────────────────────────────────

	private async _dispatch(action: ComputerAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case "click":
				return this._click(action);
			case "move":
				return this._move(action);
			case "type":
				return this._type(action);
			case "press":
				return this._press(action);
			case "launch":
				return this._launch(action);
			case "screenshot":
				return this._screenshot();
		}
	}

	/** Mouse click via cliclick (must be installed; bundled or PATH). */
	private async _click(action: ClickAction): Promise<ComputerUseResult> {
		const button = action.button ?? "left";
		const cliArg = button === "double" ? "dc" : button === "right" ? "rc" : "c";
		const coord = `${action.x},${action.y}`;
		await this._shell("cliclick", [`${cliArg}:${coord}`]);
		return { success: true };
	}

	/** Mouse move via cliclick. */
	private async _move(action: MoveAction): Promise<ComputerUseResult> {
		await this._shell("cliclick", [`m:${action.x},${action.y}`]);
		return { success: true };
	}

	/** Type text via osascript keystroke (handles all Unicode, spaces, and special chars). */
	private async _type(action: TypeAction): Promise<ComputerUseResult> {
		// Use osascript keystroke — more reliable than cliclick t: for text with spaces,
		// punctuation, or non-ASCII characters.
		const escaped = action.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = `tell application "System Events" to keystroke "${escaped}"`;
		await this._shell("osascript", ["-e", script]);
		return { success: true };
	}

	/**
	 * Press a key combination via osascript keystroke.
	 * Key format examples: "return", "escape", "cmd+c", "cmd+shift+4"
	 */
	private async _press(action: PressAction): Promise<ComputerUseResult> {
		const script = this._buildKeystrokeScript(action.key);
		await this._shell("osascript", ["-e", script]);
		return { success: true };
	}

	/** Launch an application via the `open` command. */
	private async _launch(action: LaunchAction): Promise<ComputerUseResult> {
		await this._shell("open", ["-a", action.app]);
		return { success: true };
	}

	/** Capture a screenshot via the Tauri screen command (reuses existing infra). */
	private async _screenshot(): Promise<ComputerUseResult> {
		try {
			const base64 = await invoke<string>("capture_screen");
			return { success: true, screenshotData: base64 };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	// ── Private: helpers ────────────────────────────────────────────────────────

	/**
	 * Run a shell command via the Tauri shell plugin.
	 * Throws if the command exits with a non-zero status.
	 */
	private async _shell(program: string, args: string[]): Promise<void> {
		const result = await invoke<{ stdout: string; stderr: string; code: number }>(
			"run_shell_command",
			{ program, args }
		);
		if (result.code !== 0) {
			throw new Error(`${program} exited ${result.code}: ${result.stderr}`);
		}
	}

	/**
	 * Build an osascript keystroke expression.
	 * Supports: modifier+key combos like "cmd+c", "cmd+shift+tab", bare keys.
	 */
	private _buildKeystrokeScript(key: string): string {
		const MODIFIERS: Record<string, string> = {
			cmd: "command down",
			command: "command down",
			shift: "shift down",
			opt: "option down",
			option: "option down",
			ctrl: "control down",
			control: "control down",
		};

		const SPECIAL_KEYS: Record<string, string> = {
			return: "return",
			enter: "return",
			escape: "escape",
			tab: "tab",
			space: "space",
			delete: "delete",
			backspace: "delete",
			up: "up arrow",
			down: "down arrow",
			left: "left arrow",
			right: "right arrow",
			home: "home",
			end: "end",
			pageup: "page up",
			pagedown: "page down",
			f1: "f1",
			f2: "f2",
			f3: "f3",
			f4: "f4",
			f5: "f5",
		};

		const parts = key.toLowerCase().split("+");
		const modParts = parts.slice(0, -1);
		const keyPart = parts[parts.length - 1];

		const usingClauses = modParts
			.map((m) => MODIFIERS[m])
			.filter(Boolean)
			.join(", ");

		const specialKey = SPECIAL_KEYS[keyPart];

		const keystrokePart = specialKey
			? `key code (run script "return (get key code \\"${specialKey}\\")")`
			: `keystroke "${keyPart}"`;

		const using = usingClauses ? ` using {${usingClauses}}` : "";
		return `tell application "System Events" to ${keystrokePart}${using}`;
	}

	private _resetReleaseTimer(): void {
		this._clearReleaseTimer();
		this._releaseTimer = setTimeout(() => {
			console.log("[ComputerUse] Auto-releasing control after timeout");
			this.release();
		}, this.opts.controlTimeoutMs);
	}

	private _clearReleaseTimer(): void {
		if (this._releaseTimer !== null) {
			clearTimeout(this._releaseTimer);
			this._releaseTimer = null;
		}
	}
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/** Shared ComputerUse instance. Wire permission/control callbacks at init time. */
export const computerUse = new ComputerUse();

// ── WS integration ─────────────────────────────────────────────────────────────

/**
 * Handle a 'computer_use' message from the cloud WebSocket.
 *
 * Expected payload shape:
 *   { type: "computer_use", action: ComputerAction }
 *
 * Returns the ComputerUseResult. Callers should send it back to the cloud
 * as an acknowledgement if needed.
 */
export async function handleComputerUseMessage(payload: unknown): Promise<ComputerUseResult> {
	const p = payload as { action?: unknown };
	if (!p?.action || typeof p.action !== "object") {
		return { success: false, error: "Invalid computer_use payload: missing action" };
	}

	const action = p.action as ComputerAction;
	const validTypes: ComputerActionType[] = [
		"click",
		"move",
		"type",
		"press",
		"launch",
		"screenshot",
	];

	if (!validTypes.includes(action.type)) {
		return { success: false, error: `Unknown action type: ${String(action.type)}` };
	}

	return computerUse.executeAction(action);
}
