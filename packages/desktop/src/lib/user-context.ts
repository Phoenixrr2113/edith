/**
 * user-context.ts — UserContext aggregation for context-aware Edith responses.
 *
 * UserContext is the "brain" that assembles everything known about the user's
 * current situation into a single object. It is attached to every outbound WS
 * message so the cloud backend can make informed decisions without extra round-trips.
 *
 * Sources:
 *   - gemini-bridge.ts  → currentScreen (what's on screen right now)
 *   - capture-store.ts  → recentActivity (last N screen/audio captures)
 *   - settings.ts       → connectionMode, settings snapshot
 *   - browser globals   → currentTime
 *   - App state stores  → activeApps (parsed from ScreenContext.apps)
 */

import type { ScreenContext } from "./gemini-bridge.js";
import { settingsStore } from "./settings.svelte.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Connection mode reported by the desktop app. */
export type ConnectionMode = "cloud" | "local" | "offline";

/** A brief record of recent user activity derived from screen/audio captures. */
export interface ActivityRecord {
	/** ISO-8601 timestamp */
	ts: string;
	/** Human-readable description (from ScreenContext.activity) */
	description: string;
	/** Apps visible at that moment */
	apps: string[];
}

/** The full assembled context object sent with each user message. */
export interface UserContextPayload {
	/** ISO-8601 timestamp when this context was assembled */
	assembledAt: string;
	/** Current wall-clock time (ISO-8601) */
	currentTime: string;
	/** Current screen understanding from Gemini bridge (null if not available) */
	currentScreen: ScreenContext | null;
	/** Ring of recent activity records (most recent first, max 10) */
	recentActivity: ActivityRecord[];
	/** Active app names derived from the most recent screen context */
	activeApps: string[];
	/** Geographic location if available (browser Geolocation API) */
	location: GeolocationCoordinates | null;
	/** Connection mode to the cloud backend */
	connectionMode: ConnectionMode;
	/** Relevant settings snapshot (non-sensitive fields only) */
	settings: ContextSettingsSnapshot;
}

/** A non-sensitive snapshot of relevant settings. */
export interface ContextSettingsSnapshot {
	ttsEnabled: boolean;
	ttsProvider: string;
	sttEnabled: boolean;
	screenCaptureEnabled: boolean;
	geminiEnabled: boolean;
}

// ── UserContext ────────────────────────────────────────────────────────────────

export class UserContext {
	private _currentScreen: ScreenContext | null = null;
	private _activityRing: ActivityRecord[] = [];
	private _connectionMode: ConnectionMode = "offline";
	private _location: GeolocationCoordinates | null = null;

	private static readonly ACTIVITY_RING_SIZE = 10;

	// ── Feed methods (called by other subsystems) ───────────────────────────────

	/** Update with the latest screen context from gemini-bridge. */
	updateScreen(ctx: ScreenContext): void {
		this._currentScreen = ctx;

		// Push to activity ring
		const record: ActivityRecord = {
			ts: ctx.timestamp,
			description: ctx.activity,
			apps: ctx.apps,
		};
		this._activityRing.unshift(record);
		if (this._activityRing.length > UserContext.ACTIVITY_RING_SIZE) {
			this._activityRing.pop();
		}
	}

	/** Update the connection mode (called by ConnectionModeManager or ws-client). */
	setConnectionMode(mode: ConnectionMode): void {
		this._connectionMode = mode;
	}

	/**
	 * Attempt to refresh the cached geolocation.
	 * Silently no-ops if the Geolocation API is unavailable or permission is denied.
	 */
	async refreshLocation(): Promise<void> {
		if (!navigator.geolocation) return;
		return new Promise((resolve) => {
			navigator.geolocation.getCurrentPosition(
				(pos) => {
					this._location = pos.coords;
					resolve();
				},
				() => resolve(), // permission denied or error — ignore
				{ timeout: 5000, maximumAge: 60_000 }
			);
		});
	}

	// ── Core method ─────────────────────────────────────────────────────────────

	/**
	 * Assemble and return the full UserContextPayload.
	 *
	 * This is a synchronous snapshot — all sources have already fed data in
	 * via updateScreen() / setConnectionMode() / refreshLocation().
	 * Callers attach the result to each WsInputMessage before sending.
	 */
	buildContext(): UserContextPayload {
		const s = settingsStore.value;
		const now = new Date().toISOString();

		const settings: ContextSettingsSnapshot = {
			ttsEnabled: s.ttsEnabled,
			ttsProvider: s.ttsProvider,
			sttEnabled: s.sttEnabled,
			screenCaptureEnabled: s.screenCaptureEnabled,
			geminiEnabled: s.geminiEnabled,
		};

		return {
			assembledAt: now,
			currentTime: now,
			currentScreen: this._currentScreen,
			recentActivity: [...this._activityRing],
			activeApps: this._currentScreen?.apps ?? [],
			location: this._location,
			connectionMode: this._connectionMode,
			settings,
		};
	}

	// ── Accessors ───────────────────────────────────────────────────────────────

	get currentScreen(): ScreenContext | null {
		return this._currentScreen;
	}

	get recentActivity(): readonly ActivityRecord[] {
		return this._activityRing;
	}

	get connectionMode(): ConnectionMode {
		return this._connectionMode;
	}
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Shared UserContext instance for the desktop app.
 * Import this singleton to feed updates and to call buildContext().
 */
export const userContext = new UserContext();

// ── WS message extension ──────────────────────────────────────────────────────

/**
 * Extend a WsInputMessage-like object with the current user context.
 *
 * Usage:
 *   const msg = withContext({ type: "input", text, source: "voice", deviceId, ts: Date.now() });
 *   wsClient.send(msg);
 */
export function withContext<T extends object>(msg: T): T & { context: UserContextPayload } {
	return { ...msg, context: userContext.buildContext() };
}
