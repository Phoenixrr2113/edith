/**
 * Device Authentication — lib/auth.ts (CLOUD-AUTH-048)
 *
 * JWT-based auth for Edith device connections.
 * Uses Web Crypto API (built into Bun) — no external JWT dependency.
 *
 * Algorithm: HS256 (HMAC-SHA256)
 * Claims:    { sub: deviceId, iat, exp }
 * Lifetime:  30 days; refresh when expiry < 7 days away
 *
 * Used by:
 *   - lib/cloud-transport.ts — verifyDeviceToken() on every WebSocket upgrade
 *   - Tauri app              — generateDeviceToken() to mint tokens at setup
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeviceTokenPayload {
	/** Device identifier (sub claim) */
	deviceId: string;
	/** Issued-at unix seconds */
	iat: number;
	/** Expiry unix seconds */
	exp: number;
}

export interface DeviceRegistration {
	deviceId: string;
	/** Human-readable label, e.g. "Randy's MacBook Pro" */
	label: string;
	/** ISO timestamp of first registration */
	registeredAt: string;
	/** ISO timestamp of last successful auth */
	lastSeenAt?: string;
}

/** Result of verifyDeviceToken — null if invalid/expired */
export type VerifyResult =
	| { valid: true; payload: DeviceTokenPayload; needsRefresh: boolean }
	| { valid: false; reason: "invalid" | "expired" | "malformed" };

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REFRESH_THRESHOLD_SECONDS = 7 * 24 * 60 * 60; // refresh if < 7 days remain

// ── Internal helpers ──────────────────────────────────────────────────────────

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
	const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str: string): Uint8Array {
	// Pad to multiple of 4
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	const padding = (4 - (padded.length % 4)) % 4;
	const base64 = padded + "=".repeat(padding);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	const keyBytes = new TextEncoder().encode(secret);
	return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a signed JWT for a device.
 *
 * @param deviceId - Unique device identifier (stored as JWT `sub`)
 * @param secret   - DEVICE_SECRET from config (shared secret, keep private)
 * @returns        Signed JWT string
 */
export async function generateDeviceToken(deviceId: string, secret: string): Promise<string> {
	if (!secret) throw new Error("DEVICE_SECRET is not set — cannot generate device token");

	const header = base64urlEncode(
		new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
	);
	const now = Math.floor(Date.now() / 1000);
	const payload: DeviceTokenPayload = {
		deviceId,
		iat: now,
		exp: now + TOKEN_LIFETIME_SECONDS,
	};
	const payloadEncoded = base64urlEncode(
		new TextEncoder().encode(JSON.stringify({ sub: deviceId, ...payload }))
	);

	const signingInput = `${header}.${payloadEncoded}`;
	const key = await importHmacKey(secret);
	const signatureBuffer = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(signingInput)
	);

	const signature = base64urlEncode(signatureBuffer);
	return `${signingInput}.${signature}`;
}

/**
 * Verify a device JWT and return the payload if valid.
 *
 * @param token  - JWT string from Authorization header
 * @param secret - DEVICE_SECRET from config
 * @returns      VerifyResult — check `.valid` before accessing `.payload`
 */
export async function verifyDeviceToken(token: string, secret: string): Promise<VerifyResult> {
	if (!secret) {
		console.error("[auth] DEVICE_SECRET is not set — rejecting all tokens");
		return { valid: false, reason: "invalid" };
	}

	const parts = token.split(".");
	if (parts.length !== 3) {
		return { valid: false, reason: "malformed" };
	}

	const [headerB64, payloadB64, sigB64] = parts;

	// Verify signature
	try {
		const key = await importHmacKey(secret);
		const signingInput = `${headerB64}.${payloadB64}`;
		const expectedSig = base64urlDecode(sigB64);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			expectedSig,
			new TextEncoder().encode(signingInput)
		);

		if (!valid) {
			return { valid: false, reason: "invalid" };
		}
	} catch {
		return { valid: false, reason: "malformed" };
	}

	// Decode payload
	let claims: Record<string, unknown>;
	try {
		const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
		claims = JSON.parse(payloadJson) as Record<string, unknown>;
	} catch {
		return { valid: false, reason: "malformed" };
	}

	const exp = claims.exp as number | undefined;
	const iat = claims.iat as number | undefined;
	const sub = (claims.sub ?? claims.deviceId) as string | undefined;
	const deviceId = (claims.deviceId ?? sub) as string | undefined;

	if (!exp || !iat || !deviceId) {
		return { valid: false, reason: "malformed" };
	}

	const now = Math.floor(Date.now() / 1000);
	if (now >= exp) {
		return { valid: false, reason: "expired" };
	}

	const payload: DeviceTokenPayload = { deviceId, iat, exp };
	const needsRefresh = exp - now < REFRESH_THRESHOLD_SECONDS;

	return { valid: true, payload, needsRefresh };
}

/**
 * Refresh a token if it is still valid but expiry is within 7 days.
 * Returns null if the existing token is invalid or expired (client must re-auth).
 *
 * @param token   - Existing JWT
 * @param secret  - DEVICE_SECRET from config
 * @returns       New JWT string, or null if refresh is not possible
 */
export async function refreshToken(token: string, secret: string): Promise<string | null> {
	const result = await verifyDeviceToken(token, secret);
	if (!result.valid) return null;
	return generateDeviceToken(result.payload.deviceId, secret);
}

/**
 * Extract the Authorization Bearer token from an HTTP upgrade request header string.
 * Returns null if the header is missing or malformed.
 *
 * Usage in cloud-transport.ts:
 *   const token = extractBearerToken(req.headers.get("authorization"));
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
	if (!authHeader) return null;
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : null;
}
