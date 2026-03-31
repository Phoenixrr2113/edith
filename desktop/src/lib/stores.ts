/**
 * Svelte 5 reactive state for background worker progress.
 *
 * Workers are keyed by taskId and hold display state for the
 * WorkerProgress component. Updated by ws-client progress messages.
 */

export interface WorkerEntry {
	label: string;
	startTime: number;
	progress?: number; // 0–100, optional
	status: "running" | "complete" | "failed";
}

// Svelte 5 reactive map — use a plain $state object so reactivity propagates
let _workers = $state<Map<string, WorkerEntry>>(new Map());

/** Read-only reactive access to the workers map. */
export function getWorkers(): Map<string, WorkerEntry> {
	return _workers;
}

export function addWorker(taskId: string, label: string): void {
	const next = new Map(_workers);
	next.set(taskId, { label, startTime: Date.now(), status: "running" });
	_workers = next;
}

export function updateWorker(
	taskId: string,
	patch: Partial<Pick<WorkerEntry, "label" | "progress" | "status">>
): void {
	const existing = _workers.get(taskId);
	if (!existing) return;
	const next = new Map(_workers);
	next.set(taskId, { ...existing, ...patch });
	_workers = next;
}

export function removeWorker(taskId: string): void {
	const next = new Map(_workers);
	next.delete(taskId);
	_workers = next;
}
