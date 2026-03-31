/**
 * Screen capture API — wraps the Tauri Rust commands exposed by screen.rs.
 *
 * Three modes:
 *  1. captureScreen()              — one-shot, returns base64 PNG
 *  2. startPeriodicCapture(ms)     — starts background loop via Rust
 *  3. stopPeriodicCapture()        — stops the background loop
 *
 * Periodic captures emit a `screen-frame` Tauri event with:
 *   { data: string (base64 PNG), ts: number (unix ms) }
 *
 * Subscribe via onScreenFrame() to receive frames.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { captureStore } from "./capture-store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScreenFrame {
	/** Base64-encoded PNG */
	data: string;
	/** Unix timestamp (ms) when the frame was captured */
	ts: number;
}

// ── Single-shot capture ────────────────────────────────────────────────────

/**
 * Capture the primary display immediately.
 * Returns a base64-encoded PNG string.
 * Throws if Screen Recording permission is denied or capture fails.
 */
export async function captureScreen(): Promise<string> {
	return invoke<string>("capture_screen");
}

// ── Periodic capture ───────────────────────────────────────────────────────

let _captureActive = false;
let _frameListeners: Array<(frame: ScreenFrame) => void> = [];
let _unlistenTauri: UnlistenFn | null = null;

/**
 * Start periodic screen capture at the given interval (default 1000 ms).
 * Safe to call multiple times — subsequent calls are no-ops while active.
 *
 * @param intervalMs  Capture interval in milliseconds (minimum 500).
 */
export async function startPeriodicCapture(intervalMs = 1_000): Promise<void> {
	if (_captureActive) return;
	_captureActive = true;

	// Subscribe to Tauri events before starting so we don't miss the first frame.
	_unlistenTauri = await listen<ScreenFrame>("screen-frame", (event) => {
		const frame = event.payload;

		// Persist to local capture store
		captureStore.storeCapture("screen", frame.data, {
			source: "display:0",
			mimeType: "image/png",
		});

		for (const cb of _frameListeners) {
			try {
				cb(frame);
			} catch (err) {
				console.error("[screen-capture] frame listener error:", err);
			}
		}
	});

	await invoke("start_capture", { intervalMs });
}

/**
 * Stop periodic screen capture.
 */
export async function stopPeriodicCapture(): Promise<void> {
	if (!_captureActive) return;
	_captureActive = false;

	await invoke("stop_capture");

	if (_unlistenTauri) {
		_unlistenTauri();
		_unlistenTauri = null;
	}
}

/**
 * Register a callback to receive screen frames from periodic capture.
 * Returns an unsubscribe function.
 *
 * @example
 * const unsub = onScreenFrame(frame => sendToCloud(frame));
 * // later:
 * unsub();
 */
export function onScreenFrame(cb: (frame: ScreenFrame) => void): () => void {
	_frameListeners.push(cb);
	return () => {
		_frameListeners = _frameListeners.filter((f) => f !== cb);
	};
}

/** Whether periodic capture is currently active. */
export function isCaptureActive(): boolean {
	return _captureActive;
}
