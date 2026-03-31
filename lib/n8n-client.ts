/**
 * n8n webhook client — shared fetch + error handling for all n8n endpoints.
 */
import { N8N_URL } from "./config";
import { fmtErr } from "./util";

export async function n8nPost(
	endpoint: string,
	payload: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }> {
	try {
		const res = await fetch(`${N8N_URL}/webhook/${endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		const body = await res.text();

		if (!res.ok) {
			// n8n returns 500 with "No item to return" when empty (e.g. no calendar events)
			if (body.includes("No item to return")) {
				return { ok: true, data: null };
			}
			return { ok: false, error: body, status: res.status };
		}

		try {
			return { ok: true, data: JSON.parse(body) };
		} catch {
			return { ok: true, data: body };
		}
	} catch (err) {
		return { ok: false, error: `n8n unreachable: ${fmtErr(err)}. Is n8n running at ${N8N_URL}?` };
	}
}
