/**
 * Claude dispatch engine — Agent SDK query() with session management, queue, and retries.
 *
 * Core orchestration: dispatchToClaude(), dispatchToConversation(), circuit breaker, queue.
 * SDK options live in dispatch-options.ts; stream processing in dispatch-stream.ts.
 */

// Import query from instrument.ts — uses the Langfuse-patched version when available
import { query } from "../instrument";
import { buildBrief } from "./briefs";
import {
	CHAT_ID,
	CIRCUIT_BREAKER_COOLDOWN_MS,
	INTER_DISPATCH_DELAY_MS,
	LIGHTWEIGHT_TIMEOUT_MS,
	MAX_CONSECUTIVE_FAILURES,
	QUERY_TIMEOUT_MS,
	REFLECTOR_EVAL_ONLY_RATIO,
} from "./config";
import { buildSdkOptions, getLastStderr, LIGHTWEIGHT_TASKS } from "./dispatch-options";
import { processMessageStream } from "./dispatch-stream";
import { edithLog } from "./edith-logger";
import { DispatchQueue, Priority, type QueuedJob } from "./queue";
import { DEFAULT_REFLECTOR_CONFIG, type ReflectorMode, ReflectorSession } from "./reflector";
import { setActiveQuery } from "./session";
import { clearSession, sessionId } from "./state";
import { sendTyping } from "./telegram";
import { startTranscript } from "./transcript";
import { fmtErr } from "./util";

// Lazy import to avoid circular deps — only used in cloud mode
const emitState = async (state: "thinking" | "idle") => {
	try {
		const { IS_CLOUD } = await import("./config");
		if (!IS_CLOUD) return;
		const { emitAgentState } = await import("./cloud-transport");
		emitAgentState(state);
	} catch {}
};

// --- Re-exports (preserve public API for tests and consumers) ---
export type { DispatchOptions } from "./dispatch-options";
export { buildSdkOptions } from "./dispatch-options";
export type { StreamResult, ToolCallRecord } from "./dispatch-stream";
export { processMessageStream } from "./dispatch-stream";
export { Priority };

/** @deprecated Use QueuedJob from ./queue instead */
export type DispatchJob = Pick<QueuedJob, "prompt" | "opts" | "resolve">;

// Re-import DispatchOptions for local use (the export above is type-only)
import type { DispatchOptions } from "./dispatch-options";

// --- Queue ---
let busy = false;
export const dispatchQueue = new DispatchQueue();

// --- Circuit breaker ---
let consecutiveFailures = 0;
let circuitBreakerUntil = 0;
let lastFailureError = "";
let activeLabel = "";

// --- Unique ID counter ---
let pidCounter = 0;

/**
 * Concurrent dispatch — runs alongside the main dispatch without touching the busy flag.
 * Used for P1_USER messages that must not wait behind background tasks.
 * Always runs with resume:false (ephemeral session) to avoid session conflicts.
 */
async function dispatchConcurrent(prompt: string, opts: DispatchOptions): Promise<string> {
	const label = opts.label ?? "concurrent";
	const startTime = Date.now();
	let typingInterval: ReturnType<typeof setInterval> | null = null;
	const wakeId = `${label}-${Date.now()}`;

	const abortController = new AbortController();
	const timeoutMs = QUERY_TIMEOUT_MS;
	const timeoutHandle = setTimeout(() => {
		edithLog.error("dispatch_concurrent_timeout", { label, timeoutMs });
		abortController.abort();
	}, timeoutMs);

	try {
		edithLog.info("dispatch_concurrent_start", {
			label,
			prompt: prompt.slice(0, 1000),
		});

		// Don't call emitState — would race with main dispatch's state tracking

		const typingChatId = opts.chatId ?? CHAT_ID;
		if (typingChatId) {
			sendTyping(typingChatId);
			typingInterval = setInterval(() => sendTyping(typingChatId), 5_000);
		}

		startTranscript(wakeId);

		// Force ephemeral session — no shared state
		const sdkOptions = buildSdkOptions({ ...opts, resume: false }, abortController);
		const queryHandle = query({ prompt, options: sdkOptions });

		const pseudoPid = ++pidCounter;

		const { lastResult, totalCost, turns, stopReason, toolCalls } = await processMessageStream(
			queryHandle,
			label,
			wakeId,
			false, // never resume
			opts,
			pseudoPid,
			null, // no reflector for concurrent
			abortController,
			prompt.slice(0, 300),
			true // concurrent — skip global session state
		);

		edithLog.info("dispatch_concurrent_end", {
			label,
			durationMs: Date.now() - startTime,
			turns,
			cost: totalCost,
			stopReason,
			toolCallCount: toolCalls.length,
			prompt: prompt.slice(0, 300),
		});

		return lastResult;
	} catch (err) {
		edithLog.error("dispatch_concurrent_error", {
			label,
			error: fmtErr(err),
			elapsedMs: Date.now() - startTime,
		});
		return "";
	} finally {
		clearTimeout(timeoutHandle);
		if (typingInterval) clearInterval(typingInterval);
	}
}

/**
 * Core dispatch — spawns Agent SDK query() and processes the message stream.
 */
export async function dispatchToClaude(
	prompt: string,
	opts: DispatchOptions = {}
): Promise<string> {
	const { resume = true, label = "dispatch" } = opts;

	// Circuit breaker check
	if (Date.now() < circuitBreakerUntil) {
		edithLog.warn("dispatch_skipped", {
			label,
			reason: "circuit_breaker",
			consecutiveFailures,
			expiresInSec: Math.round((circuitBreakerUntil - Date.now()) / 1000),
			lastError: lastFailureError,
			prompt: prompt.slice(0, 300),
		});
		return "";
	}

	if (busy) {
		const priority = opts.priority ?? Priority.P2_INTERACTIVE;

		// P1_USER messages bypass the busy flag — they run concurrently in their
		// own ephemeral session (resume:false) so Randy never waits behind a
		// background task. P0_CRITICAL (bootstrap) still queues to avoid races.
		if (priority === Priority.P1_USER) {
			edithLog.info("dispatch_concurrent", {
				label,
				priority,
				activeLabel,
				reason: "P1_USER bypasses busy flag",
				prompt: prompt.slice(0, 200),
			});
			// Run concurrently — force ephemeral session to avoid conflicts
			return dispatchConcurrent(prompt, { ...opts, resume: false, label });
		}

		if (opts.skipIfBusy) {
			edithLog.info("dispatch_skipped", {
				label,
				reason: "busy",
				activeLabel,
				queueDepth: dispatchQueue.length,
				prompt: prompt.slice(0, 200),
			});
			return "";
		}
		edithLog.info("dispatch_queued", {
			label,
			priority,
			queueSize: dispatchQueue.length + 1,
			activeLabel,
			prompt: prompt.slice(0, 200),
		});
		return new Promise((resolve) => {
			dispatchQueue.enqueue({ prompt, opts, resolve, priority, enqueuedAt: Date.now() });
		});
	}

	busy = true;
	activeLabel = label;
	const startTime = Date.now();
	let typingInterval: ReturnType<typeof setInterval> | null = null;
	const wakeId = `${label}-${Date.now()}`;

	// AbortController for timeout — use shorter timeout for lightweight tasks
	const abortController = new AbortController();
	const timeoutMs = LIGHTWEIGHT_TASKS.has(label) ? LIGHTWEIGHT_TIMEOUT_MS : QUERY_TIMEOUT_MS;
	const timeoutHandle = setTimeout(() => {
		edithLog.error("dispatch_timeout", {
			label,
			timeoutMs,
			elapsedMs: Date.now() - startTime,
			prompt: prompt.slice(0, 300),
		});
		abortController.abort();
	}, timeoutMs);

	try {
		edithLog.info("dispatch_start", {
			label,
			session: resume ? sessionId : "ephemeral",
			briefType: opts.briefType,
			prompt: prompt.slice(0, 1000),
		});

		emitState("thinking");

		// Typing indicator
		const typingChatId = opts.chatId ?? CHAT_ID;
		if (typingChatId) {
			sendTyping(typingChatId);
			typingInterval = setInterval(() => sendTyping(typingChatId), 5_000);
		}

		// Start transcript
		startTranscript(wakeId);

		// Build options and launch query
		const sdkOptions = buildSdkOptions(opts, abortController);
		const queryHandle = query({ prompt, options: sdkOptions });
		setActiveQuery(queryHandle);

		const pseudoPid = ++pidCounter;

		// Start reflector for this session — randomly assign A/B mode
		const reflectorMode: ReflectorMode =
			Math.random() < REFLECTOR_EVAL_ONLY_RATIO ? "eval-only" : "active";
		const reflector = DEFAULT_REFLECTOR_CONFIG.enabled
			? new ReflectorSession(prompt, label, { mode: reflectorMode })
			: null;
		if (reflector) {
			edithLog.info("reflector_assigned", { label, mode: reflectorMode });
		}

		// Process message stream
		const {
			lastResult,
			newSessionId,
			totalCost,
			turns,
			needsRetry,
			modelUsage,
			durationApiMs,
			stopReason,
			toolCalls,
		} = await processMessageStream(
			queryHandle,
			label,
			wakeId,
			resume,
			opts,
			pseudoPid,
			reflector,
			abortController,
			prompt.slice(0, 300)
		);

		// Handle session retry — push to front of queue so finally block drains it
		if (needsRetry) {
			return new Promise<string>((retryResolve) => {
				dispatchQueue.pushFront({
					prompt,
					opts: { ...opts, resume: true, label, _sessionRetried: true },
					resolve: retryResolve,
					priority: opts.priority ?? Priority.P0_CRITICAL,
					enqueuedAt: Date.now(),
				});
			});
		}

		// Log completion
		const durationMs = Date.now() - startTime;
		edithLog.info("dispatch_end", {
			label,
			durationMs,
			durationApiMs,
			turns,
			cost: totalCost,
			stopReason,
			models: modelUsage,
			inputTokens: Object.values(modelUsage).reduce((s, m) => s + m.inputTokens, 0),
			outputTokens: Object.values(modelUsage).reduce((s, m) => s + m.outputTokens, 0),
			cacheReadTokens: Object.values(modelUsage).reduce(
				(s, m) => s + (m.cacheReadInputTokens ?? 0),
				0
			),
			cacheWriteTokens: Object.values(modelUsage).reduce(
				(s, m) => s + (m.cacheCreationInputTokens ?? 0),
				0
			),
			toolCalls: toolCalls.map((t) => t.name),
			toolCallCount: toolCalls.length,
			toolCallDetails: toolCalls,
			prompt: prompt.slice(0, 1000),
			result: lastResult?.replace(/\n/g, " "),
			session: newSessionId?.slice(0, 8) ?? "ephemeral",
		});

		// Reflector: post-completion evaluation (non-blocking)
		if (reflector) {
			reflector
				.evaluateCompletion(lastResult)
				.then((eval_) => {
					if (eval_) {
						edithLog.info("reflector_evaluation", {
							label,
							score: eval_.score,
							assessment: eval_.assessment.slice(0, 200),
						});
					}
				})
				.catch(() => {}); // fire-and-forget
		}

		// Reset circuit breaker on success
		consecutiveFailures = 0;

		emitState("idle");
		return lastResult;
	} catch (err) {
		const errMsg = fmtErr(err);
		lastFailureError = errMsg;
		const stderr = getLastStderr().trim();
		edithLog.error("dispatch_error", {
			label,
			error: errMsg,
			stderr: stderr || undefined,
			consecutiveFailures: consecutiveFailures + 1,
			elapsedMs: Date.now() - startTime,
			prompt: prompt.slice(0, 300),
		});

		emitState("idle");

		// Stale session — SDK throws "No conversation found with session ID"
		// Clear session and retry once (the try block's needsRetry path doesn't
		// reach here because the SDK throws before processMessageStream completes)
		if (errMsg.includes("No conversation found") && sessionId && !opts._sessionRetried) {
			edithLog.warn("session_reset_catch", { label, sessionId: sessionId.slice(0, 8) });
			clearSession();
			consecutiveFailures = 0;
			return dispatchToClaude(prompt, { ...opts, resume: false, _sessionRetried: true });
		}

		// Circuit breaker
		consecutiveFailures++;
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
			edithLog.error("circuit_breaker", {
				failures: consecutiveFailures,
				cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
				cooldownUntil: new Date(circuitBreakerUntil).toISOString(),
				lastError: errMsg,
				label,
			});
		}

		setActiveQuery(null);
		return "";
	} finally {
		clearTimeout(timeoutHandle);
		if (typingInterval) clearInterval(typingInterval);
		busy = false;
		activeLabel = "";

		if (dispatchQueue.length > 0) {
			// Delay to allow MCP servers from previous dispatch to shut down (prevents Kuzu lock contention)
			await Bun.sleep(INTER_DISPATCH_DELAY_MS);
			const next = dispatchQueue.dequeue();
			if (next) {
				edithLog.info("dispatch_queue_drain", {
					remaining: dispatchQueue.length,
					priority: next.priority,
					nextLabel: next.opts.label ?? "unknown",
					nextPrompt: next.prompt.slice(0, 200),
				});
				dispatchToClaude(next.prompt, next.opts)
					.then(next.resolve)
					.catch(() => next.resolve(""));
			}
		}
	}
}

/**
 * Dispatch a conversation message — builds brief, dispatches to Claude.
 *
 * Uses resume:false (ephemeral session) because continue:true is fragile —
 * stale/missing session files cause the SDK to return 0 tokens silently.
 * Conversation context comes from the brief (taskboard entries, memory),
 * not from SDK session continuation.
 */
export async function dispatchToConversation(
	chatId: number,
	_messageId: number,
	message: string
): Promise<void> {
	const brief = await buildBrief("message", { message, chatId: String(chatId) });
	await dispatchToClaude(brief, {
		resume: false,
		label: "message",
		chatId,
		priority: Priority.P1_USER,
	});

	// Note: empty result is normal — responses sent via tool calls (send_message)
	// produce no text output. Actual failures throw exceptions in dispatchToClaude
	// and are handled by the caller (bootstrap dead-letters on exception).
}
