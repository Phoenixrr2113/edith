/**
 * Barrel re-export — keeps the public API stable.
 * All callers importing from './briefs' continue to work without changes.
 */
import { CHAT_ID } from "../config";
import { buildLocationBrief, buildMessageBrief } from "./conversation";
import { buildProactiveBrief } from "./proactive";
import {
	buildEveningBrief,
	buildFullBrief,
	buildMiddayBrief,
	buildScheduledBrief,
} from "./scheduled";

export type BriefType =
	| "boot"
	| "morning"
	| "midday"
	| "evening"
	| "message"
	| "location"
	| "scheduled"
	| "proactive";

/** Map task names to brief types for known scheduled tasks. */
export const BRIEF_TYPE_MAP: Record<string, BriefType> = {
	"morning-brief": "morning",
	"midday-check": "midday",
	"evening-wrap": "evening",
	"proactive-check": "proactive",
};

/**
 * Build the prompt for a given wake reason.
 */
export async function buildBrief(type: BriefType, extra?: Record<string, string>): Promise<string> {
	switch (type) {
		case "boot":
		case "morning":
			return buildFullBrief(type);
		case "midday":
			return buildMiddayBrief();
		case "evening":
			return buildEveningBrief();
		case "message":
			return buildMessageBrief(extra?.message ?? "", extra?.chatId ?? String(CHAT_ID));
		case "location":
			return buildLocationBrief(
				extra?.description ?? "",
				extra?.lat ?? "",
				extra?.lon ?? "",
				extra?.chatId ?? String(CHAT_ID)
			);
		case "scheduled":
			return buildScheduledBrief(extra?.prompt ?? "", extra?.taskName ?? "");
		case "proactive":
			return buildProactiveBrief();
		default:
			return extra?.prompt ?? "";
	}
}

export { buildLocationBrief, buildMessageBrief } from "./conversation";
export { buildProactiveBrief, detectTriggers, gatherScreenContext } from "./proactive";
// Re-export sub-module symbols for direct access
export {
	buildEveningBrief,
	buildFullBrief,
	buildMiddayBrief,
	buildScheduledBrief,
} from "./scheduled";
