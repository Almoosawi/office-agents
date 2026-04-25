// CLI adapter — spawns `claude`/`codex`/`gemini` non-interactively and
// normalizes their stream-json output into ChatChunk events.
//
// Why text-only / no native tool execution (yet):
//   The bridge enforces a uniform tool path: model emits an
//   `<office_tool name="..." id="...">{...}</office_tool>` marker in its
//   text, the taskpane gate-routes it (ARCHITECTURE §9), and the result is
//   fed back as a tool message. Letting each CLI execute its own tools
//   would bypass that gate. Native tool mode is reserved for a future
//   sprint once the gate router speaks each CLI's wire protocol.
//
// Windows spawn quirk: `claude.exe` is a real binary (spawn shell:false
// works), but `codex.cmd` / `gemini.cmd` are npm shims that need cmd.exe
// as the interpreter. We use shell:true on Windows for those, and validate
// every arg against a strict whitelist to keep the injection surface zero.
// User-controlled prose (system prompts, user messages) NEVER reaches argv;
// it goes through stdin only.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type {
	ChatChunk,
	ChatRequest,
	ProbeResult,
	ProviderAdapter,
	ProviderEntry,
} from "./types.js";

const PROBE_TIMEOUT_MS = 5_000;

export type CliKey = "claude" | "codex" | "gemini" | "unknown";

export function detectCli(entry: ProviderEntry): CliKey {
	const cmd = (entry.command ?? "").toLowerCase().replace(/\\/g, "/");
	const tail = cmd.split("/").pop() ?? "";
	const stem = tail.replace(/\.(exe|cmd|bat|sh)$/, "");
	if (stem === "claude") return "claude";
	if (stem === "codex") return "codex";
	if (stem === "gemini") return "gemini";
	return "unknown";
}

/** Strict whitelist for argv values that may originate from the registry. */
const SAFE_ARG = /^[A-Za-z0-9._\-:/=+]*$/;

function assertSafeArg(value: string, field: string): void {
	if (!SAFE_ARG.test(value)) {
		throw new Error(
			`Invalid characters in provider field '${field}'; only [A-Za-z0-9._\\-:/=+] allowed`,
		);
	}
}

function isWindowsShim(cmd: string): boolean {
	// On Windows, Node's spawn with shell:false uses CreateProcess directly.
	// CreateProcess can auto-resolve `.exe` via PATH but cannot execute `.cmd`/
	// `.bat` shims (npm puts `codex.cmd`/`gemini.cmd` in its bin dir; bare
	// `codex` resolves to that via PATHEXT only when invoked through cmd.exe).
	// So: shell:true is required for anything that isn't an explicit `.exe`.
	if (process.platform !== "win32") return false;
	return !/\.exe$/i.test(cmd);
}

/** Format messages for stdin. CLIs that don't speak stream-json input get
 *  a flat `[system]\n\n[user]\n\n[assistant]…` block with a trailing user. */
export function flattenMessages(req: ChatRequest, entry: ProviderEntry): string {
	const sys = entry.system_prompt_override ?? "";
	const parts: string[] = [];
	if (sys) parts.push(`System: ${sys}`);
	for (const m of req.messages) {
		const tag =
			m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : `Tool(${m.tool_name ?? "?"})`;
		parts.push(`${tag}: ${m.content}`);
	}
	return parts.join("\n\n");
}

export interface BuiltCli {
	args: string[];
	stdin: string;
}

export function buildCliInvocation(
	cli: CliKey,
	req: ChatRequest,
	entry: ProviderEntry,
): BuiltCli {
	const model = req.model ?? entry.model;
	if (model) assertSafeArg(model, "model");
	switch (cli) {
		case "claude": {
			// claude --print --input-format=stream-json --output-format=stream-json
			// expects ONE JSON line per message on stdin. System prompt rides as
			// `--append-system-prompt` (escaped via stdin handoff via env? no — we
			// must use --append-system-prompt arg, but route it via a sentinel
			// file later if injection becomes a concern). For now we whitelist.
			const args = [
				"--bare",
				"--print",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--no-session-persistence",
			];
			if (model) args.push("--model", model);
			// One JSON object per message on stdin.
			const lines = req.messages.map((m) =>
				JSON.stringify({
					type: "message",
					role: m.role,
					content: m.content,
				}),
			);
			if (entry.system_prompt_override) {
				lines.unshift(
					JSON.stringify({
						type: "message",
						role: "system",
						content: entry.system_prompt_override,
					}),
				);
			}
			return { args, stdin: `${lines.join("\n")}\n` };
		}
		case "codex": {
			const args = ["exec", "--sandbox", "read-only"];
			if (model) args.push("--model", model);
			return { args, stdin: flattenMessages(req, entry) };
		}
		case "gemini": {
			// gemini reads stdin and appends to --prompt. We pass a single
			// space (empty string + shell:true on Windows can be stripped),
			// then put the real prompt on stdin. The leading space becomes
			// part of the user message — harmless.
			const args = [
				"--prompt",
				" ",
				"--output-format",
				"stream-json",
				"--approval-mode",
				"plan",
			];
			if (model) args.push("--model", model);
			return { args, stdin: flattenMessages(req, entry) };
		}
		default:
			return { args: [], stdin: flattenMessages(req, entry) };
	}
}

export function normalizeStreamLine(_cli: CliKey, line: string): ChatChunk[] {
	// stream-json shape varies between vendors; we look for the union of
	// known fields. Unknown shapes are dropped silently (not surfaced as
	// errors) because the CLIs interleave control frames we don't care about.
	const trimmed = line.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Plain text — pass through (e.g. codex `exec` text mode).
		return [{ type: "text", delta: `${trimmed}\n` }];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const o = parsed as Record<string, unknown>;
	const delta = (o.delta as Record<string, unknown> | undefined) ?? undefined;

	if (o.type === "content_block_delta" && delta && typeof delta.text === "string") {
		return [{ type: "text", delta: delta.text }];
	}
	if (o.type === "tool_use" && typeof o.id === "string" && typeof o.name === "string") {
		return [
			{
				type: "tool_call",
				id: o.id,
				name: o.name,
				argsJson: JSON.stringify(o.input ?? {}),
			},
		];
	}
	if (o.type === "message_delta" && delta && typeof delta.stop_reason === "string") {
		const reason = delta.stop_reason as string;
		return [{ type: "done", reason: reason === "end_turn" ? "stop" : "stop" }];
	}
	if (typeof o.text === "string") return [{ type: "text", delta: o.text }];
	if (typeof o.delta === "string") return [{ type: "text", delta: o.delta }];
	return [];
}

interface SpawnLike {
	(
		command: string,
		args: readonly string[],
		options: {
			stdio: ["pipe", "pipe", "pipe"];
			shell: boolean;
			windowsHide: boolean;
		},
	): ChildProcess;
}

export interface CliAdapterOptions {
	/** Inject a fake spawn for tests. Defaults to `node:child_process.spawn`. */
	spawnFn?: SpawnLike;
}

export function createCliAdapter(opts: CliAdapterOptions = {}): ProviderAdapter {
	const spawnFn: SpawnLike = (opts.spawnFn ?? (spawn as unknown as SpawnLike));

	return {
		kind: "cli",

		async probe(entry: ProviderEntry): Promise<ProbeResult> {
			const cmd = entry.command;
			if (!cmd) return { available: false, reason: "no command set" };
			const t0 = Date.now();
			let child: ChildProcess;
			try {
				child = spawnFn(cmd, ["--version"], {
					stdio: ["pipe", "pipe", "pipe"],
					shell: isWindowsShim(cmd),
					windowsHide: true,
				});
			} catch (e) {
				return { available: false, reason: (e as Error).message };
			}
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (b: Buffer) => {
				stdout += b.toString("utf8");
			});
			child.stderr?.on("data", (b: Buffer) => {
				stderr += b.toString("utf8");
			});
			child.stdin?.end();
			const timer = setTimeout(() => child.kill("SIGTERM"), PROBE_TIMEOUT_MS);
			try {
				const [code] = (await once(child, "close")) as [number | null];
				clearTimeout(timer);
				const latencyMs = Date.now() - t0;
				if (code === 0) {
					const version = stdout.trim().split("\n")[0];
					return { available: true, version, latencyMs };
				}
				return {
					available: false,
					reason: stderr.trim() || `exit ${code}`,
					latencyMs,
				};
			} catch (e) {
				clearTimeout(timer);
				return { available: false, reason: (e as Error).message };
			}
		},

		async listModels(entry: ProviderEntry): Promise<string[]> {
			// CLIs don't publish stable list-models endpoints. Curated lists per
			// vendor; the Settings UI gets a "refresh" action later (Sprint 2)
			// once the sidecar lane is wired so we can query OAuth-authenticated
			// model lists.
			switch (detectCli(entry)) {
				case "claude":
					return [
						"claude-opus-4-7",
						"claude-sonnet-4-6",
						"claude-haiku-4-5",
					];
				case "codex":
					return ["gpt-5", "gpt-5-mini", "o3", "o3-mini"];
				case "gemini":
					return [
						"gemini-2.5-pro",
						"gemini-2.5-flash",
						"gemini-2.5-flash-lite",
					];
				default:
					return [];
			}
		},

		async *chat(entry: ProviderEntry, req: ChatRequest): AsyncIterable<ChatChunk> {
			const cli = detectCli(entry);
			if (cli === "unknown" || !entry.command) {
				yield {
					type: "error",
					message: `unsupported CLI command: ${entry.command ?? "(none)"}`,
				};
				yield { type: "done", reason: "error" };
				return;
			}
			let invocation: BuiltCli;
			try {
				invocation = buildCliInvocation(cli, req, entry);
			} catch (e) {
				yield { type: "error", message: (e as Error).message };
				yield { type: "done", reason: "error" };
				return;
			}
			const child = spawnFn(entry.command, invocation.args, {
				stdio: ["pipe", "pipe", "pipe"],
				shell: isWindowsShim(entry.command),
				windowsHide: true,
			});
			if (req.signal) {
				const onAbort = () => child.kill("SIGTERM");
				if (req.signal.aborted) {
					onAbort();
				} else {
					req.signal.addEventListener("abort", onAbort, { once: true });
				}
			}
			child.stdin?.write(invocation.stdin);
			child.stdin?.end();

			let stderrBuf = "";
			child.stderr?.on("data", (b: Buffer) => {
				stderrBuf += b.toString("utf8");
			});

			let buf = "";
			if (child.stdout) {
				for await (const piece of child.stdout) {
					buf += (piece as Buffer).toString("utf8");
					let idx = buf.indexOf("\n");
					while (idx >= 0) {
						const line = buf.slice(0, idx);
						buf = buf.slice(idx + 1);
						for (const c of normalizeStreamLine(cli, line)) yield c;
						idx = buf.indexOf("\n");
					}
				}
				if (buf.trim()) {
					for (const c of normalizeStreamLine(cli, buf)) yield c;
				}
			}
			const [code] = (await once(child, "close")) as [number | null];
			if (req.signal?.aborted) {
				yield { type: "done", reason: "abort" };
				return;
			}
			if ((code ?? 0) !== 0) {
				yield {
					type: "error",
					message: stderrBuf.trim() || `${entry.command} exited ${code}`,
				};
				yield { type: "done", reason: "error" };
				return;
			}
			yield { type: "done", reason: "stop" };
		},
	};
}

/** Default adapter using `node:child_process.spawn`. */
export const cliAdapter: ProviderAdapter = createCliAdapter();
