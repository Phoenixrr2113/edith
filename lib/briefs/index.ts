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
	buildWeekendBrief,
	buildWeeklyReviewBrief,
	buildMonthlyReviewBrief,
	buildQuarterlyReviewBrief,
} from "./scheduled";

export type BriefType =
	| "boot"
	| "morning"
	| "midday"
	| "evening"
	| "weekend"
	| "weekly"
	| "monthly"
	| "quarterly"
	| "message"
	| "location"
	| "scheduled"
	| "proactive";

/** Map task names to brief types for known scheduled tasks. */
export const BRIEF_TYPE_MAP: Record<string, BriefType> = {
	"morning-brief": "morning",
	"midday-check": "midday",
	"evening-wrap": "evening",
	"weekend-brief": "weekend",
	"weekly-review": "weekly",
	"monthly-review": "monthly",
	"quarterly-review": "quarterly",
	"check-reminders": "scheduled",
	"proactive-check": "proactive",
};

/** Routing table: brief type → agent + model + skill name. */
export interface SkillRoute {
	agent: "communicator" | "researcher" | "analyst" | "monitor";
	model: "sonnet" | "haiku" | "opus";
	skill: string | null;
}

export const SKILL_ROUTING: Record<BriefType, SkillRoute> = {
	boot:      { agent: "communicator", model: "sonnet", skill: "morning-brief" },
	morning:   { agent: "communicator", model: "sonnet", skill: "morning-brief" },
	midday:    { agent: "communicator", model: "sonnet", skill: "midday-check" },
	evening:   { agent: "communicator", model: "sonnet", skill: "evening-wrap" },
	weekend:   { agent: "communicator", model: "sonnet", skill: "weekend-brief" },
	weekly:    { agent: "analyst",      model: "sonnet", skill: "weekly-review" },
	monthly:   { agent: "analyst",      model: "sonnet", skill: "monthly-review" },
	quarterly: { agent: "analyst",      model: "opus",   skill: "quarterly-review" },
	message:   { agent: "communicator", model: "sonnet", skill: null },
	location:  { agent: "communicator", model: "sonnet", skill: null },
	scheduled: { agent: "monitor",      model: "haiku",  skill: "reminder-check" },
	proactive: { agent: "monitor",      model: "haiku",  skill: "proactive-check" },
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
		case "weekend":
			return buildWeekendBrief();
		case "weekly":
			return buildWeeklyReviewBrief();
		case "monthly":
			return buildMonthlyReviewBrief();
		case "quarterly":
			return buildQuarterlyReviewBrief();
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
	buildWeekendBrief,
	buildWeeklyReviewBrief,
	buildMonthlyReviewBrief,
	buildQuarterlyReviewBrief,
} from "./scheduled";
