import { describe, expect, it } from "vitest";
import { validateProviderEntry } from "../src/providers/validation.js";

describe("validateProviderEntry — required scalar fields", () => {
	it("rejects non-objects", () => {
		expect(validateProviderEntry(null).ok).toBe(false);
		expect(validateProviderEntry("hi").ok).toBe(false);
		expect(validateProviderEntry(42).ok).toBe(false);
		expect(validateProviderEntry([]).ok).toBe(false);
	});

	it("rejects bad ids", () => {
		const bad = ["", "spaces here", "has/slash", "has\\back", "has space"];
		for (const id of bad) {
			const r = validateProviderEntry({
				id,
				kind: "cli",
				label: "x",
				enabled: true,
				command: "claude",
			});
			expect(r.ok, `id="${id}" should fail`).toBe(false);
		}
	});

	it("requires kind in the enum", () => {
		const r = validateProviderEntry({
			id: "x",
			kind: "weird",
			label: "x",
			enabled: true,
		});
		expect(r.ok).toBe(false);
	});

	it("requires enabled boolean and label string", () => {
		expect(
			validateProviderEntry({
				id: "x",
				kind: "cli",
				label: "x",
				enabled: "yes",
				command: "claude",
			}).ok,
		).toBe(false);
		expect(
			validateProviderEntry({
				id: "x",
				kind: "cli",
				label: 42,
				enabled: true,
				command: "claude",
			}).ok,
		).toBe(false);
	});
});

describe("validateProviderEntry — kind=cli", () => {
	it("accepts allowlisted bare names", () => {
		for (const command of ["claude", "codex", "gemini", "claude.exe", "codex.cmd"]) {
			const r = validateProviderEntry({
				id: `cli:${command}`,
				kind: "cli",
				label: command,
				enabled: true,
				command,
			});
			expect(r.ok, command).toBe(true);
		}
	});

	it("rejects unknown commands and shell-injection attempts", () => {
		const bad = ["rm", "wget", "claude;rm", "powershell", "cmd"];
		for (const command of bad) {
			const r = validateProviderEntry({
				id: "cli:x",
				kind: "cli",
				label: "x",
				enabled: true,
				command,
			});
			expect(r.ok, command).toBe(false);
		}
	});

	it("rejects path-bearing commands", () => {
		for (const command of [
			"/usr/bin/claude",
			"C:\\bin\\claude.exe",
			"./claude",
			"../codex",
		]) {
			const r = validateProviderEntry({
				id: "cli:x",
				kind: "cli",
				label: "x",
				enabled: true,
				command,
			});
			expect(r.ok, command).toBe(false);
		}
	});

	it("rejects cli with base_url or api_key_ref", () => {
		expect(
			validateProviderEntry({
				id: "cli:x",
				kind: "cli",
				label: "x",
				enabled: true,
				command: "claude",
				base_url: "http://127.0.0.1/x",
			}).ok,
		).toBe(false);
		expect(
			validateProviderEntry({
				id: "cli:x",
				kind: "cli",
				label: "x",
				enabled: true,
				command: "claude",
				api_key_ref: "kc_x",
			}).ok,
		).toBe(false);
	});
});

describe("validateProviderEntry — kind=sidecar/local/byok", () => {
	const baseLoopback = "http://127.0.0.1:8080/v1";

	it("accepts loopback base_urls for all non-cli kinds", () => {
		for (const kind of ["sidecar", "local", "byok"] as const) {
			for (const base_url of [
				"http://127.0.0.1:8080/v1",
				"http://localhost:1234/v1",
				"https://127.0.0.1/v1",
				"http://[::1]:9000",
			]) {
				const r = validateProviderEntry({
					id: `${kind}:x`,
					kind,
					label: kind,
					enabled: true,
					base_url,
				});
				expect(r.ok, `${kind} ${base_url}`).toBe(true);
			}
		}
	});

	it("rejects non-loopback base_urls", () => {
		for (const base_url of [
			"https://api.openai.com/v1",
			"http://10.0.0.5/x",
			"http://192.168.1.1/x",
			"http://example.com",
			"http://0.0.0.0/x",
		]) {
			const r = validateProviderEntry({
				id: "byok:x",
				kind: "byok",
				label: "x",
				enabled: true,
				base_url,
			});
			expect(r.ok, base_url).toBe(false);
		}
	});

	it("rejects non-http(s) schemes", () => {
		for (const base_url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"ftp://127.0.0.1",
			"ws://127.0.0.1/x",
		]) {
			const r = validateProviderEntry({
				id: "byok:x",
				kind: "byok",
				label: "x",
				enabled: true,
				base_url,
			});
			expect(r.ok, base_url).toBe(false);
		}
	});

	it("rejects non-cli without base_url", () => {
		const r = validateProviderEntry({
			id: "byok:x",
			kind: "byok",
			label: "x",
			enabled: true,
		});
		expect(r.ok).toBe(false);
	});

	it("rejects non-cli with command", () => {
		const r = validateProviderEntry({
			id: "byok:x",
			kind: "byok",
			label: "x",
			enabled: true,
			base_url: baseLoopback,
			command: "claude",
		});
		expect(r.ok).toBe(false);
	});

	it("validates api_key_ref shape", () => {
		const r = validateProviderEntry({
			id: "byok:x",
			kind: "byok",
			label: "x",
			enabled: true,
			base_url: baseLoopback,
			api_key_ref: "has space",
		});
		expect(r.ok).toBe(false);
	});
});

describe("validateProviderEntry — sampling + numeric ranges", () => {
	const base = {
		id: "cli:claude",
		kind: "cli" as const,
		label: "Claude",
		enabled: true,
		command: "claude",
	};

	it("rejects out-of-range temperature", () => {
		expect(validateProviderEntry({ ...base, temperature: -1 }).ok).toBe(false);
		expect(validateProviderEntry({ ...base, temperature: 5 }).ok).toBe(false);
		expect(validateProviderEntry({ ...base, temperature: Number.NaN }).ok).toBe(
			false,
		);
		expect(validateProviderEntry({ ...base, temperature: Number.POSITIVE_INFINITY }).ok).toBe(
			false,
		);
	});

	it("accepts in-range numerics", () => {
		expect(
			validateProviderEntry({
				...base,
				temperature: 0.7,
				top_p: 0.9,
				max_tokens: 4096,
				priority: 5,
			}).ok,
		).toBe(true);
	});

	it("rejects non-integer max_tokens", () => {
		expect(validateProviderEntry({ ...base, max_tokens: 1.5 }).ok).toBe(false);
		expect(validateProviderEntry({ ...base, max_tokens: 0 }).ok).toBe(false);
	});

	it("rejects model names with shell metacharacters", () => {
		for (const model of ['"; rm -rf / #', "a;b", "$(whoami)", "a b"]) {
			expect(validateProviderEntry({ ...base, model }).ok).toBe(false);
		}
	});

	it("rejects oversized system_prompt_override", () => {
		const huge = "x".repeat(40_000);
		expect(
			validateProviderEntry({ ...base, system_prompt_override: huge }).ok,
		).toBe(false);
	});

	it("rejects fallbacks with bad shapes", () => {
		expect(
			validateProviderEntry({ ...base, fallbacks: ["ok-id", "bad space"] }).ok,
		).toBe(false);
		expect(validateProviderEntry({ ...base, fallbacks: "not-array" }).ok).toBe(
			false,
		);
	});

	it("rejects oversized extra blob", () => {
		const huge = "x".repeat(5000);
		expect(validateProviderEntry({ ...base, extra: { huge } }).ok).toBe(false);
	});
});
