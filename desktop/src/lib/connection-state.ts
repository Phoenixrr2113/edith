/**
 * connection-state.ts — Cloud-to-local fallback state machine.
 *
 * Tracks the active connection mode and handles automatic transitions:
 *   cloud → local (if Ollama available) → offline
 *
 * Recovery: when cloud reconnects, switch back to "cloud" automatically.
 * Configurable via preferLocal setting.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ConnectionMode = "cloud" | "local" | "offline";

export interface ConnectionModeState {
	mode: ConnectionMode;
	/** True when we know Ollama is reachable at localhost:11434 */
	ollamaAvailable: boolean;
	/** True when the cloud WS is connected */
	cloudConnected: boolean;
	/** Whether the user has manually forced a mode (overrides auto) */
	manualOverride: ConnectionMode | null;
}

export interface ConnectionModeEvents {
	modeChange: ConnectionMode;
	ollamaChange: boolean;
}

type ModeHandler<K extends keyof ConnectionModeEvents> = (payload: ConnectionModeEvents[K]) => void;

// ── Constants ──────────────────────────────────────────────────────────────────

const OLLAMA_URL = "http://localhost:11434/api/tags";
const OLLAMA_CHECK_INTERVAL_MS = 15_000;
const OLLAMA_CHECK_TIMEOUT_MS = 3_000;

// ── ConnectionModeManager ─────────────────────────────────────────────────────

export class ConnectionModeManager {
	private _mode: ConnectionMode = "cloud";
	private _ollamaAvailable = false;
	private _cloudConnected = false;
	private _manualOverride: ConnectionMode | null = null;
	private _preferLocal: boolean;

	private _ollamaTimer: ReturnType<typeof setInterval> | null = null;

	private _listeners: {
		[K in keyof ConnectionModeEvents]?: Array<ModeHandler<K>>;
	} = {};

	constructor(preferLocal = false) {
		this._preferLocal = preferLocal;
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	/** Start monitoring Ollama availability. Call once at app init. */
	start(): void {
		this._checkOllama();
		this._ollamaTimer = setInterval(() => {
			this._checkOllama();
		}, OLLAMA_CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this._ollamaTimer !== null) {
			clearInterval(this._ollamaTimer);
			this._ollamaTimer = null;
		}
	}

	/** Called by ws-client when cloud WS connects. */
	onCloudConnected(): void {
		this._cloudConnected = true;
		// Clear manual override when cloud comes back (unless user explicitly chose local)
		if (this._manualOverride !== "local") {
			this._manualOverride = null;
		}
		this._resolve();
	}

	/** Called by ws-client when cloud WS disconnects. */
	onCloudDisconnected(): void {
		this._cloudConnected = false;
		this._resolve();
	}

	/** Force a specific mode. Pass null to return to automatic. */
	forceMode(mode: ConnectionMode | null): void {
		this._manualOverride = mode;
		this._resolve();
	}

	get mode(): ConnectionMode {
		return this._mode;
	}

	get ollamaAvailable(): boolean {
		return this._ollamaAvailable;
	}

	get cloudConnected(): boolean {
		return this._cloudConnected;
	}

	get manualOverride(): ConnectionMode | null {
		return this._manualOverride;
	}

	get snapshot(): ConnectionModeState {
		return {
			mode: this._mode,
			ollamaAvailable: this._ollamaAvailable,
			cloudConnected: this._cloudConnected,
			manualOverride: this._manualOverride,
		};
	}

	on<K extends keyof ConnectionModeEvents>(event: K, handler: ModeHandler<K>): () => void {
		if (!this._listeners[event]) {
			(this._listeners as Record<K, Array<ModeHandler<K>>>)[event] = [];
		}
		(this._listeners[event] as Array<ModeHandler<K>>).push(handler);
		return () => {
			const arr = this._listeners[event] as Array<ModeHandler<K>> | undefined;
			if (arr) {
				const idx = arr.indexOf(handler);
				if (idx !== -1) arr.splice(idx, 1);
			}
		};
	}

	// ── Private ────────────────────────────────────────────────────────────────

	/** Determine the correct mode given current state and apply it. */
	private _resolve(): void {
		let next: ConnectionMode;

		if (this._manualOverride !== null) {
			next = this._manualOverride;
		} else if (this._preferLocal && this._ollamaAvailable) {
			next = "local";
		} else if (this._cloudConnected) {
			next = "cloud";
		} else if (this._ollamaAvailable) {
			next = "local";
		} else {
			next = "offline";
		}

		if (next !== this._mode) {
			this._mode = next;
			this._emit("modeChange", next);
		}
	}

	private async _checkOllama(): Promise<void> {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), OLLAMA_CHECK_TIMEOUT_MS);
			const res = await fetch(OLLAMA_URL, { signal: controller.signal });
			clearTimeout(timer);
			const available = res.ok;
			if (available !== this._ollamaAvailable) {
				this._ollamaAvailable = available;
				this._emit("ollamaChange", available);
				this._resolve();
			}
		} catch {
			if (this._ollamaAvailable) {
				this._ollamaAvailable = false;
				this._emit("ollamaChange", false);
				this._resolve();
			}
		}
	}

	private _emit<K extends keyof ConnectionModeEvents>(
		event: K,
		payload: ConnectionModeEvents[K]
	): void {
		const handlers = this._listeners[event] as Array<ModeHandler<K>> | undefined;
		if (!handlers) return;
		for (const h of handlers) {
			try {
				h(payload);
			} catch (err) {
				console.error(`[ConnectionModeManager] Handler error for "${event}":`, err);
			}
		}
	}
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const connectionModeManager = new ConnectionModeManager();
