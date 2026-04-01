/**
 * Shared test helpers — temp directory management and config mocking.
 *
 * Usage: call `setupTestDir()` in beforeAll, `cleanupTestDir()` in afterAll.
 * This creates a temp dir and patches the config module so all state files
 * point to the temp dir instead of .state/.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

export function setupTestDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "edith-test-"));
	mkdirSync(join(tempDir, "inbox"), { recursive: true });
	mkdirSync(join(tempDir, "transcripts"), { recursive: true });
	return tempDir;
}

export function cleanupTestDir(): void {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
}

export function getTempDir(): string {
	return tempDir;
}
