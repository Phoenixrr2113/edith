<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		ollamaStatus,
		refreshOllamaStatus,
		DEFAULT_OLLAMA_URL,
	} from './ollama.js';
	import { settingsStore } from './settings.js';
	import { openUrl } from '@tauri-apps/plugin-opener';

	const POLL_INTERVAL_MS = 30_000;
	const OLLAMA_INSTALL_URL = 'https://ollama.ai';

	let checking = $state(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	function baseUrl(): string {
		return settingsStore.value.ollamaUrl ?? DEFAULT_OLLAMA_URL;
	}

	async function check() {
		if (checking) return;
		checking = true;
		try {
			await refreshOllamaStatus(baseUrl());
		} finally {
			checking = false;
		}
	}

	async function handleInstallClick() {
		try {
			await openUrl(OLLAMA_INSTALL_URL);
		} catch {
			// Fallback: window.open if Tauri shell unavailable (dev browser)
			window.open(OLLAMA_INSTALL_URL, '_blank');
		}
	}

	onMount(() => {
		check();
		timer = setInterval(check, POLL_INTERVAL_MS);
	});

	onDestroy(() => {
		if (timer !== null) clearInterval(timer);
	});

	// Re-check when the ollamaUrl setting changes
	$effect(() => {
		void settingsStore.value.ollamaUrl;
		check();
	});

	// Derived display state
	const status = $derived(ollamaStatus.value);
	const connected = $derived(status.running);
	const models = $derived(status.models);
</script>

<div class="ollama-status">
	<div class="status-row">
		<span
			class="indicator"
			class:connected
			class:checking
			title={connected ? 'Ollama connected' : checking ? 'Checking…' : 'Ollama not detected'}
		></span>
		<span class="label">
			{#if checking}
				Checking…
			{:else if connected}
				Connected
			{:else}
				Not detected
			{/if}
		</span>
		<button
			class="refresh-btn"
			onclick={check}
			type="button"
			aria-label="Refresh Ollama status"
			disabled={checking}
		>↻</button>
	</div>

	{#if !checking && !connected}
		<div class="install-prompt">
			<span class="install-text">Ollama enables local AI fallback.</span>
			<button class="install-btn" onclick={handleInstallClick} type="button">
				Install Ollama
			</button>
		</div>
	{/if}

	{#if connected && models.length > 0}
		<ul class="model-list">
			{#each models as model (model.name)}
				<li class="model-item">
					<span class="model-name">{model.name}</span>
					{#if model.size}
						<span class="model-size">{formatSize(model.size)}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if connected && models.length === 0}
		<p class="no-models">No models installed. Run <code>ollama pull llama3</code> to get started.</p>
	{/if}
</div>

<script lang="ts" module>
	function formatSize(bytes: number): string {
		if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
		if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
		return `${bytes} B`;
	}
</script>

<style>
	.ollama-status {
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

	.indicator.connected {
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

	.model-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.model-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--input-bg);
		border: 1px solid var(--input-border);
		border-radius: 6px;
		padding: 5px 9px;
	}

	.model-name {
		font-size: 12px;
		color: var(--text-color);
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
	}

	.model-size {
		font-size: 11px;
		color: var(--text-muted);
	}

	.no-models {
		font-size: 11px;
		color: var(--text-muted);
		margin: 0;
	}

	.no-models code {
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
		background: var(--input-bg);
		padding: 1px 4px;
		border-radius: 3px;
	}
</style>
