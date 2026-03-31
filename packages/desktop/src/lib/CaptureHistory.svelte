<script lang="ts">
	import { captureStore, type CaptureType, type CaptureEntry } from './capture-store.js';

	interface Props {
		/** Which type to display. Defaults to 'screen'. */
		type?: CaptureType;
		/** Max entries to show (default 20). */
		count?: number;
	}

	let { type = 'screen', count = 20 }: Props = $props();

	// ── State ─────────────────────────────────────────────────────────────────

	let entries = $state<CaptureEntry[]>([]);
	let expandedId = $state<string | null>(null);
	let activeType = $state<CaptureType>(type);
	let revision = $state(0);

	// Load (or reload) on mount and whenever revision changes
	$effect(() => {
		void revision;
		entries = captureStore.getRecentCaptures(activeType, count);
	});

	$effect(() => {
		activeType = type;
		expandedId = null;
		entries = captureStore.getRecentCaptures(activeType, count);
	});

	// ── Helpers ───────────────────────────────────────────────────────────────

	function formatTime(ts: number): string {
		const d = new Date(ts);
		const now = Date.now();
		const diffMs = now - ts;
		const diffMins = Math.floor(diffMs / 60_000);

		if (diffMins < 1) return 'Just now';
		if (diffMins === 1) return '1 min ago';
		if (diffMins < 60) return `${diffMins} min ago`;

		const diffHrs = Math.floor(diffMins / 60);
		if (diffHrs === 1) return '1 hr ago';
		if (diffHrs < 24) return `${diffHrs} hrs ago`;

		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function thumbSrc(entry: CaptureEntry): string | null {
		if (entry.type !== 'screen') return null;
		const mime = entry.metadata?.mimeType ?? 'image/jpeg';
		return `data:${mime};base64,${entry.data}`;
	}

	function entryLabel(entry: CaptureEntry): string {
		if (entry.type === 'screen') {
			const w = entry.metadata?.width;
			const h = entry.metadata?.height;
			return w && h ? `${w}×${h}` : (entry.metadata?.source ?? 'Screenshot');
		}
		const dur = entry.metadata?.durationMs;
		return dur ? `${(dur / 1000).toFixed(1)}s` : (entry.metadata?.source ?? 'Audio clip');
	}

	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	function handleDelete(id: string) {
		captureStore.deleteCapture(id);
		if (expandedId === id) expandedId = null;
		revision += 1;
	}

	function handleClearAll() {
		captureStore.clearByType(activeType);
		expandedId = null;
		revision += 1;
	}

	function handleTabChange(t: CaptureType) {
		activeType = t;
		expandedId = null;
		entries = captureStore.getRecentCaptures(t, count);
	}
</script>

<div class="capture-history">
	<!-- Type tabs -->
	<div class="tabs" role="tablist" aria-label="Capture type">
		<button
			role="tab"
			type="button"
			class="tab"
			class:active={activeType === 'screen'}
			aria-selected={activeType === 'screen'}
			onclick={() => handleTabChange('screen')}
		>
			Screen
		</button>
		<button
			role="tab"
			type="button"
			class="tab"
			class:active={activeType === 'audio'}
			aria-selected={activeType === 'audio'}
			onclick={() => handleTabChange('audio')}
		>
			Audio
		</button>
		{#if entries.length > 0}
			<button
				type="button"
				class="clear-btn"
				onclick={handleClearAll}
				aria-label="Clear all {activeType} captures"
			>
				Clear all
			</button>
		{/if}
	</div>

	<!-- Entry list -->
	{#if entries.length === 0}
		<p class="empty">No {activeType} captures stored.</p>
	{:else}
		<ul class="entry-list" role="list">
			{#each entries as entry (entry.id)}
				<li class="entry" class:expanded={expandedId === entry.id}>
					<!-- Summary row -->
					<div class="entry-row">
						<!-- Thumbnail (screen) or waveform icon (audio) -->
						{#if entry.type === 'screen'}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<img
								class="thumb"
								src={thumbSrc(entry) ?? ''}
								alt="Screenshot thumbnail"
								loading="lazy"
								onclick={() => toggleExpand(entry.id)}
							/>
						{:else}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<div
								class="audio-icon"
								role="img"
								aria-label="Audio clip"
								onclick={() => toggleExpand(entry.id)}
							>
								&#9835;
							</div>
						{/if}

						<div class="entry-meta">
							<span class="entry-label">{entryLabel(entry)}</span>
							<span class="entry-time">{formatTime(entry.timestamp)}</span>
						</div>

						<div class="entry-actions">
							<button
								type="button"
								class="expand-btn"
								onclick={() => toggleExpand(entry.id)}
								aria-expanded={expandedId === entry.id}
								aria-label="{expandedId === entry.id ? 'Collapse' : 'Expand'} capture preview"
							>
								{expandedId === entry.id ? '▲' : '▼'}
							</button>
							<button
								type="button"
								class="delete-btn"
								onclick={() => handleDelete(entry.id)}
								aria-label="Delete this capture"
							>
								✕
							</button>
						</div>
					</div>

					<!-- Expanded preview -->
					{#if expandedId === entry.id}
						<div class="preview" role="region" aria-label="Capture preview">
							{#if entry.type === 'screen'}
								<img
									class="preview-img"
									src={thumbSrc(entry) ?? ''}
									alt="Full screenshot preview"
								/>
							{:else}
								<p class="audio-preview-hint">
									Audio data stored (base64). Use the Web Audio API or an
									<code>&lt;audio&gt;</code> element with a blob URL to play back.
								</p>
								{#if entry.metadata}
									<pre class="meta-block">{JSON.stringify(entry.metadata, null, 2)}</pre>
								{/if}
							{/if}
							<div class="preview-meta">
								<span>ID: <code>{entry.id}</code></span>
								<span>Stored: {new Date(entry.timestamp).toLocaleString()}</span>
								{#if entry.metadata?.mimeType}
									<span>MIME: {entry.metadata.mimeType}</span>
								{/if}
							</div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.capture-history {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* Tabs */
	.tabs {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.tab {
		background: var(--btn-bg);
		border: 1px solid var(--input-border);
		color: var(--text-secondary);
		border-radius: 6px;
		padding: 4px 10px;
		font-size: 11px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.tab:hover {
		background: var(--btn-bg-hover);
		color: var(--text-color);
	}

	.tab.active {
		background: var(--btn-bg-active);
		border-color: var(--accent);
		color: var(--text-color);
	}

	.clear-btn {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 11px;
		cursor: pointer;
		padding: 4px 6px;
		border-radius: 4px;
		transition: color 0.15s, background 0.15s;
	}

	.clear-btn:hover {
		color: #ef4444;
		background: rgba(239, 68, 68, 0.1);
	}

	/* Empty state */
	.empty {
		font-size: 12px;
		color: var(--text-muted);
		margin: 4px 0;
	}

	/* Entry list */
	.entry-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.entry {
		background: var(--btn-bg);
		border: 1px solid var(--input-border);
		border-radius: 8px;
		overflow: hidden;
		transition: border-color 0.15s;
	}

	.entry.expanded {
		border-color: var(--accent);
	}

	/* Summary row */
	.entry-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
	}

	/* Thumbnail */
	.thumb {
		width: 40px;
		height: 28px;
		object-fit: cover;
		border-radius: 4px;
		flex-shrink: 0;
		cursor: pointer;
		background: var(--input-bg);
		border: 1px solid var(--input-border);
	}

	/* Audio icon placeholder */
	.audio-icon {
		width: 40px;
		height: 28px;
		border-radius: 4px;
		flex-shrink: 0;
		cursor: pointer;
		background: var(--input-bg);
		border: 1px solid var(--input-border);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		color: var(--accent);
	}

	.entry-meta {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.entry-label {
		font-size: 12px;
		color: var(--text-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.entry-time {
		font-size: 10px;
		color: var(--text-muted);
	}

	.entry-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.expand-btn,
	.delete-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 12px;
		padding: 3px 5px;
		border-radius: 4px;
		line-height: 1;
		transition: color 0.15s, background 0.15s;
		color: var(--text-muted);
	}

	.expand-btn:hover {
		color: var(--text-color);
		background: var(--btn-bg-hover);
	}

	.delete-btn:hover {
		color: #ef4444;
		background: rgba(239, 68, 68, 0.1);
	}

	/* Expanded preview */
	.preview {
		padding: 8px;
		border-top: 1px solid var(--separator);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.preview-img {
		width: 100%;
		border-radius: 4px;
		object-fit: contain;
		max-height: 180px;
		background: var(--input-bg);
	}

	.audio-preview-hint {
		font-size: 11px;
		color: var(--text-muted);
		margin: 0;
	}

	.meta-block {
		font-size: 10px;
		color: var(--text-muted);
		background: var(--input-bg);
		border-radius: 4px;
		padding: 6px;
		overflow-x: auto;
		margin: 0;
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
	}

	.preview-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.preview-meta span {
		font-size: 10px;
		color: var(--text-muted);
	}

	.preview-meta code {
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
		font-size: 10px;
	}
</style>
