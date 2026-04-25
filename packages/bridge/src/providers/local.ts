// Local adapter — user-run OpenAI-compatible servers (Ollama, LMStudio,
// vLLM, llama.cpp). All four expose `/v1/models` + `/v1/chat/completions`,
// so the adapter is just an OpenAI-compat thin wrapper.
//
// Ollama note: its native API is `/api/tags` + `/api/chat`. The OpenAI-compat
// surface lives at `/v1/...`. Default base_url in the registry already points
// there. If the user wants the native Ollama API directly, they can change
// base_url and we'll add a separate adapter later — not needed for MVP.

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

export function createLocalAdapter(opts: OpenAiCompatOptions = {}): ProviderAdapter {
	return {
		kind: "local",
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

export const localAdapter: ProviderAdapter = createLocalAdapter();
