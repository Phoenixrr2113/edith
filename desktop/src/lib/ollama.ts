/**
 * Ollama detection utilities for local LLM fallback.
 *
 * Detection only — actual inference comes in a later task (TAURI-FALLBACK-115).
 * Uses the Ollama REST API health endpoint. No Tauri commands required.
 */

export interface OllamaModel {
	name: string;
	/** Size in bytes, if available */
	size?: number;
}

export interface OllamaStatus {
	/** Whether the Ollama daemon is reachable */
	running: boolean;
	/** Available models (empty when not running) */
	models: OllamaModel[];
	/** Timestamp of last successful check (ms since epoch), or 0 if never */
	lastChecked: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Default Ollama base URL. Overridden by settingsStore.ollamaUrl at runtime. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

// ── Internal cache ────────────────────────────────────────────────────────────

/** Cache TTL: 5 minutes (per spec). */
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cached: (OllamaStatus & { fetchedAt: number }) | null = null;

function isCacheValid(): boolean {
	if (!_cached) return false;
	return Date.now() - _cached.fetchedAt < CACHE_TTL_MS;
}

/** Invalidate the status cache (e.g. on network reconnect). */
export function invalidateOllamaCache(): void {
	_cached = null;
}

// ── Core detection ────────────────────────────────────────────────────────────

/**
 * Fetch model list from the Ollama daemon at `baseUrl`.
 * Returns an OllamaStatus. Never throws — errors map to { running: false }.
 */
export async function detectOllama(
	baseUrl: string = DEFAULT_OLLAMA_URL,
	options: { useCache?: boolean } = {}
): Promise<OllamaStatus> {
	const useCache = options.useCache ?? true;
	if (useCache && isCacheValid() && _cached) {
		return { running: _cached.running, models: _cached.models, lastChecked: _cached.lastChecked };
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);

		const res = await fetch(`${baseUrl}/api/tags`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});

		clearTimeout(timeout);

		if (!res.ok) {
			const status = notRunning();
			cacheStatus(status);
			return status;
		}

		const json = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
		const models: OllamaModel[] = (json.models ?? []).map((m) => ({
			name: m.name,
			size: m.size,
		}));

		const status: OllamaStatus = { running: true, models, lastChecked: Date.now() };
		cacheStatus(status);
		return status;
	} catch {
		const status = notRunning();
		cacheStatus(status);
		return status;
	}
}

/**
 * Return just the available model names when Ollama is running.
 * Returns an empty array if not reachable.
 */
export async function getOllamaModels(
	baseUrl: string = DEFAULT_OLLAMA_URL
): Promise<OllamaModel[]> {
	const status = await detectOllama(baseUrl);
	return status.models;
}

// ── Reactive state (Svelte 5 $state) ─────────────────────────────────────────

function notRunning(): OllamaStatus {
	return { running: false, models: [], lastChecked: Date.now() };
}

function cacheStatus(status: OllamaStatus): void {
	_cached = { ...status, fetchedAt: Date.now() };
}

/**
 * Reactive Ollama availability store.
 *
 * Usage in a Svelte component:
 *   import { ollamaStatus, refreshOllamaStatus } from '$lib/ollama.js';
 *   // ollamaStatus.value.running — reactive
 */
export const ollamaStatus = (() => {
	let _s = $state<OllamaStatus>({ running: false, models: [], lastChecked: 0 });

	return {
		get value(): OllamaStatus {
			return _s;
		},
		_set(next: OllamaStatus): void {
			_s = next;
		},
	};
})();

/**
 * Check Ollama and update reactive state.
 * Called by OllamaStatus.svelte on mount and periodically.
 */
export async function refreshOllamaStatus(baseUrl?: string): Promise<OllamaStatus> {
	const status = await detectOllama(baseUrl, { useCache: false });
	ollamaStatus._set(status);
	return status;
}

/** Convenience derived — is Ollama reachable right now? */
export function isOllamaAvailable(): boolean {
	return ollamaStatus.value.running;
}
