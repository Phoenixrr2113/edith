/**
 * MCP response helpers — kills the { content: [{ type: "text" as const, text: ... }] } boilerplate.
 */

export function textResponse(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

export function jsonResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
