/**
 * Conversation brief builders — simple string builders, no async deps.
 */
import { getRecentTaskboardEntries } from "../taskboard";

export function buildMessageBrief(message: string, chatId: string): string {
  const taskboard = getRecentTaskboardEntries();
  const contextBlock = taskboard
    ? `\n[Recent taskboard context]\n${taskboard}\n[End taskboard context]\n`
    : "";

  return `${message}\n${contextBlock}\nBefore responding:\n1. Search Cognee for relevant context about this topic\n2. If this is a task, DO it — don't describe what you'd do\n3. If you learn new info (people, decisions, preferences), store it in Cognee\n\n[Reply using the send_message tool with chat_id ${chatId}. Keep it under 5 lines unless more detail is needed.]`;
}

export function buildLocationBrief(description: string, lat: string, lon: string, chatId: string): string {
  return `[Location update] ${description}. Coordinates: ${lat}, ${lon}. Chat ID: ${chatId}. Note this for context.`;
}
