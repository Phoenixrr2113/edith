/**
 * Claude dispatch engine — Agent SDK query() with session management, queue, and retries.
 *
 * Replaces the old spawn("claude -p") approach with the Claude Agent SDK.
 * Key improvements:
 *   - streamInput() for real-time message injection mid-session
 *   - Session continuity via continue/resume
 *   - Streaming message observation (turn counting, transcript logging)
 *   - Circuit breaker for repeated failures
 *   - AbortController timeout to prevent hangs
 */

import {
	type McpServerConfig,
	type Options,
	type Query,
	query,
	type SDKAssistantMessage,
	type SDKCompactBoundaryMessage,
	type SDKResultMessage,
	type SDKTaskNotificationMessage,
	type SDKTaskProgressMessage,
	type SDKTaskStartedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type BriefType, buildBrief } from "./briefs";
import {
	CHAT_ID,
	CIRCUIT_BREAKER_COOLDOWN_MS,
	INTER_DISPATCH_DELAY_MS,
	LIGHTWEIGHT_TIMEOUT_MS,
	MAX_CONSECUTIVE_FAILURES,
	QUERY_TIMEOUT_MS,
	REFLECTOR_EVAL_ONLY_RATIO,
} from "./config";
import { assembleSystemPrompt } from "./context";
import { edithLog } from "./edith-logger";
import { DEFAULT_REFLECTOR_CONFIG, type ReflectorMode, ReflectorSession } from "./reflector";
import { getActiveQuery, injectMessage, setActiveQuery, setActiveSessionId } from "./session";
import {
	activeProcesses,
	clearSession,
	PROJECT_ROOT,
	saveSession,
	sessionId,
	writeActiveProcesses,
} from "./state";
import { loadJson } from "./storage";
import { sendTyping } from "./telegram";
import { appendTranscript, startTranscript } from "./transcript";
import { fmtErr } from "./util";

// --- Queue ---
let busy = false;

export interface DispatchJob {
	prompt: string;
	opts: DispatchOptions;
	resolve: (result: string) => void;
}

export const dispatchQueue: DispatchJob[] = [];

export interface DispatchOptions {
	resume?: boolean;
	label?: string;
	chatId?: number;
	skipIfBusy?: boolean;
	briefType?: BriefType;
	maxTurns?: number;
	_sessionRetried?: boolean;
}

// --- Circuit breaker ---
let consecutiveFailures = 0;
let circuitBreakerUntil = 0;

// --- Unique ID counter ---
let pidCounter = 0;

// --- Lightweight task set (uses shorter timeout) ---
const LIGHTWEIGHT_TASKS = new Set(["check-reminders", "proactive-check"]);

// --- Content block types matching BetaMessage.content shape ---
interface ToolUseBlock {
	type: "tool_use";
	name: string;
	input: Record<string, unknown>;
}

interface TextBlock {
	type: "text";
	text: string;
}

type ContentBlock = ToolUseBlock | TextBlock | { type: string };

// --- MCP config ---
function loadMcpConfig(): Record<string, McpServerConfig> {
	try {
		const config = loadJson<Record<string, unknown>>(`${PROJECT_ROOT}/.mcp.json`, {});
		// JSON is loaded as unknown; cast to the SDK's expected shape
		return (config.mcpServers as Record<string, McpServerConfig>) ?? {};
	} catch {
		return {};
	}
}

/** Builds the Agent SDK Options object from dispatch config. */
export function buildSdkOptions(opts: DispatchOptions, abortController: AbortController): Options {
	const { resume = true } = opts;
	const systemPrompt = assembleSystemPrompt();

	const sdkOptions: Options = {
		abortController,
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: systemPrompt,
		},
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		cwd: PROJECT_ROOT,
		mcpServers: loadMcpConfig(),
		maxTurns: opts.maxTurns ?? 50,
		settingSources: ["project"],
		allowedTools: [
			"Read",
			"Write",
			"Edit",
			"Bash",
			"Glob",
			"Grep",
			"WebFetch",
			"WebSearch",
			"Agent",
			"Skill",
		],
	};

	// Session handling
	if (resume) {
		if (sessionId) {
			sdkOptions.resume = sessionId;
		}
	} else {
		// Ephemeral sessions for scheduled tasks
		sdkOptions.persistSession = false;
	}

	return sdkOptions;
}

export interface StreamResult {
	lastResult: string;
	newSessionId: string;
	totalCost: number;
	turns: number;
	needsRetry: boolean;
	modelUsage: Record<string, { inputTokens: number; outputTokens: number }>;
	durationApiMs: number;
	stopReason: string | null;
}

/** Consumes the Agent SDK query stream, tracking turns, cost, and session. */
export async function processMessageStream(
	queryHandle: Query,
	label: string,
	wakeId: string,
	resume: boolean,
	opts: DispatchOptions,
	pseudoPid: number,
	reflector: ReflectorSession | null,
	_abortController?: AbortController
): Promise<StreamResult> {
	let turns = 0;
	let lastResult = "";
	let newSessionId = "";
	let totalCost = 0;
	let needsRetry = false;
	let modelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
	let durationApiMs = 0;
	let stopReason: string | null = null;

	/** Inject a reflection into the running session (non-blocking). */
	const maybeInject = async (
		trigger: "periodic" | "compaction" | "guard",
		guardCtx?: { toolName: string; toolInput: Record<string, unknown> }
	) => {
		if (!reflector) return;
		try {
			const reflection = await reflector.buildReflection(trigger, guardCtx);
			if (reflection) {
				const injected = await injectMessage(reflection);
				if (injected) {
					reflector.recordUserMessage(`[reflector:${trigger}] ${reflection.slice(0, 100)}`);
					edithLog.debug("reflector_injected", {
						label,
						trigger,
						reflection: reflection.slice(0, 80),
					});
				}
			}
		} catch (err) {
			edithLog.error("reflector_inject_failed", { label, trigger, error: fmtErr(err) });
		}
	};

	try {
		for await (const message of queryHandle) {
			appendTranscript(wakeId, message);

			// Track session ID
			if ("session_id" in message && message.session_id && resume) {
				if (message.session_id !== newSessionId) {
					newSessionId = message.session_id;
					setActiveSessionId(newSessionId);
				}
			}

			// --- Reflector: detect compaction ---
			if (
				message.type === "system" &&
				"subtype" in message &&
				message.subtype === "compact_boundary"
			) {
				const boundary = message as SDKCompactBoundaryMessage;
				const preTokens = boundary.compact_metadata.pre_tokens;
				const trigger = boundary.compact_metadata.trigger;
				edithLog.info("compaction", { label, preTokens, trigger });

				if (reflector) {
					reflector.recordCompaction(preTokens, trigger);
					// Compaction reflection is critical — always fire
					await maybeInject("compaction");
				}
			}

			// --- Background agent task events ---
			if (message.type === "system" && "subtype" in message) {
				const subtype = message.subtype;

				if (subtype === "task_started") {
					const m = message as SDKTaskStartedMessage;
					edithLog.info("task_started", { label, taskId: m.task_id, description: m.description });
				}

				if (subtype === "task_progress") {
					const m = message as SDKTaskProgressMessage;
					edithLog.debug("task_progress", {
						label,
						taskId: m.task_id,
						tool: m.last_tool_name ?? "working",
						durationSecs: Math.round((m.usage?.duration_ms ?? 0) / 1000),
						toolUses: m.usage?.tool_uses ?? 0,
					});
				}

				if (subtype === "task_notification") {
					const m = message as SDKTaskNotificationMessage;
					const durSecs = m.usage?.duration_ms ? Math.round(m.usage.duration_ms / 1000) : 0;
					edithLog.info("task_complete", {
						label,
						taskId: m.task_id,
						status: m.status,
						summary: m.summary,
						duration: durSecs,
						toolUses: m.usage?.tool_uses,
					});
				}
			}

			// Count turns on assistant messages with tool use
			if (message.type === "assistant") {
				const assistantMsg = message as SDKAssistantMessage;
				const content = assistantMsg.message?.content;
				const blocks = (content as ContentBlock[] | undefined) ?? [];
				const toolUseBlocks = blocks.filter(
					(block): block is ToolUseBlock => block.type === "tool_use"
				);
				const hasToolUse = toolUseBlocks.length > 0;
				if (hasToolUse) turns++;

				// --- Reflector: feed tool uses + check triggers ---
				if (reflector && hasToolUse) {
					for (const block of toolUseBlocks) {
						const toolName = block.name ?? "";
						const toolInput = block.input ?? {};
						const inputPreview = JSON.stringify(toolInput).slice(0, 300);

						reflector.recordToolUse(toolName, inputPreview);

						// Guard irreversible actions
						if (reflector.shouldGuardTool(toolName, toolInput)) {
							await maybeInject("guard", { toolName, toolInput });
						}
					}

					// Periodic reflection on Nth tool call
					if (reflector.shouldReflectOnToolCall()) {
						await maybeInject("periodic");
					}
				}

				// Extract text for logging + reflector
				const textBlocks = blocks.filter((block): block is TextBlock => block.type === "text");
				if (textBlocks.length) {
					lastResult = textBlocks[textBlocks.length - 1].text ?? "";
					if (reflector) {
						reflector.recordText(lastResult);
					}
				}
			}

			// Extract result info
			if (message.type === "result") {
				const resultMsg = message as SDKResultMessage;
				totalCost = resultMsg.total_cost_usd ?? 0;
				turns = resultMsg.num_turns ?? turns;
				if ("modelUsage" in resultMsg) modelUsage = resultMsg.modelUsage ?? {};
				if ("duration_api_ms" in resultMsg)
					durationApiMs = ((resultMsg as Record<string, unknown>).duration_api_ms as number) ?? 0;
				if ("stop_reason" in resultMsg)
					stopReason = (resultMsg as Record<string, unknown>).stop_reason as string | null;

				if ("result" in resultMsg && typeof resultMsg.result === "string") {
					lastResult = resultMsg.result ?? lastResult;
				}

				// Check for errors
				if (resultMsg.is_error) {
					const errorSubtype = "subtype" in resultMsg ? resultMsg.subtype : "unknown";
					edithLog.error("sdk_result_error", { label, errorSubtype });

					// Detect corrupted session — flag for retry after cleanup
					if (errorSubtype === "error_during_execution" && sessionId && !opts._sessionRetried) {
						edithLog.warn("session_reset", { label, reason: errorSubtype });
						clearSession();
						needsRetry = true;
					}
				}
			}
		}
	} finally {
		setActiveQuery(null);
		setActiveSessionId("");
		activeProcesses.delete(pseudoPid);
		writeActiveProcesses();
	}

	return {
		lastResult,
		newSessionId,
		totalCost,
		turns,
		needsRetry,
		modelUsage,
		durationApiMs,
		stopReason,
	};
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
		edithLog.warn("dispatch_skipped", { label, reason: "circuit_breaker" });
		return "";
	}

	if (busy) {
		// Try streamInput injection if session is running — works for both messages and scheduled tasks
		if (getActiveQuery()) {
			const injected = await injectMessage(prompt, opts.chatId);
			if (injected) {
				edithLog.info("message_injected", { label, prompt: prompt.slice(0, 200) });
				return "injected";
			}
		}

		if (opts.skipIfBusy) {
			edithLog.info("dispatch_skipped", { label, reason: "busy" });
			return "";
		}
		edithLog.info("dispatch_queued", { label, queueSize: dispatchQueue.length + 1 });
		return new Promise((resolve) => {
			dispatchQueue.push({ prompt, opts, resolve });
		});
	}

	busy = true;
	const startTime = Date.now();
	let typingInterval: ReturnType<typeof setInterval> | null = null;
	const wakeId = `${label}-${Date.now()}`;
	let pseudoPid = 0;

	// AbortController for timeout — use shorter timeout for lightweight tasks
	const abortController = new AbortController();
	const timeoutMs = LIGHTWEIGHT_TASKS.has(label) ? LIGHTWEIGHT_TIMEOUT_MS : QUERY_TIMEOUT_MS;
	const timeoutHandle = setTimeout(() => {
		edithLog.error("dispatch_timeout", { label, timeoutMs });
		abortController.abort();
	}, timeoutMs);

	try {
		edithLog.info("dispatch_start", {
			label,
			session: resume ? sessionId : "ephemeral",
			briefType: opts.briefType,
			prompt: prompt.slice(0, 1000),
		});

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

		// Track as active process (unique ID)
		pseudoPid = ++pidCounter;
		activeProcesses.set(pseudoPid, {
			pid: pseudoPid,
			label,
			startedAt: new Date().toISOString(),
			prompt: prompt.slice(0, 200),
		});
		writeActiveProcesses();

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
		} = await processMessageStream(
			queryHandle,
			label,
			wakeId,
			resume,
			opts,
			pseudoPid,
			reflector,
			abortController
		);

		// Handle session retry — push to front of queue so finally block drains it
		if (needsRetry) {
			return new Promise<string>((retryResolve) => {
				dispatchQueue.unshift({
					prompt,
					opts: { ...opts, resume: true, label, _sessionRetried: true },
					resolve: retryResolve,
				});
			});
		}

		// Save session ID
		if (resume && newSessionId && newSessionId !== sessionId) {
			saveSession(newSessionId);
			edithLog.info("session_new", { label, sessionId: newSessionId.slice(0, 8) });
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
			prompt: prompt.slice(0, 1000),
			result: lastResult?.replace(/\n/g, " ").slice(0, 1000),
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

		if (totalCost) {
			edithLog.info("cost", { label, usd: totalCost });
		}

		// Reset circuit breaker on success
		consecutiveFailures = 0;

		return lastResult;
	} catch (err) {
		const errMsg = fmtErr(err);
		edithLog.error("dispatch_error", { label, error: errMsg });

		// Circuit breaker
		consecutiveFailures++;
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
			edithLog.error("circuit_breaker", {
				failures: consecutiveFailures,
				cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
			});
		}

		setActiveQuery(null);
		setActiveSessionId("");
		activeProcesses.delete(pseudoPid); // Clean up if inner finally didn't run
		writeActiveProcesses();
		return "";
	} finally {
		clearTimeout(timeoutHandle);
		if (typingInterval) clearInterval(typingInterval);
		busy = false;

		if (dispatchQueue.length > 0) {
			// Delay to allow MCP servers from previous dispatch to shut down (prevents Kuzu lock contention)
			await Bun.sleep(INTER_DISPATCH_DELAY_MS);
			const next = dispatchQueue.shift();
			if (next) {
				edithLog.info("dispatch_queue_drain", { remaining: dispatchQueue.length });
				dispatchToClaude(next.prompt, next.opts)
					.then(next.resolve)
					.catch(() => next.resolve(""));
			}
		}
	}
}

/**
 * Dispatch a conversation message — builds brief, dispatches to Claude.
 */
export async function dispatchToConversation(
	chatId: number,
	_messageId: number,
	message: string
): Promise<void> {
	const brief = await buildBrief("message", { message, chatId: String(chatId) });
	const result = await dispatchToClaude(brief, { resume: true, label: "message", chatId });

	// "injected" means streamInput was used — no need to check for errors
	if (result === "injected") return;

	// Note: empty result is normal — responses sent via tool calls (send_message)
	// produce no text output. Actual failures throw exceptions in dispatchToClaude
	// and are handled by the caller (bootstrap dead-letters on exception).
}
