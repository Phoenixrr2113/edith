<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import SpeechBubble, { type BubbleType } from './lib/SpeechBubble.svelte';
	import WorkerProgress from './lib/WorkerProgress.svelte';
	import Settings from './lib/Settings.svelte';
	import { EdithWsClient, type ConnectionState, type WsAudioMessage } from './lib/ws-client.js';
	import { connectionModeManager, type ConnectionMode } from './lib/connection-state.js';
	import ConnectionStatus from './lib/ConnectionStatus.svelte';
	import { addWorker, updateWorker, removeWorker } from './lib/stores.svelte.js';
	import { settingsStore } from './lib/settings.svelte.js';
	import { initTheme } from './lib/theme.svelte.js';
	import Onboarding from './lib/Onboarding.svelte';
	import AudioPlayer from './lib/AudioPlayer.svelte';
	import { playAudio, stopAudio } from './lib/audio.js';
	import { speak } from './lib/tts.js';
	import TaskQueueStatus from './lib/TaskQueueStatus.svelte';
	import { taskQueue } from './lib/task-queue.svelte.js';
	import type { QueuedTask } from './lib/task-queue.svelte.js';
	import { SyncManager, type SyncStatus as SyncStatusType } from './lib/sync.js';
	import SyncStatus from './lib/SyncStatus.svelte';
	import VoiceInput from './lib/VoiceInput.svelte';
	import { audioCapture } from './lib/audio-capture.js';
	import {
		startPeriodicCapture,
		stopPeriodicCapture,
		onScreenFrame,
		isCaptureActive,
	} from './lib/screen-capture.js';
	import { StreamManager } from './lib/stream-to-cloud.js';
	import { ScreenTriggerEngine } from './lib/screen-triggers.js';
	import { sendToGemini } from './lib/gemini-bridge.js';
	import UpdateNotification from './lib/UpdateNotification.svelte';
	import {
		checkForUpdate,
		startPeriodicCheck,
		stopPeriodicCheck,
		onUpdateAvailable,
		type UpdateInfo,
	} from './lib/updater.js';
	import { listen } from '@tauri-apps/api/event';
	import RiveCharacter, { type AgentState } from './lib/RiveCharacter.svelte';

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
	/** Controls visible via right-click on character */
	let controlsVisible = $state(false);

	// Dynamic window resizing for settings panel
	async function resizeWindow(width: number, height: number): Promise<void> {
		try {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			const { LogicalSize } = await import('@tauri-apps/api/dpi');
			const win = getCurrentWindow();
			await win.setSize(new LogicalSize(width, height));
		} catch {
			// Not in Tauri
		}
	}

	$effect(() => {
		if (settingsOpen) {
			resizeWindow(360, 500);
		} else {
			resizeWindow(200, 200);
		}
	});
	/** True while TTS audio is playing */
	let audioPlaying = $state(false);

	// ── Rive character state ──────────────────────────────────────────────────
	let characterState = $derived<AgentState>(
		connectionState !== 'connected'
			? 'offline'
			: messages.some((m) => m.type === 'error')
				? 'error'
				: agentTyping
					? 'thinking'
					: messages.length > 0
						? 'talking'
						: 'idle'
	);

	// ── Onboarding ────────────────────────────────────────────────────────────
	/** Show onboarding when: never completed, OR wsUrl/wsToken are missing */
	function needsOnboarding(): boolean {
		try {
			const done = localStorage.getItem('edith-onboarding-complete');
			if (done === 'true') {
				// Still show if critical settings are missing
				const s = settingsStore.value;
				return !s.wsUrl || !s.wsToken;
			}
		} catch {
			// ignore
		}
		return true;
	}
	let onboardingVisible = $state(false); // TODO: restore needsOnboarding() after testing

	function handleOnboardingComplete(): void {
		onboardingVisible = false;
		// Reconnect WS with potentially new settings
		wsClient.disconnect();
		wsClient.connect(settingsStore.value.wsUrl, settingsStore.value.wsToken);
	}
	/** Non-null when an update is available */
	let pendingUpdate = $state<UpdateInfo | null>(null);

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

	// Stream manager: batches + compresses screen frames before sending to cloud
	const streamManager = new StreamManager(wsClient, audioCapture, {
		batchIntervalMs: 5_000,
		maxImageWidth: 800,
		maxQueuedFrames: 3,
	});

	// Sync manager
	const syncManager = new SyncManager(wsClient);
	let syncStatus = $state<SyncStatusType>(syncManager.status);
	let lastSyncAt = $state<number | null>(syncManager.lastSyncAt);

	// React to settings changes — start/stop capture when toggles change
	$effect(() => {
		void settingsStore.value.screenCaptureEnabled;
		void settingsStore.value.screenCaptureIntervalMs;
		syncScreenCapture().catch((err) => console.warn('[App] syncScreenCapture (effect):', err));
	});

	$effect(() => {
		void settingsStore.value.audioCaptureEnabled;
		void settingsStore.value.audioCaptureMode;
		void settingsStore.value.audioCaptureBufferSecs;
		syncAudioCapture().catch((err) => console.warn('[App] syncAudioCapture (effect):', err));
	});

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
					// If the message requests TTS, synthesize and speak it
					if (msg.speak) {
						speak(msg.text).catch((err) => {
							console.error('[App] TTS speak error:', err);
						});
					}
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

		// ── Auto-updater ──────────────────────────────────────────────────────────
		// Listen for the Rust-side `update-available` event (fired ~5s after launch)
		listen<UpdateInfo>('update-available', (event) => {
			pendingUpdate = event.payload;
		}).then((unlisten) => unsubs.push(unlisten)).catch(() => {});

		// Also wire the JS-side updater callbacks (for manual/periodic checks)
		unsubs.push(onUpdateAvailable((info) => { pendingUpdate = info; }));

		// Kick off an initial check and start periodic 6-hour re-checks
		checkForUpdate().catch(() => {});
		startPeriodicCheck();
		unsubs.push(stopPeriodicCheck);

		// Start ambient audio capture if enabled in settings
		syncAudioCapture().catch((err) => console.warn('[App] syncAudioCapture:', err));

		// Start screen capture if enabled in settings
		syncScreenCapture().catch((err) => console.warn('[App] syncScreenCapture:', err));
	});

	// ── Audio capture lifecycle ─────────────────────────────────────────────────

	/** Start/restart ambient audio capture based on current settings. */
	async function syncAudioCapture(): Promise<void> {
		const { audioCaptureEnabled, audioCaptureMode, audioCaptureBufferSecs } = settingsStore.value;

		if (audioCaptureEnabled && !audioCapture.isActive) {
			try {
				await audioCapture.startAudioCapture({
					mode: audioCaptureMode,
					bufferSecs: audioCaptureBufferSecs,
				});
			} catch (err) {
				console.warn('[App] Audio capture start failed:', err);
			}
		} else if (!audioCaptureEnabled && audioCapture.isActive) {
			audioCapture.stopAudioCapture();
		}
	}

	// ── Screen capture lifecycle ────────────────────────────────────────────────

	let _screenFrameUnsub: (() => void) | null = null;
	let _triggerEngine: ScreenTriggerEngine | null = null;
	let _triggerUnsub: (() => void) | null = null;
	/** Prevent concurrent Gemini requests */
	let _geminiInFlight = false;

	/**
	 * Handle a significant-change or app-switched trigger:
	 * send the frame to Gemini for understanding, then forward
	 * the structured context to the cloud via WS.
	 */
	async function handleTrigger(imageData: string): Promise<void> {
		if (_geminiInFlight) return;
		const { geminiEnabled, geminiApiKey } = settingsStore.value;
		if (!geminiEnabled || !geminiApiKey?.trim()) return;

		_geminiInFlight = true;
		try {
			const ctx = await sendToGemini(imageData);
			wsClient.send({
				type: 'screen_context',
				summary: ctx.activity,
				imageData,
				apps: ctx.apps,
				confidence: ctx.confidence,
				ts: Date.now(),
			});
		} catch (err) {
			console.warn('[App] Gemini bridge error:', err);
		} finally {
			_geminiInFlight = false;
		}
	}

	/** Start/stop periodic screen capture based on current settings. */
	async function syncScreenCapture(): Promise<void> {
		const { screenCaptureEnabled, screenCaptureIntervalMs } = settingsStore.value;

		if (screenCaptureEnabled && !isCaptureActive()) {
			try {
				// Create a fresh trigger engine for this capture session.
				_triggerEngine = new ScreenTriggerEngine({
					significantChangeThreshold: 0.15,
					appSwitchThreshold: 0.40,
					debounceMs: 3_000,
				});

				// On significant-change or app-switch → run Gemini understanding.
				// Keep last frame data available via closure.
				let _lastFrameData = '';
				_triggerUnsub = _triggerEngine.on((evt) => {
					if (evt.type === 'significant-change' || evt.type === 'app-switched') {
						handleTrigger(_lastFrameData).catch(() => {});
					}
				});

				// Subscribe to frames before starting.
				_screenFrameUnsub = onScreenFrame((frame) => {
					_lastFrameData = frame.data;

					// Always feed frames to the trigger engine for diff analysis.
					_triggerEngine?.processFrame(frame.data, frame.ts);

					// Batch frames through StreamManager (resizes + attaches audio).
					// When Gemini is enabled the trigger handler sends enriched payloads;
					// StreamManager handles the ambient/raw stream in both cases.
					streamManager.pushFrame(frame);
				});

				streamManager.start();
				await startPeriodicCapture(screenCaptureIntervalMs);
			} catch (err) {
				console.warn('[App] Screen capture start failed:', err);
				streamManager.stop();
				_screenFrameUnsub?.();
				_screenFrameUnsub = null;
				_triggerUnsub?.();
				_triggerUnsub = null;
				_triggerEngine?.destroy();
				_triggerEngine = null;
			}
		} else if (!screenCaptureEnabled && isCaptureActive()) {
			streamManager.stop();
			await stopPeriodicCapture();
			_screenFrameUnsub?.();
			_screenFrameUnsub = null;
			_triggerUnsub?.();
			_triggerUnsub = null;
			_triggerEngine?.destroy();
			_triggerEngine = null;
		}
	}

	/** Send a voice-transcribed message to the orchestrator via WebSocket. */
	function handleVoiceTranscript(text: string) {
		if (!text.trim()) return;
		wsClient.send({
			type: 'input',
			text: text.trim(),
			source: 'voice',
			deviceId: 'desktop',
			ts: Date.now(),
		});
	}

	onDestroy(() => {
		for (const unsub of unsubs) unsub();
		wsClient.disconnect();
		stopAudio();
		audioCapture.stopAudioCapture();
		streamManager.stop();
		stopPeriodicCapture().catch(() => {});
		_screenFrameUnsub?.();
		_screenFrameUnsub = null;
		_triggerUnsub?.();
		_triggerUnsub = null;
		_triggerEngine?.destroy();
		_triggerEngine = null;
	});
</script>

{#if onboardingVisible}
	<Onboarding onComplete={handleOnboardingComplete} />
{/if}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<main
	oncontextmenu={(e) => { e.preventDefault(); controlsVisible = !controlsVisible; }}
	onclick={() => { if (controlsVisible) controlsVisible = false; }}
>
	<RiveCharacter agentState={characterState} size={180} />

	{#if controlsVisible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="context-menu" onclick={(e) => e.stopPropagation()}>
		<button class="menu-item" onclick={() => { settingsOpen = true; controlsVisible = false; }} type="button">
			⚙️ Settings
		</button>
		<div class="menu-sep"></div>
		<span class="menu-status">
			{connMode === 'cloud' ? '🟢' : connMode === 'local' ? '🟡' : '⚫'} {connMode}
		</span>
	</div>
	{/if}
</main>

{#if settingsOpen}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="settings-overlay" onclick={() => (settingsOpen = false)}>
	<div class="settings-card" onclick={(e) => e.stopPropagation()}>
		<Settings open={settingsOpen} onClose={() => (settingsOpen = false)} />
	</div>
</div>
{/if}

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
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: 0;
		margin: 0;
		overflow: hidden;
	}

	.bubble-stack {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: center;
		width: 100%;
		max-width: 280px;
		margin: 0;
	}

	.settings-overlay {
		position: fixed;
		inset: 0;
		background: rgba(20, 20, 25, 0.95);
		z-index: 20000;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}

	.settings-card {
		flex: 1;
		padding: 8px;
	}

	:global(.worker-progress) {
		margin-bottom: 8px;
	}

	.context-menu {
		position: absolute;
		bottom: 8px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		background: rgba(30, 30, 35, 0.95);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 10px;
		padding: 4px;
		min-width: 160px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
		z-index: 10000;
	}

	.menu-item {
		background: none;
		border: none;
		color: #e0e0e0;
		font-size: 13px;
		padding: 8px 12px;
		text-align: left;
		cursor: pointer;
		border-radius: 6px;
		transition: background 0.1s;
	}

	.menu-item:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.menu-sep {
		height: 1px;
		background: rgba(255, 255, 255, 0.08);
		margin: 4px 8px;
	}

	.menu-status {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.4);
		padding: 4px 12px 6px;
		text-transform: capitalize;
	}

</style>
