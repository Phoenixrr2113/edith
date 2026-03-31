/**
 * Telegram API helpers — shared between edith.ts and mcp/server.ts.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TELEGRAM_BOT_TOKEN as BOT_TOKEN, INBOX_DIR } from "./config";

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

export async function tgCall(method: string, body?: Record<string, unknown>): Promise<unknown> {
	const res = await fetch(`${TG}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json();
	if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
	return json.result;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
	const chunks = [];
	for (let i = 0; i < text.length; i += 4096) {
		chunks.push(text.slice(i, i + 4096));
	}
	for (const chunk of chunks) {
		try {
			await tgCall("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "Markdown" });
		} catch {
			await tgCall("sendMessage", { chat_id: chatId, text: chunk });
		}
	}
}

export async function sendTyping(chatId: number): Promise<void> {
	try {
		await tgCall("sendChatAction", { chat_id: chatId, action: "typing" });
	} catch {}
}

export async function sendPhoto(
	chatId: number,
	photoData: string,
	caption?: string
): Promise<void> {
	const base64Match = photoData.match(/^data:image\/(\w+);base64,(.+)$/);
	if (!base64Match) throw new Error("Invalid image data format");

	const [, , base64Data] = base64Match;
	const imageBuffer = Buffer.from(base64Data, "base64");
	const formData = new FormData();
	formData.append("chat_id", String(chatId));
	formData.append("photo", new Blob([imageBuffer]), "image.png");
	if (caption) formData.append("caption", caption);

	const res = await fetch(`${TG}/sendPhoto`, { method: "POST", body: formData });
	const json = await res.json();
	if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description}`);
}

export async function downloadFile(fileId: string, ext: string): Promise<string> {
	const fileInfo = (await tgCall("getFile", { file_id: fileId })) as { file_path?: string };
	const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
	const res = await fetch(url);
	const buf = await res.arrayBuffer();
	const localPath = join(INBOX_DIR, `${Date.now()}.${ext}`);
	writeFileSync(localPath, Buffer.from(buf));
	return localPath;
}

export async function transcribeAudio(filePath: string): Promise<string> {
	const providers = [
		{ url: "https://api.groq.com/openai/v1/audio/transcriptions", key: process.env.GROQ_API_KEY },
		{ url: "https://api.openai.com/v1/audio/transcriptions", key: process.env.OPENAI_API_KEY },
	];

	for (const { url, key } of providers) {
		if (!key) continue;
		try {
			// Create fresh FormData for each attempt (body stream is consumed after fetch)
			const formData = new FormData();
			formData.append("file", Bun.file(filePath));
			formData.append("model", "whisper-large-v3");
			const res = await fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}` },
				body: formData,
			});
			if (res.ok) {
				const data = await res.json();
				return data.text ?? "";
			}
		} catch {}
	}
	return "";
}
