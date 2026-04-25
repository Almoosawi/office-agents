import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { join } from "node:path";
import { CliProxyManager } from "../src/sidecar/cliproxy.js";

function fakeChild(opts: {
	exitCodeAfterMs?: number;
	stdout?: string[];
	stderr?: string[];
}): import("node:child_process").ChildProcess {
	const stdout = Readable.from((opts.stdout ?? []).map((s) => Buffer.from(s, "utf8")));
	const stderr = Readable.from((opts.stderr ?? []).map((s) => Buffer.from(s, "utf8")));
	const ee = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
		emit: EventEmitter["emit"];
	};
	let _exitCode: number | null = null;
	Object.defineProperty(ee, "exitCode", {
		get: () => _exitCode,
	});
	Object.defineProperty(ee, "pid", { value: 12345 });
	(ee as unknown as { stdout: Readable }).stdout = stdout;
	(ee as unknown as { stderr: Readable }).stderr = stderr;
	(ee as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn((sig?: string) => {
		setTimeout(() => {
			_exitCode = sig === "SIGKILL" ? 137 : 0;
			(ee as unknown as { emit: EventEmitter["emit"] }).emit("exit", _exitCode);
		}, 5);
		return true;
	}) as unknown as (sig?: string) => boolean;
	if (opts.exitCodeAfterMs !== undefined) {
		setTimeout(() => {
			_exitCode = opts.exitCodeAfterMs!;
			(ee as unknown as { emit: EventEmitter["emit"] }).emit("exit", _exitCode);
		}, opts.exitCodeAfterMs);
	}
	return ee;
}

let scratchDirs: string[] = [];
function tmpDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), `oa-cliproxy-${prefix}-`));
	scratchDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
	scratchDirs = [];
});

describe("CliProxyManager", () => {
	it("starts: writes config with random api key, becomes ready, exposes baseUrl", async () => {
		const configDir = tmpDir("cfg");
		const authDir = tmpDir("auth");
		const spawnFn = vi.fn(() =>
			fakeChild({ stdout: [], stderr: [] }),
		) as unknown as typeof import("node:child_process").spawn;
		const fetchFn = vi.fn(async () =>
			new Response(JSON.stringify({ data: [], object: "list" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		) as unknown as typeof fetch;
		const mgr = new CliProxyManager({
			binaryPath: "C:/fake/cli-proxy-api.exe",
			configDir,
			authDir,
			port: 18317,
			spawnFn,
			fetchFn,
		});
		const info = await mgr.start({ readyTimeoutMs: 5_000 });
		expect(info.baseUrl).toBe("http://127.0.0.1:18317");
		expect(info.apiKey).toMatch(/^[0-9a-f]{48}$/);
		expect(info.binarySource).toBe("override");
		expect(mgr.isRunning()).toBe(true);
		// Confirm the config we wrote uses our generated key + port
		const cfg = readFileSync(join(configDir, "config.yaml"), "utf8");
		expect(cfg).toContain(`port: 18317`);
		expect(cfg).toContain(`- "${info.apiKey}"`);
		expect(cfg).toContain('host: "127.0.0.1"');
		expect(spawnFn).toHaveBeenCalledTimes(1);
		const spawnArgs = spawnFn.mock.calls[0]!;
		expect(spawnArgs[0]).toBe("C:/fake/cli-proxy-api.exe");
		expect(spawnArgs[1]).toContain("-config");
		await mgr.stop();
		expect(mgr.isRunning()).toBe(false);
	});

	it("waitReady fails when the child exits before HTTP responds", async () => {
		const spawnFn = vi.fn(() =>
			fakeChild({ exitCodeAfterMs: 50 }),
		) as unknown as typeof import("node:child_process").spawn;
		const fetchFn = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const mgr = new CliProxyManager({
			binaryPath: "C:/fake/cli-proxy-api.exe",
			configDir: tmpDir("cfg"),
			authDir: tmpDir("auth"),
			port: 18318,
			spawnFn,
			fetchFn,
		});
		await expect(mgr.start({ readyTimeoutMs: 1_000 })).rejects.toThrow(
			/exited before becoming ready|did not become ready/,
		);
		expect(mgr.isRunning()).toBe(false);
	});

	it("rejects double-start", async () => {
		const spawnFn = vi.fn(() => fakeChild({})) as unknown as typeof import("node:child_process").spawn;
		const fetchFn = vi.fn(
			async () =>
				new Response("{}", {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const mgr = new CliProxyManager({
			binaryPath: "C:/fake/cli-proxy-api.exe",
			configDir: tmpDir("cfg"),
			authDir: tmpDir("auth"),
			port: 18319,
			spawnFn,
			fetchFn,
		});
		await mgr.start({ readyTimeoutMs: 5_000 });
		await expect(mgr.start({ readyTimeoutMs: 5_000 })).rejects.toThrow(
			/already running/,
		);
		await mgr.stop();
	});

	it("treats 401 from /v1/models as proof the server is up", async () => {
		// Realistic: user hasn't run -claude-login yet; proxy responds with
		// the configured api key but no upstream creds, so /v1/models works
		// while provider-specific paths return empty.
		const spawnFn = vi.fn(() => fakeChild({})) as unknown as typeof import("node:child_process").spawn;
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error("ECONNREFUSED");
			return new Response("Unauthorized", { status: 401 });
		}) as unknown as typeof fetch;
		const mgr = new CliProxyManager({
			binaryPath: "C:/fake/cli-proxy-api.exe",
			configDir: tmpDir("cfg"),
			authDir: tmpDir("auth"),
			port: 18320,
			spawnFn,
			fetchFn,
		});
		const info = await mgr.start({ readyTimeoutMs: 3_000 });
		expect(info.baseUrl).toContain("18320");
		await mgr.stop();
	});
});

// Real-binary smoke test. Skipped unless REAL_CLI_PROBE=1 — same gate as
// providers-cli.test.ts. Verified locally: starts in ~280ms, /v1/models
// returns 200 with an empty data array, /api/provider/claude/v1/models same.
describe.runIf(process.env.REAL_CLI_PROBE === "1")(
	"real CliProxyManager smoke",
	() => {
		it("spawns the vendored binary and serves /v1/models", async () => {
			const { CliProxyManager } = await import("../src/sidecar/cliproxy.js");
			const mgr = new CliProxyManager({
				configDir: tmpDir("real-cfg"),
				authDir: tmpDir("real-auth"),
				port: 18399,
			});
			try {
				const info = await mgr.start({ readyTimeoutMs: 15_000 });
				expect(info.apiKey).toMatch(/^[0-9a-f]+$/);
				expect(info.binarySource).toMatch(/vendor|install|env/);
				const res = await fetch(`${info.baseUrl}/v1/models`, {
					headers: { authorization: `Bearer ${info.apiKey}` },
				});
				expect(res.status).toBe(200);
			} finally {
				await mgr.stop();
			}
		}, 30_000);
	},
);
