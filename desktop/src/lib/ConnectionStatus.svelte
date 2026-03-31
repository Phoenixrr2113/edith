<script lang="ts">
	import type { ConnectionMode } from './connection-state.js';

	interface Props {
		mode: ConnectionMode;
		ollamaAvailable: boolean;
		cloudConnected: boolean;
		manualOverride: ConnectionMode | null;
		onForceCloud: () => void;
		onForceLocal: () => void;
		onForceAuto: () => void;
	}

	let {
		mode,
		ollamaAvailable,
		cloudConnected,
		manualOverride,
		onForceCloud,
		onForceLocal,
		onForceAuto,
	}: Props = $props();

	const ICONS: Record<ConnectionMode, string> = {
		cloud: '☁',
		local: '⬡',
		offline: '⊘',
	};

	const LABELS: Record<ConnectionMode, string> = {
		cloud: 'Cloud',
		local: 'Local (Ollama)',
		offline: 'Offline',
	};

	const COLORS: Record<ConnectionMode, string> = {
		cloud: 'var(--dot-connected, #4caf50)',
		local: 'var(--dot-local, #f0a500)',
		offline: 'var(--dot-disconnected, #666)',
	};
</script>

<div class="connection-status" title="Connection: {LABELS[mode]}">
	<span class="icon" style="color: {COLORS[mode]}">{ICONS[mode]}</span>
	<span class="label">{LABELS[mode]}</span>
	{#if manualOverride !== null}
		<button class="override-btn" onclick={onForceAuto} type="button" title="Return to automatic">
			auto
		</button>
	{:else}
		{#if mode !== 'cloud' && cloudConnected}
			<button class="override-btn" onclick={onForceCloud} type="button" title="Switch to cloud">
				☁
			</button>
		{/if}
		{#if mode !== 'local' && ollamaAvailable}
			<button class="override-btn" onclick={onForceLocal} type="button" title="Switch to local Ollama">
				⬡
			</button>
		{/if}
	{/if}
</div>

<style>
	.connection-status {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.icon {
		font-size: 12px;
		line-height: 1;
	}

	.label {
		font-size: 11px;
		color: var(--text-muted);
	}

	.override-btn {
		background: var(--btn-bg);
		color: var(--text-secondary);
		border: 1px solid var(--input-border);
		border-radius: 4px;
		padding: 1px 5px;
		font-size: 10px;
		cursor: pointer;
		line-height: 1.4;
		transition: background 0.15s;
	}

	.override-btn:hover {
		background: var(--btn-bg-hover);
	}
</style>
