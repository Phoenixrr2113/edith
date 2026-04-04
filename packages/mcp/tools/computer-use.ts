/**
 * Computer use MCP tool — routes through capability router to companion app.
 *
 * In cloud mode, actions are sent via WebSocket to the desktop companion.
 * In local mode, returns an error (use the dedicated computer-use MCP server instead).
 *
 * Issue: #139
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { capabilityRouter } from "../../agent/lib/capability-router";
import { textResponse } from "../../agent/lib/mcp-helpers";

export function registerComputerUseTools(server: McpServer): void {
	server.registerTool(
		"computer_use",
		{
			description:
				"Execute a computer automation action on Randy's desktop via the companion app. Requires companion to be connected. Actions: click, type, press (keyboard shortcut), launch (app), screenshot.",
			inputSchema: {
				action: z
					.enum([
						"click",
						"double_click",
						"right_click",
						"move",
						"type",
						"press",
						"launch",
						"screenshot",
					])
					.describe("Action to perform"),
				x: z.number().optional().describe("X coordinate (for click/move actions)"),
				y: z.number().optional().describe("Y coordinate (for click/move actions)"),
				text: z
					.string()
					.optional()
					.describe("Text to type (for type action) or key combo (for press action, e.g. 'cmd+c')"),
				app: z.string().optional().describe("App name or bundle ID (for launch action)"),
			},
		},
		async ({ action, x, y, text, app }) => {
			if (!capabilityRouter.isDeviceConnected()) {
				return textResponse(
					"No companion device connected. Computer use requires the Edith desktop app to be running and connected."
				);
			}

			const result = await capabilityRouter.executeComputerAction({
				type: action,
				x,
				y,
				text,
				app,
			});

			if (!result.success) {
				return textResponse(`Computer action failed: ${result.error}`);
			}

			if (result.screenshot) {
				return textResponse(
					`Action completed. Screenshot captured (${result.screenshot.length} chars base64).`
				);
			}

			return textResponse(
				`Action completed: ${action}${result.stdout ? ` — ${result.stdout}` : ""}`
			);
		}
	);
}
