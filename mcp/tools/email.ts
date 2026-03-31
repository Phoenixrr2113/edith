import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResponse, textResponse } from "../../lib/mcp-helpers";
import { batchManage, manageEmail, searchEmails } from "../../lib/gmail";
import { n8nPost } from "../../lib/n8n-client";
import { logEvent } from "../../lib/state";

// ── Helper: run Gmail directly, fall back to n8n on auth/config errors ────────

async function withGmailFallback<T>(
	gmailFn: () => Promise<T>,
	n8nFn: () => Promise<{ ok: boolean; data?: unknown; error?: string }>
): Promise<{ ok: boolean; data?: T | unknown; error?: string }> {
	try {
		const data = await gmailFn();
		return { ok: true, data };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// If Google auth isn't configured, silently fall back to n8n
		if (msg.includes("Google OAuth not configured") || msg.includes("token refresh failed")) {
			return n8nFn();
		}
		// Real Gmail API error — surface it
		return { ok: false, error: msg };
	}
}

// ============================================================
// Email — manage_emails (get + manage + batch, one tool)
// ============================================================

export function registerEmailTools(server: McpServer): void {
	server.registerTool(
		"manage_emails",
		{
			description:
				"Unified Gmail tool. Action 'get' fetches recent emails. Actions 'archive', 'trash', 'markAsRead', 'addLabel', 'removeLabel' manage a single email by messageId. Use 'operations' array for batch management (up to 50). Prefer archive over trash — archive is reversible.",
			inputSchema: {
				action: z
					.enum(["get", "archive", "trash", "markAsRead", "addLabel", "removeLabel"])
					.default("get")
					.describe("What to do. Default: 'get' to fetch emails."),
				// Get params
				hoursBack: z
					.number()
					.min(1)
					.max(48)
					.optional()
					.describe("(get) Hours back to search. Default: 4"),
				unreadOnly: z.boolean().optional().describe("(get) Only unread emails. Default: true"),
				maxResults: z.number().min(1).max(50).optional().describe("(get) Max emails. Default: 10"),
				query: z.string().optional().describe("(get) Raw Gmail search query (overrides hoursBack/unreadOnly)"),
				// Single manage params
				messageId: z.string().optional().describe("(manage) Gmail message ID from a previous get"),
				label: z.string().optional().describe("(addLabel/removeLabel) Label name"),
				// Batch params
				operations: z
					.array(
						z.object({
							messageId: z.string(),
							action: z.enum(["archive", "trash", "markAsRead", "addLabel", "removeLabel"]),
							label: z.string().optional(),
						})
					)
					.max(50)
					.optional()
					.describe("(batch) Array of operations. Overrides single messageId/action."),
			},
		},
		async ({ action, hoursBack, unreadOnly, maxResults, query, messageId, label, operations }) => {
			// ── Batch mode ──────────────────────────────────────────────────────────
			if (operations && operations.length > 0) {
				const result = await withGmailFallback(
					() => batchManage(operations as Array<{ messageId: string; action: "archive" | "trash" | "markAsRead" | "addLabel" | "removeLabel"; label?: string }>),
					() => n8nPost("gmail", { action: "batch", operations })
				);
				if (!result.ok) return textResponse(`Batch email error: ${result.error}`);
				logEvent("email_managed_batch", {
					count: operations.length,
					actions: [...new Set(operations.map((o) => o.action))].join(","),
				});
				return jsonResponse(result.data ?? { success: true, count: operations.length });
			}

			// ── Get mode ────────────────────────────────────────────────────────────
			if (action === "get") {
				const params = {
					hoursBack: hoursBack ?? 4,
					unreadOnly: unreadOnly ?? true,
					maxResults: maxResults ?? 10,
					query,
				};
				const result = await withGmailFallback(
					() => searchEmails(params),
					() => n8nPost("gmail", { hoursBack: params.hoursBack, unreadOnly: params.unreadOnly, maxResults: params.maxResults })
				);
				if (!result.ok) return textResponse(`Gmail error: ${result.error}`);
				return jsonResponse(result.data);
			}

			// ── Single manage ───────────────────────────────────────────────────────
			if (!messageId) return textResponse(`${action} requires a messageId`);
			if ((action === "addLabel" || action === "removeLabel") && !label) {
				return textResponse(`${action} requires a label name`);
			}
			const result = await withGmailFallback(
				() => manageEmail(messageId, action as "archive" | "trash" | "markAsRead" | "addLabel" | "removeLabel", label),
				() => n8nPost("gmail", { messageId, action, label })
			);
			if (!result.ok) return textResponse(`Email manage error: ${result.error}`);
			logEvent("email_managed", { messageId, action, label });
			return textResponse(`Done: ${action} on ${messageId}`);
		}
	);
}
