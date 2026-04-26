import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	extractBearer,
	loadOrCreateToken,
	timingSafeEqualString,
} from "../src/auth/token.js";

const requireCjs = createRequire(import.meta.url);
const { recycle } = requireCjs("../../../scripts/recycle.cjs") as {
	recycle: (paths: string[]) => number;
};

const ENV_KEY = "OFFICE_AI_BRIDGE_TOKEN";
const trashDirs: string[] = [];
let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
});

afterEach(() => {
	if (savedEnv !== undefined) process.env[ENV_KEY] = savedEnv;
	else delete process.env[ENV_KEY];
	if (trashDirs.length > 0) {
		recycle(trashDirs.splice(0, trashDirs.length));
	}
});

function tempDir(): string {
	const d = mkdtempSync(path.join(tmpdir(), "bridge-auth-"));
	trashDirs.push(d);
	return d;
}

describe("loadOrCreateToken", () => {
	it("uses an injected token without touching disk", () => {
		const r = loadOrCreateToken({ token: "supplied", dir: tempDir() });
		expect(r.token).toBe("supplied");
		expect(r.source).toBe("injected");
	});

	it("prefers OFFICE_AI_BRIDGE_TOKEN over the file", () => {
		process.env[ENV_KEY] = "  env-token  ";
		const dir = tempDir();
		const r = loadOrCreateToken({ dir });
		expect(r.token).toBe("env-token");
		expect(r.source).toBe("env");
	});

	it("creates a fresh 64-hex token on first call and reuses it", () => {
		const dir = tempDir();
		const first = loadOrCreateToken({ dir });
		expect(first.source).toBe("generated");
		expect(first.token).toMatch(/^[a-f0-9]{64}$/);
		expect(first.path).toBe(path.join(dir, "bridge-token.txt"));
		const onDisk = readFileSync(first.path!, "utf8").trim();
		expect(onDisk).toBe(first.token);

		const second = loadOrCreateToken({ dir });
		expect(second.source).toBe("file");
		expect(second.token).toBe(first.token);
	});

	it("regenerates if the existing token is too short", () => {
		const dir = tempDir();
		const tokenFile = path.join(dir, "bridge-token.txt");
		// Manually pre-seed a too-short token to mimic a corrupt write.
		mkdirSync(dir, { recursive: true });
		writeFileSync(tokenFile, "tiny\n", "utf8");

		const r = loadOrCreateToken({ dir });
		expect(r.source).toBe("generated");
		expect(r.token.length).toBeGreaterThanOrEqual(32);
	});

	it("writes the token file with restrictive mode on POSIX", () => {
		if (process.platform === "win32") return; // NTFS perms differ
		const dir = tempDir();
		const r = loadOrCreateToken({ dir });
		const stat = statSync(r.path!);
		// owner read/write only.
		expect(stat.mode & 0o777).toBe(0o600);
	});
});

describe("extractBearer", () => {
	it("extracts the token from a well-formed header", () => {
		expect(extractBearer("Bearer abc123")).toBe("abc123");
		expect(extractBearer("bearer xyz")).toBe("xyz");
	});

	it("returns null for missing or malformed headers", () => {
		expect(extractBearer(undefined)).toBeNull();
		expect(extractBearer("")).toBeNull();
		expect(extractBearer("Basic abc")).toBeNull();
		expect(extractBearer("Bearer")).toBeNull();
		expect(extractBearer(["Bearer abc"])).toBe("abc");
	});
});

describe("timingSafeEqualString", () => {
	it("matches identical strings", () => {
		expect(timingSafeEqualString("foo", "foo")).toBe(true);
	});

	it("rejects different strings of equal length", () => {
		expect(timingSafeEqualString("foo", "bar")).toBe(false);
	});

	it("rejects strings of different lengths", () => {
		expect(timingSafeEqualString("foo", "fooo")).toBe(false);
	});
});
