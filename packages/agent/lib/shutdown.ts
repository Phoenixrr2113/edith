/**
 * Graceful shutdown — signal handlers and cleanup.
 */

import { stopCaffeinate } from "./caffeinate";
import { CHAT_ID } from "./config";
import { dispatchQueue } from "./dispatch";
import { edithLog } from "./edith-logger";
import { getActiveQuery } from "./session";
import { saveDeadLetter } from "./state";

export function registerShutdownHandlers(opts: {
	isCloud: boolean;
	getHttpServer: () => ReturnType<typeof Bun.serve> | null;
}): void {
	async function gracefulShutdown(): Promise<void> {
		const activeQuery = getActiveQuery();
		if (activeQuery) {
			edithLog.info("shutdown_closing_session", {});
			try {
				activeQuery.close();
			} catch {}
		}

		if (dispatchQueue.length > 0) {
			edithLog.info("shutdown_draining_queue", { count: dispatchQueue.length });
			for (const job of dispatchQueue.drainAll()) {
				saveDeadLetter((job.opts.chatId as number) ?? CHAT_ID, job.prompt, "shutdown_drain");
			}
		}

		if (!opts.isCloud) stopCaffeinate();
		const httpServer = opts.getHttpServer();
		if (httpServer) httpServer.stop();
		await edithLog.flush();
		process.exit(0);
	}

	process.on("SIGINT", gracefulShutdown);
	process.on("SIGTERM", gracefulShutdown);

	process.on("uncaughtException", (err: Error) => {
		edithLog.fatal("uncaught_exception", { error: err.message, err });
		gracefulShutdown();
	});

	process.on("unhandledRejection", (reason: unknown) => {
		edithLog.error("unhandled_rejection", {
			error: reason instanceof Error ? reason.message : String(reason),
			...(reason instanceof Error ? { err: reason } : {}),
		});
	});
}
