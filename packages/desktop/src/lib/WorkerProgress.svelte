<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getWorkers } from './stores.svelte.js';

	// Elapsed time formatting
	function elapsed(startTime: number): string {
		const secs = Math.floor((Date.now() - startTime) / 1000);
		if (secs < 60) return `${secs}s`;
		const mins = Math.floor(secs / 60);
		const rem = secs % 60;
		return `${mins}m${rem}s`;
	}

	// Tick every second so elapsed times stay fresh
	let tick = $state(0);
	const timer = setInterval(() => { tick++; }, 1000);

	onDestroy(() => clearInterval(timer));

	// Derived — re-evaluated whenever workers map or tick changes
	let workers = $derived.by(() => {
		void tick; // declare dependency on tick
		return Array.from(getWorkers().entries());
	});
</script>

{#if workers.length > 0}
	<div class="worker-progress" aria-live="polite">
		{#each workers as [taskId, entry] (taskId)}
			<div
				class="worker-row"
				class:failed={entry.status === 'failed'}
				class:complete={entry.status === 'complete'}
			>
				{#if entry.status === 'running'}
					<span class="spinner" aria-hidden="true"></span>
				{:else if entry.status === 'failed'}
					<span class="icon-fail" aria-hidden="true">✕</span>
				{:else}
					<span class="icon-ok" aria-hidden="true">✓</span>
				{/if}

				<span class="label">{entry.label}</span>

				{#if entry.progress !== undefined}
					<span class="pct">{entry.progress}%</span>
				{/if}

				<span class="elapsed">{elapsed(entry.startTime)}</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.worker-progress {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 280px;
		width: 100%;

		/* Fade in when rows appear */
		animation: fadeIn 0.2s ease;
	}

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(4px); }
		to   { opacity: 1; transform: translateY(0); }
	}

	.worker-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		background: rgba(20, 20, 25, 0.72);
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.06);
		font-family: "SF Mono", "Fira Mono", "Cascadia Code", monospace;
		font-size: 11px;
		color: rgba(255, 255, 255, 0.55);
		transition: background 0.2s ease, color 0.2s ease;
	}

	.worker-row.failed {
		border-color: rgba(255, 80, 80, 0.25);
		color: rgba(255, 120, 120, 0.75);
	}

	.worker-row.complete {
		color: rgba(100, 220, 120, 0.6);
	}

	.label {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.elapsed {
		flex-shrink: 0;
		color: rgba(255, 255, 255, 0.28);
		font-size: 10px;
	}

	.pct {
		flex-shrink: 0;
		font-size: 10px;
		color: rgba(255, 255, 255, 0.35);
	}

	/* Spinner */
	.spinner {
		flex-shrink: 0;
		width: 10px;
		height: 10px;
		border: 1.5px solid rgba(255, 255, 255, 0.15);
		border-top-color: rgba(255, 255, 255, 0.5);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.icon-fail,
	.icon-ok {
		flex-shrink: 0;
		width: 10px;
		font-size: 10px;
		line-height: 1;
		text-align: center;
	}
</style>
