import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResponse } from "../../agent/lib/mcp-helpers";
import { loadSchedule, saveSchedule } from "../../agent/lib/storage";
import type { ScheduleEntry } from "../../agent/lib/mcp-types";

export function registerScheduleTools(server: McpServer): void {
	// ============================================================
	// Schedule
	// ============================================================

	server.registerTool(
		"list_scheduled_tasks",
		{
			description: "List all scheduled tasks that edith.ts runs on a timer",
		},
		async () => {
			const tasks = loadSchedule();
			if (tasks.length === 0) return textResponse("No scheduled tasks.");
			const lines = tasks.map((t) => {
				if (t.intervalMinutes) return `- ${t.name}: every ${t.intervalMinutes}min`;
				return `- ${t.name}: daily at ${String(t.hour ?? 0).padStart(2, "0")}:${String(t.minute ?? 0).padStart(2, "0")}`;
			});
			return textResponse(lines.join("\n"));
		}
	);

	server.registerTool(
		"add_scheduled_task",
		{
			description:
				"Add a new scheduled task. Specify either hour+minute for daily tasks, or intervalMinutes for recurring.",
			inputSchema: {
				name: z.string().describe("Unique task name"),
				prompt: z.string().describe("The prompt or skill to run"),
				hour: z.number().min(0).max(23).optional(),
				minute: z.number().min(0).max(59).optional(),
				intervalMinutes: z.number().min(1).max(1440).optional(),
			},
		},
		async ({ name: taskName, prompt, hour, minute, intervalMinutes }) => {
			const tasks = loadSchedule();
			const existing = tasks.findIndex((t) => t.name === taskName);
			const entry: ScheduleEntry = { name: taskName, prompt };
			if (intervalMinutes != null) entry.intervalMinutes = intervalMinutes;
			else {
				entry.hour = hour ?? 9;
				entry.minute = minute ?? 0;
			}
			if (existing >= 0) tasks[existing] = entry;
			else tasks.push(entry);
			saveSchedule(tasks);
			return textResponse(`Scheduled: ${taskName}`);
		}
	);

	server.registerTool(
		"remove_scheduled_task",
		{
			description: "Remove a scheduled task by name",
			inputSchema: { name: z.string().describe("Name of the task to remove") },
		},
		async ({ name: taskName }) => {
			const tasks = loadSchedule();
			const filtered = tasks.filter((t) => t.name !== taskName);
			if (filtered.length === tasks.length) return textResponse(`Task not found: ${taskName}`);
			saveSchedule(filtered);
			return textResponse(`Removed: ${taskName}`);
		}
	);
}
