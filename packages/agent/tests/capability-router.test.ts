/**
 * Tests for capability router, WS protocol, and dispatch emissions.
 * Issues: #135, #136, #137
 */

import { describe, expect, it } from "bun:test";
import {
	type CapabilityResponse,
	CloudCapabilityRouter,
	LocalCapabilityRouter,
} from "../lib/capability-router";

describe("CloudCapabilityRouter", () => {
	it("rejects requests when no device is connected", async () => {
		const router = new CloudCapabilityRouter();
		// Not wired — sendToDevices returns false by default
		const result = await router.captureScreen();
		expect(result).toBeNull();
	});

	it("returns 0 idle seconds when no device connected", async () => {
		const router = new CloudCapabilityRouter();
		const idle = await router.getIdleSeconds();
		expect(idle).toBe(0);
	});

	it("returns empty screen context when no device connected", async () => {
		const router = new CloudCapabilityRouter();
		const ctx = await router.getScreenContext(15);
		expect(ctx.empty).toBe(true);
	});

	it("returns error for computer action when no device connected", async () => {
		const router = new CloudCapabilityRouter();
		const result = await router.executeComputerAction({ type: "screenshot" });
		expect(result.success).toBe(false);
		expect(result.error).toContain("No companion device");
	});

	it("resolves request when response arrives", async () => {
		const router = new CloudCapabilityRouter();
		const sentMessages: unknown[] = [];

		router.wire({
			sendToDevices: (msg) => {
				sentMessages.push(msg);
				return true;
			},
			isDeviceConnected: () => true,
		});

		// Start a screen capture request (don't await yet)
		const promise = router.captureScreen();

		// Simulate device response
		expect(sentMessages.length).toBe(1);
		const req = sentMessages[0] as { id: string };
		const response: CapabilityResponse = {
			type: "capability_response",
			id: req.id,
			result: { imageData: "base64screenshot" },
			ts: Date.now(),
		};
		router.handleResponse(response);

		const result = await promise;
		expect(result).toBe("base64screenshot");
	});

	it("times out after configured period", async () => {
		const router = new CloudCapabilityRouter();
		router.wire({
			sendToDevices: () => true,
			isDeviceConnected: () => true,
		});

		// getIdleSeconds has 5s timeout — use a shorter test
		// We test the timeout mechanism by not responding
		const start = Date.now();
		const result = await router.getIdleSeconds(); // 5s timeout, fallback to 0
		const elapsed = Date.now() - start;

		expect(result).toBe(0); // fallback
		expect(elapsed).toBeGreaterThanOrEqual(4000);
		expect(elapsed).toBeLessThan(10000);
	}, 15_000);

	it("isDeviceConnected returns false by default", () => {
		const router = new CloudCapabilityRouter();
		expect(router.isDeviceConnected()).toBe(false);
	});

	it("isDeviceConnected reflects wired state", () => {
		const router = new CloudCapabilityRouter();
		router.wire({
			sendToDevices: () => true,
			isDeviceConnected: () => true,
		});
		expect(router.isDeviceConnected()).toBe(true);
	});
});

describe("LocalCapabilityRouter", () => {
	it("isDeviceConnected returns false", () => {
		const router = new LocalCapabilityRouter();
		expect(router.isDeviceConnected()).toBe(false);
	});

	it("captureScreen returns null", async () => {
		const router = new LocalCapabilityRouter();
		const result = await router.captureScreen();
		expect(result).toBeNull();
	});

	it("executeComputerAction returns error", async () => {
		const router = new LocalCapabilityRouter();
		const result = await router.executeComputerAction({ type: "screenshot" });
		expect(result.success).toBe(false);
	});
});

describe("cloud-transport message types", () => {
	it("includes capability_request and capability_response in WsMessageType", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/cloud-transport.ts`).text();
		expect(source).toContain('"capability_request"');
		expect(source).toContain('"capability_response"');
	});

	it("exports registerDevice and unregisterDevice", async () => {
		const mod = await import("../lib/cloud-transport");
		expect(typeof mod.registerDevice).toBe("function");
		expect(typeof mod.unregisterDevice).toBe("function");
	});

	it("exports broadcastCapabilityRequest", async () => {
		const mod = await import("../lib/cloud-transport");
		expect(typeof mod.broadcastCapabilityRequest).toBe("function");
	});
});

describe("dispatch state emissions (#137)", () => {
	it("dispatch.ts imports emitAgentState", async () => {
		const source = await Bun.file(`${import.meta.dir}/../lib/dispatch.ts`).text();
		expect(source).toContain("emitAgentState");
		expect(source).toContain('emitState("thinking")');
		expect(source).toContain('emitState("idle")');
	});
});
