/**
 * Capability Router — abstraction for local machine capabilities.
 *
 * Brain (cloud) routes through WebSocket to the companion app (body).
 * Local mode calls macOS binaries directly.
 *
 * Architecture doc: docs/brain-body-architecture.md
 * Issues: #135, #136
 */

import type { ScreenContext } from "./screenpipe";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotifyOptions {
	/** 1=min, 2=low, 3=default, 4=high, 5=urgent */
	priority?: 1 | 2 | 3 | 4 | 5;
	tags?: string[];
	click?: string;
}

export interface ComputerAction {
	type:
		| "click"
		| "double_click"
		| "right_click"
		| "move"
		| "type"
		| "press"
		| "launch"
		| "screenshot";
	x?: number;
	y?: number;
	text?: string;
	app?: string;
}

export interface ActionResult {
	success: boolean;
	error?: string;
	screenshot?: string; // base64
	stdout?: string;
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface CapabilityRouter {
	/** Send a notification. Cloud: ntfy.sh + optional WS. Local: terminal-notifier. */
	notify(title: string, body: string, options?: NotifyOptions): Promise<void>;

	/** Capture a screenshot. Cloud: WS request to companion. Local: xcrun. */
	captureScreen(): Promise<string | null>;

	/** Get system idle seconds. Cloud: WS request. Local: ioreg. */
	getIdleSeconds(): Promise<number>;

	/** Get screen context (apps, audio). Cloud: WS request. Local: Screenpipe. */
	getScreenContext(minutes: number): Promise<ScreenContext>;

	/** Execute a computer-use action. Cloud: WS request. Local: cliclick/osascript. */
	executeComputerAction(action: ComputerAction): Promise<ActionResult>;

	/** Whether a companion device is currently connected. */
	isDeviceConnected(): boolean;
}

// ── Capability Request/Response Protocol ─────────────────────────────────────

export interface CapabilityRequest {
	type: "capability_request";
	id: string;
	capability: string;
	params: Record<string, unknown>;
	ts: number;
}

export interface CapabilityResponse {
	type: "capability_response";
	id: string;
	result?: Record<string, unknown>;
	error?: string;
	ts: number;
}

type PendingRequest = {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

// ── Cloud Implementation ─────────────────────────────────────────────────────

export class CloudCapabilityRouter implements CapabilityRouter {
	private pendingRequests = new Map<string, PendingRequest>();
	private requestCounter = 0;

	/**
	 * Send a message to connected devices. Injected at startup.
	 * Returns true if at least one device received the message.
	 */
	private sendToDevices: (msg: CapabilityRequest) => boolean = () => false;
	private checkDeviceConnected: () => boolean = () => false;

	/** Wire up the transport functions after http-server is initialized. */
	wire(opts: {
		sendToDevices: (msg: CapabilityRequest) => boolean;
		isDeviceConnected: () => boolean;
	}): void {
		this.sendToDevices = opts.sendToDevices;
		this.checkDeviceConnected = opts.isDeviceConnected;
	}

	/** Handle a capability_response from a device. */
	handleResponse(response: CapabilityResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) return; // stale or duplicate

		clearTimeout(pending.timer);
		this.pendingRequests.delete(response.id);

		if (response.error) {
			pending.reject(new Error(response.error));
		} else {
			pending.resolve(response.result ?? {});
		}
	}

	isDeviceConnected(): boolean {
		return this.checkDeviceConnected();
	}

	private request(
		capability: string,
		params: Record<string, unknown> = {},
		timeoutMs = DEFAULT_TIMEOUT_MS
	): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const id = `req_${++this.requestCounter}_${Date.now()}`;
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`capability request timed out: ${capability}`));
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timer });

			const msg: CapabilityRequest = {
				type: "capability_request",
				id,
				capability,
				params,
				ts: Date.now(),
			};

			const sent = this.sendToDevices(msg);
			if (!sent) {
				clearTimeout(timer);
				this.pendingRequests.delete(id);
				reject(new Error(`no device connected for capability: ${capability}`));
			}
		});
	}

	async notify(title: string, body: string, options?: NotifyOptions): Promise<void> {
		// Primary: ntfy.sh (always, any device)
		const { pushNotification } = await import("./ntfy");
		await pushNotification(title, body, {
			priority: options?.priority ?? 3,
			tags: options?.tags,
			click: options?.click,
		});

		// Supplemental: WS to companion if connected (desktop notification)
		if (this.isDeviceConnected()) {
			try {
				await this.request("notify", { title, body }, 5_000);
			} catch {
				// Not critical — ntfy.sh already sent
			}
		}
	}

	async captureScreen(): Promise<string | null> {
		if (!this.isDeviceConnected()) return null;
		try {
			const result = await this.request("capture_screen");
			return (result.imageData as string) ?? null;
		} catch {
			return null;
		}
	}

	async getIdleSeconds(): Promise<number> {
		if (!this.isDeviceConnected()) return 0;
		try {
			const result = await this.request("get_idle", {}, 5_000);
			return (result.seconds as number) ?? 0;
		} catch {
			return 0;
		}
	}

	async getScreenContext(minutes: number): Promise<ScreenContext> {
		const empty: ScreenContext = {
			timeRange: { start: "", end: "" },
			apps: [],
			audioTranscripts: [],
			continuousActivityMinutes: 0,
			empty: true,
		};

		if (!this.isDeviceConnected()) return empty;
		try {
			const result = await this.request("get_screen_context", { minutes }, 15_000);
			return (result as unknown as ScreenContext) ?? empty;
		} catch {
			return empty;
		}
	}

	async executeComputerAction(action: ComputerAction): Promise<ActionResult> {
		if (!this.isDeviceConnected()) {
			return { success: false, error: "No companion device connected" };
		}
		try {
			const result = await this.request(
				"computer_action",
				action as unknown as Record<string, unknown>
			);
			return result as unknown as ActionResult;
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}

// ── Local Implementation ─────────────────────────────────────────────────────

export class LocalCapabilityRouter implements CapabilityRouter {
	isDeviceConnected(): boolean {
		return false; // local mode doesn't use companion
	}

	async notify(title: string, body: string): Promise<void> {
		const { showNotification } = await import("./notify");
		await showNotification(title, body);
	}

	async captureScreen(): Promise<string | null> {
		// Could use xcrun screencapture in future
		return null;
	}

	async getIdleSeconds(): Promise<number> {
		const { getSystemIdleSeconds } = await import("./screenpipe");
		return getSystemIdleSeconds();
	}

	async getScreenContext(minutes: number): Promise<ScreenContext> {
		const { getContext } = await import("./screenpipe");
		return getContext(minutes);
	}

	async executeComputerAction(_action: ComputerAction): Promise<ActionResult> {
		return {
			success: false,
			error: "Computer use not available in local mode (use computer-use MCP)",
		};
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { IS_CLOUD } from "./config";

/** Global capability router instance. Cloud or local based on IS_CLOUD. */
export const capabilityRouter: CapabilityRouter = IS_CLOUD
	? new CloudCapabilityRouter()
	: new LocalCapabilityRouter();

/** Type-safe access to the cloud router (for wiring transport). */
export function getCloudRouter(): CloudCapabilityRouter | null {
	return capabilityRouter instanceof CloudCapabilityRouter ? capabilityRouter : null;
}
