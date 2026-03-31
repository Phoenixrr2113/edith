/**
 * screen-query.ts — Query the cloud backend about current or recent screen context.
 *
 * queryScreen(question)             — sends current screen context + question
 * queryRecentCaptures(question, n)  — queries against the last n stored captures
 *
 * Both functions send a screen_query WebSocket message (device → cloud) and
 * return a Promise that resolves with the server's answer (a text message)
 * or rejects after a timeout.
 */

import { captureStore } from "./capture-store.js";
import type { AnyWsMessage, EdithWsClient, WsTextMessage } from "./ws-client.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScreenQueryMessage {
	type: "screen_query";
	id: string;
	question: string;
	/** Base64 image of the current frame (optional — omitted for recent-captures queries). */
	imageData?: string;
	/** Recent captured frames for context (base64 strings, most-recent first). */
	recentCaptures?: string[];
	ts: number;
}

export interface ScreenQueryResult {
	answer: string;
	/** The query message id that produced this result. */
	queryId: string;
}

// Timeout (ms) to wait for a cloud response before rejecting.
const QUERY_TIMEOUT_MS = 30_000;

// ── queryScreen ────────────────────────────────────────────────────────────────

/**
 * Ask a question about what is currently on screen.
 *
 * @param wsClient  Live EdithWsClient instance.
 * @param question  Natural-language question (e.g. "what app is open?").
 * @param imageData Optional base64 screenshot (caller supplies current frame).
 *                  If omitted the cloud uses whatever it last received.
 */
export async function queryScreen(
	wsClient: EdithWsClient,
	question: string,
	imageData?: string
): Promise<ScreenQueryResult> {
	const id = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	const msg: ScreenQueryMessage = {
		type: "screen_query",
		id,
		question,
		imageData,
		ts: Date.now(),
	};

	return _sendAndAwait(wsClient, msg, id);
}

// ── queryRecentCaptures ────────────────────────────────────────────────────────

/**
 * Ask a question against the device's locally stored recent captures.
 *
 * @param wsClient  Live EdithWsClient instance.
 * @param question  Natural-language question.
 * @param count     How many recent screen captures to attach (default: 5).
 */
export async function queryRecentCaptures(
	wsClient: EdithWsClient,
	question: string,
	count = 5
): Promise<ScreenQueryResult> {
	const id = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	// Pull stored captures from the local capture store
	const stored = captureStore.getRecentCaptures("screen", count);
	const recentCaptures = stored.map((c) => c.data);

	const msg: ScreenQueryMessage = {
		type: "screen_query",
		id,
		question,
		recentCaptures: recentCaptures.length > 0 ? recentCaptures : undefined,
		ts: Date.now(),
	};

	return _sendAndAwait(wsClient, msg, id);
}

// ── Internal ───────────────────────────────────────────────────────────────────

/**
 * Send a screen_query message and wait for a matching response from the cloud.
 *
 * The cloud should reply with a `message` whose text contains the answer.
 * We match by listening for the next incoming `message` that references our
 * query id — or simply the first message that arrives within the timeout.
 *
 * NOTE: A more robust correlation mechanism (e.g. echoing the id in the reply)
 * would require cloud-side changes.  For now we use a simple "next message"
 * heuristic which is sufficient while queries are low-frequency.
 */
function _sendAndAwait(
	wsClient: EdithWsClient,
	msg: ScreenQueryMessage,
	id: string
): Promise<ScreenQueryResult> {
	return new Promise<ScreenQueryResult>((resolve, reject) => {
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout>;

		const unsub = wsClient.on("message", (incoming: AnyWsMessage) => {
			if (settled) return;

			if (incoming.type === "message") {
				const text = (incoming as WsTextMessage).text;
				settled = true;
				clearTimeout(timeoutHandle);
				unsub();
				resolve({ answer: text, queryId: id });
			}
		});

		timeoutHandle = setTimeout(() => {
			if (!settled) {
				settled = true;
				unsub();
				reject(new Error(`[screen-query] Timeout waiting for response to query ${id}`));
			}
		}, QUERY_TIMEOUT_MS);

		// Send after registering the listener to avoid a race
		wsClient.send(msg as Parameters<typeof wsClient.send>[0]);
	});
}
