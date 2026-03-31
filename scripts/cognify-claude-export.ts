#!/usr/bin/env bun
/**
 * Import Claude conversation export into Cognee.
 *
 * Filters for conversations with personal/life content,
 * extracts human messages, chunks them, and cognifies each batch.
 *
 * Usage: bun scripts/cognify-claude-export.ts /path/to/export/folder
 */

const COGNEE_URL = process.env.COGNEE_URL ?? "http://localhost:8001";
const BATCH_CHAR_LIMIT = 8000; // ~2K tokens per cognify call
const DELAY_BETWEEN_BATCHES_MS = 5000; // don't hammer Cognee

const PERSONAL_KEYWORDS = [
	"phoenix",
	"diana",
	"family",
	"house",
	"health",
	"weight",
	"gym",
	"drink",
	"japan",
	"anime",
	"real estate",
	"rental",
	"mortgage",
	"bradenton",
	"sarasota",
	"edith",
	"codegraph",
	"capsule",
	"blog",
	"conference",
	"cfp",
	"career",
	"publix",
	"timeshare",
	"westgate",
	"court",
	"custody",
	"school",
	"budget",
	"savings",
	"investment",
	"parenting",
	"adhd",
	"goals",
	"travel",
	"driving",
	"relationship",
	"wedding",
	"birthday",
];

interface ConversationExport {
	uuid: string;
	name: string;
	created_at: string;
	chat_messages: Array<{
		sender: string;
		content: Array<{ type: string; text?: string }>;
	}>;
}

function extractHumanText(convo: ConversationExport): string {
	return convo.chat_messages
		.filter((m) => m.sender === "human")
		.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text ?? ""))
		.join("\n\n");
}

function isPersonal(text: string): boolean {
	const lower = text.toLowerCase();
	return PERSONAL_KEYWORDS.some((k) => lower.includes(k));
}

function chunkText(text: string, limit: number): string[] {
	const chunks: string[] = [];
	const paragraphs = text.split("\n\n");
	let current = "";

	for (const p of paragraphs) {
		if (current.length + p.length + 2 > limit && current.length > 0) {
			chunks.push(current.trim());
			current = "";
		}
		current += (current ? "\n\n" : "") + p;
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

async function cognify(data: string): Promise<boolean> {
	try {
		const res = await fetch(`${COGNEE_URL}/api/v1/cognify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForCognify(): Promise<void> {
	// Poll status until not running
	for (let i = 0; i < 120; i++) {
		await Bun.sleep(2000);
		try {
			const res = await fetch(`${COGNEE_URL}/api/v1/cognify/status`);
			const data = (await res.json()) as any;
			const status = JSON.stringify(data).toLowerCase();
			if (!status.includes("running") && !status.includes("processing")) return;
		} catch {
			return;
		}
	}
}

async function main() {
	const exportDir = process.argv[2];
	if (!exportDir) {
		console.error("Usage: bun scripts/cognify-claude-export.ts /path/to/export/folder");
		process.exit(1);
	}

	const convosFile = `${exportDir}/conversations.json`;
	console.log(`Loading ${convosFile}...`);
	const convos: ConversationExport[] = JSON.parse(await Bun.file(convosFile).text());

	// Filter for personal conversations
	const personal = convos.filter((c) => {
		const text = extractHumanText(c);
		return text.length > 100 && isPersonal(text);
	});

	console.log(`Found ${personal.length} personal conversations out of ${convos.length} total`);

	// Sort by date (oldest first — build context chronologically)
	personal.sort((a, b) => a.created_at.localeCompare(b.created_at));

	let batchNum = 0;
	let totalChunks = 0;
	let errors = 0;

	for (const convo of personal) {
		const text = extractHumanText(convo);
		const date = convo.created_at.slice(0, 10);
		const title = convo.name || "Untitled";
		const header = `Source: Claude conversation "${title}" (${date})`;

		const chunks = chunkText(text, BATCH_CHAR_LIMIT);

		for (const chunk of chunks) {
			batchNum++;
			totalChunks++;
			const payload = `${header}\n\n${chunk}`;

			process.stdout.write(`\r[${batchNum}] Cognifying "${title.slice(0, 40)}..." (${date})`);

			const ok = await cognify(payload);
			if (!ok) {
				errors++;
				console.error(`\n  ERROR on batch ${batchNum}`);
				continue;
			}

			// Wait for processing + delay
			await waitForCognify();
			await Bun.sleep(DELAY_BETWEEN_BATCHES_MS);
		}
	}

	console.log(
		`\n\nDone! Processed ${totalChunks} chunks from ${personal.length} conversations. Errors: ${errors}`
	);
}

main();
