// Path resolution for the CLIProxyAPI sidecar binary.
//
// Three sources, tried in order:
//   1. `OFFICE_AI_CLIPROXY_BIN` env var — explicit override (CI / power users).
//   2. Per-user install location: `%LocalAppData%\OfficeAIAssistant\bin\<binary>`.
//      (The portable installer copies the binary here; this is the prod path.)
//   3. Repo dev path: `<repo>/vendor/cliproxy/<binary>` — used when running
//      from the dev tree before the installer has run.
//
// The binary filename is read from `vendor/cliproxy/VERSION.json` so that
// `pnpm cliproxy:update` (which can rewrite VERSION.json's `binary` field
// when upstream renames the executable) requires zero code changes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appDataDir } from "../memory/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface VersionPin {
	binary: string;
	tag: string;
}

let _pinCache: VersionPin | null = null;

function repoVendorDir(): string {
	// dist/sidecar/paths.js -> dist -> bridge -> packages -> repo root
	// src/sidecar/paths.ts -> src -> bridge -> packages -> repo root
	return resolve(__dirname, "..", "..", "..", "..", "vendor", "cliproxy");
}

export function loadVersionPin(): VersionPin {
	if (_pinCache) return _pinCache;
	const path = join(repoVendorDir(), "VERSION.json");
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as VersionPin;
	if (!parsed.binary) {
		throw new Error(`vendor/cliproxy/VERSION.json: missing 'binary' field`);
	}
	_pinCache = parsed;
	return parsed;
}

export interface ResolvedBinary {
	path: string;
	source: "env" | "install" | "vendor";
}

export function resolveCliproxyBinary(): ResolvedBinary | null {
	const envOverride = process.env.OFFICE_AI_CLIPROXY_BIN;
	if (envOverride) {
		return existsSync(envOverride)
			? { path: envOverride, source: "env" }
			: null;
	}
	const pin = loadVersionPin();
	const installPath = join(appDataDir(), "bin", pin.binary);
	if (existsSync(installPath)) return { path: installPath, source: "install" };
	const devPath = join(repoVendorDir(), pin.binary);
	if (existsSync(devPath)) return { path: devPath, source: "vendor" };
	return null;
}

export function cliproxyConfigDir(): string {
	return join(appDataDir(), "config", "cliproxy");
}

export function cliproxyAuthDir(): string {
	return join(appDataDir(), "auth", "cliproxy");
}
