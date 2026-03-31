<script lang="ts">
	import { onMount } from 'svelte';

	// ── Types ──────────────────────────────────────────────────────────────────

	export type BubbleType = 'message' | 'progress' | 'error' | 'typing';

	interface Props {
		text?: string;
		type?: BubbleType;
		onDismiss: () => void;
		autoFadeMs?: number;
	}

	let { text = '', type = 'message', onDismiss, autoFadeMs = 5000 }: Props = $props();

	// ── State ──────────────────────────────────────────────────────────────────

	let visible = $state(false);
	let fading = $state(false);

	// ── Actions ────────────────────────────────────────────────────────────────

	function dismiss() {
		fading = true;
		setTimeout(() => {
			onDismiss();
		}, 300);
	}

	// ── Markdown-lite renderer ─────────────────────────────────────────────────
	// Handles: **bold**, `inline code`, ```code blocks```, [text](url)
	// No external deps — pure regex transforms into safe HTML.

	function renderMarkdown(raw: string): string {
		// Escape HTML entities first to prevent injection
		let s = raw
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');

		// Fenced code blocks (```...```)
		s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

		// Inline code (`...`)
		s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

		// Bold (**...**)
		s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

		// Links ([text](url)) — only allow http/https
		s = s.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
			'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
		);

		// Newlines → <br>
		s = s.replace(/\n/g, '<br>');

		return s;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	onMount(() => {
		requestAnimationFrame(() => {
			visible = true;
		});

		// typing bubbles never auto-fade — they persist until replaced
		if (type === 'typing') return;

		const timer = setTimeout(() => {
			dismiss();
		}, autoFadeMs);

		return () => clearTimeout(timer);
	});
</script>

<div class="bubble-wrap" class:visible class:fading>
	<!-- Character avatar -->
	<div class="avatar" aria-hidden="true">
		<span class="avatar-letter">E</span>
	</div>

	<!-- Speech bubble -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bubble"
		class:bubble--message={type === 'message'}
		class:bubble--progress={type === 'progress'}
		class:bubble--error={type === 'error'}
		class:bubble--typing={type === 'typing'}
		onclick={dismiss}
		role="presentation"
	>
		<!-- Tail triangle (points toward avatar on the left) -->
		<span class="bubble-tail" aria-hidden="true"></span>

		{#if type === 'typing'}
			<span class="typing-dots" aria-label="Edith is thinking">
				<span class="dot"></span>
				<span class="dot"></span>
				<span class="dot"></span>
			</span>
		{:else if type === 'progress'}
			<span class="progress-row">
				<span class="spinner" aria-hidden="true"></span>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<span class="bubble-text">{@html renderMarkdown(text)}</span>
			</span>
		{:else}
			<!-- message | error -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<span class="bubble-text">{@html renderMarkdown(text)}</span>
		{/if}

		{#if type !== 'typing'}
			<button
				class="close-btn"
				onclick={(e) => { e.stopPropagation(); dismiss(); }}
				type="button"
				aria-label="Close"
			>×</button>
		{/if}
	</div>
</div>

<style>
	/* ── Wrapper ────────────────────────────────────────────────────────────── */

	.bubble-wrap {
		display: flex;
		flex-direction: row;
		align-items: flex-end;
		gap: 8px;
		width: 100%;
		max-width: 320px;

		opacity: 0;
		transform: translateY(8px);
		transition:
			opacity 0.25s ease,
			transform 0.25s ease;
	}

	.bubble-wrap.visible {
		opacity: 1;
		transform: translateY(0);
	}

	.bubble-wrap.fading {
		opacity: 0;
		transform: translateY(-4px);
		transition:
			opacity 0.3s ease,
			transform 0.3s ease;
	}

	/* ── Avatar ─────────────────────────────────────────────────────────────── */

	.avatar {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: linear-gradient(135deg, #6b73ff 0%, #9b59b6 100%);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 2px 8px rgba(107, 115, 255, 0.4);
	}

	.avatar-letter {
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 16px;
		font-weight: 600;
		color: #ffffff;
		line-height: 1;
	}

	/* ── Bubble base ────────────────────────────────────────────────────────── */

	.bubble {
		position: relative;
		flex: 1;
		min-width: 0;
		background: var(--bubble-bg);
		color: var(--text-color);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 13.5px;
		line-height: 1.5;
		padding: 10px 32px 10px 14px;
		border-radius: 12px;
		border: 1px solid var(--bubble-border);
		cursor: pointer;
		text-align: left;
		box-sizing: border-box;
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		transition: background 0.15s ease;
	}

	.bubble:hover {
		background: var(--bubble-bg-hover);
	}

	/* ── Tail triangle (points left toward avatar) ──────────────────────────── */

	.bubble-tail {
		position: absolute;
		left: -7px;
		bottom: 12px;
		width: 0;
		height: 0;
		border-top: 6px solid transparent;
		border-bottom: 6px solid transparent;
		border-right: 8px solid var(--bubble-bg);
	}

	/* ── Bubble type variants ───────────────────────────────────────────────── */

	.bubble--message {
		/* default — no override needed */
	}

	.bubble--progress {
		background: var(--bubble-bg);
		border-color: rgba(107, 115, 255, 0.25);
	}

	.bubble--progress .bubble-tail {
		border-right-color: var(--bubble-bg);
	}

	.bubble--error {
		background: var(--bubble-error-bg, rgba(40, 15, 18, 0.92));
		border-color: rgba(220, 60, 70, 0.35);
		color: var(--bubble-error-text, #ffb8bc);
	}

	.bubble--error .bubble-tail {
		border-right-color: var(--bubble-error-bg, rgba(40, 15, 18, 0.92));
	}

	.bubble--typing {
		background: var(--bubble-bg);
		padding: 12px 14px;
		cursor: default;
	}

	/* ── Close button ───────────────────────────────────────────────────────── */

	.close-btn {
		position: absolute;
		top: 6px;
		right: 8px;
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.3);
		font-size: 15px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 4px;
		transition: color 0.15s ease;
	}

	.close-btn:hover {
		color: rgba(255, 255, 255, 0.75);
	}

	/* ── Bubble text (markdown-rendered) ────────────────────────────────────── */

	.bubble-text :global(strong) {
		color: #ffffff;
		font-weight: 600;
	}

	.bubble-text :global(code) {
		font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
		font-size: 12px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 3px;
		padding: 1px 5px;
	}

	.bubble-text :global(pre) {
		margin: 6px 0 2px;
		padding: 8px 10px;
		background: rgba(0, 0, 0, 0.35);
		border-radius: 6px;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.bubble-text :global(pre code) {
		background: none;
		padding: 0;
		font-size: 12px;
	}

	.bubble-text :global(a) {
		color: #8b9eff;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.bubble-text :global(a:hover) {
		color: #aab8ff;
	}

	/* ── Progress row ───────────────────────────────────────────────────────── */

	.progress-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	/* ── Spinner ────────────────────────────────────────────────────────────── */

	.spinner {
		flex-shrink: 0;
		width: 14px;
		height: 14px;
		border: 2px solid rgba(107, 115, 255, 0.25);
		border-top-color: rgba(107, 115, 255, 0.85);
		border-radius: 50%;
		animation: spin 0.75s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* ── Typing dots ────────────────────────────────────────────────────────── */

	.typing-dots {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 2px 0;
	}

	.typing-dots .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: rgba(180, 180, 200, 0.75);
		animation: bounce 1.2s ease-in-out infinite;
	}

	.typing-dots .dot:nth-child(1) { animation-delay: 0s; }
	.typing-dots .dot:nth-child(2) { animation-delay: 0.2s; }
	.typing-dots .dot:nth-child(3) { animation-delay: 0.4s; }

	@keyframes bounce {
		0%, 60%, 100% {
			transform: translateY(0);
			opacity: 0.55;
		}
		30% {
			transform: translateY(-5px);
			opacity: 1;
		}
	}
</style>
