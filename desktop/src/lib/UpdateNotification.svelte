<script lang="ts">
	import { installUpdate, type UpdateInfo } from './updater.js';

	interface Props {
		update: UpdateInfo | null;
		onDismiss: () => void;
	}

	let { update, onDismiss }: Props = $props();

	let installing = $state(false);
	let error = $state<string | null>(null);

	async function handleInstall() {
		installing = true;
		error = null;
		try {
			await installUpdate();
			// relaunch() is called inside installUpdate — we won't reach here
		} catch (err) {
			error = 'Install failed. Try again later.';
			installing = false;
		}
	}
</script>

{#if update}
	<div class="update-bubble" role="status" aria-live="polite">
		<div class="update-text">
			<strong>Update available</strong> — v{update.version}
			{#if update.notes}
				<span class="update-notes">{update.notes}</span>
			{/if}
		</div>

		{#if error}
			<span class="update-error">{error}</span>
		{/if}

		<div class="update-actions">
			<button
				class="install-btn"
				onclick={handleInstall}
				disabled={installing}
				type="button"
			>
				{installing ? 'Installing…' : 'Install & Restart'}
			</button>
			<button
				class="dismiss-btn"
				onclick={onDismiss}
				disabled={installing}
				type="button"
				aria-label="Dismiss update notification"
			>✕</button>
		</div>
	</div>
{/if}

<style>
	.update-bubble {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--bubble-bg, rgba(30, 30, 30, 0.92));
		border: 1px solid var(--accent, #6c8ef2);
		border-radius: 12px;
		padding: 10px 14px;
		max-width: 300px;
		font-size: 13px;
		color: var(--text-color, #fff);
		backdrop-filter: blur(8px);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
		animation: slideIn 0.2s ease;
	}

	@keyframes slideIn {
		from { opacity: 0; transform: translateY(8px); }
		to   { opacity: 1; transform: translateY(0); }
	}

	.update-text {
		line-height: 1.4;
	}

	.update-notes {
		display: block;
		font-size: 11px;
		color: var(--text-secondary, #aaa);
		margin-top: 3px;
		white-space: pre-wrap;
		max-height: 60px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.update-error {
		font-size: 11px;
		color: var(--error-color, #f66);
	}

	.update-actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.install-btn {
		background: var(--accent, #6c8ef2);
		color: #fff;
		border: none;
		border-radius: 8px;
		padding: 5px 12px;
		font-size: 12px;
		cursor: pointer;
		flex: 1;
		transition: opacity 0.15s;
	}

	.install-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.install-btn:not(:disabled):hover {
		opacity: 0.85;
	}

	.dismiss-btn {
		background: transparent;
		color: var(--text-secondary, #aaa);
		border: none;
		cursor: pointer;
		padding: 4px 6px;
		font-size: 13px;
		border-radius: 6px;
		transition: background 0.15s;
	}

	.dismiss-btn:hover {
		background: var(--btn-bg-hover, rgba(255,255,255,0.1));
	}
</style>
