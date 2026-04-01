/**
 * Message stream processor for the Agent SDK query() handle.
 *
 * Split from dispatch.ts — contains processMessageStream() and reflector injection.
 */

import type {
	Query,
	SDKAssistantMessage,
	SDKCompactBoundaryMessage,
	SDKResultMessage,
	SDKTaskNotificationMessage,
	SDKTaskProgressMessage,
	SDKTaskStartedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DispatchOptions } from "./dispatch-options";
import { edithLog } from "./edith-logger";
import type { ReflectorSession } from "./reflector";
import { injectMessage, setActiveQuery, setActiveSessionId } from "./session";
import { clearSession, sessionId } from "./state";
import { appendTranscript } from "./transcript";
import { fmtErr } from "./util";

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

// --- Stream result types ---

export interface ToolCallRecord {
	name: string;
	input: string; // JSON preview, max 500 chars
	durationMs?: number;
}

export interface StreamResult {
	lastResult: string;
	newSessionId: string;
	totalCost: number;
	turns: number;
	needsRetry: boolean;
	modelUsage: Record<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
		}
	>;
	durationApiMs: number;
	stopReason: string | null;
	toolCalls: ToolCallRecord[];
}

/** Consumes the Agent SDK query stream, tracking turns, cost, and session. */
export async function processMessageStream(
	queryHandle: Query,
	label: string,
	wakeId: string,
	resume: boolean,
	opts: DispatchOptions,
	_pseudoPid: number,
	reflector: ReflectorSession | null,
	_abortController?: AbortController,
	promptPreview?: string
): Promise<StreamResult> {
	let turns = 0;
	let lastResult = "";
	let newSessionId = "";
	let totalCost = 0;
	let needsRetry = false;
	let modelUsage: Record<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
		}
	> = {};
	let durationApiMs = 0;
	let stopReason: string | null = null;
	const toolCalls: ToolCallRecord[] = [];

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
			edithLog.error("reflector_inject_failed", {
				label,
				trigger,
				error: fmtErr(err),
				prompt: promptPreview,
			});
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

				// Record all tool calls for edithLog
				if (hasToolUse) {
					for (const block of toolUseBlocks) {
						const toolName = block.name ?? "";
						const toolInput = block.input ?? {};
						const inputPreview = JSON.stringify(toolInput).slice(0, 500);
						toolCalls.push({ name: toolName, input: inputPreview });
					}
				}

				// --- Reflector: feed tool uses + check triggers ---
				if (reflector && hasToolUse) {
					for (const block of toolUseBlocks) {
						const toolName = block.name ?? "";
						const toolInput = block.input ?? {};
						const inputPreview = JSON.stringify(toolInput).slice(0, 500);

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
					edithLog.error("sdk_result_error", {
						label,
						errorSubtype,
						result: lastResult.slice(0, 500),
						turns,
						cost: totalCost,
						prompt: promptPreview,
					});

					// Detect corrupted session — flag for retry after cleanup
					if (errorSubtype === "error_during_execution" && sessionId && !opts._sessionRetried) {
						edithLog.warn("session_reset", {
							label,
							reason: errorSubtype,
							sessionId: sessionId.slice(0, 8),
							errorResult: lastResult.slice(0, 300),
							prompt: promptPreview,
						});
						clearSession();
						needsRetry = true;
					}
				}
			}
		}
	} finally {
		setActiveQuery(null);
		setActiveSessionId("");
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
		toolCalls,
	};
}
