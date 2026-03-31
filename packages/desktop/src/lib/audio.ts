/**
 * Audio playback module for TTS output.
 *
 * Uses the Web Audio API (available in Tauri's WebView) to decode and play
 * base64-encoded audio from the cloud. No Rust-side audio needed.
 *
 * Supports: mp3, wav, ogg, opus, aac, webm
 */

// ── MIME type → file extension map ──────────────────────────────────────────

const MIME_DEFAULTS: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/wave": "wav",
	"audio/ogg": "ogg",
	"audio/opus": "opus",
	"audio/webm": "webm",
	"audio/aac": "aac",
};

// ── Singleton state ──────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let _isPlaying = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAudioContext(): AudioContext {
	if (!audioCtx || audioCtx.state === "closed") {
		audioCtx = new AudioContext();
	}
	return audioCtx;
}

/**
 * Normalize a MIME type string to lowercase.
 * If the value looks like a file extension ("mp3", "wav") wrap it.
 */
function normalizeMime(mimeType: string): string {
	const t = mimeType.trim().toLowerCase();
	// If no slash, treat as extension
	if (!t.includes("/")) {
		const ext = t.replace(/^\./, "");
		// Find a matching key whose value equals the extension
		for (const [key, val] of Object.entries(MIME_DEFAULTS)) {
			if (val === ext) return key;
		}
		return `audio/${ext}`;
	}
	return t;
}

/**
 * Convert a base64 string to an ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode and play base64-encoded audio.
 *
 * @param base64Data  Raw base64 string (no data-URI prefix needed, but
 *                    data-URI strings are also accepted).
 * @param mimeType    Optional MIME type hint (e.g. "audio/mpeg", "mp3").
 *                    Defaults to "audio/mpeg".
 * @returns           Promise that resolves when playback ends (or rejects on error).
 */
export async function playAudio(base64Data: string, mimeType = "audio/mpeg"): Promise<void> {
	// Stop any current playback first
	stopAudio();

	const ctx = getAudioContext();

	// Resume context if suspended (browser autoplay policy)
	if (ctx.state === "suspended") {
		await ctx.resume();
	}

	// Strip data-URI prefix if present ("data:audio/mpeg;base64,...")
	const raw = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;

	const arrayBuffer = base64ToArrayBuffer(raw);

	let audioBuffer: AudioBuffer;
	try {
		audioBuffer = await ctx.decodeAudioData(arrayBuffer);
	} catch (err) {
		_isPlaying = false;
		throw new Error(`[audio] Failed to decode audio (${normalizeMime(mimeType)}): ${String(err)}`);
	}

	return new Promise<void>((resolve, reject) => {
		const source = ctx.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(ctx.destination);

		currentSource = source;
		_isPlaying = true;

		source.onended = () => {
			if (currentSource === source) {
				currentSource = null;
				_isPlaying = false;
			}
			resolve();
		};

		try {
			source.start(0);
		} catch (err) {
			currentSource = null;
			_isPlaying = false;
			reject(new Error(`[audio] Failed to start playback: ${String(err)}`));
		}
	});
}

/**
 * Stop the currently playing audio immediately.
 * Safe to call when nothing is playing.
 */
export function stopAudio(): void {
	if (currentSource) {
		try {
			currentSource.stop();
		} catch {
			// Already stopped — ignore
		}
		currentSource = null;
	}
	_isPlaying = false;
}

/**
 * Returns true if audio is currently playing.
 */
export function isPlaying(): boolean {
	return _isPlaying;
}
