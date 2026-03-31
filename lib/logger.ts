/**
 * Structured logging via BetterStack (Logtail).
 *
 * Falls back to console when BETTERSTACK_SOURCE_TOKEN is not set.
 * Heartbeat pings sent via pingHeartbeat() from the scheduler tick.
 */
import { Logtail } from "@logtail/node";
import * as Sentry from "@sentry/bun";

const token = process.env.BETTERSTACK_SOURCE_TOKEN;
const heartbeatUrl = process.env.BETTERSTACK_HEARTBEAT_URL;

const logtail = token ? new Logtail(token) : null;

export const logger = {
	info(message: string, context?: Record<string, unknown>) {
		if (logtail) logtail.info(message, context);
		console.log(message, context ? JSON.stringify(context) : "");
	},
	warn(message: string, context?: Record<string, unknown>) {
		if (logtail) logtail.warn(message, context);
		console.warn(message, context ? JSON.stringify(context) : "");
	},
	error(message: string, context?: Record<string, unknown>) {
		if (logtail) logtail.error(message, context);
		console.error(message, context ? JSON.stringify(context) : "");
		// If context contains an actual Error, send it with full stack trace
		const err = context
			? Object.values(context).find((v) => v instanceof Error)
			: undefined;
		if (err instanceof Error) {
			Sentry.captureException(err, { extra: { message, ...context } });
		} else {
			Sentry.captureMessage(message, { level: "error", extra: context });
		}
	},
	flush() {
		return logtail?.flush();
	},
};

export async function pingHeartbeat() {
	if (!heartbeatUrl) return;
	try {
		await fetch(heartbeatUrl, { method: "HEAD" });
	} catch {}
}
