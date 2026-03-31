/**
 * sync.ts — State sync protocol between desktop and cloud orchestrator.
 *
 * SyncManager handles:
 *   - Receiving sync payloads from the cloud via WebSocket
 *   - Storing them in local-cache.ts
 *   - Requesting a fresh sync (on connect, every 15 min, or on demand)
 *   - Stale check on launch: if last sync > 30 min old, request before showing UI
 *
 * Sync is one-directional: orchestrator → device (device is read-only cache).
 */

import { localCache } from "./local-cache.js";
import type { EdithWsClient, SyncPayload } from "./ws-client.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

export type SyncStatus = "idle" | "syncing" | "error";

export interface SyncState {
	status: SyncStatus;
	lastSyncAt: number | null;
	error: string | null;
}

type SyncEventMap = {
	stateChange: SyncState;
};

type SyncHandler<K extends keyof SyncEventMap> = (payload: SyncEventMap[K]) => void;

// ── SyncManager ───────────────────────────────────────────────────────────────

export class SyncManager {
	private _client: EdithWsClient;
	private _status: SyncStatus = "idle";
	private _lastSyncAt: number | null = null;
	private _error: string | null = null;
	private _syncTimer: ReturnType<typeof setInterval> | null = null;
	private _unsubs: Array<() => void> = [];
	private _listeners: {
		[K in keyof SyncEventMap]?: Array<SyncHandler<K>>;
	} = {};

	constructor(client: EdithWsClient) {
		this._client = client;

		// Seed last sync time from cache (survives page reloads)
		const schedEntry = localCache.getEntry<unknown>("schedule");
		if (schedEntry) {
			this._lastSyncAt = schedEntry.cachedAt;
		}
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/**
	 * Wire up WS listeners and auto-sync behaviour.
	 * Call once on app mount after the WS client is created.
	 */
	start(): void {
		// On every WS connect, request a sync (cloud sends 'sync' in response)
		this._unsubs.push(
			this._client.on("connected", () => {
				this._checkStalenessAndSync();
				this._startSyncTimer();
			})
		);

		// On disconnect, stop the 15-min timer
		this._unsubs.push(
			this._client.on("cloudDisconnected", () => {
				this._stopSyncTimer();
			})
		);

		// Handle incoming sync payloads
		this._unsubs.push(
			this._client.on("message", (msg) => {
				if (msg.type === "sync") {
					this.applySyncPayload(msg.payload);
				}
			})
		);
	}

	/** Stop all timers and remove WS listeners. Call on app destroy. */
	stop(): void {
		this._stopSyncTimer();
		for (const unsub of this._unsubs) unsub();
		this._unsubs = [];
	}

	/**
	 * Receive a SyncPayload from the cloud and store each field into local-cache.
	 * Called automatically when a 'sync' WS message arrives.
	 */
	applySyncPayload(payload: SyncPayload): void {
		try {
			localCache.setCached("schedule", payload.schedule);
			localCache.setCached("taskboard", payload.taskboard);
			localCache.setCached("contacts", payload.contacts);
			localCache.setCached("settings", payload.settings);

			this._lastSyncAt = payload.syncedAt ?? Date.now();
			this._setStatus("idle", null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[SyncManager] Failed to apply sync payload:", msg);
			this._setStatus("error", msg);
		}
	}

	/**
	 * Send a sync-request to the cloud via WebSocket.
	 * The cloud responds with a 'sync' message containing a fresh SyncPayload.
	 */
	requestSync(): void {
		this._setStatus("syncing", null);
		this._client.send({ type: "sync-request", ts: Date.now() });
	}

	/** Subscribe to sync state changes. Returns an unsubscribe fn. */
	on<K extends keyof SyncEventMap>(event: K, handler: SyncHandler<K>): () => void {
		if (!this._listeners[event]) {
			(this._listeners as Record<K, Array<SyncHandler<K>>>)[event] = [];
		}
		(this._listeners[event] as Array<SyncHandler<K>>).push(handler);
		return () => {
			const arr = this._listeners[event] as Array<SyncHandler<K>> | undefined;
			if (arr) {
				const idx = arr.indexOf(handler);
				if (idx !== -1) arr.splice(idx, 1);
			}
		};
	}

	get status(): SyncStatus {
		return this._status;
	}

	get lastSyncAt(): number | null {
		return this._lastSyncAt;
	}

	get error(): string | null {
		return this._error;
	}

	get snapshot(): SyncState {
		return {
			status: this._status,
			lastSyncAt: this._lastSyncAt,
			error: this._error,
		};
	}

	// ── Private ───────────────────────────────────────────────────────────────

	/** Request sync if last sync is stale (or has never happened). */
	private _checkStalenessAndSync(): void {
		if (this._lastSyncAt === null) {
			this.requestSync();
			return;
		}
		const age = Date.now() - this._lastSyncAt;
		if (age > STALE_THRESHOLD_MS) {
			this.requestSync();
		}
	}

	private _startSyncTimer(): void {
		this._stopSyncTimer();
		this._syncTimer = setInterval(() => {
			this.requestSync();
		}, SYNC_INTERVAL_MS);
	}

	private _stopSyncTimer(): void {
		if (this._syncTimer !== null) {
			clearInterval(this._syncTimer);
			this._syncTimer = null;
		}
	}

	private _setStatus(status: SyncStatus, error: string | null): void {
		const changed = this._status !== status || this._error !== error;
		this._status = status;
		this._error = error;
		if (changed) {
			this._emit("stateChange", this.snapshot);
		}
	}

	private _emit<K extends keyof SyncEventMap>(event: K, payload: SyncEventMap[K]): void {
		const handlers = this._listeners[event] as Array<SyncHandler<K>> | undefined;
		if (!handlers) return;
		for (const h of handlers) {
			try {
				h(payload);
			} catch (err) {
				console.error(`[SyncManager] Handler error for "${event}":`, err);
			}
		}
	}
}
