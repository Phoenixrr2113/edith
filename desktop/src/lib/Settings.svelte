<script lang="ts">
	import { settingsStore } from './settings.js';
	import { setTheme, type ThemeMode } from './theme.js';
	import OllamaStatus from './OllamaStatus.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	// Local draft — committed on blur; $effects keep drafts in sync with store
	let wsUrlDraft = $state(settingsStore.value.wsUrl);
	let wsTokenDraft = $state(settingsStore.value.wsToken);
	let ollamaUrlDraft = $state(settingsStore.value.ollamaUrl);

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
	<aside class="panel" class:open role="dialog" aria-label="Settings" aria-modal="true">
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

		</div>
	</aside>
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
</style>
