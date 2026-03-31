/**
 * stream-to-cloud.ts — Batches screen captures and audio buffers and streams
 * them to the cloud backend via WebSocket as screen_context messages.
 *
 * Key behaviour:
 *  - Collects screen frames at configurable batch intervals (default 5 s).
 *  - Resizes each frame to max 800 px wide before base64-encoding (~90% payload reduction).
 *  - Attaches the most-recent audio buffer snippet with each screen frame.
 *  - Drops frames gracefully when the WebSocket is backlogged (latest replaces queued).
 */

import type { AudioCapture } from "./audio-capture.js";
import type { ScreenFrame } from "./screen-capture.js";
import type { EdithWsClient } from "./ws-client.js";

// ── Configuration ──────────────────────────────────────────────────────────────

export interface StreamManagerOptions {
	/** How often (ms) to flush batched frames to cloud. Default: 5_000. */
	batchIntervalMs?: number;
	/** Max width (px) to resize screenshots before encoding. Default: 800. */
	maxImageWidth?: number;
	/** Maximum number of queued frames. Oldest dropped on overflow. Default: 3. */
	maxQueuedFrames?: number;
}

const DEFAULTS: Required<StreamManagerOptions> = {
	batchIntervalMs: 5_000,
	maxImageWidth: 800,
	maxQueuedFrames: 3,
};

// ── StreamManager ──────────────────────────────────────────────────────────────

export class StreamManager {
	private wsClient: EdithWsClient;
	private audioCapture: AudioCapture | null;
	private opts: Required<StreamManagerOptions>;

	/** Pending frames waiting for the next batch flush. */
	private queue: ScreenFrame[] = [];
	private batchTimer: ReturnType<typeof setInterval> | null = null;
	private _active = false;

	constructor(
		wsClient: EdithWsClient,
		audioCapture: AudioCapture | null = null,
		options: StreamManagerOptions = {}
	) {
		this.wsClient = wsClient;
		this.audioCapture = audioCapture;
		this.opts = { ...DEFAULTS, ...options };
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	/** Start batching and sending frames. Idempotent. */
	start(): void {
		if (this._active) return;
		this._active = true;
		this.batchTimer = setInterval(() => {
			this._flush().catch((err) => {
				console.warn("[StreamManager] flush error:", err);
			});
		}, this.opts.batchIntervalMs);
	}

	/** Stop batching. Drains queue silently. */
	stop(): void {
		if (!this._active) return;
		this._active = false;
		if (this.batchTimer !== null) {
			clearInterval(this.batchTimer);
			this.batchTimer = null;
		}
		this.queue = [];
	}

	/** Push a raw screen frame into the queue (called from App.svelte frame handler). */
	pushFrame(frame: ScreenFrame): void {
		if (!this._active) return;

		// Drop oldest if queue is full
		if (this.queue.length >= this.opts.maxQueuedFrames) {
			this.queue.shift();
		}
		this.queue.push(frame);
	}

	/** Whether the manager is currently running. */
	get isActive(): boolean {
		return this._active;
	}

	// ── Private ─────────────────────────────────────────────────────────────────

	/** Flush queued frames: resize, encode, attach audio, send via WS. */
	private async _flush(): Promise<void> {
		if (this.queue.length === 0) return;

		// Grab and clear the current queue atomically
		const frames = this.queue.splice(0);

		// Use the most-recent frame for the screen_context payload
		const latest = frames[frames.length - 1];

		// Resize the image before encoding
		const resizedData = await resizeImageBase64(latest.data, this.opts.maxImageWidth);

		// Grab audio snippet if available
		let audioData: string | undefined;
		let audioMimeType: string | undefined;
		if (this.audioCapture?.isActive) {
			const buf = await this.audioCapture.getAudioBuffer();
			if (buf) {
				audioData = buf.data;
				audioMimeType = buf.mimeType;
			}
		}

		this.wsClient.send({
			type: "screen_context",
			summary: "",
			imageData: resizedData,
			audioData,
			audioMimeType,
			apps: [],
			confidence: 1.0,
			ts: latest.ts,
		});
	}
}

// ── Image resize helper ────────────────────────────────────────────────────────

/**
 * Resize a base64 PNG/JPEG to at most `maxWidth` pixels wide using an
 * off-screen <canvas>.  Returns the base64-encoded JPEG (quality 0.75).
 *
 * Falls back to the original data string if Canvas API is unavailable
 * (e.g. in non-browser environments / tests).
 */
export async function resizeImageBase64(base64Png: string, maxWidth: number): Promise<string> {
	// Guard: only available in browser context
	if (typeof document === "undefined" || typeof Image === "undefined") {
		return base64Png;
	}

	return new Promise<string>((resolve) => {
		const img = new Image();

		img.onload = () => {
			const scale = img.width > maxWidth ? maxWidth / img.width : 1;
			const w = Math.round(img.width * scale);
			const h = Math.round(img.height * scale);

			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;

			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve(base64Png);
				return;
			}

			ctx.drawImage(img, 0, 0, w, h);
			// Export as JPEG at 75% quality for smaller payload
			const resized = canvas.toDataURL("image/jpeg", 0.75);
			// Strip the data-URL prefix to get raw base64
			const base64 = resized.split(",")[1] ?? base64Png;
			resolve(base64);
		};

		img.onerror = () => resolve(base64Png);

		// Browsers require a data-URL when setting .src from base64
		const prefix = base64Png.startsWith("data:") ? "" : "data:image/png;base64,";
		img.src = prefix + base64Png;
	});
}
