/**
 * Piper TTS offline fallback.
 *
 * Piper is a fast offline neural TTS engine (< 100ms on M-series Mac).
 * This module supports the HTTP server approach via piper-http-server:
 *   POST http://localhost:5000/api/tts  { text: string }  → audio/wav
 *
 * Detection falls back gracefully — never throws.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_PIPER_URL = "http://localhost:5000";
const DETECT_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PiperStatus {
	available: boolean;
	lastChecked: number;
}

// ── Internal cache ────────────────────────────────────────────────────────────

let _cached: (PiperStatus & { fetchedAt: number }) | null = null;

function isCacheValid(): boolean {
	if (!_cached) return false;
	return Date.now() - _cached.fetchedAt < CACHE_TTL_MS;
}

function cacheStatus(status: PiperStatus): void {
	_cached = { ...status, fetchedAt: Date.now() };
}

/** Invalidate the Piper status cache (e.g. on network reconnect). */
export function invalidatePiperCache(): void {
	_cached = null;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Probe the piper-http-server health endpoint.
 * Returns true if the server responds with HTTP 200 on GET /health or /.
 * Never throws.
 */
export async function detectPiper(
	baseUrl: string = DEFAULT_PIPER_URL,
	options: { useCache?: boolean } = {}
): Promise<PiperStatus> {
	const useCache = options.useCache ?? true;
	if (useCache && isCacheValid() && _cached) {
		return { available: _cached.available, lastChecked: _cached.lastChecked };
	}

	try {
		// piper-http-server exposes GET /health (or falls back to GET /)
		// Each path gets its own controller+timeout so an abort on one path
		// doesn't cancel the next.
		let ok = false;
		for (const path of ["/health", "/"]) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
			try {
				const res = await fetch(`${baseUrl}${path}`, {
					method: "GET",
					signal: controller.signal,
				});
				clearTimeout(timeout);
				if (res.ok) {
					ok = true;
					break;
				}
			} catch {
				clearTimeout(timeout);
				// try next path
			}
		}

		const status: PiperStatus = { available: ok, lastChecked: Date.now() };
		cacheStatus(status);
		return status;
	} catch {
		const status: PiperStatus = { available: false, lastChecked: Date.now() };
		cacheStatus(status);
		return status;
	}
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

/**
 * Synthesize `text` via the local piper-http-server.
 * Returns a base64-encoded WAV string, or throws on failure.
 *
 * Expects POST /api/tts  → audio/wav  (piper-http-server default route).
 */
export async function synthesize(
	text: string,
	baseUrl: string = DEFAULT_PIPER_URL
): Promise<string> {
	const res = await fetch(`${baseUrl}/api/tts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});

	if (!res.ok) {
		throw new Error(`Piper TTS request failed: ${res.status} ${res.statusText}`);
	}

	const arrayBuffer = await res.arrayBuffer();
	const uint8 = new Uint8Array(arrayBuffer);
	let binary = "";
	for (let i = 0; i < uint8.length; i++) {
		binary += String.fromCharCode(uint8[i]);
	}
	return btoa(binary);
}

// ── Reactive state (Svelte 5 $state) ─────────────────────────────────────────

/**
 * Reactive Piper availability store.
 *
 * Usage in a Svelte component:
 *   import { piperStatus, refreshPiperStatus } from '$lib/tts-piper.js';
 *   // piperStatus.value.available — reactive
 */
export const piperStatus = (() => {
	let _s = $state<PiperStatus>({ available: false, lastChecked: 0 });

	return {
		get value(): PiperStatus {
			return _s;
		},
		_set(next: PiperStatus): void {
			_s = next;
		},
	};
})();

/**
 * Check Piper and update reactive state.
 * Called by PiperStatus.svelte on mount and periodically.
 */
export async function refreshPiperStatus(baseUrl?: string): Promise<PiperStatus> {
	const status = await detectPiper(baseUrl, { useCache: false });
	piperStatus._set(status);
	return status;
}

/** Convenience derived — is Piper reachable right now? */
export function isPiperAvailable(): boolean {
	return piperStatus.value.available;
}
