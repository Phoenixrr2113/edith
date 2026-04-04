import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRecentActivity, readActivity } from "../../agent/lib/activity";
import { textResponse } from "../../agent/lib/mcp-helpers";

export function registerActivityTools(server: McpServer): void {
	// ============================================================
	// Activity Log
	// ============================================================

	server.registerTool(
		"get_activity",
		{
			description:
				"Get Randy's activity log — what he was doing on a given day or over recent days. Use for questions like 'what did I do today/yesterday/this week/last month'.",
			inputSchema: {
				days: z
					.number()
					.default(1)
					.describe(
						"Number of days to look back (default: 1 for today only, 7 for a week, 30 for a month)"
					),
			},
		},
		async ({ days }) => {
			if (days <= 1) {
				const content = readActivity();
				return textResponse(content || "No activity recorded today yet.");
			}
			return textResponse(getRecentActivity(days));
		}
	);
}
