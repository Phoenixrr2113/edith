<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		text: string;
		onDismiss: () => void;
		autoFadeMs?: number;
	}

	let { text, onDismiss, autoFadeMs = 5000 }: Props = $props();

	let visible = $state(false);
	let fading = $state(false);

	function dismiss() {
		fading = true;
		setTimeout(() => {
			onDismiss();
		}, 300);
	}

	onMount(() => {
		// Trigger slide-in on next frame
		requestAnimationFrame(() => {
			visible = true;
		});

		const timer = setTimeout(() => {
			dismiss();
		}, autoFadeMs);

		return () => clearTimeout(timer);
	});
</script>

<button
	class="bubble"
	class:visible
	class:fading
	onclick={dismiss}
	type="button"
	aria-label="Dismiss message"
>
	{text}
</button>

<style>
	.bubble {
		display: block;
		width: 100%;
		max-width: 280px;
		background: rgba(20, 20, 25, 0.88);
		color: #ffffff;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 14px;
		line-height: 1.45;
		padding: 12px 16px;
		border-radius: 12px;
		border: none;
		cursor: pointer;
		text-align: left;
		box-sizing: border-box;

		/* Initial state: invisible and shifted down */
		opacity: 0;
		transform: translateY(8px);
		transition:
			opacity 0.25s ease,
			transform 0.25s ease;
	}

	.bubble.visible {
		opacity: 1;
		transform: translateY(0);
	}

	.bubble.fading {
		opacity: 0;
		transform: translateY(-4px);
		transition:
			opacity 0.3s ease,
			transform 0.3s ease;
	}

	.bubble:hover {
		background: rgba(30, 30, 38, 0.92);
	}
</style>
