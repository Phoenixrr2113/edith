/**
 * updater.ts
 *
 * Wraps the Tauri v2 updater plugin.
 * The Rust side (lib.rs) does the initial check on startup and emits
 * `update-available` events to the frontend. This module provides:
 *
 *  - checkForUpdate()  — trigger an ad-hoc check
 *  - installUpdate()   — download and apply a pending update
 *  - startPeriodicCheck(intervalMs) — schedule periodic re-checks
 *  - stopPeriodicCheck()
 */

import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export interface UpdateInfo {
	version: string;
	notes: string;
}

// Holds the pending Update object from the Tauri updater API
let _pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;
let _periodicTimer: ReturnType<typeof setInterval> | null = null;

/** Listeners registered via onUpdateAvailable. */
type UpdateListener = (info: UpdateInfo) => void;
const _listeners: UpdateListener[] = [];

function _notify(info: UpdateInfo) {
	for (const fn of _listeners) {
		try {
			fn(info);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Register a callback to be called when an update becomes available.
 * Returns an unsubscribe function.
 */
export function onUpdateAvailable(fn: UpdateListener): () => void {
	_listeners.push(fn);
	return () => {
		const idx = _listeners.indexOf(fn);
		if (idx !== -1) _listeners.splice(idx, 1);
	};
}

/**
 * Check for an update now.
 * Resolves to UpdateInfo if an update is available, null otherwise.
 * Never throws — errors are swallowed so the app degrades gracefully offline.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
	try {
		const update = await check();
		if (update) {
			_pendingUpdate = update;
			const info: UpdateInfo = {
				version: update.version,
				notes: update.body ?? "",
			};
			_notify(info);
			return info;
		}
		return null;
	} catch (err) {
		// Offline or endpoint unreachable — not an error worth surfacing
		console.warn("[updater] checkForUpdate failed (offline?):", err);
		return null;
	}
}

/**
 * Download and install the pending update, then relaunch.
 * Call only after checkForUpdate() has returned a non-null result.
 */
export async function installUpdate(): Promise<void> {
	if (!_pendingUpdate) {
		console.warn("[updater] installUpdate called but no pending update stored — rechecking");
		const info = await checkForUpdate();
		if (!info) {
			console.warn("[updater] no update found on recheck");
			return;
		}
	}

	const pending = _pendingUpdate;
	if (!pending) {
		console.warn("[updater] installUpdate: no pending update available after recheck");
		return;
	}
	try {
		await pending.downloadAndInstall();
		await relaunch();
	} catch (err) {
		console.error("[updater] installUpdate failed:", err);
		throw err;
	}
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours

/**
 * Start periodic background update checks.
 * Safe to call multiple times — subsequent calls are no-ops unless the
 * previous interval was stopped.
 */
export function startPeriodicCheck(intervalMs = DEFAULT_INTERVAL_MS): void {
	if (_periodicTimer !== null) return;
	_periodicTimer = setInterval(() => {
		checkForUpdate().catch(() => {});
	}, intervalMs);
}

/** Stop periodic background update checks. */
export function stopPeriodicCheck(): void {
	if (_periodicTimer !== null) {
		clearInterval(_periodicTimer);
		_periodicTimer = null;
	}
}
