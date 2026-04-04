import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDoc } from "../../agent/lib/gdocs";
import { generateImages } from "../../agent/lib/gemini";
import { jsonResponse, textResponse } from "../../agent/lib/mcp-helpers";
import { fmtErr } from "../../agent/lib/util";

export function registerDocsTools(server: McpServer): void {
	// ============================================================
	// Google Docs
	// ============================================================

	server.registerTool(
		"manage_docs",
		{
			description:
				"Create a Google Doc. Returns a shareable URL accessible from any device. Use this for reviews, briefs, prep notes — anything Randy needs to read on his phone.",
			inputSchema: {
				title: z.string().describe("Document title"),
				content: z.string().describe("Document content (plain text or markdown)"),
				folderId: z
					.string()
					.optional()
					.describe("Google Drive folder ID (optional, defaults to root)"),
			},
		},
		async ({ title, content, folderId }) => {
			try {
				const result = await createDoc(title, content, folderId);
				return jsonResponse({
					ok: true,
					docId: result.docId,
					docUrl: result.docUrl,
					name: result.name,
				});
			} catch (err) {
				return textResponse(`Failed to create doc: ${fmtErr(err)}`);
			}
		}
	);

	// ============================================================
	// Image generation
	// ============================================================

	server.registerTool(
		"generate_image",
		{
			description:
				"Generate an image using Google's Imagen AI. Returns base64 data URL to send via Telegram.",
			inputSchema: {
				prompt: z.string().describe("Text description of the image to generate"),
				numberOfImages: z
					.number()
					.min(1)
					.max(4)
					.default(1)
					.describe("Number of images (default: 1)"),
			},
		},
		async ({ prompt, numberOfImages }) => {
			try {
				const images = await generateImages(prompt, numberOfImages);
				if (images.length === 0)
					return textResponse("No images generated. Check prompt or API quota.");
				return jsonResponse({ success: true, count: images.length, images, prompt });
			} catch (err) {
				return textResponse(`Image generation failed: ${fmtErr(err)}`);
			}
		}
	);
}
