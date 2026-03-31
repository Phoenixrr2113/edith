/**
 * MCP tool: query_logs — lets Edith (or Claude) query her own event logs.
 *
 * Supports filtering by type, level, time range, caller function, and full-text search.
 * Supports aggregations: count_by_type, count_by_level, error_summary, top_callers, hourly_volume.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryEvents } from "../../lib/edith-logger";
import { jsonResponse, textResponse } from "../../lib/mcp-helpers";

export function registerLogTools(server: McpServer): void {
	server.registerTool(
		"query_logs",
		{
			description: `Query Edith's structured event logs. Supports filtering and aggregations.

Filters (all optional, combine freely):
- type: event type like "dispatch_error", "message_received" (comma-separated for multiple)
- level: minimum log level — "trace", "debug", "info", "warn", "error", "fatal"
- timeRange: "last_hour", "last_6h", "last_24h", "last_48h", or "start_iso,end_iso"
- caller: substring match on the calling function name (e.g. "dispatch" matches "dispatchToClaude")
- search: full-text search across all event fields

Aggregations (returns grouped counts instead of raw events):
- "count_by_type" — event counts grouped by type
- "count_by_level" — counts grouped by log level
- "error_summary" — errors grouped by caller function with count + last seen
- "top_callers" — top 20 most active functions
- "hourly_volume" — event volume per hour

Examples:
- Errors in last hour: type="dispatch_error", timeRange="last_hour"
- What functions fail most: aggregate="error_summary", timeRange="last_24h"
- All dispatch activity: search="dispatch", timeRange="last_6h"`,
			inputSchema: {
				type: z.string().optional().describe("Event type filter (exact or comma-separated)"),
				level: z
					.enum(["trace", "debug", "info", "warn", "error", "fatal"])
					.optional()
					.describe("Minimum log level"),
				timeRange: z
					.string()
					.optional()
					.describe(
						'Time range: "last_hour", "last_6h", "last_24h", "last_48h", or "start_iso,end_iso"'
					),
				caller: z.string().optional().describe("Substring match on caller function name"),
				search: z.string().optional().describe("Full-text search across all fields"),
				limit: z.number().optional().default(50).describe("Max events to return (default 50)"),
				offset: z.number().optional().default(0).describe("Pagination offset"),
				aggregate: z
					.enum([
						"count_by_type",
						"count_by_level",
						"error_summary",
						"top_callers",
						"hourly_volume",
					])
					.optional()
					.describe("Aggregation mode — returns grouped data instead of raw events"),
			},
		},
		async ({ type, level, timeRange, caller, search, limit, offset, aggregate }) => {
			try {
				const result = queryEvents({
					type,
					level,
					timeRange,
					caller,
					search,
					limit,
					offset,
					aggregate,
				});
				return jsonResponse(result);
			} catch (err) {
				return textResponse(`Error querying logs: ${err}`);
			}
		}
	);
}
