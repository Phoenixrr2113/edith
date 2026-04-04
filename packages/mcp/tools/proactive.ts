import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResponse } from "../../agent/lib/mcp-helpers";
import {
	canIntervene,
	getInterventionHistory,
	recordIntervention,
} from "../../agent/lib/proactive";

export function registerProactiveTools(server: McpServer): void {
	// ============================================================
	// Proactive Intelligence
	// ============================================================

	server.registerTool(
		"proactive_history",
		{
			description:
				"Check what proactive interventions Edith has already made recently. Use before making a new proactive suggestion to avoid repeating yourself.",
			inputSchema: {
				hours: z
					.number()
					.min(1)
					.max(24)
					.default(4)
					.describe("Hours of history to check (default: 4)"),
			},
		},
		async ({ hours }) => {
			const history = getInterventionHistory(hours);
			if (history.length === 0) return textResponse("No recent interventions.");
			const lines = history.map(
				(i) =>
					`- ${new Date(i.timestamp).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} [${i.category}] ${i.message}`
			);
			return textResponse(lines.join("\n"));
		}
	);

	server.registerTool(
		"record_intervention",
		{
			description:
				"Record that a proactive intervention was made. Call this AFTER sending a proactive notification or message, so Edith tracks it for rate limiting.",
			inputSchema: {
				category: z
					.string()
					.describe(
						"Intervention category (e.g. 'meeting-prep', 'break-reminder', 'email-help', 'error-help', 'calendar-conflict')"
					),
				message: z.string().describe("Brief description of what was suggested"),
			},
		},
		async ({ category, message }) => {
			const check = canIntervene(category);
			if (!check.allowed) {
				return textResponse(`Intervention blocked: ${check.reason}`);
			}
			recordIntervention(category, message);
			return textResponse(`Recorded: [${category}] ${message.slice(0, 80)}`);
		}
	);
}
