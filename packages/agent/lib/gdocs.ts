/**
 * Google Docs / Drive REST API — lib/gdocs.ts (INFRA-GDOCS-050)
 *
 * Direct REST calls to Google Docs API v1 and Drive API v3.
 * Auth is provided by lib/google-auth.ts (tokens stored in SQLite).
 *
 * Exports:
 *   createDoc(title, content, folderId?) → { docId, docUrl, name }
 *   getDoc(docId)                        → raw Docs API document object
 */

import { getAccessToken } from "./google-auth";

// ── Base URLs ─────────────────────────────────────────────────────────────────

const DOCS_BASE = "https://docs.googleapis.com/v1/documents";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3/files";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DocResult {
	docId: string;
	docUrl: string;
	name: string;
}

// Internal shape of a Docs API batchUpdate request element
type DocsRequest = Record<string, unknown>;

// ── Internal helpers ──────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
	const token = await getAccessToken();
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function docsRequest(method: string, path: string, body?: unknown): Promise<unknown> {
	const headers = await authHeaders();
	const res = await fetch(path, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Google API ${method} ${path} → ${res.status}: ${text}`);
	}
	return res.json() as Promise<unknown>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new Google Doc with the given title and plain-text/markdown content.
 *
 * If folderId is provided, the doc is moved into that Drive folder after creation.
 *
 * @returns { docId, docUrl, name }
 */
export async function createDoc(
	title: string,
	content: string,
	folderId?: string
): Promise<DocResult> {
	// 1. Create empty document
	const created = (await docsRequest("POST", DOCS_BASE, { title })) as {
		documentId: string;
		title: string;
	};
	const docId = created.documentId;

	// 2. Insert content via batchUpdate (endOfSegmentLocation inserts at end)
	if (content.trim()) {
		const requests: DocsRequest[] = [
			{
				insertText: {
					location: { index: 1 },
					text: content,
				},
			},
		];
		await docsRequest("POST", `${DOCS_BASE}/${docId}:batchUpdate`, { requests });
	}

	// 3. Move to folder if specified
	if (folderId) {
		// Get current parents so we can remove them (Drive requires it)
		const meta = (await docsRequest("GET", `${DRIVE_BASE}/${docId}?fields=parents`, undefined)) as {
			parents?: string[];
		};
		const removeParents = (meta.parents ?? []).join(",");
		const moveUrl =
			`${DRIVE_BASE}/${docId}` +
			`?addParents=${encodeURIComponent(folderId)}` +
			(removeParents ? `&removeParents=${encodeURIComponent(removeParents)}` : "") +
			`&fields=id`;
		await docsRequest("PATCH", moveUrl, {});
	}

	return {
		docId,
		docUrl: `https://docs.google.com/document/d/${docId}/edit`,
		name: created.title,
	};
}

/**
 * Fetch a Google Doc by its document ID.
 * Returns the raw Docs API document resource.
 */
export async function getDoc(docId: string): Promise<unknown> {
	return docsRequest("GET", `${DOCS_BASE}/${docId}`);
}
