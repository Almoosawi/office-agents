// Sidecar adapter — talks to the bundled CLIProxyAPI binary over local HTTP.
//
// CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI, MIT) reuses the
// OAuth tokens already on disk from the `claude`/`codex`/`gemini` CLIs and
// exposes them as OpenAI/Anthropic/Gemini-compatible endpoints. We treat it
// as a black-box HTTP server: bridge launcher spawns the binary, hits its
// localhost port. The binary is shipped in the per-user installer (no admin)
// and runs in the user's session — same lifecycle pattern as the planned
// outlook-com sidecar.
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

export function createSidecarAdapter(opts: OpenAiCompatOptions = {}): ProviderAdapter {
	return {
		kind: "sidecar",
		probe(entry: ProviderEntry): Promise<ProbeResult> {
			return probeOpenAiCompat(entry, undefined, opts);
		},
		listModels(entry: ProviderEntry): Promise<string[]> {
			return listModelsOpenAiCompat(entry, undefined, opts);
		},
		chat(entry: ProviderEntry, req: ChatRequest): AsyncIterable<ChatChunk> {
			return chatOpenAiCompat(entry, req, undefined, opts);
		},
	};
}

export const sidecarAdapter: ProviderAdapter = createSidecarAdapter();
