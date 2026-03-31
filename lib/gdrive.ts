/**
 * Google Drive direct REST API client — lib/gdrive.ts (INFRA-GDRIVE-053)
 *
 * All calls go directly to the Drive REST API v3 via fetch.
 * No googleapis SDK dependency.
 *
 * Auth: OAuth2 access token via lib/google-auth.ts
 *
 * Exports:
 *   searchFiles(query, maxResults?)  → DriveFile[]
 *   getFile(fileId)                  → DriveFile (metadata)
 *   downloadFile(fileId)             → string (file content as text)
 *   uploadFile(name, content, folderId?, mimeType?) → DriveFile
 */

import { getAccessToken } from "./google-auth";

// ── Constants ─────────────────────────────────────────────────────────────────

const DRIVE_BASE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// Google Docs / Sheets export MIME types → plain text
const EXPORT_MIME_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  size?: string;
}

// Internal Drive API list response
interface DriveListResponse {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    webViewLink?: string;
    size?: string;
  }>;
  nextPageToken?: string;
}

// Internal Drive API file resource
interface DriveFileResource {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

function normalizeFile(f: DriveFileResource): DriveFile {
  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    modifiedTime: f.modifiedTime ?? "",
    ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
    ...(f.size ? { size: f.size } : {}),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search for files in Google Drive.
 *
 * @param query       Drive query string (e.g. "name contains 'budget'" or full-text "fullText contains 'revenue'")
 * @param maxResults  Max files to return (default: 20, max: 100)
 */
export async function searchFiles(query: string, maxResults = 20): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(Math.min(maxResults, 100)),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    orderBy: "modifiedTime desc",
  });

  const res = await driveFetch(`${DRIVE_BASE}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive search failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as DriveListResponse;
  return (data.files ?? []).map(normalizeFile);
}

/**
 * Get metadata for a single file by ID.
 */
export async function getFile(fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,modifiedTime,webViewLink,size",
  });

  const res = await driveFetch(`${DRIVE_BASE}/${encodeURIComponent(fileId)}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive getFile failed (${res.status}): ${body}`);
  }

  return normalizeFile((await res.json()) as DriveFileResource);
}

/**
 * Download file content as text.
 *
 * For Google Docs/Sheets/Slides — uses the export endpoint (exports to plain text/CSV).
 * For binary files — returns raw text (useful for .txt, .md, .json, .csv, etc.).
 */
export async function downloadFile(fileId: string): Promise<string> {
  // First get the file metadata so we know the mimeType
  const file = await getFile(fileId);
  const exportMime = EXPORT_MIME_MAP[file.mimeType];

  let res: Response;

  if (exportMime) {
    // Google Workspace files — use export endpoint
    const params = new URLSearchParams({ mimeType: exportMime });
    res = await driveFetch(
      `${DRIVE_BASE}/${encodeURIComponent(fileId)}/export?${params}`
    );
  } else {
    // Binary / non-Workspace file — download directly
    res = await driveFetch(
      `${DRIVE_BASE}/${encodeURIComponent(fileId)}?alt=media`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive download failed (${res.status}): ${body}`);
  }

  return res.text();
}

/**
 * Upload a file to Google Drive.
 *
 * Uses multipart upload: metadata + content in one request.
 *
 * @param name      File name
 * @param content   File content (text)
 * @param folderId  Parent folder ID (optional — defaults to root)
 * @param mimeType  MIME type (optional — defaults to "text/plain")
 */
export async function uploadFile(
  name: string,
  content: string,
  folderId?: string,
  mimeType = "text/plain"
): Promise<DriveFile> {
  const token = await getAccessToken();

  const metadata: Record<string, unknown> = {
    name,
    mimeType,
    ...(folderId ? { parents: [folderId] } : {}),
  };

  // Build multipart body
  const boundary = `edith_boundary_${Date.now()}`;
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n`;
  const contentPart =
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    `\r\n`;
  const body = metaPart + contentPart + `--${boundary}--`;

  const params = new URLSearchParams({
    uploadType: "multipart",
    fields: "id,name,mimeType,modifiedTime,webViewLink,size",
  });

  const res = await fetch(`${DRIVE_UPLOAD}?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${errBody}`);
  }

  return normalizeFile((await res.json()) as DriveFileResource);
}
