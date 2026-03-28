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
