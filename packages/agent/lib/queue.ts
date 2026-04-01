/**
 * Priority dispatch queue — ensures user messages always drain before background tasks.
 *
 * Priority levels (lower number = higher priority):
 *   P0_CRITICAL    — bootstrap, dead letter replay
 *   P1_USER        — Randy's messages (text, voice, photo, SMS)
 *   P2_INTERACTIVE — dashboard triggers, dashboard messages
 *   P3_BACKGROUND  — scheduled tasks (morning-brief, check-reminders, etc.)
 *
 * Within the same priority, jobs drain FIFO (insertion order).
 */

// Note: QueuedJob.opts uses a loose type to avoid circular import with dispatch.ts.
// The actual DispatchOptions type is enforced at the call site.

export enum Priority {
	P0_CRITICAL = 0,
	P1_USER = 1,
	P2_INTERACTIVE = 2,
	P3_BACKGROUND = 3,
}

// biome-ignore lint: opts is loosely typed to avoid circular import with dispatch.ts
export interface QueuedJob<T = any> {
	prompt: string;
	opts: T;
	resolve: (result: string) => void;
	priority: Priority;
	enqueuedAt: number;
}

export class DispatchQueue {
	private jobs: QueuedJob[] = [];

	/** Insert sorted by priority. Within same priority, FIFO. */
	enqueue(job: QueuedJob): void {
		const idx = this.jobs.findIndex((j) => j.priority > job.priority);
		if (idx === -1) this.jobs.push(job);
		else this.jobs.splice(idx, 0, job);
	}

	/** Push to front — used for session retry (must run next). */
	pushFront(job: QueuedJob): void {
		this.jobs.unshift(job);
	}

	/** Pop highest-priority job. */
	dequeue(): QueuedJob | undefined {
		return this.jobs.shift();
	}

	get length(): number {
		return this.jobs.length;
	}

	/** Drain all jobs and clear the queue (for shutdown). */
	drainAll(): QueuedJob[] {
		const all = [...this.jobs];
		this.jobs = [];
		return all;
	}

	[Symbol.iterator]() {
		return this.jobs[Symbol.iterator]();
	}
}
