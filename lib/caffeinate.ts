/**
 * Caffeinate — prevent macOS sleep while Edith is running.
 */
import { spawn } from "child_process";

let caffeinateProc: ReturnType<typeof spawn> | null = null;

export function startCaffeinate(): void {
  try {
    caffeinateProc = spawn("caffeinate", ["-dis"], { stdio: "ignore" });
    console.log(`[edith] caffeinate started (pid ${caffeinateProc.pid}) — preventing display, idle, and system sleep`);
    caffeinateProc.on("error", () => {
      console.warn("[edith] caffeinate not available — system may sleep");
    });
  } catch {
    console.warn("[edith] caffeinate not available — system may sleep");
  }
}

export function stopCaffeinate(): void {
  if (caffeinateProc) {
    caffeinateProc.kill();
    caffeinateProc = null;
    console.log("[edith] caffeinate stopped");
  }
}
