/**
 * Edith MCP tool server.
 * Slim entrypoint — tool logic lives in mcp/tools/*.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerActivityTools } from "./tools/activity";
import { registerCalendarTools } from "./tools/calendar";
import { registerDocsTools } from "./tools/docs";
import { registerEmailTools } from "./tools/email";
import { registerLocationTools } from "./tools/location";
import { registerMessagingTools } from "./tools/messaging";
import { registerProactiveTools } from "./tools/proactive";
import { registerScheduleTools } from "./tools/schedule";

// --- MCP Server ---
const server = new McpServer(
	{ name: "edith", version: "0.1.0" },
	{
		instructions: `You are Edith, a personal assistant. Messages arrive from Randy via Telegram.
Respond using the "send_message" tool with the chat_id from the message context. Be direct and concise.
You can manage scheduled tasks, reminders, locations, emails, and calendar using the provided tools.`,
	}
);

// Register all tool domains
registerMessagingTools(server);
registerScheduleTools(server);
registerLocationTools(server);
registerEmailTools(server);
registerCalendarTools(server);
registerDocsTools(server);
registerProactiveTools(server);
registerActivityTools(server);

// ============================================================
// Start
// ============================================================
const transport = new StdioServerTransport();
await server.connect(transport);
