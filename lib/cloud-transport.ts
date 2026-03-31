/**
 * CloudTransport — WebSocket server for device-cloud communication.
 *
 * Implements the protocol defined in docs/design-websocket-protocol.md (CLOUD-WS-047).
 *
 * Dependencies:
 *   - lib/auth.ts (CLOUD-AUTH-048) — verifyDeviceToken() for upgrade auth
 *   - lib/session.ts — injectMessage() for routing device input to active session
 *   - lib/dispatch.ts — dispatchToClaude() when no session is running
 *
 * Mount inside edith.ts via Bun.serve() websocket handler.
 */

// ── Message Types ─────────────────────────────────────────────────────────────

/** Base envelope — all messages share this shape */
export interface WsMessage {
	type: WsMessageType;
	id?: string; // optional correlation ID
	ts: number; // unix timestamp ms
}

export type WsMessageType =
	// lifecycle
	| "connected"
	| "ping"
	| "pong"
	// cloud → device
	| "message"
	| "state"
	| "progress"
	| "sync"
	| "error"
	// device → cloud
	| "input"
	| "screen_context"
	| "sync-request";

// ── Cloud → Device ────────────────────────────────────────────────────────────

/** Server welcome sent immediately after successful connection */
export interface WsConnectedMessage extends WsMessage {
	type: "connected";
	deviceId: string;
	serverVersion: string;
}

/** Text message to display in the Tauri speech bubble */
export interface WsTextMessage extends WsMessage {
	type: "message";
	text: string;
	from: "edith";
	/** If true, triggers "talking" character animation */
	speak?: boolean;
}

/** Agent state update — drives Rive animation state machine */
export interface WsStateMessage extends WsMessage {
	type: "state";
	state: AgentState;
}

export type AgentState = "idle" | "thinking" | "working" | "talking" | "sleeping";

/** Background agent progress event */
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

/** Full state sync payload (see #118 — TAURI-SYNC-118) */
export interface WsSyncMessage extends WsMessage {
	type: "sync";
	payload: SyncPayload;
}

export interface SyncPayload {
	schedule: ScheduleEntry[];
	taskboard: string; // raw markdown from ~/.edith/taskboard.md
	contacts: ContactEntry[]; // first 50 by recency
	settings: Partial<AppSettings>;
	syncedAt: number; // unix ms
}

export interface ScheduleEntry {
	id: string;
	label: string;
	cronExpression: string;
	nextFireAt: number; // unix ms
}

export interface ContactEntry {
	name: string;
	identifier: string;
	lastSeenAt: number;
}

export interface AppSettings {
	quietHoursStart: string; // "22:00"
	quietHoursEnd: string; // "08:00"
	characterVisible: boolean;
	speechBubblesEnabled: boolean;
}

/** Server-side error message */
export interface WsErrorMessage extends WsMessage {
	type: "error";
	code: WsErrorCode;
	message: string;
	/** If true, client should not reconnect immediately (e.g. auth failure) */
	fatal?: boolean;
}

export type WsErrorCode =
	| "AUTH_FAILED"
	| "AUTH_EXPIRED"
	| "RATE_LIMITED"
	| "INTERNAL_ERROR"
	| "BAD_MESSAGE";

// ── Device → Cloud ────────────────────────────────────────────────────────────

/** User text input from keyboard or voice transcription */
export interface WsInputMessage extends WsMessage {
	type: "input";
	text: string;
	source: "voice" | "keyboard";
	deviceId: string;
}

/** Gemini screen context summary — injected as ambient context */
export interface WsScreenContextMessage extends WsMessage {
	type: "screen_context";
	summary: string;
	apps: string[];
	confidence: number; // 0–1
}

/** Device requests a full sync payload */
export interface WsSyncRequestMessage extends WsMessage {
	type: "sync-request";
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

export interface WsPingMessage extends WsMessage {
	type: "ping";
}

export interface WsPongMessage extends WsMessage {
	type: "pong";
}

// ── Discriminated Union ───────────────────────────────────────────────────────

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

// ── Connection State (client-side state machine) ──────────────────────────────

export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "authenticating"
	| "connected"
	| "reconnecting";

// ── Close Codes ───────────────────────────────────────────────────────────────

export const WS_CLOSE_CODES = {
	NORMAL: 1000,
	POLICY_VIOLATION: 1008,
	INTERNAL_ERROR: 1011,
	AUTH_FAILED: 4001,
	TOKEN_EXPIRED: 4002,
	RATE_LIMITED: 4003,
} as const;

// ── Helper: build a typed message ────────────────────────────────────────────

export function makeWsMessage<T extends AnyWsMessage>(
	msg: Omit<T, "ts"> & { ts?: number }
): T {
	return { ts: Date.now(), ...msg } as T;
}

// ── WebSocket Server (skeleton — full impl in CLOUD-WS-047) ──────────────────

/**
 * Registry of connected devices.
 * Key: deviceId, Value: WebSocket handle (Bun ServerWebSocket)
 *
 * TODO(CLOUD-WS-047): replace `unknown` with Bun.ServerWebSocket<WsClientData>
 * once Bun types are available in this project.
 */
const connectedDevices = new Map<string, unknown>();

export interface WsClientData {
	deviceId: string;
	connectedAt: number;
	lastPingAt: number;
}

/**
 * Broadcast a message to all connected devices.
 */
export function broadcastToDevices(msg: AnyWsMessage): void {
	const json = JSON.stringify(msg);
	for (const [deviceId, ws] of connectedDevices) {
		try {
			// TODO(CLOUD-WS-047): cast ws to Bun.ServerWebSocket and call ws.send(json)
			void json; // placeholder until Bun types wired
			console.log(`[cloud-transport] broadcast → ${deviceId}: ${msg.type}`);
		} catch (err) {
			console.error(`[cloud-transport] Failed to send to ${deviceId}:`, err);
			connectedDevices.delete(deviceId);
		}
	}
}

/**
 * Send a message to a specific device.
 */
export function sendToDevice(deviceId: string, msg: AnyWsMessage): boolean {
	const ws = connectedDevices.get(deviceId);
	if (!ws) return false;
	try {
		// TODO(CLOUD-WS-047): cast ws to Bun.ServerWebSocket and call ws.send(json)
		const json = JSON.stringify(msg);
		void json; // placeholder until Bun types wired
		return true;
	} catch {
		connectedDevices.delete(deviceId);
		return false;
	}
}

/**
 * Emit an agent state update to all connected devices.
 * Called from dispatch.ts event handlers.
 */
export function emitAgentState(state: AgentState): void {
	broadcastToDevices(makeWsMessage<WsStateMessage>({ type: "state", state }));
}

/**
 * Emit a progress event to all connected devices.
 * Called from dispatch.ts task_started / task_progress / task_notification handlers.
 */
export function emitProgress(
	taskId: string,
	description: string,
	status: WsProgressMessage["status"],
	opts?: Pick<WsProgressMessage, "lastTool" | "toolUses" | "durationMs" | "summary">
): void {
	broadcastToDevices(
		makeWsMessage<WsProgressMessage>({
			type: "progress",
			taskId,
			description,
			status,
			...opts,
		})
	);
}

/**
 * Emit a text message to all connected devices (mirrors Telegram send_message).
 */
export function emitTextMessage(text: string, speak = false): void {
	broadcastToDevices(
		makeWsMessage<WsTextMessage>({ type: "message", text, from: "edith", speak })
	);
}

/**
 * Returns the number of currently connected devices.
 */
export function connectedDeviceCount(): number {
	return connectedDevices.size;
}
