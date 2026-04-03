<script lang="ts">
	import { settingsStore } from './settings.svelte.js';

	interface Props {
		onComplete: () => void;
	}

	let { onComplete }: Props = $props();

	// Steps: 0=welcome, 1=cloud, 2=apikeys, 3=permissions, 4=done
	let step = $state(0);
	let error = $state('');

	// Step 1 — Cloud connection
	let wsUrlDraft = $state(settingsStore.value.wsUrl || 'ws://localhost:8080/ws');
	let wsTokenDraft = $state(settingsStore.value.wsToken || '');
	let connectionTesting = $state(false);
	let connectionOk = $state<boolean | null>(null);

	// Step 2 — API keys
	let groqKeyDraft = $state(settingsStore.value.groqApiKey || '');
	let cartesiaKeyDraft = $state(settingsStore.value.cartesiaApiKey || '');
	let geminiKeyDraft = $state(settingsStore.value.geminiApiKey || '');

	// Step 3 — Permissions
	let screenGranted = $state(false);
	let micGranted = $state(false);
	let permissionsChecking = $state(false);

	const TOTAL_STEPS = 5;

	function progress(): number {
		return Math.round((step / (TOTAL_STEPS - 1)) * 100);
	}

	// ── Step validation ──────────────────────────────────────────────────────────

	function canProceed(): boolean {
		switch (step) {
			case 0: return true;
			case 1: return wsUrlDraft.trim().length > 0 && wsTokenDraft.trim().length > 0;
			case 2: return true; // API keys are optional individually but at least one should be set
			case 3: return true; // Permissions are best-effort on first run
			case 4: return true;
			default: return false;
		}
	}

	// ── Step 1: Test WebSocket connection ────────────────────────────────────────

	async function testConnection(): Promise<void> {
		error = '';
		connectionTesting = true;
		connectionOk = null;

		const url = wsUrlDraft.trim();
		const token = wsTokenDraft.trim();

		if (!url) {
			error = 'Enter a WebSocket URL first.';
			connectionTesting = false;
			return;
		}

		try {
			const wsUrl = new URL(url);
			wsUrl.searchParams.set('token', token);
			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(wsUrl.toString());
				const timeout = setTimeout(() => {
					ws.close();
					reject(new Error('Timed out after 5 seconds'));
				}, 5_000);
				ws.onopen = () => {
					clearTimeout(timeout);
					ws.close(1000);
					resolve();
				};
				ws.onerror = () => {
					clearTimeout(timeout);
					reject(new Error('Connection refused'));
				};
			});
			connectionOk = true;
		} catch (err) {
			connectionOk = false;
			error = err instanceof Error ? err.message : 'Connection failed';
		} finally {
			connectionTesting = false;
		}
	}

	// ── Step 3: Request permissions ──────────────────────────────────────────────

	async function requestScreenPermission(): Promise<void> {
		permissionsChecking = true;
		error = '';
		try {
			// getDisplayMedia triggers the macOS Screen Recording permission prompt
			const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
			stream.getTracks().forEach((t) => t.stop());
			screenGranted = true;
		} catch {
			error = 'Screen recording permission was denied or not available.';
			screenGranted = false;
		} finally {
			permissionsChecking = false;
		}
	}

	async function requestMicPermission(): Promise<void> {
		permissionsChecking = true;
		error = '';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			stream.getTracks().forEach((t) => t.stop());
			micGranted = true;
		} catch {
			error = 'Microphone permission was denied.';
			micGranted = false;
		} finally {
			permissionsChecking = false;
		}
	}

	// ── Navigation ───────────────────────────────────────────────────────────────

	function next(): void {
		error = '';

		if (step === 1) {
			// Save cloud settings
			if (!wsUrlDraft.trim()) {
				error = 'WebSocket URL is required.';
				return;
			}
			settingsStore.update('wsUrl', wsUrlDraft.trim());
			settingsStore.update('wsToken', wsTokenDraft.trim());
		}

		if (step === 2) {
			// Save API keys (any may be empty)
			settingsStore.update('groqApiKey', groqKeyDraft.trim());
			settingsStore.update('cartesiaApiKey', cartesiaKeyDraft.trim());
			settingsStore.update('geminiApiKey', geminiKeyDraft.trim());

			// Auto-enable features when keys are provided
			if (groqKeyDraft.trim()) settingsStore.update('sttEnabled', true);
			if (cartesiaKeyDraft.trim()) {
				settingsStore.update('ttsEnabled', true);
				settingsStore.update('ttsProvider', 'cartesia');
			}
			if (geminiKeyDraft.trim()) settingsStore.update('geminiEnabled', true);
		}

		if (step === 3) {
			// Enable captures based on granted permissions
			if (screenGranted) settingsStore.update('screenCaptureEnabled', true);
			if (micGranted) settingsStore.update('audioCaptureEnabled', true);
		}

		if (step < TOTAL_STEPS - 1) {
			step += 1;
		}
	}

	function back(): void {
		error = '';
		if (step > 0) step -= 1;
	}

	function finish(): void {
		// Mark onboarding complete so App.svelte won't show it again
		try {
			localStorage.setItem('edith-onboarding-complete', 'true');
		} catch {
			// ignore
		}
		onComplete();
	}

	// ── Helpers ──────────────────────────────────────────────────────────────────

	const STEP_TITLES = [
		'Welcome to Edith',
		'Connect to Cloud',
		'API Keys',
		'Permissions',
		'Ready',
	];
</script>

<div class="onboarding-overlay">
	<div class="onboarding-card" role="dialog" aria-modal="true" aria-label={STEP_TITLES[step]}>
		<!-- Progress bar -->
		<div class="progress-bar" aria-hidden="true">
			<div class="progress-fill" style="width: {progress()}%"></div>
		</div>

		<!-- Step indicator -->
		<p class="step-indicator">{step + 1} / {TOTAL_STEPS}</p>

		<!-- ── Step 0: Welcome ─────────────────────────────────────────────── -->
		{#if step === 0}
			<div class="step">
				<div class="step-icon">👋</div>
				<h1>Welcome to Edith</h1>
				<p class="subtitle">
					Your AI assistant that lives on your desktop. Let's get you set up in a few quick steps.
				</p>
				<ul class="checklist">
					<li>Connect to your Edith cloud server</li>
					<li>Add API keys for voice and AI features</li>
					<li>Grant screen and microphone permissions</li>
				</ul>
			</div>

		<!-- ── Step 1: Cloud connection ───────────────────────────────────── -->
		{:else if step === 1}
			<div class="step">
				<div class="step-icon">🔗</div>
				<h1>Connect to Cloud</h1>
				<p class="subtitle">Enter your Edith cloud server address and auth token.</p>

				<label class="field-label" for="wsUrl">WebSocket URL</label>
				<input
					id="wsUrl"
					class="field-input"
					type="url"
					placeholder="ws://your-server:8080/ws"
					bind:value={wsUrlDraft}
					autocomplete="off"
					spellcheck="false"
				/>

				<label class="field-label" for="wsToken">Auth Token</label>
				<input
					id="wsToken"
					class="field-input"
					type="password"
					placeholder="Paste your token here"
					bind:value={wsTokenDraft}
					autocomplete="off"
				/>

				<button
					class="test-btn"
					type="button"
					onclick={testConnection}
					disabled={connectionTesting || !wsUrlDraft.trim() || !wsTokenDraft.trim()}
				>
					{connectionTesting ? 'Testing…' : 'Test Connection'}
				</button>

				{#if connectionOk === true}
					<p class="status-ok">✓ Connected successfully</p>
				{:else if connectionOk === false}
					<p class="status-err">✗ {error || 'Could not connect'}</p>
				{/if}
			</div>

		<!-- ── Step 2: API keys ────────────────────────────────────────────── -->
		{:else if step === 2}
			<div class="step">
				<div class="step-icon">🔑</div>
				<h1>API Keys</h1>
				<p class="subtitle">
					Add keys to enable voice and AI features. You can skip any and add them later in Settings.
				</p>

				<label class="field-label" for="groqKey">
					Groq API Key <span class="badge">STT / Whisper</span>
				</label>
				<input
					id="groqKey"
					class="field-input"
					type="password"
					placeholder="gsk_…"
					bind:value={groqKeyDraft}
					autocomplete="off"
				/>

				<label class="field-label" for="cartesiaKey">
					Cartesia API Key <span class="badge">TTS / Voice</span>
				</label>
				<input
					id="cartesiaKey"
					class="field-input"
					type="password"
					placeholder="sk-…"
					bind:value={cartesiaKeyDraft}
					autocomplete="off"
				/>

				<label class="field-label" for="geminiKey">
					Gemini API Key <span class="badge">Screen AI</span>
				</label>
				<input
					id="geminiKey"
					class="field-input"
					type="password"
					placeholder="AIza…"
					bind:value={geminiKeyDraft}
					autocomplete="off"
				/>
			</div>

		<!-- ── Step 3: Permissions ─────────────────────────────────────────── -->
		{:else if step === 3}
			<div class="step">
				<div class="step-icon">🛡️</div>
				<h1>Permissions</h1>
				<p class="subtitle">
					Edith needs access to your screen and microphone to see context and hear you.
				</p>

				<div class="permission-row">
					<div class="permission-info">
						<strong>Screen Recording</strong>
						<span class="perm-desc">So Edith can understand what you're working on</span>
					</div>
					{#if screenGranted}
						<span class="perm-granted">✓ Granted</span>
					{:else}
						<button
							class="perm-btn"
							type="button"
							onclick={requestScreenPermission}
							disabled={permissionsChecking}
						>
							Allow
						</button>
					{/if}
				</div>

				<div class="permission-row">
					<div class="permission-info">
						<strong>Microphone</strong>
						<span class="perm-desc">So Edith can hear voice commands</span>
					</div>
					{#if micGranted}
						<span class="perm-granted">✓ Granted</span>
					{:else}
						<button
							class="perm-btn"
							type="button"
							onclick={requestMicPermission}
							disabled={permissionsChecking}
						>
							Allow
						</button>
					{/if}
				</div>

				{#if error}
					<p class="status-err">{error}</p>
				{/if}

				<p class="skip-note">You can grant these later in System Settings → Privacy.</p>
			</div>

		<!-- ── Step 4: Done ────────────────────────────────────────────────── -->
		{:else if step === 4}
			<div class="step">
				<div class="step-icon">🎉</div>
				<h1>You're all set!</h1>
				<p class="subtitle">Edith is ready. She'll stay in your corner, out of the way until you need her.</p>
				<ul class="checklist">
					{#if settingsStore.value.wsUrl}
						<li>✓ Cloud connected to {settingsStore.value.wsUrl}</li>
					{/if}
					{#if settingsStore.value.sttEnabled}
						<li>✓ Voice input enabled (Groq / Whisper)</li>
					{/if}
					{#if settingsStore.value.ttsEnabled}
						<li>✓ Text-to-speech enabled (Cartesia)</li>
					{/if}
					{#if settingsStore.value.geminiEnabled}
						<li>✓ Screen AI enabled (Gemini)</li>
					{/if}
					{#if screenGranted}
						<li>✓ Screen recording permission granted</li>
					{/if}
					{#if micGranted}
						<li>✓ Microphone permission granted</li>
					{/if}
				</ul>
			</div>
		{/if}

		<!-- Error banner (for steps other than 1/3 which show inline) -->
		{#if error && step !== 1 && step !== 3}
			<p class="status-err">{error}</p>
		{/if}

		<!-- Navigation buttons -->
		<div class="nav-row">
			{#if step > 0 && step < TOTAL_STEPS - 1}
				<button class="nav-btn secondary" type="button" onclick={back}>Back</button>
			{:else}
				<div></div>
			{/if}

			{#if step === TOTAL_STEPS - 1}
				<button class="nav-btn primary" type="button" onclick={finish}>Get Started</button>
			{:else}
				<button
					class="nav-btn primary"
					type="button"
					onclick={next}
					disabled={!canProceed()}
				>
					{step === 0 ? 'Get Started' : 'Next'}
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.onboarding-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(4px);
	}

	.onboarding-card {
		background: var(--bg-color, #1a1a1a);
		border: 1px solid var(--input-border, rgba(255,255,255,0.12));
		border-radius: 16px;
		width: min(440px, calc(100vw - 32px));
		padding: 28px 28px 24px;
		box-shadow: 0 24px 60px rgba(0,0,0,0.5);
		color: var(--text-color, #e8e8e8);
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.progress-bar {
		height: 3px;
		background: rgba(255,255,255,0.1);
		border-radius: 2px;
		margin-bottom: 8px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent, #7c6af7);
		border-radius: 2px;
		transition: width 0.3s ease;
	}

	.step-indicator {
		font-size: 11px;
		color: var(--text-secondary, rgba(255,255,255,0.4));
		margin: 0 0 20px;
		text-align: right;
	}

	.step {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-height: 280px;
	}

	.step-icon {
		font-size: 36px;
		line-height: 1;
		margin-bottom: 4px;
	}

	h1 {
		font-size: 20px;
		font-weight: 600;
		margin: 0;
		color: var(--text-color, #e8e8e8);
	}

	.subtitle {
		font-size: 13px;
		color: var(--text-secondary, rgba(255,255,255,0.6));
		margin: 0;
		line-height: 1.5;
	}

	.checklist {
		list-style: none;
		padding: 0;
		margin: 4px 0 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.checklist li {
		font-size: 13px;
		color: var(--text-secondary, rgba(255,255,255,0.6));
		padding-left: 4px;
	}

	.field-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary, rgba(255,255,255,0.6));
		margin-top: 4px;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.badge {
		font-size: 10px;
		background: rgba(124,106,247,0.2);
		color: var(--accent, #7c6af7);
		border-radius: 4px;
		padding: 1px 5px;
		font-weight: 400;
	}

	.field-input {
		background: var(--input-bg, rgba(255,255,255,0.06));
		border: 1px solid var(--input-border, rgba(255,255,255,0.12));
		border-radius: 8px;
		color: var(--text-color, #e8e8e8);
		font-size: 13px;
		padding: 8px 10px;
		width: 100%;
		box-sizing: border-box;
		outline: none;
		transition: border-color 0.15s;
	}

	.field-input:focus {
		border-color: var(--accent, #7c6af7);
	}

	.test-btn {
		align-self: flex-start;
		background: var(--btn-bg, rgba(255,255,255,0.08));
		border: 1px solid var(--input-border, rgba(255,255,255,0.12));
		border-radius: 8px;
		color: var(--text-color, #e8e8e8);
		font-size: 12px;
		padding: 6px 14px;
		cursor: pointer;
		margin-top: 4px;
		transition: background 0.15s;
	}

	.test-btn:hover:not(:disabled) {
		background: var(--btn-bg-hover, rgba(255,255,255,0.12));
	}

	.test-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.status-ok {
		font-size: 12px;
		color: #4caf50;
		margin: 2px 0 0;
	}

	.status-err {
		font-size: 12px;
		color: #ef5350;
		margin: 4px 0 0;
	}

	.permission-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px;
		background: var(--input-bg, rgba(255,255,255,0.05));
		border: 1px solid var(--input-border, rgba(255,255,255,0.08));
		border-radius: 10px;
	}

	.permission-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.permission-info strong {
		font-size: 13px;
		font-weight: 500;
	}

	.perm-desc {
		font-size: 11px;
		color: var(--text-secondary, rgba(255,255,255,0.45));
	}

	.perm-granted {
		font-size: 12px;
		color: #4caf50;
		white-space: nowrap;
	}

	.perm-btn {
		background: var(--accent, #7c6af7);
		border: none;
		border-radius: 7px;
		color: #fff;
		font-size: 12px;
		font-weight: 500;
		padding: 5px 14px;
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 0.15s;
	}

	.perm-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.perm-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.skip-note {
		font-size: 11px;
		color: var(--text-secondary, rgba(255,255,255,0.35));
		margin: 4px 0 0;
	}

	.nav-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 24px;
	}

	.nav-btn {
		border-radius: 9px;
		font-size: 13px;
		font-weight: 500;
		padding: 8px 22px;
		cursor: pointer;
		border: 1px solid transparent;
		transition: opacity 0.15s, background 0.15s;
	}

	.nav-btn.primary {
		background: var(--accent, #7c6af7);
		color: #fff;
		border-color: transparent;
	}

	.nav-btn.primary:hover:not(:disabled) {
		opacity: 0.88;
	}

	.nav-btn.primary:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.nav-btn.secondary {
		background: transparent;
		color: var(--text-secondary, rgba(255,255,255,0.55));
		border-color: var(--input-border, rgba(255,255,255,0.15));
	}

	.nav-btn.secondary:hover {
		background: var(--btn-bg, rgba(255,255,255,0.06));
	}
</style>
