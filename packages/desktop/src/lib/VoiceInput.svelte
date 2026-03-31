<script lang="ts">
	import { SpeechToText } from './stt.js';
	import { settingsStore } from './settings.js';

	interface Props {
		/** Called when transcription is ready — passes the transcribed text */
		onTranscript: (text: string) => void;
		/** Optional: also receive full diarized result */
		onDiarized?: (result: import('./diarization.js').DiarizedTranscript) => void;
		/** Whether the button is disabled (e.g. not connected) */
		disabled?: boolean;
	}

	let { onTranscript, onDiarized, disabled = false }: Props = $props();

	// ── State ──────────────────────────────────────────────────────────────────

	type RecordingState = 'idle' | 'recording' | 'transcribing' | 'error';

	let state = $state<RecordingState>('idle');
	let errorMessage = $state('');

	/** Animated waveform bar heights (0–1), updated while recording */
	let waveformBars = $state<number[]>([0.3, 0.5, 0.4, 0.6, 0.35]);
	let waveformTimer: ReturnType<typeof setInterval> | null = null;

	/** AudioContext + AnalyserNode for live waveform visualization */
	let analyserNode: AnalyserNode | null = null;
	let audioCtx: AudioContext | null = null;
	let waveBuffer: Float32Array | null = null;
	/** Separate MediaStream opened only for waveform viz (tracks stopped on cleanup) */
	let vizStream: MediaStream | null = null;

	// ── STT instance (lazy-created when first used) ────────────────────────────

	let stt: SpeechToText | null = null;

	function getStt(): SpeechToText {
		const settings = settingsStore.value;
		if (!stt) {
			stt = new SpeechToText({
				groqApiKey: settings.groqApiKey,
				diarize: true,
				primarySpeakerLabel: 'Randy',
				language: 'en',
			});
		} else {
			stt.updateOptions({ groqApiKey: settings.groqApiKey });
		}
		return stt;
	}

	// ── Waveform animation ─────────────────────────────────────────────────────

	function startWaveform(stream: MediaStream): void {
		audioCtx = new AudioContext();
		const source = audioCtx.createMediaStreamSource(stream);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		analyserNode = analyser;
		waveBuffer = new Float32Array(analyser.fftSize);

		waveformTimer = setInterval(() => {
			if (!analyserNode || !waveBuffer) return;
			analyserNode.getFloatTimeDomainData(waveBuffer);

			// Sample 5 evenly-spaced points and map to 0–1 height
			const len = waveBuffer.length;
			waveformBars = [0, 1, 2, 3, 4].map((i) => {
				const idx = Math.floor((i / 4) * (len - 1));
				return Math.min(1, Math.abs(waveBuffer![idx]) * 8 + 0.15);
			});
		}, 80);
	}

	function stopWaveform(): void {
		if (waveformTimer !== null) {
			clearInterval(waveformTimer);
			waveformTimer = null;
		}
		if (audioCtx) {
			audioCtx.close().catch(() => {});
			audioCtx = null;
		}
		analyserNode = null;
		waveBuffer = null;
		// Stop the viz stream tracks (separate from the STT recording stream)
		if (vizStream) {
			for (const t of vizStream.getTracks()) t.stop();
			vizStream = null;
		}
		// Reset bars to neutral
		waveformBars = [0.3, 0.5, 0.4, 0.6, 0.35];
	}

	// ── Button interaction ─────────────────────────────────────────────────────

	async function handleClick() {
		if (disabled) return;

		if (state === 'recording') {
			await stopRecording();
		} else if (state === 'idle' || state === 'error') {
			await startRecording();
		}
	}

	async function startRecording() {
		const settings = settingsStore.value;
		if (!settings.sttEnabled) {
			state = 'error';
			errorMessage = 'Voice input is disabled. Enable it in Settings.';
			return;
		}
		if (!settings.groqApiKey) {
			state = 'error';
			errorMessage = 'Groq API key missing. Add it in Settings.';
			return;
		}

		try {
			const instance = getStt();
			await instance.start();
			state = 'recording';
			errorMessage = '';

			// Kick off waveform visualization using a separate stream reference
			// (the SpeechToText already has its own, this is for the UI only)
			try {
				vizStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				startWaveform(vizStream);
			} catch {
				// Waveform is cosmetic — don't block recording if it fails
			}
		} catch (err) {
			state = 'error';
			errorMessage = err instanceof Error ? err.message : 'Microphone error';
		}
	}

	async function stopRecording() {
		stopWaveform();
		state = 'transcribing';

		try {
			const instance = getStt();
			const result = await instance.stop();

			if (result.text) {
				onTranscript(result.text);
				if (result.diarized && onDiarized) {
					onDiarized(result.diarized);
				}
			}

			state = 'idle';
		} catch (err) {
			state = 'error';
			errorMessage = err instanceof Error ? err.message : 'Transcription failed';
		}
	}

	// ── Label helpers ──────────────────────────────────────────────────────────

	const ariaLabel = $derived(
		state === 'recording'
			? 'Stop recording'
			: state === 'transcribing'
				? 'Transcribing…'
				: 'Start voice input'
	);
</script>

<div class="voice-input" class:recording={state === 'recording'} class:error={state === 'error'}>
	<button
		type="button"
		class="mic-btn"
		class:recording={state === 'recording'}
		class:transcribing={state === 'transcribing'}
		onclick={handleClick}
		{disabled}
		aria-label={ariaLabel}
		title={errorMessage || ariaLabel}
	>
		{#if state === 'transcribing'}
			<span class="spinner" aria-hidden="true"></span>
		{:else if state === 'recording'}
			<!-- Animated waveform bars -->
			<span class="waveform" aria-hidden="true">
				{#each waveformBars as h, i (i)}
					<span class="bar" style="height: {Math.round(h * 18) + 4}px;"></span>
				{/each}
			</span>
		{:else}
			<!-- Mic icon (SVG) -->
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				width="14"
				height="14"
				aria-hidden="true"
			>
				<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
				<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
				<line x1="12" y1="19" x2="12" y2="22" />
			</svg>
		{/if}
	</button>
</div>

<style>
	.voice-input {
		display: flex;
		align-items: center;
	}

	.mic-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		border: 1px solid var(--input-border);
		background: var(--btn-bg);
		color: var(--text-secondary);
		cursor: pointer;
		transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
		padding: 0;
		flex-shrink: 0;
	}

	.mic-btn:hover:not(:disabled) {
		background: var(--btn-bg-hover);
		color: var(--text-color);
	}

	.mic-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Recording state — pulsing red ring */
	.mic-btn.recording {
		background: rgba(220, 38, 38, 0.15);
		border-color: #dc2626;
		color: #dc2626;
		animation: pulse-ring 1.4s ease-in-out infinite;
	}

	/* Transcribing — neutral spinner */
	.mic-btn.transcribing {
		background: var(--btn-bg-active);
		border-color: var(--accent);
		color: var(--accent);
		cursor: wait;
	}

	@keyframes pulse-ring {
		0%, 100% {
			box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4);
		}
		50% {
			box-shadow: 0 0 0 4px rgba(220, 38, 38, 0);
		}
	}

	/* Waveform bars */
	.waveform {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 20px;
	}

	.bar {
		display: block;
		width: 3px;
		min-height: 4px;
		background: #dc2626;
		border-radius: 2px;
		transition: height 0.08s ease;
	}

	/* Spinner for transcribing state */
	.spinner {
		display: block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--accent, #6366f1);
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
