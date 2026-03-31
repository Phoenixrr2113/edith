/**
 * EdithWsClient — WebSocket client for device-cloud communication.
 *
 * Implements the client side of the protocol defined in
 * docs/design-websocket-protocol.md (CLOUD-WS-047).
 *
 * Framework-agnostic pure TypeScript — no Svelte imports.
 */

// ── Re-export all message types (mirrored from lib/cloud-transport.ts) ────────

export interface WsMessage {
	type: WsMessageType;
	id?: string;
	ts: number;
}

export type WsMessageType =
	| "connected"
	| "ping"
	| "pong"
	| "message"
	| "state"
	| "progress"
	| "sync"
	| "error"
	| "input"
	| "screen_context"
	| "sync-request";

// Cloud → Device

export interface WsConnectedMessage extends WsMessage {
	type: "connected";
	deviceId: string;
	serverVersion: string;
}

export interface WsTextMessage extends WsMessage {
	type: "message";
	text: string;
	from: "edith";
	speak?: boolean;
}

export interface WsStateMessage extends WsMessage {
	type: "state";
	state: AgentState;
}

export type AgentState = "idle" | "thinking" | "working" | "talking" | "sleeping";

export interface WsProgressMessage extends WsMessage {
	type: "progress";
	taskId: string;
	description: string;
	status: "started" | "progress" | "complete" | "failed";
	lastTool?: string;
	toolUses?: number;
	durationMs?: number;
	summary?: string;
}

export interface WsSyncMessage extends WsMessage {
	type: "sync";
	payload: SyncPayload;
}

export interface SyncPayload {
	schedule: ScheduleEntry[];
	taskboard: string;
	contacts: ContactEntry[];
	settings: Partial<AppSettings>;
	syncedAt: number;
}

export interface ScheduleEntry {
	id: string;
	label: string;
	cronExpression: string;
	nextFireAt: number;
}

export interface ContactEntry {
	name: string;
	identifier: string;
	lastSeenAt: number;
}

export interface AppSettings {
	quietHoursStart: string;
	quietHoursEnd: string;
	characterVisible: boolean;
	speechBubblesEnabled: boolean;
}

export interface WsErrorMessage extends WsMessage {
	type: "error";
	code: WsErrorCode;
	message: string;
	fatal?: boolean;
}

export type WsErrorCode =
	| "AUTH_FAILED"
	| "AUTH_EXPIRED"
	| "RATE_LIMITED"
	| "INTERNAL_ERROR"
	| "BAD_MESSAGE";

// Device → Cloud

export interface WsInputMessage extends WsMessage {
	type: "input";
	text: string;
	source: "voice" | "keyboard";
	deviceId: string;
}

export interface WsScreenContextMessage extends WsMessage {
	type: "screen_context";
	summary: string;
	apps: string[];
	confidence: number;
}

export interface WsSyncRequestMessage extends WsMessage {
	type: "sync-request";
}

// Heartbeat

export interface WsPingMessage extends WsMessage {
	type: "ping";
}

export interface WsPongMessage extends WsMessage {
	type: "pong";
}

// Discriminated union

export type AnyWsMessage =
	| WsConnectedMessage
	| WsTextMessage
	| WsStateMessage
	| WsProgressMessage
	| WsSyncMessage
	| WsErrorMessage
	| WsInputMessage
	| WsScreenContextMessage
	| WsSyncRequestMessage
	| WsPingMessage
	| WsPongMessage;

// DeviceMessage = messages the device is allowed to send
export type DeviceMessage =
	| WsInputMessage
	| WsScreenContextMessage
	| WsSyncRequestMessage
	| WsPingMessage;

// Connection state machine
export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "authenticating"
	| "connected"
	| "reconnecting";

// Close codes
export const WS_CLOSE_CODES = {
	NORMAL: 1000,
	POLICY_VIOLATION: 1008,
	INTERNAL_ERROR: 1011,
	AUTH_FAILED: 4001,
	TOKEN_EXPIRED: 4002,
	RATE_LIMITED: 4003,
} as const;

// ── Event map ─────────────────────────────────────────────────────────────────

export interface EdithWsClientEvents {
	/** Raw message received from server */
	message: AnyWsMessage;
	/** Connection state changed */
	stateChange: ConnectionState;
	/** Connection opened successfully (after 'connected' handshake) */
	connected: WsConnectedMessage;
	/** Connection closed (may reconnect) */
	disconnected: { code: number; reason: string };
	/** Server error message received */
	error: WsErrorMessage;
}

type EventHandler<K extends keyof EdithWsClientEvents> = (payload: EdithWsClientEvents[K]) => void;

// ── Constants ─────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const OFFLINE_QUEUE_MAX = 50;

/** Backoff delays in ms: 1s, 2s, 4s, 8s, then capped at 30s */
const BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000];
const BACKOFF_JITTER_MS = 500;

// ── EdithWsClient ─────────────────────────────────────────────────────────────

export class EdithWsClient {
	private ws: WebSocket | null = null;
	private url = "";
	private token = "";
	private connectionState: ConnectionState = "disconnected";

	// Reconnection
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private shouldReconnect = true;

	// Heartbeat
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private pongTimer: ReturnType<typeof setTimeout> | null = null;
	// Offline queue: DeviceMessages queued while disconnected
	private offlineQueue: DeviceMessage[] = [];

	// Event listeners
	private listeners: {
		[K in keyof EdithWsClientEvents]?: Array<EventHandler<K>>;
	} = {};

	// ── Public API ──────────────────────────────────────────────────────────────

	/**
	 * Open a WebSocket connection with JWT auth.
	 * Injects the token as a query parameter because browsers do not
	 * allow custom headers on WebSocket upgrades.
	 */
	connect(url: string, token: string): void {
		this.url = url;
		this.token = token;
		this.shouldReconnect = true;
		this.reconnectAttempt = 0;
		this._openSocket();
	}

	/** Gracefully close and stop reconnecting. */
	disconnect(): void {
		this.shouldReconnect = false;
		this._clearTimers();
		if (this.ws) {
			this.ws.close(WS_CLOSE_CODES.NORMAL, "Client disconnect");
			this.ws = null;
		}
		this._setConnectionState("disconnected");
	}

	/**
	 * Send a typed device message.
	 * If disconnected, the message is queued (up to 50 entries, FIFO drop on overflow).
	 */
	send(msg: DeviceMessage): void {
		const envelope: DeviceMessage = { ...msg, ts: msg.ts ?? Date.now() };

		if (this.connectionState === "connected" && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(envelope));
		} else {
			if (this.offlineQueue.length >= OFFLINE_QUEUE_MAX) {
				// Drop oldest entry (FIFO)
				this.offlineQueue.shift();
			}
			this.offlineQueue.push(envelope);
		}
	}

	/**
	 * Register an event handler.
	 * Returns an unsubscribe function.
	 */
	on<K extends keyof EdithWsClientEvents>(event: K, handler: EventHandler<K>): () => void {
		if (!this.listeners[event]) {
			(this.listeners as Record<K, Array<EventHandler<K>>>)[event] = [];
		}
		(this.listeners[event] as Array<EventHandler<K>>).push(handler);

		return () => {
			const arr = this.listeners[event] as Array<EventHandler<K>> | undefined;
			if (arr) {
				const idx = arr.indexOf(handler);
				if (idx !== -1) arr.splice(idx, 1);
			}
		};
	}

	/** Current connection state. */
	get state(): ConnectionState {
		return this.connectionState;
	}

	// ── Private: socket lifecycle ───────────────────────────────────────────────

	private _openSocket(): void {
		this._setConnectionState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

		// Append token as query param — browsers can't set Authorization header on WS
		const wsUrl = new URL(this.url);
		wsUrl.searchParams.set("token", this.token);

		try {
			this.ws = new WebSocket(wsUrl.toString());
		} catch (err) {
			console.error("[EdithWsClient] Failed to create WebSocket:", err);
			this._scheduleReconnect();
			return;
		}

		this.ws.onopen = () => {
			// State moves to 'authenticating' while we wait for the 'connected' handshake
			this._setConnectionState("authenticating");
		};

		this.ws.onmessage = (event: MessageEvent) => {
			this._handleMessage(event.data as string);
		};

		this.ws.onclose = (event: CloseEvent) => {
			this._handleClose(event);
		};

		this.ws.onerror = () => {
			// onerror is always followed by onclose; handle reconnect there
			console.warn("[EdithWsClient] WebSocket error");
		};
	}

	private _handleMessage(raw: string): void {
		let msg: AnyWsMessage;
		try {
			msg = JSON.parse(raw) as AnyWsMessage;
		} catch {
			console.warn("[EdithWsClient] Received non-JSON message:", raw);
			return;
		}

		// Emit raw message to all 'message' listeners
		this._emit("message", msg);

		switch (msg.type) {
			case "connected":
				this._onConnected(msg as WsConnectedMessage);
				break;

			case "pong":
				this._onPong();
				break;

			case "error":
				this._onError(msg as WsErrorMessage);
				break;

			default:
				// All other cloud→device messages bubble up via the 'message' event
				break;
		}
	}

	private _onConnected(msg: WsConnectedMessage): void {
		this.reconnectAttempt = 0;
		this._setConnectionState("connected");
		this._emit("connected", msg);
		this._startHeartbeat();
		this._flushOfflineQueue();
	}

	private _onPong(): void {
		// Clear the pong timeout — server is alive
		if (this.pongTimer !== null) {
			clearTimeout(this.pongTimer);
			this.pongTimer = null;
		}
	}

	private _onError(msg: WsErrorMessage): void {
		this._emit("error", msg);

		if (msg.fatal) {
			// Fatal errors (e.g. auth) — stop reconnecting immediately
			this.shouldReconnect = false;
		}
	}

	private _handleClose(event: CloseEvent): void {
		this._clearTimers();
		this.ws = null;
		this._emit("disconnected", { code: event.code, reason: event.reason });

		const code = event.code;

		// Codes that require token refresh before reconnect — handled externally for now
		const isAuthFailure =
			code === WS_CLOSE_CODES.AUTH_FAILED || code === WS_CLOSE_CODES.TOKEN_EXPIRED;

		const isRateLimited = code === WS_CLOSE_CODES.RATE_LIMITED;
		const isNormal = code === WS_CLOSE_CODES.NORMAL;

		if (!this.shouldReconnect || isNormal || isAuthFailure) {
			this._setConnectionState("disconnected");
			return;
		}

		// Rate-limited: bump to 60s regardless of backoff table
		const extraDelay = isRateLimited ? 60_000 : 0;
		this._scheduleReconnect(extraDelay);
	}

	// ── Private: reconnection ───────────────────────────────────────────────────

	private _scheduleReconnect(extraDelayMs = 0): void {
		this._setConnectionState("reconnecting");
		const idx = Math.min(this.reconnectAttempt, BACKOFF_DELAYS_MS.length - 1);
		const base = BACKOFF_DELAYS_MS[idx];
		const jitter = Math.random() * BACKOFF_JITTER_MS * 2 - BACKOFF_JITTER_MS;
		const delay = base + jitter + extraDelayMs;

		console.log(
			`[EdithWsClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt + 1})`
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectAttempt += 1;
			this._openSocket();
		}, delay);
	}

	// ── Private: heartbeat ──────────────────────────────────────────────────────

	private _startHeartbeat(): void {
		this._stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this._sendPing();
		}, HEARTBEAT_INTERVAL_MS);
	}

	private _stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.pongTimer !== null) {
			clearTimeout(this.pongTimer);
			this.pongTimer = null;
		}
	}

	private _sendPing(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;

		const now = Date.now();
		const ping: WsPingMessage = { type: "ping", ts: now };
		this.ws.send(JSON.stringify(ping));

		// Start pong timeout
		this.pongTimer = setTimeout(() => {
			console.warn("[EdithWsClient] Pong timeout — treating connection as dead");
			this.ws?.close();
		}, PONG_TIMEOUT_MS);
	}

	// ── Private: offline queue ──────────────────────────────────────────────────

	private _flushOfflineQueue(): void {
		if (this.offlineQueue.length === 0) return;
		console.log(`[EdithWsClient] Flushing ${this.offlineQueue.length} queued messages`);
		const queued = this.offlineQueue.splice(0);
		for (const msg of queued) {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify(msg));
			}
		}
	}

	// ── Private: helpers ────────────────────────────────────────────────────────

	private _setConnectionState(state: ConnectionState): void {
		if (this.connectionState !== state) {
			this.connectionState = state;
			this._emit("stateChange", state);
		}
	}

	private _emit<K extends keyof EdithWsClientEvents>(
		event: K,
		payload: EdithWsClientEvents[K]
	): void {
		const handlers = this.listeners[event] as Array<EventHandler<K>> | undefined;
		if (!handlers) return;
		for (const h of handlers) {
			try {
				h(payload);
			} catch (err) {
				console.error(`[EdithWsClient] Handler error for "${event}":`, err);
			}
		}
	}

	private _clearTimers(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this._stopHeartbeat();
	}
}
