import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { batchManage, manageEmail, searchEmails } from "../../lib/gmail";
import { jsonResponse, textResponse } from "../../lib/mcp-helpers";
import { logEvent } from "../../lib/state";

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
				query: z
					.string()
					.optional()
					.describe("(get) Raw Gmail search query (overrides hoursBack/unreadOnly)"),
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
				try {
					const data = await batchManage(
						operations as Array<{
							messageId: string;
							action: "archive" | "trash" | "markAsRead" | "addLabel" | "removeLabel";
							label?: string;
						}>
					);
					logEvent("email_managed_batch", {
						count: operations.length,
						actions: [...new Set(operations.map((o) => o.action))].join(","),
					});
					return jsonResponse(data ?? { success: true, count: operations.length });
				} catch (err) {
					return textResponse(
						`Batch email error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// ── Get mode ────────────────────────────────────────────────────────────
			if (action === "get") {
				try {
					const data = await searchEmails({
						hoursBack: hoursBack ?? 4,
						unreadOnly: unreadOnly ?? true,
						maxResults: maxResults ?? 10,
						query,
					});
					return jsonResponse(data);
				} catch (err) {
					return textResponse(`Gmail error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			// ── Single manage ───────────────────────────────────────────────────────
			if (!messageId) return textResponse(`${action} requires a messageId`);
			if ((action === "addLabel" || action === "removeLabel") && !label) {
				return textResponse(`${action} requires a label name`);
			}
			try {
				await manageEmail(
					messageId,
					action as "archive" | "trash" | "markAsRead" | "addLabel" | "removeLabel",
					label
				);
				logEvent("email_managed", { messageId, action, label });
				return textResponse(`Done: ${action} on ${messageId}`);
			} catch (err) {
				return textResponse(
					`Email manage error: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	);
}
