import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResponse } from "../../lib/mcp-helpers";
import { createEdithTask, listEdithTasks, updateEdithTask } from "../../lib/storage";

export function registerTaskTools(server: McpServer): void {
	server.registerTool(
		"create_edith_task",
		{
			description:
				"Create a follow-up task for Edith to work on later. Use this when you find something actionable during a brief or conversation that can't be done right now. The proactive loop will pick it up and execute it.",
			inputSchema: {
				text: z.string().describe("What needs to be done — clear, actionable description"),
				prompt: z
					.string()
					.optional()
					.describe("Optional detailed prompt for when the task is executed"),
				due_at: z
					.string()
					.optional()
					.describe("ISO 8601 timestamp for when this task is due (optional)"),
				context: z
					.string()
					.optional()
					.describe("Why this task was created — what triggered it, what brief found it"),
				created_by: z
					.string()
					.optional()
					.describe("Which skill/brief created this task (e.g. morning-brief, message)"),
			},
		},
		async ({ text, prompt, due_at, context, created_by }) => {
			try {
				const task = createEdithTask({
					text,
					prompt: prompt ?? undefined,
					dueAt: due_at ?? undefined,
					context: context ?? undefined,
					createdBy: created_by ?? undefined,
				});
				return textResponse(
					`Task created: ${task.id}\n- ${task.text}${task.dueAt ? `\n- Due: ${task.dueAt}` : ""}`
				);
			} catch (err) {
				return textResponse(
					`Error creating task: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	);

	server.registerTool(
		"list_edith_tasks",
		{
			description:
				"List Edith's self-assigned tasks (default: all non-done including pending, in_progress, failed)",
			inputSchema: {
				status: z
					.enum(["pending", "in_progress", "done", "failed"])
					.optional()
					.describe("Filter by status (default: all non-done tasks)"),
			},
		},
		async ({ status }) => {
			try {
				const tasks = listEdithTasks(status);
				if (tasks.length === 0) return textResponse("No tasks.");
				const lines = tasks.map(
					(t) =>
						`- [${t.status}] ${t.text}${t.dueAt ? ` (due: ${t.dueAt})` : ""}${t.createdBy ? ` [from: ${t.createdBy}]` : ""}`
				);
				return textResponse(lines.join("\n"));
			} catch (err) {
				return textResponse(
					`Error listing tasks: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	);

	server.registerTool(
		"update_edith_task",
		{
			description: "Update a task's status or details",
			inputSchema: {
				id: z.string().describe("Task ID"),
				status: z
					.enum(["pending", "in_progress", "done", "failed"])
					.optional()
					.describe("New status"),
				context: z.string().optional().describe("Add context about what was done or why it failed"),
			},
		},
		async ({ id, status, context }) => {
			try {
				updateEdithTask(id, { status, context });
				return textResponse(`Task ${id} updated${status ? ` → ${status}` : ""}`);
			} catch (err) {
				return textResponse(
					`Error updating task: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	);
}
