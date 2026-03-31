<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import SpeechBubble, { type BubbleType } from './lib/SpeechBubble.svelte';
	import WorkerProgress from './lib/WorkerProgress.svelte';
	import Settings from './lib/Settings.svelte';
	import { EdithWsClient, type ConnectionState, type WsAudioMessage } from './lib/ws-client.js';
	import { connectionModeManager, type ConnectionMode } from './lib/connection-state.js';
	import ConnectionStatus from './lib/ConnectionStatus.svelte';
	import { addWorker, updateWorker, removeWorker } from './lib/stores.js';
	import { settingsStore } from './lib/settings.js';
	import { initTheme } from './lib/theme.js';
	import AudioPlayer from './lib/AudioPlayer.svelte';
	import { playAudio, stopAudio } from './lib/audio.js';
	import TaskQueueStatus from './lib/TaskQueueStatus.svelte';
	import { taskQueue } from './lib/task-queue.js';
	import type { QueuedTask } from './lib/task-queue.js';
	import { SyncManager, type SyncStatus as SyncStatusType } from './lib/sync.js';
	import SyncStatus from './lib/SyncStatus.svelte';

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
	/** True while TTS audio is playing */
	let audioPlaying = $state(false);

	// Connection mode state (cloud / local / offline)
	let connMode = $state<ConnectionMode>(connectionModeManager.mode);
	let ollamaAvailable = $state(connectionModeManager.ollamaAvailable);
	let cloudConnected = $state(connectionModeManager.cloudConnected);
	let manualOverride = $state<ConnectionMode | null>(connectionModeManager.manualOverride);

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

	// Sync manager
	const syncManager = new SyncManager(wsClient);
	let syncStatus = $state<SyncStatusType>(syncManager.status);
	let lastSyncAt = $state<number | null>(syncManager.lastSyncAt);

	onMount(() => {
		// Initialize theme system (applies data-theme, starts system listener)
		const cleanupTheme = initTheme();
		unsubs.push(cleanupTheme);

		// Start sync manager and subscribe to state changes
		syncManager.start();
		unsubs.push(
			syncManager.on('stateChange', (state) => {
				syncStatus = state.status;
				lastSyncAt = state.lastSyncAt;
			})
		);
		unsubs.push(() => syncManager.stop());

		// Start Ollama polling + subscribe to mode changes
		connectionModeManager.start();
		unsubs.push(
			connectionModeManager.on('modeChange', (mode) => {
				connMode = mode;
				manualOverride = connectionModeManager.manualOverride;
			})
		);
		unsubs.push(
			connectionModeManager.on('ollamaChange', (available) => {
				ollamaAvailable = available;
			})
		);
		unsubs.push(() => connectionModeManager.stop());

		unsubs.push(
			wsClient.on('stateChange', (state) => {
				connectionState = state;
			})
		);

		// Wire WS cloud connect/disconnect → ConnectionModeManager
		unsubs.push(
			wsClient.on('cloudConnected', () => {
				cloudConnected = true;
				connectionModeManager.onCloudConnected();
				connMode = connectionModeManager.mode;
				manualOverride = connectionModeManager.manualOverride;

				// Flush any tasks queued while offline
				if (taskQueue.size > 0) {
					agentTyping = true;
					taskQueue.flush(async (task: QueuedTask) => {
						wsClient.send({
							type: 'input',
							text: typeof task.payload === 'string'
								? task.payload
								: JSON.stringify(task.payload),
							source: 'keyboard',
							deviceId: 'desktop',
							ts: task.timestamp,
						});
					}).finally(() => {
						agentTyping = false;
					});
				}
			})
		);
		unsubs.push(
			wsClient.on('cloudDisconnected', () => {
				cloudConnected = false;
				connectionModeManager.onCloudDisconnected();
				connMode = connectionModeManager.mode;
				manualOverride = connectionModeManager.manualOverride;
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
				} else if (msg.type === 'audio') {
					// Only play if notification sounds are enabled
					if (settingsStore.value.notificationSounds) {
						const audioMsg = msg as WsAudioMessage;
						audioPlaying = true;
						playAudio(audioMsg.data, audioMsg.mimeType ?? 'audio/mpeg')
							.catch((err) => {
								console.error('[App] Audio playback error:', err);
							})
							.finally(() => {
								audioPlaying = false;
							});
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
		stopAudio();
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

	<AudioPlayer
		playing={audioPlaying}
		onStop={() => { audioPlaying = false; }}
	/>

	<div class="controls">
		<button class="test-btn" onclick={addTestMessage} type="button">
			+ Message
		</button>
		<button class="test-btn" onclick={toggleTestTyping} type="button">
			{agentTyping ? 'Stop' : 'Typing…'}
		</button>
		<TaskQueueStatus
			queue={taskQueue}
			visible={connMode === 'offline' || connMode === 'local'}
			onClear={() => taskQueue.clear()}
		/>
		<SyncStatus
			status={syncStatus}
			{lastSyncAt}
			onSyncNow={() => syncManager.requestSync()}
		/>
		<ConnectionStatus
			mode={connMode}
			{ollamaAvailable}
			{cloudConnected}
			{manualOverride}
			onForceCloud={() => { connectionModeManager.forceMode('cloud'); connMode = connectionModeManager.mode; manualOverride = connectionModeManager.manualOverride; }}
			onForceLocal={() => { connectionModeManager.forceMode('local'); connMode = connectionModeManager.mode; manualOverride = connectionModeManager.manualOverride; }}
			onForceAuto={() => { connectionModeManager.forceMode(null); connMode = connectionModeManager.mode; manualOverride = connectionModeManager.manualOverride; }}
		/>
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
