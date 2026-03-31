/**
 * diarization.ts — Lightweight speaker detection based on audio energy levels.
 *
 * This is a lightweight approximation; full pyannote-style ML diarization
 * is deferred to a later milestone (VOICE-DIARIZE-107 phase 2).
 *
 * Approach:
 *  - Maintain a short rolling energy history to distinguish foreground speech
 *    from background noise.
 *  - The primary speaker (Randy) is identified as speaker whose voice energy
 *    exceeds the noise floor by a configurable threshold.
 *  - Additional voices are labeled Speaker-2, Speaker-3, etc., using simple
 *    energy-profile bucketing across time windows.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiarizedSegment {
	/** e.g. "Randy" | "Speaker-2" | "Speaker-3" */
	speaker: string;
	/** Segment start time in seconds (relative to recording start) */
	start: number;
	/** Segment end time in seconds */
	end: number;
	/** Transcribed text for this segment */
	text: string;
}

export interface DiarizedTranscript {
	segments: DiarizedSegment[];
	/** Total duration of the audio in seconds */
	durationSeconds: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

/** Energy analysis window in milliseconds */
const WINDOW_MS = 200;

/** Ratio above noise floor required to consider audio as speech */
const SPEECH_THRESHOLD_RATIO = 2.5;

/**
 * Number of distinct energy clusters above the speech threshold before
 * a new speaker label is assigned. This is very approximate.
 */
const SPEAKER_CLUSTER_TOLERANCE = 0.4;

// ── SpeakerDiarizer ───────────────────────────────────────────────────────────

export class SpeakerDiarizer {
	private readonly primarySpeakerLabel: string;

	/** Rolling noise floor estimate (RMS, range 0–1) */
	private noiseFloor = 0.01;

	/** Energy samples collected during the current recording session */
	private energySamples: Array<{ timeMs: number; rms: number }> = [];

	/** Audio context used for energy analysis */
	private analyserNode: AnalyserNode | null = null;
	private sampleBuffer: Float32Array | null = null;
	private analysisTimer: ReturnType<typeof setInterval> | null = null;

	constructor(primarySpeakerLabel = "Randy") {
		this.primarySpeakerLabel = primarySpeakerLabel;
	}

	// ── Public API ──────────────────────────────────────────────────────────────

	/**
	 * Attach to a live MediaStream and begin collecting energy samples.
	 * Call before recording starts.
	 */
	attach(stream: MediaStream, audioContext: AudioContext): void {
		this.detach();
		this.energySamples = [];

		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		source.connect(analyser);

		this.analyserNode = analyser;
		this.sampleBuffer = new Float32Array(analyser.fftSize);

		const startMs = Date.now();
		this.analysisTimer = setInterval(() => {
			const rms = this._getRms();
			this.energySamples.push({ timeMs: Date.now() - startMs, rms });
			this._updateNoiseFloor(rms);
		}, WINDOW_MS);
	}

	/** Stop collecting samples and clean up. */
	detach(): void {
		if (this.analysisTimer !== null) {
			clearInterval(this.analysisTimer);
			this.analysisTimer = null;
		}
		this.analyserNode = null;
		this.sampleBuffer = null;
	}

	/**
	 * Given a raw transcript string and total duration, produce a
	 * DiarizedTranscript by splitting the text into segments and assigning
	 * speaker labels based on the energy profile.
	 *
	 * The simple heuristic:
	 *  - Divide the recording into time windows matching WINDOW_MS.
	 *  - Each window above the speech threshold is "speech".
	 *  - Cluster energy levels: primary speaker = highest sustained energy.
	 *  - Secondary/tertiary voices = lower energy clusters well above noise.
	 */
	diarize(transcript: string, durationSeconds: number): DiarizedTranscript {
		if (!transcript.trim()) {
			return { segments: [], durationSeconds };
		}

		const speechWindows = this._classifySpeechWindows();

		// If we have no energy data (e.g. diarizer wasn't attached), return
		// the whole transcript as a single segment for the primary speaker.
		if (speechWindows.length === 0) {
			return {
				segments: [
					{
						speaker: this.primarySpeakerLabel,
						start: 0,
						end: durationSeconds,
						text: transcript.trim(),
					},
				],
				durationSeconds,
			};
		}

		const segments = this._buildSegments(transcript, speechWindows, durationSeconds);
		return { segments, durationSeconds };
	}

	/** Reset noise floor and energy history for a new session. */
	reset(): void {
		this.noiseFloor = 0.01;
		this.energySamples = [];
	}

	// ── Private helpers ─────────────────────────────────────────────────────────

	private _getRms(): number {
		if (!this.analyserNode || !this.sampleBuffer) return 0;
		this.analyserNode.getFloatTimeDomainData(this.sampleBuffer);
		let sumSq = 0;
		for (const s of this.sampleBuffer) sumSq += s * s;
		return Math.sqrt(sumSq / this.sampleBuffer.length);
	}

	private _updateNoiseFloor(rms: number): void {
		// Exponential moving average — slow adaptation to track ambient noise
		this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * Math.min(rms, this.noiseFloor * 3);
		if (this.noiseFloor < 0.001) this.noiseFloor = 0.001;
	}

	private _classifySpeechWindows(): Array<{ timeMs: number; rms: number; isSpeech: boolean }> {
		return this.energySamples.map((s) => ({
			...s,
			isSpeech: s.rms > this.noiseFloor * SPEECH_THRESHOLD_RATIO,
		}));
	}

	/**
	 * Split transcript into sentence-ish chunks and map each chunk to the
	 * nearest time window's speaker assignment.
	 */
	private _buildSegments(
		transcript: string,
		windows: Array<{ timeMs: number; rms: number; isSpeech: boolean }>,
		durationSeconds: number
	): DiarizedSegment[] {
		// Split on sentence boundaries: ". ", "? ", "! ", or newlines.
		const chunks = transcript
			.split(/(?<=[.?!])\s+|\n+/)
			.map((c) => c.trim())
			.filter(Boolean);

		if (chunks.length === 0) return [];

		// Build energy clusters: collect RMS values for speech windows
		const speechRmsValues = windows.filter((w) => w.isSpeech).map((w) => w.rms);
		const maxRms = speechRmsValues.length > 0 ? Math.max(...speechRmsValues) : 0;

		// Assign speaker labels: energy near peak = primary, lower = secondary
		const segments: DiarizedSegment[] = [];
		const chunkDuration = durationSeconds / chunks.length;

		for (let i = 0; i < chunks.length; i++) {
			const startSec = i * chunkDuration;
			const endSec = (i + 1) * chunkDuration;
			const midMs = ((startSec + endSec) / 2) * 1000;

			// Find the closest energy window to the midpoint of this chunk
			const closestWindow = this._findClosestWindow(windows, midMs);

			let speaker: string;
			if (!closestWindow || !closestWindow.isSpeech) {
				// No speech detected in this window — attribute to primary speaker
				// (could be a brief pause or transcription artifact)
				speaker = this.primarySpeakerLabel;
			} else {
				const energyRatio = maxRms > 0 ? closestWindow.rms / maxRms : 1;
				speaker = this._assignSpeakerLabel(energyRatio);
			}

			segments.push({ speaker, start: startSec, end: endSec, text: chunks[i] });
		}

		return segments;
	}

	private _findClosestWindow(
		windows: Array<{ timeMs: number; rms: number; isSpeech: boolean }>,
		targetMs: number
	): { timeMs: number; rms: number; isSpeech: boolean } | null {
		if (windows.length === 0) return null;
		let closest = windows[0];
		let minDist = Math.abs(windows[0].timeMs - targetMs);
		for (const w of windows) {
			const dist = Math.abs(w.timeMs - targetMs);
			if (dist < minDist) {
				minDist = dist;
				closest = w;
			}
		}
		return closest;
	}

	/**
	 * Map an energy ratio (0–1, where 1 = max observed energy) to a speaker label.
	 *
	 * Primary speaker consistently has the highest energy (loudest, closest mic).
	 * Values near the noise floor get assigned to Speaker-2, Speaker-3.
	 */
	private _assignSpeakerLabel(energyRatio: number): string {
		if (energyRatio >= 1 - SPEAKER_CLUSTER_TOLERANCE) {
			return this.primarySpeakerLabel;
		}
		if (energyRatio >= 0.35) {
			return "Speaker-2";
		}
		return "Speaker-3";
	}
}
