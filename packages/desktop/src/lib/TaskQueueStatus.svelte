<script lang="ts">
	import type { TaskQueue } from './task-queue.js';

	interface Props {
		queue: TaskQueue;
		/** Only shown when true (i.e. when offline/local) */
		visible: boolean;
		onClear: () => void;
	}

	let { queue, visible, onClear }: Props = $props();
</script>

{#if visible && queue.size > 0}
	<div class="task-queue-status" title="{queue.size} task{queue.size === 1 ? '' : 's'} queued — will send when cloud reconnects">
		<span class="badge">{queue.size}</span>
		<span class="label">task{queue.size === 1 ? '' : 's'} pending</span>
		<button class="clear-btn" onclick={onClear} type="button" title="Clear queued tasks" aria-label="Clear task queue">
			✕
		</button>
	</div>
{/if}

<style>
	.task-queue-status {
		display: flex;
		align-items: center;
		gap: 5px;
		background: var(--btn-bg, rgba(255,255,255,0.08));
		border: 1px solid var(--input-border, rgba(255,255,255,0.15));
		border-radius: 8px;
		padding: 3px 8px 3px 5px;
		font-size: 11px;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--accent, #f0a500);
		color: #000;
		border-radius: 10px;
		min-width: 18px;
		height: 18px;
		padding: 0 4px;
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
	}

	.label {
		color: var(--text-muted, #aaa);
	}

	.clear-btn {
		background: none;
		border: none;
		color: var(--text-muted, #aaa);
		cursor: pointer;
		padding: 0 2px;
		font-size: 10px;
		line-height: 1;
		transition: color 0.15s;
	}

	.clear-btn:hover {
		color: var(--text-color, #fff);
	}
</style>
