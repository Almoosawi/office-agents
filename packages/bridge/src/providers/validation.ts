// Strict ProviderEntry validation. Mounted on the public-but-loopback
// HTTP surface, so we treat every PUT body as adversarial and only let
// shapes through that the adapters can actually safely execute.
//
// The two invariants that matter most:
//   1) `kind=cli` MUST set `command` to one of three known binaries —
//      arbitrary strings would let a caller spawn anything on PATH.
//   2) `kind=sidecar/local` MUST point at a loopback HTTP base URL —
//      the bridge is local-by-design, so disallowing remote hosts here
//      keeps a hijacked add-in from turning the bridge into an SSRF/
//      data-exfil hop.
//
// Bound numeric ranges keep the OpenAI-compat adapter from forwarding
// garbage to upstream APIs (and prevent integer overflow in adapters
// that pass these straight to provider clients).

import type { ProviderEntry } from "./types.js";

/** CLI commands the bridge knows how to spawn. */
export const ALLOWED_CLI_COMMANDS: ReadonlySet<string> = new Set([
	"claude",
	"codex",
	"gemini",
]);

/** Acceptable executable suffixes (Windows shims + bare names). */
const CLI_SUFFIX_RE = /\.(?:exe|cmd|bat)$/i;

/** Strict id charset; matches the registry-key regex used elsewhere. */
const ID_RE = /^[a-zA-Z0-9._:\-]+$/;

/** Model strings forwarded to spawn argv must stay shell-safe. */
const MODEL_RE = /^[a-zA-Z0-9._:\-/]+$/;

/** Keychain reference handle; never the secret itself. */
const API_KEY_REF_RE = /^[a-zA-Z0-9._:\-]+$/;

/** Loopback hostnames we trust for sidecar/local/byok base URLs. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
	"127.0.0.1",
	"localhost",
	"::1",
	"[::1]",
]);

const KINDS = new Set(["cli", "sidecar", "local", "byok"] as const);
const ROLES = new Set(["main", "orchestrator", "background"] as const);

export type ValidationResult =
	| { ok: true; entry: ProviderEntry }
	| { ok: false; error: string };

function fail(error: string): ValidationResult {
	return { ok: false, error };
}

function isFiniteNumberInRange(
	value: unknown,
	min: number,
	max: number,
): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
	);
}

function validateCliCommand(cmd: unknown): string | null {
	if (typeof cmd !== "string" || !cmd) return "command must be a non-empty string";
	// Reject path separators — caller must not point us at arbitrary binaries.
	if (/[\\/]/.test(cmd)) {
		return "command must be a bare binary name (no path separators)";
	}
	const stem = cmd.replace(CLI_SUFFIX_RE, "").toLowerCase();
	if (!ALLOWED_CLI_COMMANDS.has(stem)) {
		return `command must be one of: ${[...ALLOWED_CLI_COMMANDS].join(", ")} (got '${cmd}')`;
	}
	return null;
}

function validateLoopbackUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return "base_url must be a non-empty string";
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return `base_url is not a valid URL (got '${raw}')`;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `base_url must use http: or https: (got '${parsed.protocol}')`;
	}
	const host = parsed.hostname.toLowerCase();
	if (!LOOPBACK_HOSTS.has(host)) {
		return `base_url must point at a loopback host (got '${host}')`;
	}
	return null;
}

/**
 * Validate an unknown payload as a ProviderEntry. Returns a discriminated
 * union — never throws. Callers reject with 400 on `ok:false`.
 */
export function validateProviderEntry(value: unknown): ValidationResult {
	if (typeof value !== "object" || value === null) {
		return fail("body must be a JSON object");
	}
	const v = value as Record<string, unknown>;

	// ----- required scalar fields -----
	if (typeof v.id !== "string" || !v.id || !ID_RE.test(v.id)) {
		return fail("id must match /^[a-zA-Z0-9._:\\-]+$/");
	}
	if (typeof v.label !== "string" || !v.label) {
		return fail("label must be a non-empty string");
	}
	if (v.label.length > 200) return fail("label must be <= 200 chars");
	if (typeof v.enabled !== "boolean") {
		return fail("enabled must be a boolean");
	}
	if (typeof v.kind !== "string" || !KINDS.has(v.kind as never)) {
		return fail(`kind must be one of: ${[...KINDS].join(", ")}`);
	}
	const kind = v.kind as ProviderEntry["kind"];

	// ----- per-kind invariants -----
	if (kind === "cli") {
		const err = validateCliCommand(v.command);
		if (err) return fail(err);
		if (v.base_url !== undefined) {
			return fail("kind=cli must not set base_url");
		}
		if (v.api_key_ref !== undefined) {
			return fail("kind=cli must not set api_key_ref");
		}
	} else {
		if (v.command !== undefined) {
			return fail(`kind=${kind} must not set command`);
		}
		const err = validateLoopbackUrl(v.base_url);
		if (err) return fail(err);
		if (v.api_key_ref !== undefined) {
			if (
				typeof v.api_key_ref !== "string" ||
				!v.api_key_ref ||
				!API_KEY_REF_RE.test(v.api_key_ref) ||
				v.api_key_ref.length > 128
			) {
				return fail("api_key_ref must match /^[a-zA-Z0-9._:\\-]+$/ and be <= 128 chars");
			}
		}
	}

	// ----- model + sampling -----
	if (v.model !== undefined) {
		if (
			typeof v.model !== "string" ||
			!v.model ||
			!MODEL_RE.test(v.model) ||
			v.model.length > 128
		) {
			return fail("model must match /^[a-zA-Z0-9._:\\-/]+$/ and be <= 128 chars");
		}
	}
	if (v.temperature !== undefined && !isFiniteNumberInRange(v.temperature, 0, 2)) {
		return fail("temperature must be a number in [0, 2]");
	}
	if (v.top_p !== undefined && !isFiniteNumberInRange(v.top_p, 0, 1)) {
		return fail("top_p must be a number in [0, 1]");
	}
	if (v.max_tokens !== undefined) {
		if (
			!Number.isInteger(v.max_tokens) ||
			(v.max_tokens as number) < 1 ||
			(v.max_tokens as number) > 1_000_000
		) {
			return fail("max_tokens must be an integer in [1, 1000000]");
		}
	}
	if (v.system_prompt_override !== undefined) {
		if (
			typeof v.system_prompt_override !== "string" ||
			v.system_prompt_override.length > 32_768
		) {
			return fail("system_prompt_override must be a string <= 32KiB");
		}
	}

	// ----- routing + roles -----
	if (v.priority !== undefined) {
		if (
			!Number.isInteger(v.priority) ||
			(v.priority as number) < 0 ||
			(v.priority as number) > 100_000
		) {
			return fail("priority must be an integer in [0, 100000]");
		}
	}
	if (v.fallbacks !== undefined) {
		if (!Array.isArray(v.fallbacks)) return fail("fallbacks must be an array");
		if (v.fallbacks.length > 16) return fail("fallbacks must have <= 16 entries");
		for (const f of v.fallbacks) {
			if (typeof f !== "string" || !f || !ID_RE.test(f)) {
				return fail("fallbacks entries must match /^[a-zA-Z0-9._:\\-]+$/");
			}
		}
	}
	if (v.role !== undefined && !ROLES.has(v.role as never)) {
		return fail(`role must be one of: ${[...ROLES].join(", ")}`);
	}
	if (v.extra !== undefined) {
		if (typeof v.extra !== "object" || v.extra === null || Array.isArray(v.extra)) {
			return fail("extra must be a plain object");
		}
		// Hard cap on extras size — serialized payload protects spawn argv /
		// log lines / DB columns from runaway growth.
		try {
			if (JSON.stringify(v.extra).length > 4096) {
				return fail("extra must serialize to <= 4096 bytes");
			}
		} catch {
			return fail("extra must be JSON-serializable");
		}
	}

	return { ok: true, entry: v as unknown as ProviderEntry };
}
