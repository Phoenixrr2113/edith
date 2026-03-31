/**
 * Caffeinate — prevent macOS sleep while Edith is running.
 */
import { spawn } from "node:child_process";
import { edithLog } from "./edith-logger";

let caffeinateProc: ReturnType<typeof spawn> | null = null;

export function startCaffeinate(): void {
	try {
		caffeinateProc = spawn("caffeinate", ["-dis", "-w", String(process.pid)], { stdio: "ignore" });
		edithLog.info("caffeinate_started", { pid: caffeinateProc.pid });
		caffeinateProc.on("error", () => {
			edithLog.warn("caffeinate_unavailable", { message: "system may sleep" });
		});
	} catch {
		edithLog.warn("caffeinate_unavailable", { message: "system may sleep" });
	}
}

export function stopCaffeinate(): void {
	if (caffeinateProc) {
		caffeinateProc.kill();
		caffeinateProc = null;
		edithLog.info("caffeinate_stopped", {});
	}
}
