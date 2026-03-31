/**
 * Settings store for the Edith desktop app.
 *
 * All settings persist to localStorage. No Tauri-plugin-store dependency —
 * localStorage is sufficient for the current app scope and avoids the
 * extra Rust/Cargo setup.
 */

export interface DesktopSettings {
	/** Theme mode */
	theme: "dark" | "light" | "system";
	/** WebSocket server URL */
	wsUrl: string;
	/** WebSocket auth token */
	wsToken: string;
	/** Play a sound when a notification arrives */
	notificationSounds: boolean;
	/** How long (ms) before a speech bubble auto-fades */
	autoFadeMs: number;
	/** Ollama base URL for local LLM fallback */
	ollamaUrl: string;
	/** Whether text-to-speech is enabled */
	ttsEnabled: boolean;
	/** Active TTS provider */
	ttsProvider: "cartesia" | "piper" | "none";
	/** Cartesia API key */
	cartesiaApiKey: string;
	/** Cartesia voice ID (empty = use default) */
	cartesiaVoiceId: string;
	/** Groq API key used for Whisper STT transcription */
	groqApiKey: string;
	/** Whether voice input (STT) is enabled */
	sttEnabled: boolean;
}

const STORAGE_KEY = "edith-settings";

const DEFAULTS: DesktopSettings = {
	theme: "system",
	wsUrl: import.meta.env?.VITE_WS_URL ?? "ws://localhost:8080/ws",
	wsToken: import.meta.env?.VITE_WS_TOKEN ?? "",
	notificationSounds: true,
	autoFadeMs: 5000,
	ollamaUrl: "http://localhost:11434",
	ttsEnabled: false,
	ttsProvider: "cartesia",
	cartesiaApiKey: "",
	cartesiaVoiceId: "",
	groqApiKey: "",
	sttEnabled: false,
};

// ── Load / save ───────────────────────────────────────────────────────────────

function load(): DesktopSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
			return { ...DEFAULTS, ...parsed };
		}
	} catch {
		// ignore
	}
	return { ...DEFAULTS };
}

function save(s: DesktopSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
	} catch {
		// ignore
	}
}

// ── Reactive settings store (Svelte 5 $state) ─────────────────────────────────

export const settingsStore = (() => {
	let _s = $state<DesktopSettings>(load());

	return {
		get value(): DesktopSettings {
			return _s;
		},
		update<K extends keyof DesktopSettings>(key: K, val: DesktopSettings[K]): void {
			_s = { ..._s, [key]: val };
			save(_s);
		},
		reset(): void {
			_s = { ...DEFAULTS };
			save(_s);
		},
	};
})();
