// User-editable provider registry. Persisted in the memory-db `settings`
// table under (scope=`providers`, key=`registry`) as a JSON array of
// ProviderEntry rows. The Settings UI mutates this; the router reads it.

import type { MemoryRepository } from "../memory/repository.js";
import type { ProviderEntry } from "./types.js";

const SCOPE = "providers";
const KEY = "registry";

/**
 * Defaults shipped with the bridge. The first three entries are the C-first
 * lane (spawn local CLI binaries). They each declare a sidecar fallback so
 * the router can switch to CLIProxyAPI automatically when the binary is
 * missing (e.g. fresh PC) — provided the user has enabled the sidecar.
 *
 * Local (Ollama/LMStudio) entries are present but disabled by default; the
 * user flips them on once they confirm a server is running.
 */
export const DEFAULT_PROVIDERS: ProviderEntry[] = [
	// ----- C lane: spawn the user's CLI binaries -----
	{
		id: "cli:claude",
		kind: "cli",
		label: "Claude (CLI)",
		enabled: true,
		command: "claude",
		priority: 10,
		fallbacks: ["sidecar:cliproxy:claude"],
		role: "main",
	},
	{
		id: "cli:codex",
		kind: "cli",
		label: "Codex (CLI)",
		enabled: true,
		command: "codex",
		priority: 11,
		fallbacks: ["sidecar:cliproxy:codex"],
	},
	{
		id: "cli:gemini",
		kind: "cli",
		label: "Gemini (CLI)",
		enabled: true,
		command: "gemini",
		priority: 12,
		fallbacks: ["sidecar:cliproxy:gemini"],
	},
	// ----- A lane: bundled CLIProxyAPI sidecar (off until the binary ships) -----
	{
		id: "sidecar:cliproxy:claude",
		kind: "sidecar",
		label: "Claude (via CLIProxyAPI)",
		enabled: false,
		base_url: "http://127.0.0.1:7860/api/provider/claude/v1",
		priority: 20,
		extra: { upstream: "claude" },
	},
	{
		id: "sidecar:cliproxy:codex",
		kind: "sidecar",
		label: "Codex (via CLIProxyAPI)",
		enabled: false,
		base_url: "http://127.0.0.1:7860/api/provider/codex/v1",
		priority: 21,
		extra: { upstream: "codex" },
	},
	{
		id: "sidecar:cliproxy:gemini",
		kind: "sidecar",
		label: "Gemini (via CLIProxyAPI)",
		enabled: false,
		base_url: "http://127.0.0.1:7860/api/provider/gemini/v1",
		priority: 22,
		extra: { upstream: "gemini" },
	},
	// ----- Local OpenAI-compatible servers -----
	{
		id: "local:ollama",
		kind: "local",
		label: "Ollama",
		enabled: false,
		base_url: "http://127.0.0.1:11434/v1",
		priority: 30,
	},
	{
		id: "local:lmstudio",
		kind: "local",
		label: "LM Studio",
		enabled: false,
		base_url: "http://127.0.0.1:1234/v1",
		priority: 31,
	},
];

export class ProviderRegistry {
	constructor(private readonly repo: MemoryRepository) {}

	/**
	 * Load the registry from settings; on first run, seeds DEFAULT_PROVIDERS.
	 * Throws on corrupt JSON so the caller can surface the issue rather than
	 * silently overwriting user data.
	 */
	load(): ProviderEntry[] {
		const raw = this.repo.getSetting(SCOPE, KEY);
		if (!raw) {
			this.save(DEFAULT_PROVIDERS);
			return DEFAULT_PROVIDERS.map((e) => ({ ...e }));
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			throw new Error(
				`Provider registry corrupt (settings:${SCOPE}/${KEY}): ${(e as Error).message}`,
			);
		}
		if (!Array.isArray(parsed)) {
			throw new Error(
				`Provider registry corrupt (settings:${SCOPE}/${KEY}): expected array`,
			);
		}
		return parsed as ProviderEntry[];
	}

	save(entries: ProviderEntry[]): void {
		this.repo.setSetting(SCOPE, KEY, JSON.stringify(entries));
	}

	get(id: string): ProviderEntry | null {
		return this.load().find((e) => e.id === id) ?? null;
	}

	upsert(entry: ProviderEntry): void {
		const list = this.load();
		const i = list.findIndex((e) => e.id === entry.id);
		if (i >= 0) list[i] = entry;
		else list.push(entry);
		this.save(list);
	}

	remove(id: string): boolean {
		const list = this.load();
		const i = list.findIndex((e) => e.id === id);
		if (i < 0) return false;
		list.splice(i, 1);
		this.save(list);
		return true;
	}

	enabled(): ProviderEntry[] {
		return this.load()
			.filter((e) => e.enabled)
			.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
	}

	/** Reset to defaults (Settings UI exposes this as "Restore defaults"). */
	resetToDefaults(): ProviderEntry[] {
		const fresh = DEFAULT_PROVIDERS.map((e) => ({ ...e }));
		this.save(fresh);
		return fresh;
	}
}
