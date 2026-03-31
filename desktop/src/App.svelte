<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import SpeechBubble from './lib/SpeechBubble.svelte';
	import { EdithWsClient, type ConnectionState } from './lib/ws-client.js';

	// Configurable via Vite env — falls back to localhost for dev
	const WS_URL: string = import.meta.env?.VITE_WS_URL ?? 'ws://localhost:8080/ws';
	const WS_TOKEN: string = import.meta.env?.VITE_WS_TOKEN ?? '';

	const MAX_BUBBLES = 3;

	interface Message {
		id: number;
		text: string;
	}

	let messages = $state<Message[]>([]);
	let nextId = 0;
	let connectionState = $state<ConnectionState>('disconnected');

	const STATUS_LABEL: Record<ConnectionState, string> = {
		disconnected: 'Disconnected',
		connecting: 'Connecting…',
		authenticating: 'Authenticating…',
		connected: 'Connected',
		reconnecting: 'Reconnecting…',
	};

	const STATUS_COLOR: Record<ConnectionState, string> = {
		disconnected: '#666',
		connecting: '#f0a500',
		authenticating: '#f0a500',
		connected: '#4caf50',
		reconnecting: '#f0a500',
	};

	const MOCK_MESSAGES = [
		"You have a meeting with Chris in 15 minutes.",
		"Your flight to Austin departs in 3 hours — time to head out.",
		"Pull request #42 was merged.",
		"Reminder: pick up the kids at 3pm.",
	];

	function addTestMessage() {
		if (messages.length >= MAX_BUBBLES) return;
		const text = MOCK_MESSAGES[nextId % MOCK_MESSAGES.length];
		messages = [...messages, { id: nextId++, text }];
	}

	function removeMessage(id: number) {
		messages = messages.filter((m) => m.id !== id);
	}

	// WebSocket client
	const wsClient = new EdithWsClient();
	const unsubs: Array<() => void> = [];

	onMount(() => {
		unsubs.push(
			wsClient.on('stateChange', (state) => {
				connectionState = state;
			})
		);

		unsubs.push(
			wsClient.on('message', (msg) => {
				if (msg.type === 'message') {
					messages = [...messages.slice(-(MAX_BUBBLES - 1)), { id: nextId++, text: msg.text }];
				}
			})
		);

		unsubs.push(
			wsClient.on('error', (err) => {
				console.error('[App] WS server error:', err.code, err.message);
			})
		);

		wsClient.connect(WS_URL, WS_TOKEN);
	});

	onDestroy(() => {
		for (const unsub of unsubs) unsub();
		wsClient.disconnect();
	});
</script>

<main>
	<div class="bubble-stack">
		{#each messages as msg (msg.id)}
			<SpeechBubble
				text={msg.text}
				onDismiss={() => removeMessage(msg.id)}
				autoFadeMs={5000}
			/>
		{/each}
	</div>

	<div class="controls">
		<button class="test-btn" onclick={addTestMessage} type="button">
			+ Test Message
		</button>
		<div class="status">
			<span class="dot" style="background: {STATUS_COLOR[connectionState]};"></span>
			<span class="status-label">{STATUS_LABEL[connectionState]}</span>
		</div>
	</div>
</main>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		background: transparent;
		color: #e0e0e0;
	}

	main {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		justify-content: flex-end;
		min-height: 100vh;
		padding: 16px;
		box-sizing: border-box;
	}

	.bubble-stack {
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-end;
		width: 100%;
		max-width: 280px;
		margin-bottom: 12px;
	}

	.test-btn {
		background: rgba(255, 255, 255, 0.08);
		color: rgba(255, 255, 255, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 8px;
		padding: 6px 12px;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.test-btn:hover {
		background: rgba(255, 255, 255, 0.14);
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-label {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.4);
	}
</style>
