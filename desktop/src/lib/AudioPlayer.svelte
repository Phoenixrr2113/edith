<script lang="ts">
	import { stopAudio } from './audio.js';

	// ── Props ──────────────────────────────────────────────────────────────────

	interface Props {
		/** Whether audio is currently playing (reactive, set by parent) */
		playing: boolean;
		/** Called when the user presses the stop button */
		onStop?: () => void;
	}

	let { playing = false, onStop }: Props = $props();

	// ── Actions ────────────────────────────────────────────────────────────────

	function handleStop() {
		stopAudio();
		onStop?.();
	}
</script>

{#if playing}
	<div class="audio-player" role="status" aria-label="Audio playing">
		<!-- Waveform bars -->
		<div class="waveform" aria-hidden="true">
			<span class="bar"></span>
			<span class="bar"></span>
			<span class="bar"></span>
			<span class="bar"></span>
			<span class="bar"></span>
		</div>

		<!-- Stop button -->
		<button
			class="stop-btn"
			onclick={handleStop}
			type="button"
			aria-label="Stop audio"
			title="Stop audio"
		>
			&#9632;
		</button>
	</div>
{/if}

<style>
	.audio-player {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
		background: var(--bubble-bg, rgba(30, 30, 46, 0.85));
		border: 1px solid rgba(107, 115, 255, 0.3);
		border-radius: 20px;
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		width: fit-content;
	}

	/* ── Waveform ────────────────────────────────────────────────────────────── */

	.waveform {
		display: flex;
		align-items: center;
		gap: 3px;
		height: 18px;
	}

	.bar {
		display: block;
		width: 3px;
		border-radius: 2px;
		background: rgba(107, 115, 255, 0.9);
		animation: wave 1.1s ease-in-out infinite;
	}

	.bar:nth-child(1) { height: 6px;  animation-delay: 0s;    }
	.bar:nth-child(2) { height: 12px; animation-delay: 0.15s; }
	.bar:nth-child(3) { height: 18px; animation-delay: 0.3s;  }
	.bar:nth-child(4) { height: 12px; animation-delay: 0.45s; }
	.bar:nth-child(5) { height: 6px;  animation-delay: 0.6s;  }

	@keyframes wave {
		0%, 100% { transform: scaleY(0.4); opacity: 0.6; }
		50%       { transform: scaleY(1);   opacity: 1;   }
	}

	/* ── Stop button ─────────────────────────────────────────────────────────── */

	.stop-btn {
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.55);
		font-size: 10px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 4px;
		transition: color 0.15s ease, background 0.15s ease;
	}

	.stop-btn:hover {
		color: rgba(255, 255, 255, 0.9);
		background: rgba(255, 255, 255, 0.08);
	}
</style>
