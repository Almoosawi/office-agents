import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
	buildCliInvocation,
	createCliAdapter,
	detectCli,
	normalizeStreamLine,
} from "../src/providers/cli.js";
import type { ProviderEntry } from "../src/providers/types.js";

function fakeChild(opts: {
	stdout?: string[];
	stderr?: string[];
	exitCode?: number;
	exitDelayMs?: number;
}): import("node:child_process").ChildProcess {
	const stdout = Readable.from((opts.stdout ?? []).map((s) => Buffer.from(s, "utf8")));
	const stderr = Readable.from((opts.stderr ?? []).map((s) => Buffer.from(s, "utf8")));
	const stdin = new Writable({
		write(_chunk, _enc, cb) {
			cb();
		},
		final(cb) {
			cb();
		},
	});
	const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
		emit: EventEmitter["emit"];
	};
	(child as unknown as { stdout: Readable }).stdout = stdout;
	(child as unknown as { stderr: Readable }).stderr = stderr;
	(child as unknown as { stdin: Writable }).stdin = stdin;
	(child as unknown as { kill: () => boolean }).kill = vi.fn(() => true) as unknown as () => boolean;

	let ended = 0;
	const maybeClose = () => {
		ended += 1;
		if (ended >= 2) {
			setTimeout(
				() => (child as unknown as { emit: EventEmitter["emit"] }).emit("close", opts.exitCode ?? 0),
				opts.exitDelayMs ?? 0,
			);
		}
	};
	stdout.once("end", maybeClose);
	stderr.once("end", maybeClose);
	return child;
}

const claudeEntry: ProviderEntry = {
	id: "cli:claude",
	kind: "cli",
	label: "Claude",
	enabled: true,
	command: "claude",
};
const codexEntry: ProviderEntry = {
	id: "cli:codex",
	kind: "cli",
	label: "Codex",
	enabled: true,
	command: "codex.cmd",
};
const geminiEntry: ProviderEntry = {
	id: "cli:gemini",
	kind: "cli",
	label: "Gemini",
	enabled: true,
	command: "/usr/local/bin/gemini",
};

describe("detectCli", () => {
	it("identifies bare names, .exe, .cmd, and full paths", () => {
		expect(detectCli({ ...claudeEntry, command: "claude" })).toBe("claude");
		expect(detectCli({ ...claudeEntry, command: "C:/Users/x/.local/bin/claude.exe" })).toBe("claude");
		expect(detectCli({ ...codexEntry, command: "codex.cmd" })).toBe("codex");
		expect(detectCli({ ...codexEntry, command: "C:\\Users\\x\\AppData\\npm\\codex.cmd" })).toBe("codex");
		expect(detectCli({ ...geminiEntry, command: "/opt/bin/gemini" })).toBe("gemini");
		expect(detectCli({ ...claudeEntry, command: "rogue" })).toBe("unknown");
	});
});

describe("buildCliInvocation", () => {
	it("builds claude stream-json invocation with stdin messages", () => {
		const built = buildCliInvocation(
			"claude",
			{ messages: [{ role: "user", content: "hi" }] },
			{ ...claudeEntry, model: "claude-haiku-4-5" },
		);
		expect(built.args).toContain("--print");
		expect(built.args).toContain("--input-format");
		expect(built.args).toContain("stream-json");
		expect(built.args).toContain("--model");
		expect(built.args).toContain("claude-haiku-4-5");
		// stdin should be one JSON message line
		const lines = built.stdin.trim().split("\n");
		expect(lines).toHaveLength(1);
		const obj = JSON.parse(lines[0]!);
		expect(obj).toMatchObject({ type: "message", role: "user", content: "hi" });
	});

	it("prepends system_prompt_override as a system message line", () => {
		const built = buildCliInvocation(
			"claude",
			{ messages: [{ role: "user", content: "hi" }] },
			{ ...claudeEntry, system_prompt_override: "Be terse." },
		);
		const lines = built.stdin.trim().split("\n").map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ role: "system", content: "Be terse." });
		expect(lines[1]).toMatchObject({ role: "user", content: "hi" });
	});

	it("rejects unsafe model names (shell injection guard)", () => {
		expect(() =>
			buildCliInvocation(
				"claude",
				{ messages: [{ role: "user", content: "x" }] },
				{ ...claudeEntry, model: '"; rm -rf / #' },
			),
		).toThrow(/Invalid characters/);
	});

	it("flattens messages for codex/gemini stdin", () => {
		const codex = buildCliInvocation(
			"codex",
			{ messages: [{ role: "user", content: "hello" }] },
			codexEntry,
		);
		expect(codex.args[0]).toBe("exec");
		expect(codex.stdin).toContain("User: hello");
		const gemini = buildCliInvocation(
			"gemini",
			{ messages: [{ role: "user", content: "hi g" }] },
			geminiEntry,
		);
		expect(gemini.args).toContain("--prompt");
		expect(gemini.args).toContain("--output-format");
		expect(gemini.stdin).toContain("User: hi g");
	});
});

describe("normalizeStreamLine", () => {
	it("extracts text from content_block_delta", () => {
		const out = normalizeStreamLine(
			"claude",
			JSON.stringify({ type: "content_block_delta", delta: { text: "hello" } }),
		);
		expect(out).toEqual([{ type: "text", delta: "hello" }]);
	});

	it("extracts tool_use as tool_call", () => {
		const out = normalizeStreamLine(
			"claude",
			JSON.stringify({
				type: "tool_use",
				id: "tu_1",
				name: "search",
				input: { q: "x" },
			}),
		);
		expect(out).toEqual([
			{
				type: "tool_call",
				id: "tu_1",
				name: "search",
				argsJson: JSON.stringify({ q: "x" }),
			},
		]);
	});

	it("emits text passthrough for non-JSON lines", () => {
		const out = normalizeStreamLine("codex", "plain output line");
		expect(out).toEqual([{ type: "text", delta: "plain output line\n" }]);
	});

	it("ignores empty lines and unknown shapes", () => {
		expect(normalizeStreamLine("gemini", "")).toEqual([]);
		expect(normalizeStreamLine("gemini", JSON.stringify({ type: "noop" }))).toEqual([]);
	});
});

describe("createCliAdapter.chat (with injected spawn)", () => {
	it("yields text chunks then a done event", async () => {
		const lines = [
			`${JSON.stringify({ type: "content_block_delta", delta: { text: "hello " } })}\n`,
			`${JSON.stringify({ type: "content_block_delta", delta: { text: "world" } })}\n`,
		];
		const adapter = createCliAdapter({
			spawnFn: vi.fn(() => fakeChild({ stdout: lines, exitCode: 0 })) as never,
		});
		const chunks = [];
		for await (const c of adapter.chat(claudeEntry, {
			messages: [{ role: "user", content: "ping" }],
		})) {
			chunks.push(c);
		}
		expect(chunks).toContainEqual({ type: "text", delta: "hello " });
		expect(chunks).toContainEqual({ type: "text", delta: "world" });
		expect(chunks.at(-1)).toEqual({ type: "done", reason: "stop" });
	});

	it("yields error + done(error) on non-zero exit", async () => {
		const adapter = createCliAdapter({
			spawnFn: vi.fn(() =>
				fakeChild({ stdout: [], stderr: ["boom\n"], exitCode: 7 }),
			) as never,
		});
		const chunks = [];
		for await (const c of adapter.chat(claudeEntry, {
			messages: [{ role: "user", content: "x" }],
		})) {
			chunks.push(c);
		}
		expect(chunks[0]).toMatchObject({ type: "error" });
		expect(chunks.at(-1)).toEqual({ type: "done", reason: "error" });
	});
});

describe("createCliAdapter.probe / listModels", () => {
	it("reports available + version on exit 0", async () => {
		const adapter = createCliAdapter({
			spawnFn: vi.fn(() =>
				fakeChild({ stdout: ["2.1.112 (Claude Code)\n"], exitCode: 0 }),
			) as never,
		});
		const probe = await adapter.probe(claudeEntry);
		expect(probe.available).toBe(true);
		expect(probe.version).toContain("2.1.112");
	});

	it("reports unavailable when command missing", async () => {
		const adapter = createCliAdapter({
			spawnFn: vi.fn(() => {
				throw new Error("ENOENT");
			}) as never,
		});
		const probe = await adapter.probe({
			...claudeEntry,
			command: "no-such-binary",
		});
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/ENOENT/);
	});

	it("returns curated model list per CLI", async () => {
		const adapter = createCliAdapter();
		expect(await adapter.listModels(claudeEntry)).toContain("claude-opus-4-7");
		expect(await adapter.listModels(codexEntry)).toContain("gpt-5");
		expect(await adapter.listModels(geminiEntry)).toContain("gemini-2.5-pro");
	});
});

// Optional smoke test: real spawn against the CLIs on PATH. Skipped unless
// the REAL_CLI_PROBE env var is set, so CI / package consumers don't need
// the binaries installed.
describe.runIf(process.env.REAL_CLI_PROBE === "1")("real-spawn smoke", () => {
	it.each(["claude", "codex", "gemini"])(
		"probes the real `%s` binary if installed",
		async (cmd) => {
			const { cliAdapter } = await import("../src/providers/cli.js");
			const probe = await cliAdapter.probe({
				id: `cli:${cmd}`,
				kind: "cli",
				label: cmd,
				enabled: true,
				command: cmd,
			});
			expect(probe.available).toBe(true);
			expect(probe.version).toBeTruthy();
		},
	);
});
