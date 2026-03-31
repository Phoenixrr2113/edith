/** Shared types between edith.ts, lib/, and mcp/server.ts */

export interface ScheduleEntry {
	name: string;
	prompt: string;
	hour?: number;
	minute?: number;
	intervalMinutes?: number;
	/** Hour (0-23) when this task should stop firing. Wraps past midnight (e.g., 21 = 9 PM). */
	quietStart?: number;
	/** Hour (0-23) when this task resumes firing (e.g., 7 = 7 AM). */
	quietEnd?: number;
	/** Days of week this task runs. 0=Sun, 1=Mon, ..., 6=Sat. Omit for every day. */
	daysOfWeek?: number[];
	/** Day of month (1-31) for monthly tasks. Omit for non-monthly. */
	dayOfMonth?: number;
	/** Months (1-12) for quarterly/annual tasks. Omit for non-monthly. */
	months?: number[];
}

export interface LocationEntry {
	name: string;
	label: string;
	lat: number;
	lon: number;
	radiusMeters: number;
}

export interface Reminder {
	id: string;
	text: string;
	type: "location" | "time";
	location?: string;
	radiusMeters?: number;
	fireAt?: string;
	fired: boolean;
	created: string;
}
