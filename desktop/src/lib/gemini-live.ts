/**
 * gemini-live.ts — Gemini Live API integration for real-time audio conversation.
 *
 * GeminiLiveSession wraps the WebSocket-based Gemini Live API
 * (wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent)
 * to enable bidirectional streaming audio I/O with Gemini 2.0 Flash.
 *
 * Audio flow:
 *   Microphone → PCM16 chunks → Gemini Live → TTS audio → playAudio()
 *
 * Integrates with stt.ts (mic access) and tts.ts (audio playback) conventions.
 * Controlled by settings: geminiLiveEnabled, geminiLiveModel.
 */

import { playAudio } from "./audio.js";
import { settingsStore } from "./settings.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_LIVE_HOST = "generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.0-flash-exp";

/** PCM sample rate required by Gemini Live API */
const INPUT_SAMPLE_RATE = 16_000;
/** Output sample rate returned by Gemini Live API */
const OUTPUT_SAMPLE_RATE = 24_000;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GeminiLiveOptions {
	/** Google Generative AI API key */
	apiKey: string;
	/** Model to use (default: gemini-2.0-flash-exp) */
	model?: string;
	/** System instruction for the session */
	systemInstruction?: string;
	/** Called when Gemini emits a text turn (partial or final) */
	onText?: (text: string, isFinal: boolean) => void;
	/** Called when an audio chunk arrives from Gemini */
	onAudio?: (base64Pcm: string) => void;
	/** Called when session is fully open */
	onOpen?: () => void;
	/** Called when session closes */
	onClose?: (code: number, reason: string) => void;
	/** Called on errors */
	onError?: (err: Error) => void;
}

export interface GeminiLiveSessionState {
	status: "idle" | "connecting" | "open" | "closing" | "closed" | "error";
	error?: string;
}

// ── Wire protocol types (Gemini Live BidiGenerateContent) ──────────────────────

interface SetupMessage {
	setup: {
		model: string;
		generationConfig: {
			responseModalities: string[];
			speechConfig: {
				voiceConfig: {
					prebuiltVoiceConfig: {
						voiceName: string;
					};
				};
			};
		};
		systemInstruction?: {
			parts: Array<{ text: string }>;
		};
	};
}

interface ClientContentMessage {
	clientContent: {
		turns: Array<{
			role: "user";
			parts: Array<{ text: string }>;
		}>;
		turnComplete: boolean;
	};
}

interface RealtimeInputMessage {
	realtimeInput: {
		mediaChunks: Array<{
			mimeType: string;
			data: string;
		}>;
	};
}

interface ServerMessagePayload {
	setupComplete?: Record<string, unknown>;
	serverContent?: {
		modelTurn?: {
			parts?: Array<{
				text?: string;
				inlineData?: { mimeType: string; data: string };
			}>;
		};
		turnComplete?: boolean;
		interrupted?: boolean;
	};
	toolCall?: unknown;
	toolCallCancellation?: unknown;
}

// ── GeminiLiveSession ─────────────────────────────────────────────────────────

export class GeminiLiveSession {
	private opts: Required<
		Omit<GeminiLiveOptions, "onText" | "onAudio" | "onOpen" | "onClose" | "onError">
	> &
		Pick<GeminiLiveOptions, "onText" | "onAudio" | "onOpen" | "onClose" | "onError">;

	private ws: WebSocket | null = null;
	private _state: GeminiLiveSessionState = { status: "idle" };

	// Mic capture
	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private scriptProcessor: ScriptProcessorNode | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;

	// Outgoing audio accumulator
	private pendingChunks: string[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: GeminiLiveOptions) {
		this.opts = {
			apiKey: options.apiKey,
			model: options.model ?? DEFAULT_MODEL,
			systemInstruction: options.systemInstruction ?? "",
			onText: options.onText,
			onAudio: options.onAudio,
			onOpen: options.onOpen,
			onClose: options.onClose,
			onError: options.onError,
		};
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	get state(): GeminiLiveSessionState {
		return { ...this._state };
	}

	/**
	 * Open a Gemini Live session.
	 * Connects the WebSocket, sends the setup message, and starts the mic pipeline.
	 */
	async open(): Promise<void> {
		if (this._state.status !== "idle" && this._state.status !== "closed") {
			throw new Error(`[GeminiLiveSession] Cannot open from state: ${this._state.status}`);
		}

		this._setState({ status: "connecting" });

		const wsUrl = this._buildWsUrl();

		try {
			this.ws = new WebSocket(wsUrl);
			this.ws.onopen = () => this._onWsOpen();
			this.ws.onmessage = (e) => this._onWsMessage(e);
			this.ws.onclose = (e) => this._onWsClose(e);
			this.ws.onerror = () => this._onWsError(new Error("WebSocket error"));
		} catch (err) {
			this._setState({ status: "error", error: String(err) });
			throw err;
		}
	}

	/**
	 * Send a text turn to Gemini (supplements or replaces audio input).
	 */
	sendText(text: string): void {
		if (this._state.status !== "open") return;

		const msg: ClientContentMessage = {
			clientContent: {
				turns: [{ role: "user", parts: [{ text }] }],
				turnComplete: true,
			},
		};
		this._send(msg);
	}

	/**
	 * Send a raw PCM16 audio chunk (base64-encoded, 16kHz mono).
	 * Called automatically by the internal mic pipeline; may also be called
	 * externally with audio from another source (e.g. audio-capture.ts buffer).
	 */
	sendAudioChunk(base64Pcm16: string): void {
		if (this._state.status !== "open") return;

		// Accumulate and flush in batches to reduce message overhead
		this.pendingChunks.push(base64Pcm16);
		this._scheduleFlush();
	}

	/**
	 * Start capturing mic audio and streaming it to Gemini Live.
	 * Requires microphone permission.
	 */
	async startMicrophone(): Promise<void> {
		if (this.mediaStream) return; // already capturing

		this.mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				sampleRate: INPUT_SAMPLE_RATE,
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});

		this.audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
		this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

		// ScriptProcessorNode gives us raw PCM float32 — we convert to PCM16
		// bufferSize 4096 at 16kHz ≈ 256ms latency, acceptable for live convo
		this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
		this.scriptProcessor.onaudioprocess = (e) => {
			const float32 = e.inputBuffer.getChannelData(0);
			const pcm16 = this._float32ToPcm16(float32);
			const base64 = this._arrayBufferToBase64(pcm16.buffer);
			this.sendAudioChunk(base64);
		};

		this.sourceNode.connect(this.scriptProcessor);
		this.scriptProcessor.connect(this.audioContext.destination);
	}

	/** Stop mic capture (session stays open — Gemini will receive turn-complete). */
	stopMicrophone(): void {
		if (this.scriptProcessor) {
			this.scriptProcessor.disconnect();
			this.scriptProcessor = null;
		}
		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
		if (this.mediaStream) {
			for (const t of this.mediaStream.getTracks()) t.stop();
			this.mediaStream = null;
		}
	}

	/** Close the session and release all resources. */
	close(): void {
		this._setState({ status: "closing" });
		this.stopMicrophone();
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.close(1000, "Session closed by client");
		}
		this.ws = null;
	}

	// ── Private: WebSocket lifecycle ────────────────────────────────────────────

	private _buildWsUrl(): string {
		const key = encodeURIComponent(this.opts.apiKey);
		// Model is specified in the setup message body, not the URL.
		return `wss://${GEMINI_LIVE_HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${key}`;
	}

	private _onWsOpen(): void {
		// Send setup message first
		const setup: SetupMessage = {
			setup: {
				model: `models/${this.opts.model}`,
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: {
								voiceName: "Aoede",
							},
						},
					},
				},
			},
		};

		if (this.opts.systemInstruction) {
			setup.setup.systemInstruction = {
				parts: [{ text: this.opts.systemInstruction }],
			};
		}

		this._send(setup);
		// Status → open after setup is acknowledged (setupComplete server message)
	}

	private _onWsMessage(event: MessageEvent): void {
		let payload: ServerMessagePayload;
		try {
			payload = JSON.parse(event.data as string) as ServerMessagePayload;
		} catch {
			console.warn("[GeminiLiveSession] Non-JSON message:", event.data);
			return;
		}

		if (payload.setupComplete !== undefined) {
			this._setState({ status: "open" });
			this.opts.onOpen?.();
			return;
		}

		if (payload.serverContent) {
			const content = payload.serverContent;

			if (content.modelTurn?.parts) {
				for (const part of content.modelTurn.parts) {
					if (part.text !== undefined) {
						const isFinal = content.turnComplete ?? false;
						this.opts.onText?.(part.text, isFinal);
					}

					if (part.inlineData) {
						const { mimeType, data } = part.inlineData;
						if (mimeType.startsWith("audio/")) {
							this.opts.onAudio?.(data);
							// Auto-play: convert PCM16 to playable audio
							this._playPcm16(data).catch((err) => {
								console.error("[GeminiLiveSession] Audio playback error:", err);
							});
						}
					}
				}
			}

			if (content.interrupted) {
				console.log("[GeminiLiveSession] Turn interrupted by user");
			}
		}
	}

	private _onWsClose(event: CloseEvent): void {
		this.stopMicrophone();
		this._setState({ status: "closed" });
		this.opts.onClose?.(event.code, event.reason);
	}

	private _onWsError(err: Error): void {
		this._setState({ status: "error", error: err.message });
		this.opts.onError?.(err);
	}

	// ── Private: audio helpers ─────────────────────────────────────────────────

	/** Accumulate chunks and flush as a single realtimeInput message. */
	private _scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this._flushAudio();
		}, 50); // 50ms batching window
	}

	private _flushAudio(): void {
		if (this.pendingChunks.length === 0) return;
		if (this._state.status !== "open") {
			this.pendingChunks = [];
			return;
		}

		const msg: RealtimeInputMessage = {
			realtimeInput: {
				mediaChunks: this.pendingChunks.map((data) => ({
					mimeType: "audio/pcm;rate=16000",
					data,
				})),
			},
		};
		this.pendingChunks = [];
		this._send(msg);
	}

	/**
	 * Play raw PCM16 audio returned by Gemini Live.
	 * Gemini returns 24kHz mono PCM16 (little-endian).
	 * We wrap it in a WAV header and hand it to playAudio().
	 */
	private async _playPcm16(base64Pcm: string): Promise<void> {
		const pcmBytes = this._base64ToUint8Array(base64Pcm);
		const wavBytes = this._pcm16ToWav(pcmBytes, OUTPUT_SAMPLE_RATE, 1);
		const base64Wav = this._arrayBufferToBase64(wavBytes.buffer);
		await playAudio(base64Wav, "audio/wav");
	}

	/**
	 * Convert Float32 PCM samples to Int16 (little-endian).
	 */
	private _float32ToPcm16(float32: Float32Array): Int16Array {
		const int16 = new Int16Array(float32.length);
		for (let i = 0; i < float32.length; i++) {
			const clamped = Math.max(-1, Math.min(1, float32[i]));
			int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		}
		return int16;
	}

	/**
	 * Wrap raw PCM16 bytes in a minimal RIFF WAV header.
	 */
	private _pcm16ToWav(pcmBytes: Uint8Array, sampleRate: number, channels: number): Uint8Array {
		const byteRate = sampleRate * channels * 2;
		const blockAlign = channels * 2;
		const dataSize = pcmBytes.length;
		const headerSize = 44;
		const buffer = new ArrayBuffer(headerSize + dataSize);
		const view = new DataView(buffer);

		const writeAscii = (offset: number, str: string) => {
			for (let i = 0; i < str.length; i++) {
				view.setUint8(offset + i, str.charCodeAt(i));
			}
		};
		const writeU32LE = (offset: number, val: number) => view.setUint32(offset, val, true);
		const writeU16LE = (offset: number, val: number) => view.setUint16(offset, val, true);

		writeAscii(0, "RIFF");
		writeU32LE(4, 36 + dataSize);
		writeAscii(8, "WAVE");
		writeAscii(12, "fmt ");
		writeU32LE(16, 16); // PCM chunk size
		writeU16LE(20, 1); // PCM format
		writeU16LE(22, channels);
		writeU32LE(24, sampleRate);
		writeU32LE(28, byteRate);
		writeU16LE(32, blockAlign);
		writeU16LE(34, 16); // bits per sample
		writeAscii(36, "data");
		writeU32LE(40, dataSize);

		new Uint8Array(buffer, headerSize).set(pcmBytes);
		return new Uint8Array(buffer);
	}

	private _arrayBufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = "";
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	private _base64ToUint8Array(base64: string): Uint8Array {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	// ── Private: helpers ───────────────────────────────────────────────────────

	private _send(msg: unknown): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private _setState(state: GeminiLiveSessionState): void {
		this._state = state;
	}
}

// ── Convenience factory ────────────────────────────────────────────────────────

/**
 * Create a GeminiLiveSession using the current app settings.
 * Returns null if geminiLiveEnabled is false or no API key is configured.
 */
export function createGeminiLiveSession(
	overrides: Partial<GeminiLiveOptions> = {}
): GeminiLiveSession | null {
	const s = settingsStore.value;

	if (!s.geminiLiveEnabled) return null;

	const apiKey = s.geminiApiKey?.trim();
	if (!apiKey) {
		console.warn("[gemini-live] geminiApiKey is not set — cannot create session");
		return null;
	}

	return new GeminiLiveSession({
		apiKey,
		model: s.geminiLiveModel ?? DEFAULT_MODEL,
		...overrides,
	});
}
