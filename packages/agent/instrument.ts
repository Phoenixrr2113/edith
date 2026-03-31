/**
 * Sentry instrumentation — loaded via `bun --preload` before all other modules.
 *
 * This MUST be the first code that runs. It initializes Sentry error monitoring,
 * tracing, and logging before any application code is imported.
 *
 * Set SENTRY_DSN in .env. If not set, Sentry silently no-ops.
 */
import * as Sentry from "@sentry/bun";

Sentry.init({
	dsn: process.env.SENTRY_DSN,

	sendDefaultPii: true,

	environment: process.env.NODE_ENV ?? "production",

	// 100% in dev, 10% in production
	tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

	enableLogs: true,
});
