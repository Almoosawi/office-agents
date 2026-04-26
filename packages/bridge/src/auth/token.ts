// Bridge auth token. Mutating /api/providers/* endpoints require a bearer
// token to gate against drive-by web pages that hit 127.0.0.1 — TLS alone
// doesn't stop a hostile origin from sending a PUT/DELETE/POST.
//
// Resolution order (first wins):
//   1) options.token (test injection)
//   2) process.env.OFFICE_AI_BRIDGE_TOKEN (advanced override)
//   3) On-disk token at %LocalAppData%\OfficeAIAssistant\auth\bridge-token.txt
//      (created on first read with 32-byte cryptographic randomness)
//
// On non-Windows we mirror to ~/.office-ai-assistant/auth/ so dev/CI flows
// behave the same way without special-casing every test harness.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN_FILE = "bridge-token.txt";

function defaultTokenDir(): string {
	if (platform() === "win32") {
		const localAppData =
			process.env.LOCALAPPDATA ||
			path.join(homedir(), "AppData", "Local");
		return path.join(localAppData, "OfficeAIAssistant", "auth");
	}
	return path.join(homedir(), ".office-ai-assistant", "auth");
}

export interface LoadedToken {
	token: string;
	source: "injected" | "env" | "file" | "generated";
	path?: string;
}

export interface LoadTokenOptions {
	/** Override directory for tests. */
	dir?: string;
	/** Pre-supplied token (highest priority; bypasses env + file). */
	token?: string;
}

/**
 * Load (or create) the bridge auth token.
 *
 * Idempotent: subsequent calls return the same token — first call materializes
 * the file. `dir` lets tests redirect away from %LocalAppData%.
 */
export function loadOrCreateToken(opts: LoadTokenOptions = {}): LoadedToken {
	if (opts.token) return { token: opts.token, source: "injected" };

	const fromEnv = process.env.OFFICE_AI_BRIDGE_TOKEN;
	if (fromEnv && fromEnv.trim()) {
		return { token: fromEnv.trim(), source: "env" };
	}

	const dir = opts.dir ?? defaultTokenDir();
	const file = path.join(dir, TOKEN_FILE);

	try {
		const stat = statSync(file);
		if (stat.isFile()) {
			const existing = readFileSync(file, "utf8").trim();
			if (existing.length >= 32) {
				return { token: existing, source: "file", path: file };
			}
		}
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
	}

	mkdirSync(dir, { recursive: true });
	const fresh = randomBytes(32).toString("hex");
	writeFileSync(file, `${fresh}\n`, { encoding: "utf8", mode: 0o600 });
	return { token: fresh, source: "generated", path: file };
}

/**
 * Constant-time string compare to avoid timing-leak fingerprinting of the
 * bearer token across many requests.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

/**
 * Extract bearer token from an `Authorization` header value. Returns null
 * for missing/malformed headers — caller responds 401.
 */
export function extractBearer(header: string | string[] | undefined): string | null {
	if (!header) return null;
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== "string") return null;
	const m = value.match(/^Bearer\s+(\S+)\s*$/i);
	return m ? (m[1] ?? null) : null;
}
