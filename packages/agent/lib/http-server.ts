/**
 * HTTP server for cloud mode — health endpoint, Telegram webhook, WebSocket.
 */

import type {
	WsClientData,
	WsConnectedMessage,
	WsErrorMessage,
	WsInputMessage,
} from "./cloud-transport";
import { CHAT_ID } from "./config";
import { dispatchToConversation } from "./dispatch";
import { edithLog } from "./edith-logger";
import { fmtErr } from "./util";

export async function startHttpServer(
	port: number,
	webhookSecret: string,
	onUpdate: (update: Record<string, unknown>) => Promise<void>
): Promise<ReturnType<typeof Bun.serve>> {
	const { authenticateUpgrade, makeWsMessage } = await import("./cloud-transport");

	// biome-ignore lint/suspicious/noExplicitAny: Bun WS type not yet publicly exported
	const connectedDevices = new Map<string, any>();

	const server = Bun.serve<WsClientData>({
		port,

		async fetch(req, srv) {
			const url = new URL(req.url);

			if (url.pathname === "/health") {
				return new Response(
					JSON.stringify({
						status: "ok",
						uptime: Math.floor(process.uptime()),
						devices: connectedDevices.size,
						ts: Date.now(),
					}),
					{ headers: { "Content-Type": "application/json" } }
				);
			}

			// ── Telegram webhook ──────
			if (url.pathname === `/webhook/${webhookSecret}` && req.method === "POST") {
				const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
				if (secretHeader && secretHeader !== webhookSecret) {
					return new Response("Forbidden", { status: 403 });
				}

				try {
					const update = (await req.json()) as Record<string, unknown>;
					onUpdate(update).catch((err) => {
						edithLog.error("webhook_process_error", { error: fmtErr(err) });
					});
					return new Response("ok", { status: 200 });
				} catch {
					return new Response("Bad Request", { status: 400 });
				}
			}

			if (url.pathname === "/ws") {
				const deviceId = await authenticateUpgrade(req);
				if (!deviceId) return new Response("Unauthorized", { status: 401 });
				const upgraded = srv.upgrade(req, {
					data: { deviceId, connectedAt: Date.now(), lastPingAt: Date.now() },
				});
				return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
			}

			return new Response("Edith Cloud", { status: 200 });
		},

		websocket: {
			open(ws) {
				const { deviceId } = ws.data;
				connectedDevices.set(deviceId, ws);
				edithLog.info("device_connected", { deviceId, total: connectedDevices.size });
				ws.send(
					JSON.stringify(
						makeWsMessage<WsConnectedMessage>({
							type: "connected",
							deviceId,
							serverVersion: "3.0.0",
						})
					)
				);
			},

			message(ws, raw) {
				ws.data.lastPingAt = Date.now();
				const { deviceId } = ws.data;
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<
						string,
						unknown
					>;
				} catch {
					ws.send(
						JSON.stringify(
							makeWsMessage<WsErrorMessage>({
								type: "error",
								code: "BAD_MESSAGE",
								message: "Invalid JSON",
							})
						)
					);
					return;
				}

				if (msg.type === "ping") {
					ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
					return;
				}

				if (msg.type === "input") {
					const input = msg as unknown as WsInputMessage;
					edithLog.info("ws_device_input", {
						deviceId,
						preview: String(input.text).slice(0, 80),
					});
					dispatchToConversation(CHAT_ID, 0, input.text).catch((err) => {
						edithLog.error("ws_dispatch_failed", { deviceId, error: fmtErr(err) });
					});
					return;
				}

				edithLog.warn("ws_unhandled_message", { deviceId, messageType: msg.type });
			},

			close(ws, code, reason) {
				const { deviceId } = ws.data;
				connectedDevices.delete(deviceId);
				edithLog.info("device_disconnected", {
					deviceId,
					code,
					reason: reason?.toString(),
					remaining: connectedDevices.size,
				});
			},
		},
	});

	edithLog.info("http_server_listening", { port });
	return server;
}
