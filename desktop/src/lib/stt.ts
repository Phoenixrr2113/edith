/**
 * stt.ts — Speech-to-text via Groq Whisper API.
 *
 * Records from the microphone using the Web Audio API + MediaRecorder,
 * encodes audio as WebM/Opus (browser-native), sends it to Groq's
 * whisper-large-v3-turbo endpoint, and returns the transcript.
 *
 * Also integrates with SpeakerDiarizer to label each transcription with
 * an estimated speaker (Randy vs Speaker-2, etc.).
 */

import { type DiarizedTranscript, SpeakerDiarizer } from "./diarization.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SttOptions {
	/** Groq API key — required for cloud transcription */
	groqApiKey: string;
	/** Sample rate hint (browsers may ignore this) */
	sampleRate?: number;
	/** Language hint passed to Whisper (e.g. "en") */
	language?: string;
	/** Whether to run diarization on the recorded audio */
	diarize?: boolean;
	/** Label to use for the primary speaker in diarization */
	primarySpeakerLabel?: string;
}

export interface TranscriptionResult {
	/** Plain transcript text */
	text: string;
	/** Diarized segments, if diarization was requested */
	diarized?: DiarizedTranscript;
	/** Duration of the audio in seconds */
	durationSeconds: number;
}

const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

// ── SpeechToText ──────────────────────────────────────────────────────────────

export class SpeechToText {
	private options: SttOptions;
	private mediaStream: MediaStream | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private audioContext: AudioContext | null = null;
	private chunks: Blob[] = [];
	private startTime = 0;
	private _listening = false;
	private diarizer: SpeakerDiarizer;

	constructor(options: SttOptions) {
		this.options = options;
		this.diarizer = new SpeakerDiarizer(options.primarySpeakerLabel ?? "Randy");
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	get isListening(): boolean {
		return this._listening;
	}

	/**
	 * Start recording from the microphone.
	 * Requests microphone permission on first call.
	 * Throws if already recording or if microphone access is denied.
	 */
	async start(): Promise<void> {
		if (this._listening) {
			throw new Error("[SpeechToText] Already recording");
		}

		this.chunks = [];
		this.diarizer.reset();

		this.mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				sampleRate: this.options.sampleRate ?? 16000,
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});

		// Set up diarizer energy analysis
		if (this.options.diarize) {
			this.audioContext = new AudioContext({
				sampleRate: this.options.sampleRate ?? 16000,
			});
			this.diarizer.attach(this.mediaStream, this.audioContext);
		}

		const mimeType = this._getSupportedMimeType();
		this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });

		this.mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		};

		this.startTime = Date.now();
		this.mediaRecorder.start(100); // collect chunks every 100ms
		this._listening = true;
	}

	/**
	 * Stop recording and transcribe.
	 * Returns the transcription result.
	 */
	async stop(): Promise<TranscriptionResult> {
		if (!this._listening || !this.mediaRecorder) {
			throw new Error("[SpeechToText] Not recording");
		}

		return new Promise<TranscriptionResult>((resolve, reject) => {
			const recorder = this.mediaRecorder!;

			recorder.onstop = async () => {
				try {
					const durationSeconds = (Date.now() - this.startTime) / 1000;
					this._cleanup();

					if (this.chunks.length === 0) {
						resolve({ text: "", durationSeconds });
						return;
					}

					const mimeType = recorder.mimeType || "audio/webm";
					const audioBlob = new Blob(this.chunks, { type: mimeType });
					const result = await this._transcribe(audioBlob, mimeType, durationSeconds);
					resolve(result);
				} catch (err) {
					reject(err);
				}
			};

			recorder.stop();
			this._listening = false;
		});
	}

	/** Update options (e.g. new API key from settings). */
	updateOptions(options: Partial<SttOptions>): void {
		this.options = { ...this.options, ...options };
		if (options.primarySpeakerLabel) {
			this.diarizer = new SpeakerDiarizer(options.primarySpeakerLabel);
		}
	}

	// ── Private helpers ─────────────────────────────────────────────────────────

	private async _transcribe(
		audioBlob: Blob,
		mimeType: string,
		durationSeconds: number
	): Promise<TranscriptionResult> {
		if (!this.options.groqApiKey) {
			throw new Error("[SpeechToText] GROQ_API_KEY is not set");
		}

		const ext = mimeType.includes("ogg")
			? "ogg"
			: mimeType.includes("mp4") || mimeType.includes("m4a")
				? "m4a"
				: "webm";

		const formData = new FormData();
		formData.append("file", audioBlob, `recording.${ext}`);
		formData.append("model", GROQ_MODEL);
		formData.append("response_format", "json");
		if (this.options.language) {
			formData.append("language", this.options.language);
		}

		const response = await fetch(GROQ_STT_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.options.groqApiKey}`,
			},
			body: formData,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(`[SpeechToText] Groq API error ${response.status}: ${errorText}`);
		}

		const json = (await response.json()) as { text?: string };
		const text = json.text?.trim() ?? "";

		// Run diarization if requested
		let diarized: DiarizedTranscript | undefined;
		if (this.options.diarize && text) {
			diarized = this.diarizer.diarize(text, durationSeconds);
		}

		return { text, diarized, durationSeconds };
	}

	private _cleanup(): void {
		this.diarizer.detach();

		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}

		if (this.mediaStream) {
			for (const track of this.mediaStream.getTracks()) {
				track.stop();
			}
			this.mediaStream = null;
		}

		this.mediaRecorder = null;
	}

	/** Pick the best supported MIME type for recording. */
	private _getSupportedMimeType(): string {
		const candidates = [
			"audio/webm;codecs=opus",
			"audio/webm",
			"audio/ogg;codecs=opus",
			"audio/mp4",
		];
		for (const type of candidates) {
			if (MediaRecorder.isTypeSupported(type)) return type;
		}
		return ""; // Let the browser choose
	}
}
