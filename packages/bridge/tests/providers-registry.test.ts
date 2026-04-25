import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeMemoryDb, openMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";
import { DEFAULT_PROVIDERS, ProviderRegistry } from "../src/providers/registry.js";

let db: DatabaseSync;
let repo: MemoryRepository;
let registry: ProviderRegistry;

beforeEach(() => {
	db = openMemoryDb({ dbPath: ":memory:" });
	repo = new MemoryRepository(db);
	registry = new ProviderRegistry(repo);
});

afterEach(() => {
	db.close();
	closeMemoryDb();
});

describe("ProviderRegistry", () => {
	it("seeds DEFAULT_PROVIDERS on first load and persists them", () => {
		const first = registry.load();
		expect(first.length).toBe(DEFAULT_PROVIDERS.length);
		// Confirm the cli-claude default is intact and enabled.
		const claude = first.find((e) => e.id === "cli:claude");
		expect(claude?.enabled).toBe(true);
		expect(claude?.fallbacks).toContain("sidecar:cliproxy:claude");
		// Re-load should not reset to defaults — settings row exists.
		registry.upsert({ ...claude!, label: "edited" });
		const after = registry.load();
		expect(after.find((e) => e.id === "cli:claude")?.label).toBe("edited");
	});

	it("upserts and removes entries", () => {
		registry.load(); // seed
		registry.upsert({
			id: "byok:openai",
			kind: "byok",
			label: "OpenAI (BYOK)",
			enabled: true,
			base_url: "https://api.openai.com/v1",
			api_key_ref: "kc:openai",
			priority: 40,
		});
		expect(registry.get("byok:openai")?.label).toBe("OpenAI (BYOK)");
		expect(registry.remove("byok:openai")).toBe(true);
		expect(registry.get("byok:openai")).toBeNull();
		expect(registry.remove("missing")).toBe(false);
	});

	it("enabled() returns only enabled entries sorted by priority", () => {
		registry.load();
		const enabled = registry.enabled();
		expect(enabled.length).toBeGreaterThan(0);
		// All defaults that are enabled have priorities 10/11/12 (cli lane).
		expect(enabled[0]?.id).toBe("cli:claude");
		expect(enabled[1]?.id).toBe("cli:codex");
		expect(enabled[2]?.id).toBe("cli:gemini");
	});

	it("throws when stored registry is corrupt", () => {
		repo.setSetting("providers", "registry", "{ not json");
		expect(() => registry.load()).toThrow(/corrupt/);
	});

	it("resetToDefaults restores fresh entries", () => {
		registry.load();
		registry.remove("cli:claude");
		expect(registry.get("cli:claude")).toBeNull();
		const fresh = registry.resetToDefaults();
		expect(fresh.find((e) => e.id === "cli:claude")).toBeDefined();
	});
});
