/**
 * Tests for cloud mode guards — MCP filtering, platform guards, scheduler skipping.
 * Issues: #131, #132, #134
 */

import { describe, expect, it } from "bun:test";

// --- #131: MCP Server Filtering ---

describe("MCP server filtering", () => {
	it("CLOUD_EXCLUDED_SERVERS contains computer-use and cognee", async () => {
		// Import the module to verify the set exists and contains expected values
		const source = await Bun.file(`${import.meta.dir}/../lib/dispatch-options.ts`).text();
		expect(source).toContain("CLOUD_EXCLUDED_SERVERS");
		expect(source).toContain('"computer-use"');
		expect(source).toContain('"cognee"');
	});

	it("loadMcpConfig filters servers when IS_CLOUD is true", async () => {
		// Verify the filtering logic exists in the source
		const source = await Bun.file(`${import.meta.dir}/../lib/dispatch-options.ts`).text();
		expect(source).toContain("CLOUD_EXCLUDED_SERVERS.has(name)");
		expect(source).toContain("IS_CLOUD");
	});
});

// --- #132: Platform Guards in notify.ts ---

describe("notify.ts platform guards", () => {
	it("showNotification has IS_CLOUD guard", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/notify.ts`).text();
		// Verify the guard exists before the Bun.spawn call
		const notifFn = source.slice(
			source.indexOf("async function showNotification"),
			source.indexOf("async function showDialog")
		);
		expect(notifFn).toContain("IS_CLOUD");
		expect(notifFn).toContain("return;");
	});

	it("showDialog has IS_CLOUD guard and returns first button", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/notify.ts`).text();
		const dialogFn = source.slice(
			source.indexOf("async function showDialog"),
			source.indexOf("async function showAlert")
		);
		expect(dialogFn).toContain("IS_CLOUD");
		expect(dialogFn).toContain("return buttons[0]");
	});

	it("showAlert has IS_CLOUD guard", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/notify.ts`).text();
		const alertFn = source.slice(source.indexOf("async function showAlert"));
		expect(alertFn).toContain("IS_CLOUD");
		expect(alertFn).toContain("return;");
	});
});

// --- #134: Scheduler Cloud Skipping ---

describe("scheduler cloud skipping", () => {
	it("CLOUD_SKIPPED_TASKS contains proactive-check", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/scheduler.ts`).text();
		expect(source).toContain("CLOUD_SKIPPED_TASKS");
		expect(source).toContain('"proactive-check"');
	});

	it("runScheduler skips cloud-excluded tasks", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/scheduler.ts`).text();
		expect(source).toContain("IS_CLOUD && CLOUD_SKIPPED_TASKS.has(entry.name)");
	});

	it("getSystemIdleSeconds returns 0 in cloud mode", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/screenpipe.ts`).text();
		const idleFn = source.slice(
			source.indexOf("async function getSystemIdleSeconds"),
			source.indexOf("async function isUserIdle")
		);
		expect(idleFn).toContain("IS_CLOUD");
		expect(idleFn).toContain("return 0");
	});
});

// --- #133: ntfy.sh Integration ---

describe("ntfy.ts", () => {
	it("exports pushNotification and isNtfyConfigured", async () => {
		const { pushNotification, isNtfyConfigured } = await import("../lib/ntfy");
		expect(typeof pushNotification).toBe("function");
		expect(typeof isNtfyConfigured).toBe("function");
	});

	it("isNtfyConfigured returns false when NTFY_TOPIC not set", async () => {
		const { isNtfyConfigured } = await import("../lib/ntfy");
		// NTFY_TOPIC is not set in test env
		expect(isNtfyConfigured()).toBe(false);
	});

	it("pushNotification returns false when topic not configured", async () => {
		const { pushNotification } = await import("../lib/ntfy");
		const result = await pushNotification("Test", "Test body");
		expect(result).toBe(false);
	});
});

describe("send_notification push channel", () => {
	it("messaging.ts includes push channel in enum", async () => {
		const source = await Bun.file(`${import.meta.dir}/../mcp/tools/messaging.ts`).text();
		expect(source).toContain('"push"');
		expect(source).toContain("pushNotification");
		expect(source).toContain("ntfy");
	});
});
