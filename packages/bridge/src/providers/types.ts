// Provider abstraction for the assistant-bridge.
//
// Hybrid lane order (per ARCHITECTURE / PLAN module 2):
//   1) `cli`     — spawn the user's local CLI binary (`claude`/`codex`/`gemini`).
//   2) `sidecar` — bundled CLIProxyAPI HTTP proxy (OpenAI/Anthropic/Gemini-
//                  compatible), reuses the CLIs' OAuth tokens. Fallback for (1).
//   3) `local`   — user-run OpenAI-compatible server (Ollama, LMStudio, vLLM,
//                  llama.cpp).
//   4) `byok`    — direct cloud-API call with a user-supplied key.
//
// Selection is user-driven: every provider lives in `ProviderRegistry`,
// gets enabled/disabled in the Settings UI, and the router walks the
// `fallbacks[]` chain on probe failure.
//
// Orchestrator hook (foundation only): `role: 'orchestrator'` flags a
// provider as a small-job worker. Dispatch lives in `providers/orchestrator.ts`
// (deferred to Sprint 2). The job-envelope types below are stable so callers
// can start producing them today.

export type ProviderKind = "cli" | "sidecar" | "local" | "byok";

export type ProviderRole = "main" | "orchestrator" | "background";

export interface ProviderEntry {
	/** Stable id, e.g. `cli:claude`, `sidecar:cliproxy:claude`, `local:ollama`. */
	id: string;
	kind: ProviderKind;
	/** UI label. */
	label: string;
	/** Whether this entry participates in routing. */
	enabled: boolean;

	// ---- discovery + invocation ----

	/** kind=`cli`: binary name on PATH or full path (e.g. `claude`, `codex.cmd`). */
	command?: string;
	/** kind=`sidecar`/`local`/`byok`: HTTP base URL (no trailing slash). */
	base_url?: string;
	/** kind=`byok`: opaque keychain reference; never plaintext in DB. */
	api_key_ref?: string;

	// ---- model + sampling ----

	model?: string;
	/** 0.0..2.0 (UI clamps). */
	temperature?: number;
	/** 0..1. */
	top_p?: number;
	max_tokens?: number;
	/** Appended AFTER persona + skill prompts, before the user message. */
	system_prompt_override?: string;

	// ---- routing + roles ----

	/** Lower wins in the picker. */
	priority?: number;
	/** Provider ids to try if probe() fails on this one (in order). */
	fallbacks?: string[];
	/** Foundation hook for the deferred orchestrator dispatcher. */
	role?: ProviderRole;

	// ---- per-kind extras ----

	/** Free-form per-kind hints (e.g. `{ upstream: "claude" }` for sidecar). */
	extra?: Record<string, unknown>;
}

export interface ProbeResult {
	available: boolean;
	/** Human-readable reason when unavailable. */
	reason?: string;
	/** CLI/server version if reported. */
	version?: string;
	/** Model list if the probe surface returned it. */
	models?: string[];
	latencyMs?: number;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
	role: MessageRole;
	content: string;
	/** For role=`tool`: id of the assistant tool_use block being answered. */
	tool_call_id?: string;
	/** For role=`tool`: tool name. */
	tool_name?: string;
}

export interface ChatRequest {
	messages: ChatMessage[];
	/** Per-call overrides; fall back to entry settings when absent. */
	model?: string;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	/** Adapters MUST honor and kill the underlying process/socket. */
	signal?: AbortSignal;
}

/** Discriminated streaming chunk. Adapters normalize into this shape. */
export type ChatChunk =
	| { type: "text"; delta: string }
	| { type: "tool_call"; id: string; name: string; argsJson: string }
	| { type: "tool_result"; id: string; resultJson: string }
	| { type: "error"; message: string; recoverable?: boolean }
	| {
			type: "done";
			reason?: "stop" | "length" | "tool_call" | "error" | "abort";
	  };

export interface ProviderAdapter {
	kind: ProviderKind;
	probe(entry: ProviderEntry): Promise<ProbeResult>;
	listModels(entry: ProviderEntry): Promise<string[]>;
	chat(entry: ProviderEntry, req: ChatRequest): AsyncIterable<ChatChunk>;
}

// ---------- Orchestrator job envelope (foundation; dispatch deferred) ----------

export type OrchestratorBody =
	| { format: "json"; data: unknown }
	| { format: "markdown"; text: string }
	| { format: "yaml"; text: string };

export interface OrchestratorJob {
	/** e.g. `summarize`, `extract_action_items`, `classify_email`. */
	job_type: string;
	/** Caller-supplied; echoed back in the result. */
	job_id: string;
	/** Provider id this job should be routed to, if any. */
	preferred_provider?: string;
	/** Hard deadline; dispatcher aborts if exceeded. */
	timeout_ms?: number;
	body: OrchestratorBody;
	/** JSON Schema / typebox / null. Unused until the dispatcher lands. */
	expected_schema?: unknown;
}

export interface OrchestratorResult {
	job_id: string;
	ok: boolean;
	body?: OrchestratorBody;
	error?: string;
	/** Provider id that handled the job. */
	provider_used?: string;
	latency_ms?: number;
}
