/**
 * Content filter — scans screen frames for sensitive content before sending to cloud.
 *
 * Uses simple OCR keyword heuristics (no ML). Runs synchronously against the
 * base64 image data string and against a supplied active-URL hint.
 *
 * Design target: < 5 ms per frame on main thread.
 *
 * Issue: INFRA-SENSITIVE-092
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Rectangular region within the frame (normalised 0-1 coordinates). */
export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
}

export interface ContentFilterResult {
	/** Whether the frame is safe to send to the cloud. */
	safe: boolean;
	/** Human-readable reason when safe === false. */
	reason?: string;
	/**
	 * Regions that were detected as sensitive.
	 * Currently populated for URL-bar detection only; pixel-level redaction
	 * is left for a future GPU-side pass.
	 */
	redactedAreas?: Region[];
}

// ── Sensitive domain list ─────────────────────────────────────────────────────

/**
 * Domains treated as sensitive (banking, financial, medical, auth).
 * Matched against any visible URL text in the frame or against an explicit
 * `activeUrl` hint passed by the caller.
 */
const SENSITIVE_DOMAINS: string[] = [
	// Banking / credit unions
	"chase.com",
	"bankofamerica.com",
	"wellsfargo.com",
	"citibank.com",
	"usbank.com",
	"schwab.com",
	"fidelity.com",
	"vanguard.com",
	"tdameritrade.com",
	"etrade.com",
	"ally.com",
	"capitalone.com",
	"discover.com",
	"synchrony.com",
	"navyfederal.org",
	"paypal.com",
	"venmo.com",
	"stripe.com",
	"mint.com",
	"quicken.com",
	"turbotax.com",
	"irs.gov",
	// Medical
	"mychart.com",
	"epic.com",
	"healthgrades.com",
	"cvs.com",
	"walgreens.com",
	"anthem.com",
	"aetna.com",
	"cigna.com",
	"humana.com",
	"unitedhealthcare.com",
	// Auth / secrets
	"lastpass.com",
	"1password.com",
	"bitwarden.com",
	"keepass.io",
	"dashlane.com",
	"okta.com",
	"auth0.com",
	"accounts.google.com",
	"login.microsoftonline.com",
	"appleid.apple.com",
	"github.com/settings",
	"console.aws.amazon.com",
	"portal.azure.com",
	"console.cloud.google.com",
	// Private comms
	"web.whatsapp.com",
	"messages.google.com",
];

// ── Sensitive keyword patterns ─────────────────────────────────────────────────

/**
 * Patterns in base64 payload that suggest sensitive on-screen text.
 *
 * Note: base64 text from real OCR would come through a separate pipeline.
 * Here we search the image filename metadata and any embedded text hints
 * that the Tauri layer may inject. The primary gate is domain matching.
 */
const SENSITIVE_KEYWORDS_RE = new RegExp(
	[
		// Password masking characters (UTF-8 base64 segments for ● or •)
		"4peF", // base64 fragment for ●
		"4oiY", // base64 fragment for •
		// Credit card patterns: 4 groups of 4 digits
		"\\d{4}[\\s-]\\d{4}[\\s-]\\d{4}[\\s-]\\d{4}",
		// SSN pattern
		"\\d{3}-\\d{2}-\\d{4}",
		// Routing/account number labels
		"routing number",
		"account number",
		"ssn",
		"social security",
		"credit card",
		"cvv",
		"card number",
		"password",
		"passphrase",
		"private key",
		"secret key",
		"api key",
		"access token",
		"bearer token",
	].join("|"),
	"i"
);

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Scan a screen frame for sensitive content.
 *
 * @param imageBase64  Base64-encoded PNG/JPEG of the screen frame.
 * @param activeUrl    Optional: the URL currently shown in the browser address
 *                     bar. Supplied by the Tauri accessibility layer when
 *                     available. Provides a faster and more reliable signal
 *                     than OCR-based URL detection.
 * @param ocrText      Optional: OCR text extracted from the frame by the
 *                     Tauri/Rust layer. When provided, keyword matching runs
 *                     against plain text rather than base64 data.
 */
export function contentFilter(
	imageBase64: string,
	activeUrl?: string,
	ocrText?: string
): ContentFilterResult {
	// 1. Domain check on the explicit active URL (fastest path)
	if (activeUrl) {
		const matched = matchesSensitiveDomain(activeUrl);
		if (matched) {
			return {
				safe: false,
				reason: `Sensitive site detected in active URL: ${matched}`,
				redactedAreas: [{ x: 0, y: 0, width: 1, height: 1, label: "sensitive-url" }],
			};
		}
	}

	// 2. Domain check against any URL-like strings embedded in OCR text
	if (ocrText) {
		const urlsInText = extractUrls(ocrText);
		for (const url of urlsInText) {
			const matched = matchesSensitiveDomain(url);
			if (matched) {
				return {
					safe: false,
					reason: `Sensitive domain found in visible text: ${matched}`,
					redactedAreas: [{ x: 0, y: 0, width: 1, height: 0.06, label: "address-bar" }],
				};
			}
		}
	}

	// 3. Keyword scan — prefer OCR text when available, fall back to base64 data
	const scanTarget = ocrText ?? imageBase64;
	const kwMatch = SENSITIVE_KEYWORDS_RE.exec(scanTarget);
	if (kwMatch) {
		const keyword = kwMatch[0].substring(0, 30); // truncate for logging
		return {
			safe: false,
			reason: `Sensitive keyword pattern detected: "${keyword}"`,
		};
	}

	// 4. Frame is clean
	return { safe: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the matching sensitive domain string if `url` contains it,
 * or undefined if no match.
 */
function matchesSensitiveDomain(url: string): string | undefined {
	const lower = url.toLowerCase();
	return SENSITIVE_DOMAINS.find((domain) => lower.includes(domain));
}

/**
 * Extract URL-like substrings from a block of text.
 * Looks for http(s):// patterns or bare domain.tld patterns.
 */
function extractUrls(text: string): string[] {
	// http(s):// URLs
	const httpMatches = [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((m) => m[0]);
	// bare domains (e.g. "chase.com/login")
	const bareMatches = [...text.matchAll(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?/gi)].map(
		(m) => m[0]
	);
	return [...httpMatches, ...bareMatches];
}
