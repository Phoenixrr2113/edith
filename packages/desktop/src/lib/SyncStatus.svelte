<script lang="ts">
	import type { SyncStatus } from './sync.js';

	interface Props {
		status: SyncStatus;
		lastSyncAt: number | null;
		onSyncNow: () => void;
	}

	let { status, lastSyncAt, onSyncNow }: Props = $props();

	function formatLastSync(ts: number | null): string {
		if (ts === null) return 'Never';
		const diff = Date.now() - ts;
		if (diff < 60_000) return 'Just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		return `${Math.floor(diff / 3_600_000)}h ago`;
	}
</script>

<div class="sync-status">
	<span class="sync-label">
		{#if status === 'syncing'}
			<span class="spinner" aria-hidden="true">⟳</span>
			Syncing…
		{:else if status === 'error'}
			<span class="error-dot" aria-hidden="true">●</span>
			Sync error
		{:else}
			Synced {formatLastSync(lastSyncAt)}
		{/if}
	</span>
	<button
		class="sync-btn"
		onclick={onSyncNow}
		disabled={status === 'syncing'}
		type="button"
		title="Sync now"
		aria-label="Sync now"
	>
		Sync Now
	</button>
</div>

<style>
	.sync-status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--text-secondary);
	}

	.sync-label {
		display: flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	.spinner {
		display: inline-block;
		animation: spin 1s linear infinite;
		font-size: 13px;
		line-height: 1;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.error-dot {
		color: var(--error-color, #e55);
		font-size: 8px;
	}

	.sync-btn {
		background: var(--btn-bg);
		color: var(--text-secondary);
		border: 1px solid var(--input-border);
		border-radius: 6px;
		padding: 3px 8px;
		font-size: 11px;
		cursor: pointer;
		transition: background 0.15s ease;
		white-space: nowrap;
	}

	.sync-btn:hover:not(:disabled) {
		background: var(--btn-bg-hover);
		color: var(--text-color);
	}

	.sync-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
