/**
 * ScreenTriggerEngine — event-driven screen understanding triggers.
 *
 * Monitors screen captures for significant changes and fires typed events:
 *   - 'app-switched'        — active application appears to have changed
 *   - 'significant-change'  — large visual delta between frames
 *   - 'idle-detected'       — no change detected for idle threshold
 *
 * Consumers hook in via on() and receive a ScreenTriggerEvent payload.
 * No external dependencies — pure heuristics on base64 PNG frames.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ScreenTriggerType = "app-switched" | "significant-change" | "idle-detected";

export interface ScreenTriggerEvent {
	type: ScreenTriggerType;
	/** Unix timestamp (ms) when the trigger fired */
	ts: number;
	/** Estimated pixel-change ratio (0–1) between the last two frames */
	changePct?: number;
	/** Extracted OCR-like text tokens from the frame (title-bar region sample) */
	textSample?: string;
}

export interface ScreenTriggerOptions {
	/**
	 * Pixel-change ratio (0–1) above which a 'significant-change' event fires.
	 * Default: 0.15  (15 % of sampled pixels changed).
	 */
	significantChangeThreshold?: number;
	/**
	 * Pixel-change ratio above which an 'app-switched' event fires.
	 * This is typically higher than significantChangeThreshold.
	 * Default: 0.40  (40 % of sampled pixels changed).
	 */
	appSwitchThreshold?: number;
	/**
	 * Milliseconds of no-change before 'idle-detected' fires.
	 * Default: 120 000 (2 minutes).
	 */
	idleThresholdMs?: number;
	/**
	 * Minimum milliseconds between successive events of the same type.
	 * Default: 2 000.
	 */
	debounceMs?: number;
	/**
	 * Number of pixels to sample per axis when computing the diff.
	 * Higher = more accurate, but slower.  Default: 64 (64×64 = 4096 samples).
	 */
	sampleResolution?: number;
}

type TriggerHandler = (event: ScreenTriggerEvent) => void;

// ── ScreenTriggerEngine ────────────────────────────────────────────────────────

export class ScreenTriggerEngine {
	// Resolved config
	private readonly _sigThreshold: number;
	private readonly _appThreshold: number;
	private readonly _idleMs: number;
	private readonly _debounceMs: number;
	private readonly _resolution: number;

	// State
	private _prevPixels: Uint8ClampedArray | null = null;
	private _lastEventTsMap = new Map<ScreenTriggerType, number>();
	private _idleTimer: ReturnType<typeof setTimeout> | null = null;

	// Event listeners
	private _listeners: TriggerHandler[] = [];

	constructor(opts: ScreenTriggerOptions = {}) {
		this._sigThreshold = opts.significantChangeThreshold ?? 0.15;
		this._appThreshold = opts.appSwitchThreshold ?? 0.4;
		this._idleMs = opts.idleThresholdMs ?? 120_000;
		this._debounceMs = opts.debounceMs ?? 2_000;
		this._resolution = opts.sampleResolution ?? 64;
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Feed a new screen frame (base64-encoded PNG) into the engine.
	 * Call this from onScreenFrame() in the desktop app.
	 */
	processFrame(base64Png: string, ts = Date.now()): void {
		this._decodeAndDiff(base64Png, ts);
	}

	/** Register a listener for trigger events.  Returns an unsubscribe fn. */
	on(handler: TriggerHandler): () => void {
		this._listeners.push(handler);
		return () => {
			this._listeners = this._listeners.filter((h) => h !== handler);
		};
	}

	/** Stop all timers and remove all listeners. */
	destroy(): void {
		this._clearIdleTimer();
		this._listeners = [];
		this._prevPixels = null;
	}

	// ── Private: frame diff ────────────────────────────────────────────────────

	/**
	 * Decode a base64 PNG into raw pixel data via OffscreenCanvas,
	 * compute a diff against the previous frame, and fire events.
	 */
	private _decodeAndDiff(base64Png: string, ts: number): void {
		// Use OffscreenCanvas + createImageBitmap when available (Tauri WebView supports it)
		const src = `data:image/png;base64,${base64Png}`;
		const img = new Image();
		img.onload = () => {
			try {
				const res = this._resolution;
				const canvas = new OffscreenCanvas(res, res);
				const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
				if (!ctx) return;

				ctx.drawImage(img, 0, 0, res, res);
				const imageData = ctx.getImageData(0, 0, res, res);
				const pixels = imageData.data; // RGBA flat array

				const changePct = this._computeChangePct(pixels);
				this._prevPixels = pixels;

				if (changePct > 0) {
					// Something changed — reset idle timer
					this._resetIdleTimer();
				}

				// Fire typed events based on change magnitude
				if (changePct >= this._appThreshold) {
					this._maybeFireEvent({ type: "app-switched", ts, changePct });
				} else if (changePct >= this._sigThreshold) {
					this._maybeFireEvent({ type: "significant-change", ts, changePct });
				}
			} catch {
				// Decode error — skip frame silently
			}
		};
		img.onerror = () => {
			/* skip undecodeable frames */
		};
		img.src = src;
	}

	private _computeChangePct(current: Uint8ClampedArray): number {
		const prev = this._prevPixels;
		if (!prev || prev.length !== current.length) {
			// No previous frame yet — treat as 0 change (first frame baseline)
			return 0;
		}

		const totalPixels = current.length / 4; // RGBA → pixels
		let changed = 0;

		for (let i = 0; i < current.length; i += 4) {
			const dr = Math.abs(current[i] - prev[i]);
			const dg = Math.abs(current[i + 1] - prev[i + 1]);
			const db = Math.abs(current[i + 2] - prev[i + 2]);
			// Threshold per-channel delta to ignore noise
			if (dr + dg + db > 30) {
				changed++;
			}
		}

		return changed / totalPixels;
	}

	// ── Private: events ────────────────────────────────────────────────────────

	private _maybeFireEvent(event: ScreenTriggerEvent): void {
		const last = this._lastEventTsMap.get(event.type) ?? 0;
		if (event.ts - last < this._debounceMs) return;
		this._lastEventTsMap.set(event.type, event.ts);
		this._emit(event);
	}

	private _emit(event: ScreenTriggerEvent): void {
		for (const h of this._listeners) {
			try {
				h(event);
			} catch (err) {
				console.error("[ScreenTriggerEngine] listener error:", err);
			}
		}
	}

	// ── Private: idle timer ────────────────────────────────────────────────────

	private _resetIdleTimer(): void {
		this._clearIdleTimer();
		this._idleTimer = setTimeout(() => {
			this._maybeFireEvent({ type: "idle-detected", ts: Date.now() });
		}, this._idleMs);
	}

	private _clearIdleTimer(): void {
		if (this._idleTimer !== null) {
			clearTimeout(this._idleTimer);
			this._idleTimer = null;
		}
	}
}
