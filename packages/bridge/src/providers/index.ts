// Public surface for the providers module.

export type {
	ChatChunk,
	ChatMessage,
	ChatRequest,
	MessageRole,
	OrchestratorBody,
	OrchestratorJob,
	OrchestratorResult,
	ProbeResult,
	ProviderAdapter,
	ProviderEntry,
	ProviderKind,
	ProviderRole,
} from "./types.js";

export {
	DEFAULT_PROVIDERS,
	ProviderRegistry,
} from "./registry.js";

export {
	buildCliInvocation,
	cliAdapter,
	createCliAdapter,
	detectCli,
	flattenMessages,
	normalizeStreamLine,
	type CliAdapterOptions,
	type CliKey,
} from "./cli.js";

export {
	chatOpenAiCompat,
	listModelsOpenAiCompat,
	probeOpenAiCompat,
	type OpenAiCompatOptions,
} from "./openai-compat.js";

export {
	createSidecarAdapter,
	sidecarAdapter,
} from "./sidecar.js";

export {
	createLocalAdapter,
	localAdapter,
} from "./local.js";

export {
	ProviderRouter,
	type RouteDecision,
	type RouterOptions,
} from "./router.js";
