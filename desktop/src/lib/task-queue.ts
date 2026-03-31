/**
 * task-queue.ts — Persistent task queue for offline mode.
 *
 * Holds user requests while cloud is unavailable.
 * Persists to localStorage so it survives app restarts.
 * Max 50 tasks; oldest evicted when full.
 * Tasks older than 24h are discarded on flush.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QueuedTask {
	id: string;
	type: string;
	payload: unknown;
	timestamp: number;
	retries: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "edith_task_queue";
const MAX_SIZE = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── TaskQueue ─────────────────────────────────────────────────────────────────

export class TaskQueue {
	tasks = $state<QueuedTask[]>([]);

	constructor() {
		this._load();
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	get size(): number {
		return this.tasks.length;
	}

	/**
	 * Add a task to the queue. If at max capacity, oldest task is evicted.
	 */
	enqueue(
		task: Omit<QueuedTask, "id" | "timestamp" | "retries"> &
			Partial<Pick<QueuedTask, "id" | "timestamp" | "retries">>
	): void {
		const full: QueuedTask = {
			id: task.id ?? this._generateId(),
			type: task.type,
			payload: task.payload,
			timestamp: task.timestamp ?? Date.now(),
			retries: task.retries ?? 0,
		};

		if (this.tasks.length >= MAX_SIZE) {
			// Evict oldest (FIFO)
			this.tasks = this.tasks.slice(1);
		}

		this.tasks = [...this.tasks, full];
		this._persist();
	}

	/**
	 * Remove and return the oldest task (FIFO). Returns undefined if empty.
	 */
	dequeue(): QueuedTask | undefined {
		if (this.tasks.length === 0) return undefined;
		const [first, ...rest] = this.tasks;
		this.tasks = rest;
		this._persist();
		return first;
	}

	/**
	 * View the next task without removing it.
	 */
	peek(): QueuedTask | undefined {
		return this.tasks[0];
	}

	/**
	 * Clear all tasks from the queue.
	 */
	clear(): void {
		this.tasks = [];
		this._persist();
	}

	/**
	 * Send all queued tasks to the cloud via the provided sender function.
	 * Tasks older than 24h are discarded without sending.
	 * Returns the number of tasks flushed (excluding discarded).
	 */
	async flush(sender: (task: QueuedTask) => Promise<void>): Promise<number> {
		if (this.tasks.length === 0) return 0;

		const now = Date.now();
		const eligible = this.tasks.filter((t) => now - t.timestamp <= MAX_AGE_MS);
		const discarded = this.tasks.length - eligible.length;

		if (discarded > 0) {
			console.log(`[TaskQueue] Discarding ${discarded} tasks older than 24h`);
		}

		this.tasks = [];
		this._persist();

		let sent = 0;
		for (const task of eligible) {
			try {
				await sender(task);
				sent++;
			} catch (err) {
				console.error("[TaskQueue] Failed to flush task:", task.id, err);
				// Re-queue with incremented retries
				this.enqueue({ ...task, retries: task.retries + 1 });
			}
		}

		return sent;
	}

	// ── Private ────────────────────────────────────────────────────────────────

	private _generateId(): string {
		return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	private _persist(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tasks));
		} catch (err) {
			console.warn("[TaskQueue] Failed to persist to localStorage:", err);
		}
	}

	private _load(): void {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				this.tasks = parsed as QueuedTask[];
			}
		} catch (err) {
			console.warn("[TaskQueue] Failed to load from localStorage:", err);
		}
	}
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const taskQueue = new TaskQueue();
