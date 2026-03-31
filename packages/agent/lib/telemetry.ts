/**
 * Langfuse tracing — must be imported FIRST in edith.ts.
 *
 * Uses the direct Langfuse SDK (not OTEL) for reliable trace emission.
 * Each dispatch creates a trace with spans for the Agent SDK call.
 *
 * Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL in .env.
 */

import Langfuse from "langfuse";

const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
const baseUrl = process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000";

let langfuse: InstanceType<typeof Langfuse> | null = null;

if (publicKey && secretKey) {
	langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
	console.log(`[telemetry] Langfuse initialized (${baseUrl})`);
} else {
	console.warn("[telemetry] Langfuse keys not set — tracing disabled");
}

/** Start a new trace for a dispatch. Returns a trace object or null. */
export function startTrace(name: string, metadata?: Record<string, unknown>) {
	if (!langfuse) return null;
	return langfuse.trace({ name, metadata });
}

/** Create a span within a trace (for sub-operations). */
export function startSpan(trace: ReturnType<typeof startTrace>, name: string, input?: unknown) {
	if (!trace) return null;
	return trace.span({ name, input });
}

/** Record a generation (LLM call) within a trace. */
export function recordGeneration(
	trace: ReturnType<typeof startTrace>,
	opts: {
		name: string;
		model?: string;
		input?: unknown;
		output?: unknown;
		usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
		durationMs?: number;
	}
) {
	if (!trace) return;
	trace.generation({
		name: opts.name,
		model: opts.model,
		input: opts.input,
		output: opts.output,
		usage: opts.usage
			? {
					total: opts.usage.totalTokens,
					input: opts.usage.inputTokens,
					output: opts.usage.outputTokens,
				}
			: undefined,
		completionStartTime: opts.durationMs ? new Date(Date.now() - opts.durationMs) : undefined,
	});
}

/** Flush pending traces (call before shutdown). */
export async function flushTraces() {
	if (langfuse) await langfuse.flushAsync();
}

/** Shutdown Langfuse client. */
export async function shutdownTraces() {
	if (langfuse) await langfuse.shutdownAsync();
}

export { langfuse };
