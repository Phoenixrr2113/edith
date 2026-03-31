import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logEvent } from "../../lib/state";
import { textResponse, jsonResponse } from "../../lib/mcp-helpers";
import { n8nPost } from "../../lib/n8n-client";

export function registerEmailTools(server: McpServer): void {
  // ============================================================
  // Email — manage_emails (get + manage + batch, one tool)
  // ============================================================

  server.registerTool("manage_emails", {
    description: "Unified Gmail tool. Action 'get' fetches recent emails. Actions 'archive', 'trash', 'markAsRead', 'addLabel', 'removeLabel' manage a single email by messageId. Use 'operations' array for batch management (up to 50). Prefer archive over trash — archive is reversible.",
    inputSchema: {
      action: z.enum(["get", "archive", "trash", "markAsRead", "addLabel", "removeLabel"]).default("get")
        .describe("What to do. Default: 'get' to fetch emails."),
      // Get params
      hoursBack: z.number().min(1).max(48).optional().describe("(get) Hours back to search. Default: 4"),
      unreadOnly: z.boolean().optional().describe("(get) Only unread emails. Default: true"),
      maxResults: z.number().min(1).max(20).optional().describe("(get) Max emails. Default: 10"),
      // Single manage params
      messageId: z.string().optional().describe("(manage) Gmail message ID from a previous get"),
      label: z.string().optional().describe("(addLabel/removeLabel) Label name"),
      // Batch params
      operations: z.array(z.object({
        messageId: z.string(),
        action: z.enum(["archive", "trash", "markAsRead", "addLabel", "removeLabel"]),
        label: z.string().optional(),
      })).max(50).optional().describe("(batch) Array of operations. Overrides single messageId/action."),
    },
  }, async ({ action, hoursBack, unreadOnly, maxResults, messageId, label, operations }) => {
    // Batch mode
    if (operations && operations.length > 0) {
      const result = await n8nPost("gmail", { action: "batch", operations });
      if (!result.ok) return textResponse(`Batch email error: ${result.error}`);
      logEvent("email_managed_batch", { count: operations.length, actions: [...new Set(operations.map(o => o.action))].join(",") });
      return jsonResponse(result.data ?? { success: true, count: operations.length });
    }

    // Get mode
    if (action === "get") {
      const params = { hoursBack: hoursBack ?? 4, unreadOnly: unreadOnly ?? true, maxResults: maxResults ?? 10 };
      const result = await n8nPost("gmail", params);
      if (!result.ok) return textResponse(`Gmail error: ${result.error}`);
      const data = result.data;
      if (data?.emails?.length > params.maxResults) {
        data.emails = data.emails.slice(0, params.maxResults);
        data.count = data.emails.length;
      }
      return jsonResponse(data);
    }

    // Single manage
    if (!messageId) return textResponse(`${action} requires a messageId`);
    if ((action === "addLabel" || action === "removeLabel") && !label) {
      return textResponse(`${action} requires a label name`);
    }
    const result = await n8nPost("gmail", { messageId, action, label });
    if (!result.ok) return textResponse(`Email manage error: ${result.error}`);
    logEvent("email_managed", { messageId, action, label });
    return textResponse(`Done: ${action} on ${messageId}`);
  });
}
