/**
 * capture-store.ts — Local storage layer for screen and audio captures.
 *
 * Uses localStorage to persist captured data (base64-encoded) with automatic
 * pruning. Designed for Tauri webview where bun:sqlite is unavailable.
 *
 * Limits:
 *  - MAX_CAPTURES per type (default 50)
 *  - MAX_TOTAL_BYTES across all captures (default 10MB)
 *  - Entries older than captureRetentionHours are pruned automatically
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type CaptureType = "screen" | "audio";

export interface CaptureMetadata {
	/** Source label, e.g. "display:0" or "microphone" */
	source?: string;
	/** Width in pixels (screen captures) */
	width?: number;
	/** Height in pixels (screen captures) */
	height?: number;
	/** MIME type of the data, e.g. "image/jpeg" or "audio/webm" */
	mimeType?: string;
	/** Duration in milliseconds (audio captures) */
	durationMs?: number;
	[key: string]: unknown;
}

export interface CaptureEntry {
	id: string;
	type: CaptureType;
	/** Base64-encoded capture data */
	data: string;
	timestamp: number;
	metadata?: CaptureMetadata;
}

export interface CaptureStoreSettings {
	/** Max number of captures to keep per type (default 50) */
	maxCaptures: number;
	/** Auto-delete old entries (default true) */
	autoDelete: boolean;
	/** How long to retain captures in hours (default 2) */
	captureRetentionHours: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = "edith_capture_";
const SETTINGS_KEY = "edith_capture_settings";
const INDEX_KEY = "edith_capture_index";

/** 10 MB total cap across all captures */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** Default per-type limit */
const DEFAULT_MAX_CAPTURES = 50;

/** Default retention window */
const DEFAULT_RETENTION_HOURS = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function entryKey(id: string): string {
	return `${STORAGE_KEY_PREFIX}${id}`;
}

// ── CaptureStore ──────────────────────────────────────────────────────────────

export class CaptureStore {
	private settings: CaptureStoreSettings;

	constructor(settings?: Partial<CaptureStoreSettings>) {
		this.settings = this.loadSettings(settings);
	}

	// ── Settings ─────────────────────────────────────────────────────────────

	private loadSettings(overrides?: Partial<CaptureStoreSettings>): CaptureStoreSettings {
		const defaults: CaptureStoreSettings = {
			maxCaptures: DEFAULT_MAX_CAPTURES,
			autoDelete: true,
			captureRetentionHours: DEFAULT_RETENTION_HOURS,
		};
		try {
			const raw = localStorage.getItem(SETTINGS_KEY);
			const stored = raw ? (JSON.parse(raw) as Partial<CaptureStoreSettings>) : {};
			return { ...defaults, ...stored, ...overrides };
		} catch {
			return { ...defaults, ...overrides };
		}
	}

	updateSettings(updates: Partial<CaptureStoreSettings>): void {
		this.settings = { ...this.settings, ...updates };
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
		} catch {
			// ignore
		}
	}

	getSettings(): CaptureStoreSettings {
		return { ...this.settings };
	}

	// ── Index management ─────────────────────────────────────────────────────

	/** Returns the ordered list of all capture IDs (oldest first). */
	private loadIndex(): string[] {
		try {
			const raw = localStorage.getItem(INDEX_KEY);
			if (raw) return JSON.parse(raw) as string[];
		} catch {
			// ignore
		}
		return [];
	}

	private saveIndex(index: string[]): void {
		try {
			localStorage.setItem(INDEX_KEY, JSON.stringify(index));
		} catch {
			// ignore
		}
	}

	// ── Core operations ───────────────────────────────────────────────────────

	/**
	 * Store a capture entry. Auto-prunes by age and count/size after storing.
	 * Returns the id of the stored entry, or null if storage failed.
	 */
	storeCapture(type: CaptureType, data: string, metadata?: CaptureMetadata): string | null {
		const entry: CaptureEntry = {
			id: generateId(),
			type,
			data,
			timestamp: Date.now(),
			metadata,
		};

		try {
			localStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
		} catch (err) {
			console.warn("[CaptureStore] Failed to write capture:", err);
			return null;
		}

		const index = this.loadIndex();
		index.push(entry.id);
		this.saveIndex(index);

		// Auto-prune after every store
		if (this.settings.autoDelete) {
			this.pruneOldCaptures(this.settings.captureRetentionHours * 60 * 60 * 1000);
		}
		this.enforceCaptureLimits();

		return entry.id;
	}

	/**
	 * Retrieve recent captures of the given type, newest first.
	 * @param type   'screen' or 'audio'
	 * @param count  Max entries to return (default 10)
	 */
	getRecentCaptures(type: CaptureType, count = 10): CaptureEntry[] {
		const index = this.loadIndex();
		const results: CaptureEntry[] = [];

		// Walk newest → oldest
		for (let i = index.length - 1; i >= 0 && results.length < count; i--) {
			const entry = this.readEntry(index[i]);
			if (entry && entry.type === type) {
				results.push(entry);
			}
		}

		return results;
	}

	/** Get a single capture entry by id, or null. */
	getCapture(id: string): CaptureEntry | null {
		return this.readEntry(id);
	}

	/** Delete a single capture by id. */
	deleteCapture(id: string): void {
		try {
			localStorage.removeItem(entryKey(id));
		} catch {
			// ignore
		}
		const index = this.loadIndex().filter((i) => i !== id);
		this.saveIndex(index);
	}

	/**
	 * Remove all captures older than maxAgeMs milliseconds.
	 * Returns the number of entries removed.
	 */
	pruneOldCaptures(maxAgeMs: number): number {
		const cutoff = Date.now() - maxAgeMs;
		const index = this.loadIndex();
		const kept: string[] = [];
		let removed = 0;

		for (const id of index) {
			const entry = this.readEntry(id);
			if (!entry || entry.timestamp < cutoff) {
				try {
					localStorage.removeItem(entryKey(id));
				} catch {
					// ignore
				}
				removed++;
			} else {
				kept.push(id);
			}
		}

		if (removed > 0) {
			this.saveIndex(kept);
		}

		return removed;
	}

	/** Remove all captures of all types. */
	clearAll(): void {
		const index = this.loadIndex();
		for (const id of index) {
			try {
				localStorage.removeItem(entryKey(id));
			} catch {
				// ignore
			}
		}
		this.saveIndex([]);
	}

	/** Remove all captures of a given type. */
	clearByType(type: CaptureType): void {
		const index = this.loadIndex();
		const kept: string[] = [];

		for (const id of index) {
			const entry = this.readEntry(id);
			if (entry && entry.type === type) {
				try {
					localStorage.removeItem(entryKey(id));
				} catch {
					// ignore
				}
			} else {
				kept.push(id);
			}
		}

		this.saveIndex(kept);
	}

	/**
	 * Returns approximate storage used by all captures in bytes.
	 * (Estimated as sum of raw JSON string lengths × 2 for UTF-16 encoding.)
	 */
	estimatedStorageBytes(): number {
		const index = this.loadIndex();
		let total = 0;
		for (const id of index) {
			try {
				const raw = localStorage.getItem(entryKey(id));
				if (raw) total += raw.length * 2;
			} catch {
				// ignore
			}
		}
		return total;
	}

	/** Count captures by type. */
	countByType(type: CaptureType): number {
		const index = this.loadIndex();
		let count = 0;
		for (const id of index) {
			const entry = this.readEntry(id);
			if (entry && entry.type === type) count++;
		}
		return count;
	}

	// ── Internal helpers ──────────────────────────────────────────────────────

	private readEntry(id: string): CaptureEntry | null {
		try {
			const raw = localStorage.getItem(entryKey(id));
			if (!raw) return null;
			return JSON.parse(raw) as CaptureEntry;
		} catch {
			return null;
		}
	}

	/**
	 * Enforce per-type count cap and total size cap.
	 * Removes oldest entries first when over limit.
	 */
	private enforceCaptureLimits(): void {
		const index = this.loadIndex();
		const max = this.settings.maxCaptures;

		// Count per type (oldest first in index)
		const typeCounts: Record<CaptureType, number> = { screen: 0, audio: 0 };
		for (const id of index) {
			const entry = this.readEntry(id);
			if (entry) typeCounts[entry.type]++;
		}

		const toRemove = new Set<string>();

		// Walk oldest → newest, mark excess entries for removal
		const typeSeen: Record<CaptureType, number> = { screen: 0, audio: 0 };
		for (const id of index) {
			const entry = this.readEntry(id);
			if (!entry) {
				toRemove.add(id);
				continue;
			}
			typeSeen[entry.type]++;
			const excess = typeCounts[entry.type] - max;
			if (excess > 0 && typeSeen[entry.type] <= excess) {
				toRemove.add(id);
			}
		}

		// Enforce total byte cap — remove oldest until under limit
		const filtered = index.filter((id) => !toRemove.has(id));
		let totalBytes = 0;
		for (const id of filtered) {
			try {
				const raw = localStorage.getItem(entryKey(id));
				if (raw) totalBytes += raw.length * 2;
			} catch {
				// ignore
			}
		}

		// Walk oldest first to trim down to byte budget
		for (const id of filtered) {
			if (totalBytes <= MAX_TOTAL_BYTES) break;
			try {
				const raw = localStorage.getItem(entryKey(id));
				if (raw) totalBytes -= raw.length * 2;
			} catch {
				// ignore
			}
			toRemove.add(id);
		}

		if (toRemove.size > 0) {
			for (const id of toRemove) {
				try {
					localStorage.removeItem(entryKey(id));
				} catch {
					// ignore
				}
			}
			this.saveIndex(index.filter((id) => !toRemove.has(id)));
		}
	}
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const captureStore = new CaptureStore();
