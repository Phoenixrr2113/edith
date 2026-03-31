<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import SpeechBubble, { type BubbleType } from './lib/SpeechBubble.svelte';
	import WorkerProgress from './lib/WorkerProgress.svelte';
	import Settings from './lib/Settings.svelte';
	import { EdithWsClient, type ConnectionState } from './lib/ws-client.js';
	import { addWorker, updateWorker, removeWorker } from './lib/stores.js';
	import { settingsStore } from './lib/settings.js';
	import { initTheme } from './lib/theme.js';

	const MAX_BUBBLES = 3;

	interface Message {
		id: number;
		text: string;
		type: BubbleType;
		autoFadeMs?: number;
	}

	let messages = $state<Message[]>([]);
	let nextId = 0;
	let connectionState = $state<ConnectionState>('disconnected');
	/** True while the agent is in 'thinking' or 'working' state */
	let agentTyping = $state(false);
	let settingsOpen = $state(false);

	const STATUS_LABEL: Record<ConnectionState, string> = {
		disconnected: 'Disconnected',
		connecting: 'Connecting…',
		authenticating: 'Authenticating…',
		connected: 'Connected',
		reconnecting: 'Reconnecting…',
	};

	const STATUS_COLOR: Record<ConnectionState, string> = {
		disconnected: 'var(--dot-disconnected, #666)',
		connecting: 'var(--dot-connecting, #f0a500)',
		authenticating: 'var(--dot-connecting, #f0a500)',
		connected: 'var(--dot-connected, #4caf50)',
		reconnecting: 'var(--dot-connecting, #f0a500)',
	};

	const MOCK_MESSAGES: Array<{ text: string; type: BubbleType }> = [
		{ text: 'You have a meeting with **Chris** in 15 minutes.', type: 'message' },
		{ text: 'Your flight to Austin departs in 3 hours — time to head out.', type: 'message' },
		{ text: '**Error:** Could not reach the calendar server.', type: 'error' },
		{ text: 'Reminder: pick up the kids at 3pm.', type: 'message' },
	];

	let mockIdx = 0;

	function addTestMessage() {
		if (messages.length >= MAX_BUBBLES) return;
		const mock = MOCK_MESSAGES[mockIdx % MOCK_MESSAGES.length];
		mockIdx++;
		messages = [...messages, { id: nextId++, text: mock.text, type: mock.type }];
	}

	function toggleTestTyping() {
		agentTyping = !agentTyping;
	}

	function removeMessage(id: number) {
		messages = messages.filter((m) => m.id !== id);
	}

	// WebSocket client
	const wsClient = new EdithWsClient();
	const unsubs: Array<() => void> = [];

	onMount(() => {
		// Initialize theme system (applies data-theme, starts system listener)
		const cleanupTheme = initTheme();
		unsubs.push(cleanupTheme);

		unsubs.push(
			wsClient.on('stateChange', (state) => {
				connectionState = state;
			})
		);

		unsubs.push(
			wsClient.on('message', (msg) => {
				if (msg.type === 'message') {
					messages = [
						...messages.slice(-(MAX_BUBBLES - 1)),
						{ id: nextId++, text: msg.text, type: 'message' as BubbleType },
					];
				} else if (msg.type === 'state') {
					agentTyping = msg.state === 'thinking' || msg.state === 'working';
				} else if (msg.type === 'error') {
					messages = [
						...messages.slice(-(MAX_BUBBLES - 1)),
						{ id: nextId++, text: msg.message, type: 'error' as BubbleType },
					];
				} else if (msg.type === 'progress') {
					const { taskId, description, status } = msg;
					if (status === 'started') {
						addWorker(taskId, description);
					} else if (status === 'progress') {
						updateWorker(taskId, { label: description });
					} else if (status === 'complete') {
						updateWorker(taskId, { status: 'complete' });
						setTimeout(() => removeWorker(taskId), 1000);
					} else if (status === 'failed') {
						updateWorker(taskId, { status: 'failed' });
						setTimeout(() => removeWorker(taskId), 3000);
					}
				}
			})
		);

		unsubs.push(
			wsClient.on('error', (err) => {
				console.error('[App] WS server error:', err.code, err.message);
			})
		);

		wsClient.connect(settingsStore.value.wsUrl, settingsStore.value.wsToken);
	});

	onDestroy(() => {
		for (const unsub of unsubs) unsub();
		wsClient.disconnect();
	});
</script>

<main>
	<div class="bubble-stack">
		{#if agentTyping}
			<SpeechBubble
				type="typing"
				onDismiss={() => { agentTyping = false; }}
			/>
		{/if}
		{#each messages as msg (msg.id)}
			<SpeechBubble
				text={msg.text}
				type={msg.type}
				onDismiss={() => removeMessage(msg.id)}
				autoFadeMs={msg.autoFadeMs ?? settingsStore.value.autoFadeMs}
			/>
		{/each}
	</div>

	<WorkerProgress />

	<div class="controls">
		<button class="test-btn" onclick={addTestMessage} type="button">
			+ Message
		</button>
		<button class="test-btn" onclick={toggleTestTyping} type="button">
			{agentTyping ? 'Stop' : 'Typing…'}
		</button>
		<div class="status">
			<span class="dot" style="background: {STATUS_COLOR[connectionState]};"></span>
			<span class="status-label">{STATUS_LABEL[connectionState]}</span>
		</div>
		<button
			class="gear-btn"
			onclick={() => (settingsOpen = !settingsOpen)}
			type="button"
			aria-label="Open settings"
			aria-pressed={settingsOpen}
		>⚙</button>
	</div>
</main>

<Settings open={settingsOpen} onClose={() => (settingsOpen = false)} />

<style>
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		background: transparent;
		color: var(--text-color);
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
		max-width: 320px;
		margin-bottom: 12px;
	}

	.test-btn {
		background: var(--btn-bg);
		color: var(--text-secondary);
		border: 1px solid var(--input-border);
		border-radius: 8px;
		padding: 6px 12px;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.test-btn:hover {
		background: var(--btn-bg-hover);
	}

	:global(.worker-progress) {
		margin-bottom: 8px;
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
		color: var(--text-muted);
	}

	.gear-btn {
		background: var(--btn-bg);
		border: 1px solid var(--input-border);
		color: var(--text-secondary);
		border-radius: 8px;
		padding: 5px 8px;
		font-size: 14px;
		cursor: pointer;
		line-height: 1;
		transition: background 0.15s, color 0.15s;
	}

	.gear-btn:hover {
		background: var(--btn-bg-hover);
		color: var(--text-color);
	}

	.gear-btn[aria-pressed="true"] {
		background: var(--btn-bg-active);
		border-color: var(--accent);
		color: var(--text-color);
	}
</style>
