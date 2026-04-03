<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		piperStatus,
		refreshPiperStatus,
		DEFAULT_PIPER_URL,
	} from './tts-piper.svelte.js';
	import { openUrl } from '@tauri-apps/plugin-opener';

	const POLL_INTERVAL_MS = 30_000;
	const PIPER_INSTALL_URL = 'https://github.com/rhasspy/piper';

	let checking = $state(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function check() {
		if (checking) return;
		checking = true;
		try {
			await refreshPiperStatus(DEFAULT_PIPER_URL);
		} finally {
			checking = false;
		}
	}

	async function handleInstallClick() {
		try {
			await openUrl(PIPER_INSTALL_URL);
		} catch {
			// Fallback: window.open if Tauri shell unavailable (dev browser)
			window.open(PIPER_INSTALL_URL, '_blank');
		}
	}

	onMount(() => {
		check();
		timer = setInterval(check, POLL_INTERVAL_MS);
	});

	onDestroy(() => {
		if (timer !== null) clearInterval(timer);
	});

	// Derived display state
	const status = $derived(piperStatus.value);
	const available = $derived(status.available);
</script>

<div class="piper-status">
	<div class="status-row">
		<span
			class="indicator"
			class:available
			class:checking
			title={available ? 'Piper connected' : checking ? 'Checking…' : 'Piper not detected'}
		></span>
		<span class="label">
			{#if checking}
				Checking…
			{:else if available}
				Connected
			{:else}
				Not detected
			{/if}
		</span>
		<button
			class="refresh-btn"
			onclick={check}
			type="button"
			aria-label="Refresh Piper status"
			disabled={checking}
		>↻</button>
	</div>

	{#if !checking && !available}
		<div class="install-prompt">
			<span class="install-text">Piper enables offline speech synthesis.</span>
			<button class="install-btn" onclick={handleInstallClick} type="button">
				Install Piper
			</button>
		</div>
	{/if}
</div>

<style>
	.piper-status {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.status-row {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.indicator {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--dot-disconnected, #666);
		transition: background 0.2s ease;
	}

	.indicator.checking {
		background: var(--dot-connecting, #f0a500);
		animation: pulse 1s ease-in-out infinite;
	}

	.indicator.available {
		background: var(--dot-connected, #4caf50);
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.label {
		font-size: 13px;
		color: var(--text-color);
		flex: 1;
	}

	.refresh-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 14px;
		padding: 2px 4px;
		border-radius: 4px;
		line-height: 1;
		transition: color 0.15s, background 0.15s;
	}

	.refresh-btn:hover:not(:disabled) {
		color: var(--text-color);
		background: var(--btn-bg-hover);
	}

	.refresh-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.install-prompt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		background: var(--input-bg);
		border: 1px solid var(--input-border);
		border-radius: 7px;
		padding: 8px 10px;
	}

	.install-text {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.4;
	}

	.install-btn {
		flex-shrink: 0;
		background: var(--btn-bg-active, #2563eb);
		border: none;
		border-radius: 6px;
		color: #fff;
		cursor: pointer;
		font-size: 11px;
		font-weight: 600;
		padding: 5px 10px;
		transition: opacity 0.15s;
	}

	.install-btn:hover {
		opacity: 0.85;
	}
</style>
