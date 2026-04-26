import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { SidecarSupervisor } from "../src/sidecar/supervisor.js";
import { CliProxyManager } from "../src/sidecar/cliproxy.js";

function fakeChild(): import("node:child_process").ChildProcess {
	const ee = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
		emit: EventEmitter["emit"];
	};
	let _exitCode: number | null = null;
	Object.defineProperty(ee, "exitCode", { get: () => _exitCode });
	Object.defineProperty(ee, "pid", { value: 4242 });
	(ee as unknown as { stdout: Readable }).stdout = Readable.from([]);
	(ee as unknown as { stderr: Readable }).stderr = Readable.from([]);
	(ee as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(
		(sig?: string) => {
			setTimeout(() => {
				_exitCode = sig === "SIGKILL" ? 137 : 0;
				(ee as unknown as { emit: EventEmitter["emit"] }).emit(
					"exit",
					_exitCode,
				);
			}, 5);
			return true;
		},
	) as unknown as (sig?: string) => boolean;
	return ee;
}

function fakeManager(opts: {
	startDelayMs?: number;
	failStart?: string;
	port?: number;
}): CliProxyManager {
	let started = 0;
	const spawnFn = vi.fn(() => fakeChild()) as unknown as typeof import("node:child_process").spawn;
	const fetchFn = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
	const mgr = new CliProxyManager({
		binaryPath: "C:/fake/cli-proxy-api.exe",
		configDir: `${process.env.TEMP ?? "/tmp"}/sup-cfg-${Math.random()}`,
		authDir: `${process.env.TEMP ?? "/tmp"}/sup-auth-${Math.random()}`,
		port: opts.port ?? 18400 + Math.floor(Math.random() * 50),
		spawnFn,
		fetchFn,
	});
	if (opts.failStart) {
		mgr.start = async () => {
			started += 1;
			throw new Error(opts.failStart!);
		};
	} else if (opts.startDelayMs) {
		const original = mgr.start.bind(mgr);
		mgr.start = async (startOpts) => {
			started += 1;
			await new Promise((r) => setTimeout(r, opts.startDelayMs));
			return original(startOpts);
		};
	}
	(mgr as unknown as { _started: () => number })._started = () => started;
	return mgr;
}

describe("SidecarSupervisor.ensureRunning", () => {
	it("starts the manager exactly once for concurrent callers", async () => {
		let createdCount = 0;
		const mgr = fakeManager({ startDelayMs: 30 });
		const sup = new SidecarSupervisor({
			managerFactory: () => {
				createdCount += 1;
				return mgr;
			},
		});

		const [k1, k2, k3] = await Promise.all([
			sup.ensureRunning(),
			sup.ensureRunning(),
			sup.ensureRunning(),
		]);
		expect(k1).toBe(k2);
		expect(k2).toBe(k3);
		expect(k1).toMatch(/^[0-9a-f]+$/);
		expect(createdCount).toBe(1);
		expect(sup.isRunning()).toBe(true);
		expect(sup.apiKey()).toBe(k1);
		await sup.stop();
		expect(sup.isRunning()).toBe(false);
	});

	it("retries fresh after a failed start", async () => {
		let attempt = 0;
		const sup = new SidecarSupervisor({
			managerFactory: () => {
				attempt += 1;
				return attempt === 1
					? fakeManager({ failStart: "binary missing" })
					: fakeManager({});
			},
		});

		await expect(sup.ensureRunning()).rejects.toThrow(/binary missing/);
		expect(sup.isRunning()).toBe(false);
		// Second call should create a new manager and succeed.
		const key = await sup.ensureRunning();
		expect(key).toMatch(/^[0-9a-f]+$/);
		expect(attempt).toBe(2);
		await sup.stop();
	});

	it("stop() is safe when nothing is running", async () => {
		const sup = new SidecarSupervisor({
			managerFactory: () => fakeManager({}),
		});
		await expect(sup.stop()).resolves.toBeUndefined();
	});

	it("apiKey() returns undefined before ensureRunning resolves", () => {
		const sup = new SidecarSupervisor({
			managerFactory: () => fakeManager({}),
		});
		expect(sup.apiKey()).toBeUndefined();
		expect(sup.isRunning()).toBe(false);
	});
});

describe("createSidecarAdapter — supervisor integration", () => {
	it("calls ensureRunning before each probe and forwards the key", async () => {
		const { createSidecarAdapter } = await import(
			"../src/providers/sidecar.js"
		);
		let calls = 0;
		const adapter = createSidecarAdapter({
			ensureRunning: async () => {
				calls += 1;
				return "test-key-abc";
			},
			fetchFn: vi.fn(async (url, init) => {
				const headers = (init as { headers: Record<string, string> })?.headers;
				expect(headers.authorization).toBe("Bearer test-key-abc");
				return new Response(JSON.stringify({ data: [{ id: "model-x" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});

		const probe1 = await adapter.probe({
			id: "sidecar:cliproxy:claude",
			kind: "sidecar",
			label: "x",
			enabled: true,
			base_url: "http://127.0.0.1:8317/api/provider/claude/v1",
		});
		expect(probe1.available).toBe(true);
		expect(probe1.models).toEqual(["model-x"]);
		expect(calls).toBe(1);
	});

	it("reports unavailable when ensureRunning rejects", async () => {
		const { createSidecarAdapter } = await import(
			"../src/providers/sidecar.js"
		);
		const adapter = createSidecarAdapter({
			ensureRunning: async () => {
				throw new Error("binary not found");
			},
		});
		const probe = await adapter.probe({
			id: "sidecar:cliproxy:claude",
			kind: "sidecar",
			label: "x",
			enabled: true,
			base_url: "http://127.0.0.1:8317/api/provider/claude/v1",
		});
		expect(probe.available).toBe(false);
		expect(probe.reason).toContain("binary not found");
	});

	it("chat surfaces ensureRunning failure as error+done(error)", async () => {
		const { createSidecarAdapter } = await import(
			"../src/providers/sidecar.js"
		);
		const adapter = createSidecarAdapter({
			ensureRunning: async () => {
				throw new Error("port in use");
			},
		});
		const out = [];
		for await (const c of adapter.chat(
			{
				id: "sidecar:cliproxy:claude",
				kind: "sidecar",
				label: "x",
				enabled: true,
				base_url: "http://127.0.0.1:8317/api/provider/claude/v1",
			},
			{ messages: [{ role: "user", content: "hi" }] },
		)) {
			out.push(c);
		}
		expect(out[0]).toMatchObject({ type: "error" });
		expect((out[0] as { message: string }).message).toContain("port in use");
		expect(out.at(-1)).toEqual({ type: "done", reason: "error" });
	});

	it("falls back to apiKey() supplier when no ensureRunning is provided", async () => {
		const { createSidecarAdapter } = await import(
			"../src/providers/sidecar.js"
		);
		const adapter = createSidecarAdapter({
			apiKey: () => "static-key",
			fetchFn: vi.fn(async (_url, init) => {
				const headers = (init as { headers: Record<string, string> })?.headers;
				expect(headers.authorization).toBe("Bearer static-key");
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		const probe = await adapter.probe({
			id: "sidecar:cliproxy:claude",
			kind: "sidecar",
			label: "x",
			enabled: true,
			base_url: "http://127.0.0.1:8317/api/provider/claude/v1",
		});
		expect(probe.available).toBe(true);
	});
});
