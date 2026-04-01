/**
 * Tests for lib/handlers.ts — handleLocation, handleVoice, handlePhoto, handleText.
 *
 * Strategy: use Bun's mock.module() to replace all external dependencies with
 * controllable fakes. Each describe block exercises one handler's logic paths.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Shared mock state ─────────────────────────────────────────────────────────

// Captured calls
const calls = {
	sendMessage: [] as [number, string][],
	markFired: [] as string[][],
	dispatchToClaude: [] as [string, object][],
	dispatchToConversation: [] as [number, number, string][],
	downloadFile: [] as [string, string][],
	transcribeAudio: [] as string[],
	buildBrief: [] as [string, object][],
	logEvent: [] as [string, object][],
};

// Return values (overridable per test)
let downloadFileResult = "/tmp/test-file.ogg";
let downloadFileError: Error | null = null;
let transcribeAudioResult: string | null = "Hello from Randy";
let checkLocationRemindersResult: {
	reminder: { id: string; text: string };
	locationLabel: string;
}[] = [];
let checkTimeRemindersResult: { id: string; text: string }[] = [];
let checkLocationTransitionsResult: {
	type: "arrived" | "departed";
	locationName: string;
	locationLabel: string;
}[] = [];
let canInterveneResult = { allowed: true, reason: undefined as string | undefined };
let buildBriefResult = "location brief content";

function resetCalls() {
	calls.sendMessage = [];
	calls.markFired = [];
	calls.dispatchToClaude = [];
	calls.dispatchToConversation = [];
	calls.downloadFile = [];
	calls.transcribeAudio = [];
	calls.buildBrief = [];
	calls.logEvent = [];
}

function resetResults() {
	downloadFileResult = "/tmp/test-file.ogg";
	downloadFileError = null;
	transcribeAudioResult = "Hello from Randy";
	checkLocationRemindersResult = [];
	checkTimeRemindersResult = [];
	checkLocationTransitionsResult = [];
	canInterveneResult = { allowed: true, reason: undefined };
	buildBriefResult = "location brief content";
}

// ─── Mock modules (must be called before any handler import) ──────────────────

mock.module("../lib/telegram", () => ({
	sendMessage: async (chatId: number, text: string) => {
		calls.sendMessage.push([chatId, text]);
	},
	downloadFile: async (fileId: string, ext: string) => {
		calls.downloadFile.push([fileId, ext]);
		if (downloadFileError) throw downloadFileError;
		return downloadFileResult;
	},
	transcribeAudio: async (path: string) => {
		calls.transcribeAudio.push(path);
		return transcribeAudioResult;
	},
}));

mock.module("../lib/dispatch", () => ({
	dispatchToClaude: async (prompt: string, opts: object) => {
		calls.dispatchToClaude.push([prompt, opts]);
	},
	dispatchToConversation: async (chatId: number, messageId: number, content: string) => {
		calls.dispatchToConversation.push([chatId, messageId, content]);
	},
	Priority: { P0_CRITICAL: 0, P1_USER: 1, P2_INTERACTIVE: 2, P3_BACKGROUND: 3 },
}));

mock.module("../lib/geo", () => ({
	checkLocationReminders: (_lat: number, _lon: number) => {
		return checkLocationRemindersResult;
	},
	checkTimeReminders: () => {
		return checkTimeRemindersResult;
	},
	checkLocationTransitions: (_lat: number, _lon: number) => {
		return checkLocationTransitionsResult;
	},
	markFired: (ids: string[]) => {
		calls.markFired.push(ids);
	},
}));

mock.module("../lib/briefs", () => ({
	buildBrief: async (type: string, context: object) => {
		calls.buildBrief.push([type, context]);
		return buildBriefResult;
	},
}));

mock.module("../lib/proactive", () => ({
	canIntervene: (_category: string) => {
		return canInterveneResult;
	},
}));

mock.module("../lib/state", () => ({
	logEvent: (type: string, data: object) => {
		calls.logEvent.push([type, data]);
	},
}));

// edith-logger — used directly by handlers.ts; capture calls for assertions
mock.module("../lib/edith-logger", () => ({
	edithLog: {
		info: (type: string, data: object) => {
			calls.logEvent.push([type, data]);
		},
		warn: (type: string, data: object) => {
			calls.logEvent.push([type, data]);
		},
		error: (type: string, data: object) => {
			calls.logEvent.push([type, data]);
		},
		debug: () => {},
		event: () => {},
	},
}));

// Config — provide a stable CHAT_ID for the SMS handler
mock.module("../lib/config", () => ({
	CHAT_ID: 12345,
	EVENTS_FILE: "/tmp/test-events.jsonl",
	EVENTS_MAX_AGE_MS: 48 * 60 * 60 * 1000,
	STATE_DIR: "/tmp/test-state",
}));

mock.module("../lib/util", () => ({
	fmtErr: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// ─── Import handlers after mocks are in place ─────────────────────────────────

const { handleLocation, handleVoice, handlePhoto, handleText } = await import("../lib/handlers");

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
	resetCalls();
	resetResults();
});

// ─── handleLocation ───────────────────────────────────────────────────────────

describe("handleLocation", () => {
	test("does nothing when no reminders and no transitions", async () => {
		await handleLocation(999, 40.7128, -74.006);

		expect(calls.sendMessage).toHaveLength(0);
		expect(calls.markFired).toHaveLength(0);
		expect(calls.dispatchToClaude).toHaveLength(0);
		expect(calls.buildBrief).toHaveLength(0);
	});

	test("sends message and marks fired for a single location reminder", async () => {
		checkLocationRemindersResult = [
			{ reminder: { id: "rem-1", text: "Pick up groceries" }, locationLabel: "Whole Foods" },
		];

		await handleLocation(999, 40.7128, -74.006);

		expect(calls.sendMessage).toHaveLength(1);
		expect(calls.sendMessage[0][0]).toBe(999);
		expect(calls.sendMessage[0][1]).toContain("Whole Foods");
		expect(calls.sendMessage[0][1]).toContain("Pick up groceries");
		expect(calls.markFired).toHaveLength(1);
		expect(calls.markFired[0]).toEqual(["rem-1"]);
	});

	test("sends messages for multiple location reminders and marks all fired", async () => {
		checkLocationRemindersResult = [
			{ reminder: { id: "rem-a", text: "Reminder A" }, locationLabel: "Store" },
			{ reminder: { id: "rem-b", text: "Reminder B" }, locationLabel: "Store" },
		];

		await handleLocation(999, 40.7128, -74.006);

		expect(calls.sendMessage).toHaveLength(2);
		expect(calls.markFired).toHaveLength(1);
		expect(calls.markFired[0]).toEqual(["rem-a", "rem-b"]);
	});

	test("sends message and marks fired for time reminders", async () => {
		checkTimeRemindersResult = [{ id: "t-1", text: "Call dentist" }];

		await handleLocation(999, 40.7128, -74.006);

		expect(calls.sendMessage).toHaveLength(1);
		expect(calls.sendMessage[0][1]).toContain("Call dentist");
		expect(calls.markFired).toHaveLength(1);
		expect(calls.markFired[0]).toEqual(["t-1"]);
	});

	test("marks fired separately for location and time reminders", async () => {
		checkLocationRemindersResult = [
			{ reminder: { id: "loc-1", text: "Location reminder" }, locationLabel: "Home" },
		];
		checkTimeRemindersResult = [{ id: "time-1", text: "Time reminder" }];

		await handleLocation(999, 40.7128, -74.006);

		expect(calls.sendMessage).toHaveLength(2);
		expect(calls.markFired).toHaveLength(2);
		expect(calls.markFired[0]).toEqual(["loc-1"]);
		expect(calls.markFired[1]).toEqual(["time-1"]);
	});

	test("calls buildBrief and dispatchToClaude when transitions detected and gate allows", async () => {
		checkLocationTransitionsResult = [
			{ type: "arrived", locationName: "home", locationLabel: "Home" },
		];

		await handleLocation(999, 40.7128, -74.006);

		expect(calls.buildBrief).toHaveLength(1);
		expect(calls.buildBrief[0][0]).toBe("location");
		expect(calls.dispatchToClaude).toHaveLength(1);
		expect(calls.dispatchToClaude[0][0]).toBe(buildBriefResult);
		expect((calls.dispatchToClaude[0][1] as any).label).toBe("location");
		expect((calls.dispatchToClaude[0][1] as any).briefType).toBe("location");
	});

	test("skips dispatch when canIntervene returns not allowed", async () => {
		checkLocationTransitionsResult = [
			{ type: "arrived", locationName: "home", locationLabel: "Home" },
		];
		canInterveneResult = { allowed: false, reason: "quiet hours" };

		await handleLocation(999, 40.7128, -74.006);

		expect(calls.buildBrief).toHaveLength(0);
		expect(calls.dispatchToClaude).toHaveLength(0);
	});

	test("includes arrived emoji in brief description", async () => {
		checkLocationTransitionsResult = [
			{ type: "arrived", locationName: "home", locationLabel: "Home" },
		];

		await handleLocation(999, 40.0, -70.0);

		expect(calls.buildBrief).toHaveLength(1);
		const context = calls.buildBrief[0][1] as any;
		expect(context.description).toContain("Arrived at Home");
	});

	test("includes departed description in brief context", async () => {
		checkLocationTransitionsResult = [
			{ type: "departed", locationName: "office", locationLabel: "Office" },
		];

		await handleLocation(999, 40.0, -70.0);

		const context = calls.buildBrief[0][1] as any;
		expect(context.description).toContain("Left Office");
	});

	test("passes lat/lon/chatId as strings to buildBrief context", async () => {
		checkLocationTransitionsResult = [
			{ type: "arrived", locationName: "gym", locationLabel: "Gym" },
		];

		await handleLocation(777, 37.5, -122.3);

		const context = calls.buildBrief[0][1] as any;
		expect(context.lat).toBe("37.5");
		expect(context.lon).toBe("-122.3");
		expect(context.chatId).toBe("777");
	});
});

// ─── handleVoice ──────────────────────────────────────────────────────────────

describe("handleVoice", () => {
	test("downloads file, transcribes, and dispatches transcription", async () => {
		downloadFileResult = "/tmp/voice-abc.ogg";
		transcribeAudioResult = "Pick up milk";

		await handleVoice(999, 42, "file-id-123");

		expect(calls.downloadFile).toHaveLength(1);
		expect(calls.downloadFile[0][0]).toBe("file-id-123");
		expect(calls.downloadFile[0][1]).toBe("ogg");

		expect(calls.transcribeAudio).toHaveLength(1);
		expect(calls.transcribeAudio[0]).toBe("/tmp/voice-abc.ogg");

		expect(calls.dispatchToConversation).toHaveLength(1);
		expect(calls.dispatchToConversation[0][0]).toBe(999);
		expect(calls.dispatchToConversation[0][1]).toBe(42);
		expect(calls.dispatchToConversation[0][2]).toContain("Pick up milk");
		expect(calls.dispatchToConversation[0][2]).toContain("[Voice note from Randy]");
	});

	test("wraps transcription in correct format", async () => {
		transcribeAudioResult = "Some transcribed words";

		await handleVoice(1, 1, "fid");

		const content = calls.dispatchToConversation[0][2];
		expect(content).toBe(`[Voice note from Randy] "Some transcribed words"`);
	});

	test("falls back to file path message when transcription is null", async () => {
		downloadFileResult = "/tmp/audio.ogg";
		transcribeAudioResult = null;

		await handleVoice(999, 5, "file-xyz");

		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("[Voice note from Randy]");
		expect(content).toContain("/tmp/audio.ogg");
		expect(content).toContain("Could not transcribe");
	});

	test("dispatches error message when downloadFile throws", async () => {
		downloadFileError = new Error("network timeout");

		await handleVoice(999, 8, "bad-file-id");

		expect(calls.dispatchToConversation).toHaveLength(1);
		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("[Voice note from Randy]");
		expect(content).toContain("Failed to download/transcribe");
		expect(content).toContain("network timeout");
	});

	test("logs voice_transcribed event on success", async () => {
		await handleVoice(999, 10, "file-1");

		expect(calls.logEvent).toHaveLength(1);
		expect(calls.logEvent[0][0]).toBe("voice_transcribed");
	});

	test("logs error event when downloadFile throws", async () => {
		downloadFileError = new Error("fail");

		await handleVoice(999, 11, "file-fail");

		expect(calls.logEvent).toHaveLength(1);
		expect(calls.logEvent[0][0]).toBe("voice_processing_failed");
	});

	test("passes correct chatId and messageId to dispatchToConversation", async () => {
		await handleVoice(888, 55, "fid");

		expect(calls.dispatchToConversation[0][0]).toBe(888);
		expect(calls.dispatchToConversation[0][1]).toBe(55);
	});
});

// ─── handlePhoto ──────────────────────────────────────────────────────────────

describe("handlePhoto", () => {
	test("downloads jpg and dispatches with local path", async () => {
		downloadFileResult = "/tmp/photo-abc.jpg";

		await handlePhoto(999, 7, "photo-file-id", "");

		expect(calls.downloadFile).toHaveLength(1);
		expect(calls.downloadFile[0][0]).toBe("photo-file-id");
		expect(calls.downloadFile[0][1]).toBe("jpg");

		expect(calls.dispatchToConversation).toHaveLength(1);
		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("[Photo from Randy]");
		expect(content).toContain("/tmp/photo-abc.jpg");
	});

	test("includes caption in dispatch when provided", async () => {
		downloadFileResult = "/tmp/photo.jpg";

		await handlePhoto(999, 7, "photo-id", "My dog at the beach");

		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("Caption: My dog at the beach");
	});

	test("omits caption section when caption is empty string", async () => {
		downloadFileResult = "/tmp/photo.jpg";

		await handlePhoto(999, 7, "photo-id", "");

		const content = calls.dispatchToConversation[0][2];
		expect(content).not.toContain("Caption:");
	});

	test("dispatches error message when downloadFile throws", async () => {
		downloadFileError = new Error("download failed");

		await handlePhoto(999, 9, "bad-photo-id", "");

		expect(calls.dispatchToConversation).toHaveLength(1);
		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("[Photo from Randy]");
		expect(content).toContain("Failed to download");
		expect(content).toContain("download failed");
	});

	test("passes correct chatId and messageId to dispatchToConversation", async () => {
		await handlePhoto(444, 22, "fid", "");

		expect(calls.dispatchToConversation[0][0]).toBe(444);
		expect(calls.dispatchToConversation[0][1]).toBe(22);
	});
});

// ─── handleText ───────────────────────────────────────────────────────────────

describe("handleText", () => {
	test("wraps with [Message from Randy] prefix when isSmsBot=false", async () => {
		await handleText(999, 3, "What time is it?", false);

		expect(calls.dispatchToConversation).toHaveLength(1);
		const content = calls.dispatchToConversation[0][2];
		expect(content).toBe("[Message from Randy via Telegram] What time is it?");
	});

	test("passes correct chatId and messageId when isSmsBot=false", async () => {
		await handleText(777, 11, "Hello", false);

		expect(calls.dispatchToConversation[0][0]).toBe(777);
		expect(calls.dispatchToConversation[0][1]).toBe(11);
	});

	test("wraps with SMS triage instructions when isSmsBot=true", async () => {
		await handleText(999, 5, "Your verification code is 123456", true);

		expect(calls.dispatchToConversation).toHaveLength(1);
		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("[Incoming SMS forwarded by relay bot]");
		expect(content).toContain("Your verification code is 123456");
		expect(content).toContain("[Triage this:");
	});

	test("SMS triage includes store/ignore/forward instructions", async () => {
		await handleText(999, 5, "Hey", true);

		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("Cognee");
		expect(content).toContain("send_message");
		expect(content).toContain("spam");
	});

	test("SMS triage includes Chat ID in instructions", async () => {
		await handleText(999, 5, "Hi", true);

		const content = calls.dispatchToConversation[0][2];
		expect(content).toContain("Chat ID: 12345");
	});

	test("does not include SMS prefix when isSmsBot=false", async () => {
		await handleText(999, 3, "Direct message", false);

		const content = calls.dispatchToConversation[0][2];
		expect(content).not.toContain("[Incoming SMS");
		expect(content).not.toContain("[Triage this:");
	});

	test("passes correct chatId and messageId when isSmsBot=true", async () => {
		await handleText(888, 99, "SMS text", true);

		expect(calls.dispatchToConversation[0][0]).toBe(888);
		expect(calls.dispatchToConversation[0][1]).toBe(99);
	});
});
