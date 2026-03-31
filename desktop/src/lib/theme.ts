/**
 * Theme store for the Edith desktop app.
 *
 * Supports 'dark' | 'light' | 'system' modes.
 * Persists to localStorage. Applies CSS custom properties via data-theme
 * attribute on document.documentElement.
 */

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "edith-theme";
const DEFAULT_MODE: ThemeMode = "system";

// ── Theme state (Svelte 5 $state lives in .svelte files; export plain object) ─

/** Reactive theme state — import and read in Svelte components */
export const themeState = (() => {
	let _mode = $state<ThemeMode>(loadStoredMode());
	let _resolved = $state<ResolvedTheme>(resolveMode(_mode));

	return {
		get mode() {
			return _mode;
		},
		get resolved() {
			return _resolved;
		},
		set(mode: ThemeMode) {
			_mode = mode;
			_resolved = resolveMode(mode);
		},
	};
})();

// ── System media query listener ───────────────────────────────────────────────

let _mql: MediaQueryList | null = null;
let _mqlListener: ((e: MediaQueryListEvent) => void) | null = null;

/**
 * Initialize the theme system. Call once in onMount.
 * Reads saved preference, applies theme, and starts system listener.
 * Returns a cleanup function to call in onDestroy.
 */
export function initTheme(): () => void {
	applyTheme(themeState.mode);

	_mql = window.matchMedia("(prefers-color-scheme: dark)");
	_mqlListener = () => {
		if (themeState.mode === "system") {
			const resolved = _mql?.matches ? "dark" : "light";
			themeState.set("system");
			applyThemeResolved(resolved);
		}
	};
	_mql.addEventListener("change", _mqlListener);

	return () => {
		if (_mql && _mqlListener) {
			_mql.removeEventListener("change", _mqlListener);
		}
	};
}

/**
 * Set and persist a theme mode, then apply it immediately.
 */
export function setTheme(mode: ThemeMode): void {
	themeState.set(mode);
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {
		// localStorage unavailable (e.g. sandboxed)
	}
	applyTheme(mode);
}

/**
 * Apply a theme mode to the DOM (resolves 'system' → dark/light).
 */
export function applyTheme(mode: ThemeMode): void {
	const resolved = resolveMode(mode);
	applyThemeResolved(resolved);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function applyThemeResolved(resolved: ResolvedTheme): void {
	document.documentElement.setAttribute("data-theme", resolved);
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
	if (mode === "system") {
		try {
			return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		} catch {
			return "dark";
		}
	}
	return mode;
}

function loadStoredMode(): ThemeMode {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "dark" || stored === "light" || stored === "system") {
			return stored;
		}
	} catch {
		// localStorage unavailable
	}
	return DEFAULT_MODE;
}
