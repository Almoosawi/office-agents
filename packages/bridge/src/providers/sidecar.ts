// Sidecar adapter — talks to the bundled CLIProxyAPI binary over local HTTP.
//
// CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI, MIT) reuses the
// OAuth tokens already on disk from the `claude`/`codex`/`gemini` CLIs and
// exposes them as OpenAI/Anthropic/Gemini-compatible endpoints. The bridge
// launcher creates a SidecarSupervisor; the supervisor lazy-spawns the
// binary on the first probe/chat. The user never has to start it manually.
//
// This adapter is plain OpenAI-compat HTTP; CLIProxyAPI handles the
// translation to the upstream provider format. The user-visible tradeoff
// versus the `cli` adapter: faster (no per-call process spawn), full feature
// parity (native streaming + tool calls), but adds ~30MB binary to the
// installer and one persistent localhost process.

import {
	chatOpenAiCompat,
	listModelsOpenAiCompat,
	probeOpenAiCompat,
	type OpenAiCompatOptions,
} from "./openai-compat.js";
import type {
	ChatChunk,
	ChatRequest,
	ProbeResult,
	ProviderAdapter,
	ProviderEntry,
} from "./types.js";

export interface SidecarAdapterOptions extends OpenAiCompatOptions {
	/**
	 * Synchronous API key supplier. Used when no `ensureRunning` hook is
	 * provided (manual lifecycle management). Returns `undefined` when
	 * the sidecar isn't running yet — the upstream proxy will respond
	 * 401 and probe() will report unavailable.
	 */
	apiKey?: () => string | undefined;
	/**
	 * Async hook that guarantees the sidecar is up before probe/chat
	 * resolves. Returns the live API key. When supplied, this takes
	 * precedence over `apiKey()`. The supervisor wires this in
	 * production; tests can omit it to inspect the no-supervisor path.
	 */
	ensureRunning?: () => Promise<string>;
}

export function createSidecarAdapter(
	opts: SidecarAdapterOptions = {},
): ProviderAdapter {
	const getKeySync = (): string | undefined => opts.apiKey?.();

	async function ensureKey(): Promise<{ key?: string; error?: string }> {
		if (!opts.ensureRunning) return { key: getKeySync() };
		try {
			return { key: await opts.ensureRunning() };
		} catch (e) {
			return { error: (e as Error).message };
		}
	}

	return {
		kind: "sidecar",
		async probe(entry: ProviderEntry): Promise<ProbeResult> {
			const r = await ensureKey();
			if (r.error) return { available: false, reason: r.error };
			return probeOpenAiCompat(entry, r.key, opts);
		},
		async listModels(entry: ProviderEntry): Promise<string[]> {
			const r = await ensureKey();
			if (r.error) return [];
			return listModelsOpenAiCompat(entry, r.key, opts);
		},
		async *chat(
			entry: ProviderEntry,
			req: ChatRequest,
		): AsyncIterable<ChatChunk> {
			const r = await ensureKey();
			if (r.error) {
				yield { type: "error", message: r.error };
				yield { type: "done", reason: "error" };
				return;
			}
			yield* chatOpenAiCompat(entry, req, r.key, opts);
		},
	};
}

export const sidecarAdapter: ProviderAdapter = createSidecarAdapter();
