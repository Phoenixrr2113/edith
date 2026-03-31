<script lang="ts">
	import { localCache, type CacheKey } from './local-cache.js';

	interface Props {
		onRefresh?: (key: CacheKey) => void;
	}

	let { onRefresh }: Props = $props();

	const KEYS: { key: CacheKey; label: string }[] = [
		{ key: 'schedule', label: 'Schedule' },
		{ key: 'contacts', label: 'Contacts' },
		{ key: 'taskboard', label: 'Taskboard' },
		{ key: 'settings', label: 'Settings' },
	];

	// Reactive tick — re-evaluate every second to keep "X minutes ago" fresh
	let tick = $state(0);
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		tickTimer = setInterval(() => { tick += 1; }, 60_000);
		return () => {
			if (tickTimer !== null) clearInterval(tickTimer);
		};
	});

	function getEntryAge(key: CacheKey): string {
		void tick; // reactive dependency — intentional expression to subscribe to tick
		const entry = localCache.getEntry(key);
		if (!entry) return 'Not cached';

		const ageMs = Date.now() - entry.cachedAt;
		const ageMins = Math.floor(ageMs / 60_000);

		if (ageMins < 1) return 'Just synced';
		if (ageMins === 1) return '1 minute ago';
		if (ageMins < 60) return `${ageMins} minutes ago`;

		const ageHrs = Math.floor(ageMins / 60);
		if (ageHrs === 1) return '1 hour ago';
		return `${ageHrs} hours ago`;
	}

	function isFresh(key: CacheKey): boolean {
		void tick; // reactive dependency
		return localCache.isFresh(key);
	}

	function hasEntry(key: CacheKey): boolean {
		void tick; // reactive dependency
		return localCache.has(key);
	}

	function handleRefresh(key: CacheKey) {
		onRefresh?.(key);
	}
</script>

<div class="cache-status">
	{#each KEYS as { key, label }}
		<div class="cache-row">
			<span class="cache-dot" class:fresh={isFresh(key)} class:stale={hasEntry(key) && !isFresh(key)} class:empty={!hasEntry(key)}></span>
			<span class="cache-label">{label}</span>
			<span class="cache-age">{getEntryAge(key)}</span>
			<button
				class="refresh-btn"
				type="button"
				onclick={() => handleRefresh(key)}
				aria-label="Refresh {label} cache"
			>↻</button>
		</div>
	{/each}
</div>

<style>
	.cache-status {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.cache-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.cache-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.cache-dot.fresh {
		background: #4ade80; /* green */
	}

	.cache-dot.stale {
		background: #facc15; /* yellow */
	}

	.cache-dot.empty {
		background: var(--text-muted, #888);
		opacity: 0.4;
	}

	.cache-label {
		font-size: 13px;
		color: var(--text-color);
		flex: 1;
	}

	.cache-age {
		font-size: 11px;
		color: var(--text-muted, #888);
		white-space: nowrap;
	}

	.refresh-btn {
		background: none;
		border: none;
		color: var(--text-muted, #888);
		cursor: pointer;
		font-size: 14px;
		padding: 2px 5px;
		border-radius: 4px;
		line-height: 1;
		transition: color 0.15s, background 0.15s;
	}

	.refresh-btn:hover {
		color: var(--text-color);
		background: var(--btn-bg-hover, rgba(255,255,255,0.08));
	}
</style>
