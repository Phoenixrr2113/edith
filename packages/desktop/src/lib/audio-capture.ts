/**
 * audio-capture.ts — Ambient audio capture for screen context.
 *
 * Two capture modes:
 *   - "microphone"   : getUserMedia — mic input, always available
 *   - "system"       : getDisplayMedia with audio:true — system audio via
 *                      macOS screen-recording permission (no video track kept)
 *
 * Audio is buffered as WebM/Opus chunks and exposed as a base64 string so
 * the WS client can attach it to a screen_context payload.
 *
 * This is designed for ambient awareness (short rolling buffers), not
 * high-fidelity recording.
 */

import { captureStore } from "./capture-store.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type AudioCaptureMode = "microphone" | "system";

export interface AudioCaptureOptions {
	/** Which audio source to capture (default: "microphone") */
	mode?: AudioCaptureMode;
	/** Rolling buffer duration in seconds (default: 30) */
	bufferSecs?: number;
	/** Target sample rate hint (browsers may ignore) */
	sampleRate?: number;
}

export interface AudioCaptureState {
	active: boolean;
	mode: AudioCaptureMode;
	/** Approximate bytes buffered */
	bufferedBytes: number;
	/** ISO timestamp of when capture started, or null */
	startedAt: string | null;
}

// ── AudioCapture ───────────────────────────────────────────────────────────────

export class AudioCapture {
	private options: Required<AudioCaptureOptions>;
	private mediaStream: MediaStream | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	/** Rolling ring of recent chunks. Oldest are dropped when bufferSecs exceeded. */
	private chunks: Array<{ blob: Blob; ts: number }> = [];
	private _active = false;
	private startedAt: Date | null = null;

	constructor(options: AudioCaptureOptions = {}) {
		this.options = {
			mode: options.mode ?? "microphone",
			bufferSecs: options.bufferSecs ?? 30,
			sampleRate: options.sampleRate ?? 16000,
		};
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	get isActive(): boolean {
		return this._active;
	}

	get state(): AudioCaptureState {
		const bufferedBytes = this.chunks.reduce((sum, c) => sum + c.blob.size, 0);
		return {
			active: this._active,
			mode: this.options.mode,
			bufferedBytes,
			startedAt: this.startedAt?.toISOString() ?? null,
		};
	}

	/**
	 * Begin capturing audio.
	 * - "microphone" requests mic permission via getUserMedia.
	 * - "system" requests screen-share permission via getDisplayMedia (macOS
	 *   will prompt for screen recording access; we request audio-only).
	 *
	 * Throws if already active or if permission is denied.
	 */
	async startAudioCapture(overrides: Partial<AudioCaptureOptions> = {}): Promise<void> {
		if (this._active) {
			throw new Error("[AudioCapture] Already capturing");
		}

		// Apply any one-shot overrides
		if (overrides.mode !== undefined) this.options.mode = overrides.mode;
		if (overrides.bufferSecs !== undefined) this.options.bufferSecs = overrides.bufferSecs;
		if (overrides.sampleRate !== undefined) this.options.sampleRate = overrides.sampleRate;

		this.chunks = [];

		if (this.options.mode === "system") {
			this.mediaStream = await this._acquireSystemAudio();
		} else {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					sampleRate: this.options.sampleRate,
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
				video: false,
			});
		}

		// Ensure we actually got an audio track
		const audioTracks = this.mediaStream.getAudioTracks();
		if (audioTracks.length === 0) {
			this._releaseStream();
			throw new Error("[AudioCapture] No audio track in media stream");
		}

		const mimeType = AudioCapture._bestMimeType();
		this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : {});

		this.mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) {
				this.chunks.push({ blob: e.data, ts: Date.now() });
				this._evictOldChunks();
			}
		};

		this.mediaRecorder.onerror = (e) => {
			console.error("[AudioCapture] MediaRecorder error:", e);
		};

		// Collect in 1-second slices for fine-grained rolling eviction
		this.startedAt = new Date();
		this.mediaRecorder.start(1000);
		this._active = true;
	}

	/**
	 * Stop capturing.  Any buffered audio is retained until getAudioBuffer() is called.
	 */
	stopAudioCapture(): void {
		if (!this._active) return;

		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			this.mediaRecorder.stop();
		}

		this._releaseStream();
		this.mediaRecorder = null;
		this._active = false;
		this.startedAt = null;
	}

	/**
	 * Return recent audio as a base64-encoded string (same MIME as recorded).
	 * Returns null if nothing has been buffered yet.
	 */
	async getAudioBuffer(): Promise<{ data: string; mimeType: string } | null> {
		if (this.chunks.length === 0) return null;

		const blobs = this.chunks.map((c) => c.blob);
		const mimeType = blobs[0].type || "audio/webm";
		const combined = new Blob(blobs, { type: mimeType });

		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				// result is "data:<mime>;base64,<data>" — strip the prefix
				const base64 = result.split(",")[1] ?? "";

				// Persist to local capture store
				captureStore.storeCapture("audio", base64, {
					source: this.options.mode,
					mimeType,
					durationMs: this.options.bufferSecs * 1000,
				});

				resolve({ data: base64, mimeType });
			};
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(combined);
		});
	}

	/** Flush the buffer without stopping capture. */
	clearBuffer(): void {
		this.chunks = [];
	}

	/** Update options on a live capture (e.g. new bufferSecs from settings). */
	updateOptions(options: Partial<AudioCaptureOptions>): void {
		if (options.bufferSecs !== undefined) {
			this.options.bufferSecs = options.bufferSecs;
			this._evictOldChunks();
		}
		// mode + sampleRate changes only take effect on next startAudioCapture()
		if (options.mode !== undefined) this.options.mode = options.mode;
		if (options.sampleRate !== undefined) this.options.sampleRate = options.sampleRate;
	}

	// ── Private helpers ─────────────────────────────────────────────────────────

	/**
	 * Request system audio via getDisplayMedia.
	 *
	 * On macOS + Tauri the web view honours the screen-recording permission
	 * already granted for screenshots.  We set video:false so no video track
	 * is acquired (reduces overhead).  Some browsers/OS combos ignore
	 * video:false and return a video track anyway — we simply don't use it.
	 */
	private async _acquireSystemAudio(): Promise<MediaStream> {
		const constraints: DisplayMediaStreamOptions = {
			audio: {
				// Suppress echo / noise on the captured output if supported
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			} as MediaTrackConstraints,
			video: false,
		};

		try {
			const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
			// Drop any stray video tracks immediately to save resources
			for (const vt of stream.getVideoTracks()) {
				vt.stop();
				stream.removeTrack(vt);
			}
			return stream;
		} catch {
			// Fallback: some browsers require video:true for getDisplayMedia
			const fallback = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
			for (const vt of fallback.getVideoTracks()) {
				vt.stop();
				fallback.removeTrack(vt);
			}
			if (fallback.getAudioTracks().length === 0) {
				throw new Error(
					"[AudioCapture] System audio not available — macOS may require screen recording permission"
				);
			}
			return fallback;
		}
	}

	/** Drop chunks older than bufferSecs from the front of the ring. */
	private _evictOldChunks(): void {
		const cutoff = Date.now() - this.options.bufferSecs * 1000;
		while (this.chunks.length > 0 && this.chunks[0].ts < cutoff) {
			this.chunks.shift();
		}
	}

	private _releaseStream(): void {
		if (this.mediaStream) {
			for (const track of this.mediaStream.getTracks()) {
				track.stop();
			}
			this.mediaStream = null;
		}
	}

	/** Pick best supported MIME type for recording. */
	private static _bestMimeType(): string {
		const candidates = [
			"audio/webm;codecs=opus",
			"audio/webm",
			"audio/ogg;codecs=opus",
			"audio/mp4",
		];
		for (const t of candidates) {
			if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
		}
		return "";
	}
}

// ── Singleton convenience export ───────────────────────────────────────────────

export const audioCapture = new AudioCapture();

/** Thin wrappers for callers that just want fire-and-forget control. */
export async function captureSystemAudio(): Promise<void> {
	await audioCapture.startAudioCapture({ mode: "system" });
}

export async function startAudioCapture(options?: AudioCaptureOptions): Promise<void> {
	await audioCapture.startAudioCapture(options);
}

export function stopAudioCapture(): void {
	audioCapture.stopAudioCapture();
}

export async function getAudioBuffer(): Promise<{ data: string; mimeType: string } | null> {
	return audioCapture.getAudioBuffer();
}
