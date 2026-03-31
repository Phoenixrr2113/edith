/**
 * local-cache.ts — localStorage-backed cache with TTL support.
 *
 * Provides typed get/set/delete/clear for offline data:
 * schedule, contacts, taskboard, settings.
 *
 * Uses localStorage because bun:sqlite is not available in the Tauri webview.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type CacheKey = "schedule" | "contacts" | "taskboard" | "settings";

export interface CacheEntry<T> {
	data: T;
	cachedAt: number;
	ttlMs: number;
}

// Default TTLs per key (ms)
const DEFAULT_TTL: Record<CacheKey, number> = {
	schedule: 10 * 60 * 1000, // 10 min
	contacts: 60 * 60 * 1000, // 1 hour
	taskboard: 5 * 60 * 1000, // 5 min
	settings: 24 * 60 * 60 * 1000, // 24 hours
};

const STORAGE_PREFIX = "edith_cache_";

// ── LocalCache ────────────────────────────────────────────────────────────────

export class LocalCache {
	private storageKey(key: CacheKey): string {
		return `${STORAGE_PREFIX}${key}`;
	}

	/**
	 * Returns cached data if it exists and has not expired.
	 * Returns null if missing or stale.
	 */
	getCached<T>(key: CacheKey): T | null {
		try {
			const raw = localStorage.getItem(this.storageKey(key));
			if (!raw) return null;

			const entry = JSON.parse(raw) as CacheEntry<T>;
			const age = Date.now() - entry.cachedAt;

			if (age > entry.ttlMs) {
				// Expired — remove it
				localStorage.removeItem(this.storageKey(key));
				return null;
			}

			return entry.data;
		} catch {
			return null;
		}
	}

	/**
	 * Store data under key with an optional TTL (falls back to default for that key).
	 */
	setCached<T>(key: CacheKey, data: T, ttlMs?: number): void {
		const entry: CacheEntry<T> = {
			data,
			cachedAt: Date.now(),
			ttlMs: ttlMs ?? DEFAULT_TTL[key],
		};
		try {
			localStorage.setItem(this.storageKey(key), JSON.stringify(entry));
		} catch (err) {
			console.warn("[LocalCache] Failed to write to localStorage:", err);
		}
	}

	/** Delete a single cached entry. */
	delete(key: CacheKey): void {
		localStorage.removeItem(this.storageKey(key));
	}

	/** Clear all edith cache entries. */
	clear(): void {
		const keys: CacheKey[] = ["schedule", "contacts", "taskboard", "settings"];
		for (const key of keys) {
			localStorage.removeItem(this.storageKey(key));
		}
	}

	/**
	 * Returns the raw CacheEntry (including metadata) for a key, or null.
	 * Useful for displaying "last synced" info without TTL enforcement.
	 */
	getEntry<T>(key: CacheKey): CacheEntry<T> | null {
		try {
			const raw = localStorage.getItem(this.storageKey(key));
			if (!raw) return null;
			return JSON.parse(raw) as CacheEntry<T>;
		} catch {
			return null;
		}
	}

	/** True if a cached entry exists (even if expired). */
	has(key: CacheKey): boolean {
		return localStorage.getItem(this.storageKey(key)) !== null;
	}

	/** True if a cached entry exists and has not expired. */
	isFresh(key: CacheKey): boolean {
		return this.getCached(key) !== null;
	}
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const localCache = new LocalCache();
