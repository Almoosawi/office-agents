// Shared client for OpenAI-compatible HTTP endpoints. Used by:
//   - `sidecar` adapter (CLIProxyAPI exposes /api/provider/*/v1/...)
//   - `local` adapter (Ollama, LMStudio, vLLM, llama.cpp all speak this)
//   - `byok` adapter (cloud APIs, when we add it)
//
// Endpoints used:
//   GET  {base}/models                    → ProbeResult.models
//   POST {base}/chat/completions  (SSE)   → ChatChunk stream
//
// We rely on the global `fetch` (Node 22+ / WebKit). No network deps.

import type {
	ChatChunk,
	ChatMessage,
	ChatRequest,
	ProbeResult,
	ProviderEntry,
} from "./types.js";

const PROBE_TIMEOUT_MS = 5_000;

export interface OpenAiCompatOptions {
	/** Inject for tests. Defaults to global `fetch`. */
	fetchFn?: typeof fetch;
}

function jsonHeaders(apiKey?: string): Record<string, string> {
	const h: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json",
	};
	if (apiKey) h.authorization = `Bearer ${apiKey}`;
	return h;
}

function sseHeaders(apiKey?: string): Record<string, string> {
	const h: Record<string, string> = {
		"content-type": "application/json",
		accept: "text/event-stream",
	};
	if (apiKey) h.authorization = `Bearer ${apiKey}`;
	return h;
}

function withTimeout(
	ms: number,
	signal?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(new Error("timeout")), ms);
	if (signal) {
		if (signal.aborted) ctl.abort(signal.reason);
		else
			signal.addEventListener(
				"abort",
				() => ctl.abort(signal.reason),
				{ once: true },
			);
	}
	return { signal: ctl.signal, cancel: () => clearTimeout(timer) };
}

export async function probeOpenAiCompat(
	entry: ProviderEntry,
	apiKey?: string,
	opts: OpenAiCompatOptions = {},
): Promise<ProbeResult> {
	const f = opts.fetchFn ?? fetch;
	if (!entry.base_url) return { available: false, reason: "no base_url set" };
	const t0 = Date.now();
	const url = `${entry.base_url.replace(/\/$/, "")}/models`;
	const { signal, cancel } = withTimeout(PROBE_TIMEOUT_MS);
	try {
		const res = await f(url, {
			method: "GET",
			headers: jsonHeaders(apiKey),
			signal,
		});
		cancel();
		const latencyMs = Date.now() - t0;
		if (!res.ok) {
			return {
				available: false,
				reason: `${res.status} ${res.statusText}`,
				latencyMs,
			};
		}
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		const models = (body.data ?? [])
			.map((m) => m?.id)
			.filter((x): x is string => typeof x === "string");
		return { available: true, models, latencyMs };
	} catch (e) {
		cancel();
		return { available: false, reason: (e as Error).message };
	}
}

export async function listModelsOpenAiCompat(
	entry: ProviderEntry,
	apiKey?: string,
	opts: OpenAiCompatOptions = {},
): Promise<string[]> {
	const probe = await probeOpenAiCompat(entry, apiKey, opts);
	return probe.models ?? [];
}

interface SseChoice {
	delta?: {
		content?: string;
		tool_calls?: Array<{
			id?: string;
			function?: { name?: string; arguments?: string };
		}>;
	};
	finish_reason?: string | null;
}
interface SseChunk {
	choices?: SseChoice[];
}

export function toChatChunks(line: string): ChatChunk[] {
	const trimmed = line.trim();
	if (!trimmed) return [];
	if (trimmed === "data: [DONE]") return [{ type: "done", reason: "stop" }];
	if (!trimmed.startsWith("data:")) return [];
	const json = trimmed.slice(5).trim();
	if (!json) return [];
	let parsed: SseChunk;
	try {
		parsed = JSON.parse(json) as SseChunk;
	} catch {
		return [];
	}
	const out: ChatChunk[] = [];
	for (const ch of parsed.choices ?? []) {
		const text = ch.delta?.content;
		if (typeof text === "string" && text.length > 0) {
			out.push({ type: "text", delta: text });
		}
		for (const tc of ch.delta?.tool_calls ?? []) {
			if (tc.id && tc.function?.name) {
				out.push({
					type: "tool_call",
					id: tc.id,
					name: tc.function.name,
					argsJson: tc.function.arguments ?? "{}",
				});
			}
		}
		if (ch.finish_reason) {
			const r = ch.finish_reason;
			out.push({
				type: "done",
				reason:
					r === "stop"
						? "stop"
						: r === "length"
							? "length"
							: r === "tool_calls"
								? "tool_call"
								: "stop",
			});
		}
	}
	return out;
}

function buildBody(req: ChatRequest, entry: ProviderEntry): string {
	const model = req.model ?? entry.model;
	const messages: Array<{ role: string; content: string }> = [];
	if (entry.system_prompt_override) {
		messages.push({
			role: "system",
			content: entry.system_prompt_override,
		});
	}
	for (const m of req.messages as ChatMessage[]) {
		messages.push({ role: m.role, content: m.content });
	}
	const body: Record<string, unknown> = { model, messages, stream: true };
	const temp = req.temperature ?? entry.temperature;
	if (temp !== undefined) body.temperature = temp;
	const topP = req.top_p ?? entry.top_p;
	if (topP !== undefined) body.top_p = topP;
	const maxT = req.max_tokens ?? entry.max_tokens;
	if (maxT !== undefined) body.max_tokens = maxT;
	return JSON.stringify(body);
}

export async function* chatOpenAiCompat(
	entry: ProviderEntry,
	req: ChatRequest,
	apiKey?: string,
	opts: OpenAiCompatOptions = {},
): AsyncIterable<ChatChunk> {
	const f = opts.fetchFn ?? fetch;
	if (!entry.base_url) {
		yield { type: "error", message: "no base_url set" };
		yield { type: "done", reason: "error" };
		return;
	}
	const url = `${entry.base_url.replace(/\/$/, "")}/chat/completions`;
	const res = await f(url, {
		method: "POST",
		headers: sseHeaders(apiKey),
		body: buildBody(req, entry),
		signal: req.signal,
	});
	if (!res.ok || !res.body) {
		let errBody = "";
		try {
			errBody = await res.text();
		} catch {
			// body already consumed or absent — leave empty
		}
		yield {
			type: "error",
			message: `${res.status} ${res.statusText}${errBody ? `: ${errBody}` : ""}`,
		};
		yield { type: "done", reason: "error" };
		return;
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				for (const c of toChatChunks(line)) yield c;
				nl = buf.indexOf("\n");
			}
		}
		if (buf.trim()) {
			for (const c of toChatChunks(buf)) yield c;
		}
	} catch (e) {
		// Abort is not an error: when the dispatcher fires req.signal,
		// undici throws AbortError out of reader.read(). Surface that as
		// a clean done(abort) so chat_abort renders correctly in the
		// taskpane instead of looking like a transport failure.
		if (req.signal?.aborted) {
			yield { type: "done", reason: "abort" };
			return;
		}
		yield { type: "error", message: (e as Error).message };
		yield { type: "done", reason: "error" };
	}
}
