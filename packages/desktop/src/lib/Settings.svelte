<script lang="ts">
	import { settingsStore } from './settings.svelte.js';
	import { setTheme, type ThemeMode } from './theme.svelte.js';
	import { audioCapture } from './audio-capture.js';
	import type { AudioCaptureMode } from './audio-capture.js';
	import OllamaStatus from './OllamaStatus.svelte';
	import PiperStatus from './PiperStatus.svelte';
	import CacheStatus from './CacheStatus.svelte';
	import { localCache, type CacheKey } from './local-cache.js';
	import CaptureHistory from './CaptureHistory.svelte';
	import { captureStore } from './capture-store.js';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	// Local draft — committed on blur; $effects keep drafts in sync with store
	let wsUrlDraft = $state(settingsStore.value.wsUrl);
	let wsTokenDraft = $state(settingsStore.value.wsToken);
	let ollamaUrlDraft = $state(settingsStore.value.ollamaUrl);
	let cartesiaApiKeyDraft = $state(settingsStore.value.cartesiaApiKey);
	let cartesiaVoiceIdDraft = $state(settingsStore.value.cartesiaVoiceId);
	let groqApiKeyDraft = $state(settingsStore.value.groqApiKey);
	let geminiApiKeyDraft = $state(settingsStore.value.geminiApiKey);

	function handleThemeChange(mode: ThemeMode) {
		settingsStore.update('theme', mode);
		setTheme(mode);
	}

	function handleSoundsChange(e: Event) {
		settingsStore.update('notificationSounds', (e.target as HTMLInputElement).checked);
	}

	function handleAutoFadeChange(e: Event) {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!isNaN(val) && val >= 500 && val <= 60000) {
			settingsStore.update('autoFadeMs', val);
		}
	}

	function handleWsUrlBlur() {
		if (wsUrlDraft.trim()) {
			settingsStore.update('wsUrl', wsUrlDraft.trim());
		}
	}

	function handleWsTokenBlur() {
		settingsStore.update('wsToken', wsTokenDraft);
	}

	function handleOllamaUrlBlur() {
		if (ollamaUrlDraft.trim()) {
			settingsStore.update('ollamaUrl', ollamaUrlDraft.trim());
		}
	}

	function handleTtsEnabledChange(e: Event) {
		settingsStore.update('ttsEnabled', (e.target as HTMLInputElement).checked);
	}

	function handleTtsProviderChange(e: Event) {
		const val = (e.target as HTMLSelectElement).value as 'cartesia' | 'piper' | 'none';
		settingsStore.update('ttsProvider', val);
	}

	function handleCartesiaApiKeyBlur() {
		settingsStore.update('cartesiaApiKey', cartesiaApiKeyDraft);
	}

	function handleCartesiaVoiceIdBlur() {
		settingsStore.update('cartesiaVoiceId', cartesiaVoiceIdDraft.trim());
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) onClose();
	}

	function handleOverlayClick(e: MouseEvent) {
		if ((e.target as HTMLElement).classList.contains('overlay')) onClose();
	}

	// Keep drafts in sync if settings change externally
	$effect(() => {
		wsUrlDraft = settingsStore.value.wsUrl;
	});
	$effect(() => {
		wsTokenDraft = settingsStore.value.wsToken;
	});
	$effect(() => {
		ollamaUrlDraft = settingsStore.value.ollamaUrl;
	});
	$effect(() => {
		cartesiaApiKeyDraft = settingsStore.value.cartesiaApiKey;
	});
	$effect(() => {
		cartesiaVoiceIdDraft = settingsStore.value.cartesiaVoiceId;
	});
	$effect(() => {
		groqApiKeyDraft = settingsStore.value.groqApiKey;
	});
	$effect(() => {
		geminiApiKeyDraft = settingsStore.value.geminiApiKey;
	});

	function handleSttEnabledChange(e: Event) {
		settingsStore.update('sttEnabled', (e.target as HTMLInputElement).checked);
	}

	function handleGroqApiKeyBlur() {
		settingsStore.update('groqApiKey', groqApiKeyDraft);
	}

	function handleGeminiEnabledChange(e: Event) {
		settingsStore.update('geminiEnabled', (e.target as HTMLInputElement).checked);
	}

	function handleGeminiApiKeyBlur() {
		settingsStore.update('geminiApiKey', geminiApiKeyDraft);
	}

	// Audio capture handlers
	function handleAudioCaptureEnabledChange(e: Event) {
		const enabled = (e.target as HTMLInputElement).checked;
		settingsStore.update('audioCaptureEnabled', enabled);
		if (!enabled && audioCapture.isActive) {
			audioCapture.stopAudioCapture();
		}
	}

	function handleAudioCaptureModeChange(e: Event) {
		const mode = (e.target as HTMLSelectElement).value as AudioCaptureMode;
		settingsStore.update('audioCaptureMode', mode);
		// Restart capture with new mode if currently active
		if (audioCapture.isActive) {
			audioCapture.stopAudioCapture();
			audioCapture.startAudioCapture({ mode }).catch((err) => {
				console.error('[Settings] Audio capture restart failed:', err);
			});
		}
	}

	function handleAudioCaptureBufferSecsChange(e: Event) {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!isNaN(val) && val >= 5 && val <= 120) {
			settingsStore.update('audioCaptureBufferSecs', val);
			audioCapture.updateOptions({ bufferSecs: val });
		}
	}

	// Screen capture handlers
	function handleScreenCaptureEnabledChange(e: Event) {
		settingsStore.update('screenCaptureEnabled', (e.target as HTMLInputElement).checked);
	}

	function handleScreenCaptureIntervalChange(e: Event) {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!isNaN(val) && val >= 500 && val <= 60000) {
			settingsStore.update('screenCaptureIntervalMs', val);
		}
	}

	// Used to force CacheStatus to re-render after clear
	let cacheRevision = $state(0);

	function handleClearCaches() {
		localCache.clear();
		cacheRevision += 1;
	}

	function handleCacheRefresh(_key: CacheKey) {
		// Refresh is fulfilled externally by requesting a sync from the server.
		// For now, just delete the stale entry so UI reflects "Not cached".
		localCache.delete(_key);
		cacheRevision += 1;
	}

	// Capture storage settings
	function handleMaxCapturesChange(e: Event) {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!isNaN(val) && val >= 5 && val <= 200) {
			settingsStore.update('maxCaptures', val);
			captureStore.updateSettings({ maxCaptures: val });
		}
	}

	function handleAutoDeleteCapturesChange(e: Event) {
		const enabled = (e.target as HTMLInputElement).checked;
		settingsStore.update('autoDeleteCaptures', enabled);
		captureStore.updateSettings({ autoDelete: enabled });
	}

	function handleCaptureRetentionHoursChange(e: Event) {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!isNaN(val) && val >= 1 && val <= 48) {
			settingsStore.update('captureRetentionHours', val);
			captureStore.updateSettings({ captureRetentionHours: val });
		}
	}

	function handleClearCaptures() {
		captureStore.clearAll();
		captureHistoryRevision += 1;
	}

	let captureHistoryRevision = $state(0);
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="overlay"
	class:open
	onclick={handleOverlayClick}
	aria-hidden={!open}
>
	<div class="panel" class:open role="dialog" aria-label="Settings" aria-modal="true">
		<header class="panel-header">
			<span class="panel-title">Settings</span>
			<button class="close-btn" onclick={onClose} type="button" aria-label="Close settings">✕</button>
		</header>

		<div class="panel-body">

			<!-- Theme -->
			<section class="section">
				<div class="section-label">Appearance</div>
				<div class="theme-options">
					{#each (['dark', 'light', 'system'] as ThemeMode[]) as mode}
						<button
							type="button"
							class="theme-btn"
							class:active={settingsStore.value.theme === mode}
							onclick={() => handleThemeChange(mode)}
						>
							{mode === 'dark' ? '🌙 Dark' : mode === 'light' ? '☀️ Light' : '⚙️ System'}
						</button>
					{/each}
				</div>
			</section>

			<div class="separator"></div>

			<!-- Notification sounds -->
			<section class="section">
				<div class="section-label">Notifications</div>
				<label class="toggle-row">
					<span class="toggle-label">Notification sounds</span>
					<span class="toggle-track" class:on={settingsStore.value.notificationSounds}>
						<input
							type="checkbox"
							checked={settingsStore.value.notificationSounds}
							onchange={handleSoundsChange}
							aria-label="Notification sounds"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
			</section>

			<div class="separator"></div>

			<!-- Auto-fade duration -->
			<section class="section">
				<div class="section-label">Message Display</div>
				<label class="field-row">
					<span class="field-label">Auto-fade after</span>
					<div class="input-suffix">
						<input
							type="number"
							class="number-input"
							min="500"
							max="60000"
							step="500"
							value={settingsStore.value.autoFadeMs}
							onchange={handleAutoFadeChange}
							aria-label="Auto-fade duration in milliseconds"
						/>
						<span class="suffix">ms</span>
					</div>
				</label>
			</section>

			<div class="separator"></div>

			<!-- WebSocket URL -->
			<section class="section">
				<div class="section-label">Connection</div>
				<label class="field-col">
					<span class="field-label">WebSocket URL</span>
					<input
						type="text"
						class="text-input"
						bind:value={wsUrlDraft}
						onblur={handleWsUrlBlur}
						placeholder="ws://localhost:8080/ws"
						aria-label="WebSocket server URL"
					/>
				</label>
				<label class="field-col" style="margin-top: 10px;">
					<span class="field-label">Auth token</span>
					<input
						type="password"
						class="text-input"
						bind:value={wsTokenDraft}
						onblur={handleWsTokenBlur}
						placeholder="optional"
						aria-label="WebSocket auth token"
					/>
				</label>
			</section>

			<div class="separator"></div>

			<!-- Ollama (local LLM) -->
			<section class="section">
				<div class="section-label">Local AI (Ollama)</div>
				<label class="field-col" style="margin-bottom: 10px;">
					<span class="field-label">Ollama URL</span>
					<input
						type="text"
						class="text-input"
						bind:value={ollamaUrlDraft}
						onblur={handleOllamaUrlBlur}
						placeholder="http://localhost:11434"
						aria-label="Ollama base URL"
					/>
				</label>
				<OllamaStatus />
			</section>

			<div class="separator"></div>

			<!-- Voice (TTS) -->
			<section class="section">
				<div class="section-label">Voice (TTS)</div>
				<label class="toggle-row" style="margin-bottom: 10px;">
					<span class="toggle-label">Enable text-to-speech</span>
					<span class="toggle-track" class:on={settingsStore.value.ttsEnabled}>
						<input
							type="checkbox"
							checked={settingsStore.value.ttsEnabled}
							onchange={handleTtsEnabledChange}
							aria-label="Enable text-to-speech"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
				{#if settingsStore.value.ttsEnabled}
					<label class="field-col" style="margin-bottom: 10px;">
						<span class="field-label">Provider</span>
						<select
							class="text-input"
							value={settingsStore.value.ttsProvider}
							onchange={handleTtsProviderChange}
							aria-label="TTS provider"
						>
							<option value="cartesia">Cartesia (cloud)</option>
							<option value="piper">Piper (local)</option>
							<option value="none">None</option>
						</select>
					</label>
					{#if settingsStore.value.ttsProvider === 'cartesia'}
						<label class="field-col" style="margin-bottom: 10px;">
							<span class="field-label">Cartesia API key</span>
							<input
								type="password"
								class="text-input"
								bind:value={cartesiaApiKeyDraft}
								onblur={handleCartesiaApiKeyBlur}
								placeholder="sk-..."
								aria-label="Cartesia API key"
							/>
						</label>
						<label class="field-col">
							<span class="field-label">Voice ID <span style="color: var(--text-muted); font-weight: 400;">(optional)</span></span>
							<input
								type="text"
								class="text-input"
								bind:value={cartesiaVoiceIdDraft}
								onblur={handleCartesiaVoiceIdBlur}
								placeholder="leave blank for default"
								aria-label="Cartesia voice ID"
							/>
						</label>
					{:else if settingsStore.value.ttsProvider === 'piper'}
						<PiperStatus />
					{/if}
				{/if}
			</section>

			<div class="separator"></div>

			<!-- Voice Input (STT) -->
			<section class="section">
				<div class="section-label">Voice Input (STT)</div>
				<label class="toggle-row" style="margin-bottom: 10px;">
					<span class="toggle-label">Enable voice input</span>
					<span class="toggle-track" class:on={settingsStore.value.sttEnabled}>
						<input
							type="checkbox"
							checked={settingsStore.value.sttEnabled}
							onchange={handleSttEnabledChange}
							aria-label="Enable voice input"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
				{#if settingsStore.value.sttEnabled}
					<label class="field-col">
						<span class="field-label">Groq API key</span>
						<input
							type="password"
							class="text-input"
							bind:value={groqApiKeyDraft}
							onblur={handleGroqApiKeyBlur}
							placeholder="gsk_..."
							aria-label="Groq API key for Whisper STT"
						/>
					</label>
					<p style="font-size: 11px; color: var(--text-muted); margin: 6px 0 0;">
						Uses Groq Whisper for ~300ms transcription.
					</p>
				{/if}
			</section>

			<div class="separator"></div>

			<!-- Audio Capture -->
			<section class="section">
				<div class="section-label">Audio Capture</div>
				<label class="toggle-row" style="margin-bottom: 10px;">
					<span class="toggle-label">Enable ambient audio capture</span>
					<span class="toggle-track" class:on={settingsStore.value.audioCaptureEnabled}>
						<input
							type="checkbox"
							checked={settingsStore.value.audioCaptureEnabled}
							onchange={handleAudioCaptureEnabledChange}
							aria-label="Enable ambient audio capture"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
				{#if settingsStore.value.audioCaptureEnabled}
					<label class="field-col" style="margin-bottom: 10px;">
						<span class="field-label">Source</span>
						<select
							class="text-input"
							value={settingsStore.value.audioCaptureMode}
							onchange={handleAudioCaptureModeChange}
							aria-label="Audio capture source"
						>
							<option value="microphone">Microphone</option>
							<option value="system">System audio (screen recording)</option>
						</select>
					</label>
					<label class="field-row">
						<span class="field-label">Buffer</span>
						<div class="input-suffix">
							<input
								type="number"
								class="number-input"
								min="5"
								max="120"
								step="5"
								value={settingsStore.value.audioCaptureBufferSecs}
								onchange={handleAudioCaptureBufferSecsChange}
								aria-label="Audio buffer duration in seconds"
							/>
							<span class="suffix">sec</span>
						</div>
					</label>
					{#if settingsStore.value.audioCaptureMode === 'system'}
						<p style="font-size: 11px; color: var(--text-muted); margin: 6px 0 0;">
							Requires screen recording permission in macOS System Settings.
						</p>
					{/if}
				{/if}
			</section>

			<div class="separator"></div>

			<!-- Screen Capture -->
			<section class="section">
				<div class="section-label">Screen Capture</div>
				<label class="toggle-row" style="margin-bottom: 10px;">
					<span class="toggle-label">Enable screen capture</span>
					<span class="toggle-track" class:on={settingsStore.value.screenCaptureEnabled}>
						<input
							type="checkbox"
							checked={settingsStore.value.screenCaptureEnabled}
							onchange={handleScreenCaptureEnabledChange}
							aria-label="Enable screen capture"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
				{#if settingsStore.value.screenCaptureEnabled}
					<label class="field-row">
						<span class="field-label">Capture every</span>
						<div class="input-suffix">
							<input
								type="number"
								class="number-input"
								min="500"
								max="60000"
								step="500"
								value={settingsStore.value.screenCaptureIntervalMs}
								onchange={handleScreenCaptureIntervalChange}
								aria-label="Screen capture interval in milliseconds"
							/>
							<span class="suffix">ms</span>
						</div>
					</label>
					<p style="font-size: 11px; color: var(--text-muted); margin: 6px 0 0;">
						Requires Screen Recording permission in macOS System Settings.
					</p>
				{/if}
			</section>

			<div class="separator"></div>

			<!-- Gemini Screen Understanding -->
			<section class="section">
				<div class="section-label">Screen Understanding (Gemini)</div>
				<label class="toggle-row" style="margin-bottom: 10px;">
					<span class="toggle-label">Enable Gemini analysis</span>
					<span class="toggle-track" class:on={settingsStore.value.geminiEnabled}>
						<input
							type="checkbox"
							checked={settingsStore.value.geminiEnabled}
							onchange={handleGeminiEnabledChange}
							aria-label="Enable Gemini screen understanding"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
				{#if settingsStore.value.geminiEnabled}
					<label class="field-col">
						<span class="field-label">Google AI API key</span>
						<input
							type="password"
							class="text-input"
							bind:value={geminiApiKeyDraft}
							onblur={handleGeminiApiKeyBlur}
							placeholder="AIza..."
							aria-label="Google Generative AI API key"
						/>
					</label>
					<p style="font-size: 11px; color: var(--text-muted); margin: 6px 0 0;">
						Uses Gemini 2.0 Flash. Requires Screen Capture to be enabled.
					</p>
				{/if}
			</section>

			<div class="separator"></div>

			<!-- Capture Storage -->
			<section class="section">
				<div class="section-label">Capture Storage</div>
				<label class="toggle-row" style="margin-bottom: 10px;">
					<span class="toggle-label">Auto-delete old captures</span>
					<span class="toggle-track" class:on={settingsStore.value.autoDeleteCaptures}>
						<input
							type="checkbox"
							checked={settingsStore.value.autoDeleteCaptures}
							onchange={handleAutoDeleteCapturesChange}
							aria-label="Auto-delete old captures"
						/>
						<span class="toggle-thumb"></span>
					</span>
				</label>
				<label class="field-row" style="margin-bottom: 10px;">
					<span class="field-label">Keep per type</span>
					<div class="input-suffix">
						<input
							type="number"
							class="number-input"
							min="5"
							max="200"
							step="5"
							value={settingsStore.value.maxCaptures}
							onchange={handleMaxCapturesChange}
							aria-label="Max captures per type"
						/>
					</div>
				</label>
				{#if settingsStore.value.autoDeleteCaptures}
					<label class="field-row" style="margin-bottom: 10px;">
						<span class="field-label">Retain for</span>
						<div class="input-suffix">
							<input
								type="number"
								class="number-input"
								min="1"
								max="48"
								step="1"
								value={settingsStore.value.captureRetentionHours}
								onchange={handleCaptureRetentionHoursChange}
								aria-label="Capture retention in hours"
							/>
							<span class="suffix">hr</span>
						</div>
					</label>
				{/if}
				<p style="font-size: 11px; color: var(--text-muted); margin: 0 0 10px;">
					Max 10 MB total. Oldest captures pruned first.
				</p>
				{#key captureHistoryRevision}
					<CaptureHistory count={10} />
				{/key}
				<button
					class="clear-cache-btn"
					type="button"
					onclick={handleClearCaptures}
					style="margin-top: 12px;"
				>
					Clear all captures
				</button>
			</section>

			<div class="separator"></div>

			<!-- Cache -->
			<section class="section">
				<div class="section-label">Offline Cache</div>
				{#key cacheRevision}
					<CacheStatus onRefresh={handleCacheRefresh} />
				{/key}
				<button
					class="clear-cache-btn"
					type="button"
					onclick={handleClearCaches}
					style="margin-top: 12px;"
				>
					Clear all caches
				</button>
			</section>

		</div>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		pointer-events: none;
		/* No backdrop — window is transparent/frameless */
	}

	.overlay.open {
		pointer-events: auto;
	}

	.panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 280px;
		background: var(--panel-bg);
		border-left: 1px solid var(--panel-border);
		display: flex;
		flex-direction: column;
		transform: translateX(100%);
		transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
		overflow: hidden;
	}

	.panel.open {
		transform: translateX(0);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 16px 12px;
		border-bottom: 1px solid var(--separator);
		flex-shrink: 0;
	}

	.panel-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-color);
		letter-spacing: 0.02em;
		text-transform: uppercase;
	}

	.close-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 14px;
		padding: 4px 6px;
		border-radius: 6px;
		line-height: 1;
		transition: color 0.15s, background 0.15s;
	}

	.close-btn:hover {
		color: var(--text-color);
		background: var(--btn-bg-hover);
	}

	.panel-body {
		flex: 1;
		overflow-y: auto;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.panel-body::-webkit-scrollbar {
		width: 4px;
	}

	.panel-body::-webkit-scrollbar-thumb {
		background: var(--scrollbar);
		border-radius: 2px;
	}

	.section {
		padding: 12px 0;
	}

	.section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: 10px;
	}

	.separator {
		height: 1px;
		background: var(--separator);
		margin: 0 -16px;
	}

	/* Theme toggle buttons */
	.theme-options {
		display: flex;
		gap: 6px;
	}

	.theme-btn {
		flex: 1;
		background: var(--btn-bg);
		border: 1px solid var(--input-border);
		color: var(--text-secondary);
		border-radius: 8px;
		padding: 7px 4px;
		font-size: 11px;
		cursor: pointer;
		transition: all 0.15s ease;
		text-align: center;
	}

	.theme-btn:hover {
		background: var(--btn-bg-hover);
		color: var(--text-color);
	}

	.theme-btn.active {
		background: var(--btn-bg-active);
		border-color: var(--accent);
		color: var(--text-color);
	}

	/* Toggle switch */
	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: pointer;
	}

	.toggle-label {
		font-size: 13px;
		color: var(--text-color);
	}

	.toggle-track {
		position: relative;
		width: 36px;
		height: 20px;
		border-radius: 10px;
		background: var(--toggle-track);
		transition: background 0.2s ease;
		flex-shrink: 0;
	}

	.toggle-track.on {
		background: var(--toggle-track-on);
	}

	.toggle-track input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-thumb {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--toggle-thumb);
		transition: transform 0.2s ease;
		pointer-events: none;
	}

	.toggle-track.on .toggle-thumb {
		transform: translateX(16px);
	}

	/* Field rows */
	.field-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.field-col {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.field-label {
		font-size: 13px;
		color: var(--text-color);
	}

	.input-suffix {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.number-input {
		width: 72px;
		background: var(--input-bg);
		border: 1px solid var(--input-border);
		border-radius: 6px;
		color: var(--text-color);
		font-size: 13px;
		padding: 5px 8px;
		text-align: right;
		outline: none;
		transition: border-color 0.15s;
		-moz-appearance: textfield;
	}

	.number-input:focus {
		border-color: var(--input-border-focus);
	}

	.number-input::-webkit-inner-spin-button,
	.number-input::-webkit-outer-spin-button {
		opacity: 0.5;
	}

	.suffix {
		font-size: 11px;
		color: var(--text-muted);
	}

	.text-input {
		width: 100%;
		background: var(--input-bg);
		border: 1px solid var(--input-border);
		border-radius: 6px;
		color: var(--text-color);
		font-size: 12px;
		padding: 6px 8px;
		outline: none;
		transition: border-color 0.15s;
		box-sizing: border-box;
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
	}

	.text-input:focus {
		border-color: var(--input-border-focus);
	}

	.text-input::placeholder {
		color: var(--text-muted);
	}

	.clear-cache-btn {
		width: 100%;
		background: var(--btn-bg);
		border: 1px solid var(--input-border);
		color: var(--text-secondary);
		border-radius: 8px;
		padding: 7px 12px;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
		text-align: center;
	}

	.clear-cache-btn:hover {
		background: var(--btn-bg-hover);
		color: var(--text-color);
	}
</style>
