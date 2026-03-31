/**
 * Shared utilities.
 */

/** Format an unknown error value into a string message. */
export function fmtErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
