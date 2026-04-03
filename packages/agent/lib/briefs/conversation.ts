/**
 * Conversation brief builders — simple string builders, no async deps.
 */
import { getRecentTaskboardEntries } from "../taskboard";

export function buildMessageBrief(message: string, _chatId?: string): string {
	const taskboard = getRecentTaskboardEntries();
	const contextBlock = taskboard
		? `\n[Recent taskboard context]\n${taskboard}\n[End taskboard context]\n`
		: "";

	return `${message}\n${contextBlock}\nBefore responding:\n1. Search CodeGraph knowledge for relevant context about this topic\n2. If this is a task, DO it — don't describe what you'd do\n3. If you learn new info (people, decisions, preferences), store it in CodeGraph knowledge\n\n[Reply using the send_message tool. Keep it under 5 lines unless more detail is needed.]`;
}

export function buildLocationBrief(
	description: string,
	lat: string,
	lon: string,
	_chatId?: string
): string {
	return `[Location update] ${description}. Coordinates: ${lat}, ${lon}. Note this for context.`;
}
