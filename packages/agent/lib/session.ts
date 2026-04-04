/**
 * Session management — tracks the active Agent SDK query handle.
 * Enables message injection via streamInput() when Edith is busy.
 *
 * Design: docs/design-session-management.md
 *
 * This module is intentionally stateless with respect to persistence.
 * All in-memory state is correct: it must be null/empty after any restart
 * or redeploy. Persistent session IDs live in lib/state.ts (SQLite-backed).
 *
 * Cloud safety:
 *   - No file I/O in this module.
 *   - activeQuery is always null after a redeploy — injectMessage() returns false gracefully.
 *   - activeSessionId is in-memory only — cleared on dispatch end.
 *
 * Multi-user note:
 *   Currently single-user. For multi-user, these would become Maps keyed by userId.
 *   See docs/design-session-management.md § User Isolation.
 */

import { randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { edithLog } from "./edith-logger";
import { fmtErr } from "./util";

let activeQuery: Query | null = null;
let activeSessionId: string = "";

/** Set (or clear) the active Agent SDK query handle for the current dispatch. */
export function setActiveQuery(q: Query | null): void {
	activeQuery = q;
}

/** Get the active Agent SDK query handle, or null if no dispatch is running. */
export function getActiveQuery(): Query | null {
	return activeQuery;
}

/**
 * Set the current Agent SDK session ID (in-memory only).
 * Called by processMessageStream() as session_id arrives in the stream.
 * Cleared when dispatch ends. Does NOT persist — use state.ts#saveSession() for that.
 */
export function setActiveSessionId(id: string): void {
	activeSessionId = id;
}

/**
 * Get the current in-memory session ID.
 * Only valid while a dispatch is running. Empty string otherwise.
 */
export function getActiveSessionId(): string {
	return activeSessionId;
}

/** True if a dispatch is currently in progress (activeQuery is set). */
export function isSessionRunning(): boolean {
	return activeQuery !== null;
}

/**
 * Inject a user message into the active session via streamInput().
 * Returns true if injection succeeded, false if no active session.
 */
export async function injectMessage(text: string, _chatId?: number): Promise<boolean> {
	if (!activeQuery) return false;

	try {
		const message: SDKUserMessage = {
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			timestamp: new Date().toISOString(),
			session_id: activeSessionId,
			uuid: randomUUID(),
		};

		// Create a single-item async iterable
		async function* singleMessage() {
			yield message;
		}

		if (typeof activeQuery.streamInput !== "function") {
			edithLog.debug("session_inject_unavailable", {
				reason: "streamInput not available in this SDK version",
			});
			return false;
		}
		await activeQuery.streamInput(singleMessage());
		edithLog.info("session_message_injected", { preview: text.slice(0, 80) });
		return true;
	} catch (err) {
		edithLog.error("session_stream_input_failed", {
			error: fmtErr(err),
			inputPreview: text.slice(0, 200),
			hasActiveQuery: !!activeQuery,
			sessionId: activeSessionId?.slice(0, 8),
		});
		return false;
	}
}
