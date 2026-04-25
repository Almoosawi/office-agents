import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeMemoryDb, openMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderRouter } from "../src/providers/router.js";
import type {
	ChatChunk,
	ChatRequest,
	ProbeResult,
	ProviderAdapter,
	ProviderEntry,
} from "../src/providers/types.js";

let db: DatabaseSync;
let repo: MemoryRepository;
let registry: ProviderRegistry;

beforeEach(() => {
	db = openMemoryDb({ dbPath: ":memory:" });
	repo = new MemoryRepository(db);
	registry = new ProviderRegistry(repo);
	registry.load();
});
afterEach(() => {
	db.close();
	closeMemoryDb();
});

function fakeAdapter(
	kind: ProviderEntry["kind"],
	probeByCommand: Record<string, ProbeResult>,
): ProviderAdapter {
	return {
		kind,
		async probe(entry) {
			const key = entry.command ?? entry.base_url ?? entry.id;
			return probeByCommand[key] ?? { available: false, reason: "no probe" };
		},
		async listModels() {
			return [];
		},
		// biome-ignore lint/correctness/useYield: stub adapter
		async *chat(_e, _r): AsyncIterable<ChatChunk> {
			return;
		},
	};
}

describe("ProviderRouter.resolve", () => {
	it("returns the requested entry when probe succeeds", async () => {
		const router = new ProviderRouter({
			registry,
			adapters: {
				cli: fakeAdapter("cli", {
					claude: { available: true, version: "2.1" },
				}),
				sidecar: fakeAdapter("sidecar", {}),
				local: fakeAdapter("local", {}),
				byok: fakeAdapter("byok", {}),
			},
		});
		const decision = await router.resolve("cli:claude");
		expect(decision.fallbackUsed).toBe(false);
		expect(decision.chosen.id).toBe("cli:claude");
	});

	it("walks fallback chain when primary probe fails", async () => {
		// Enable the sidecar fallback so the router considers it.
		const sidecar = registry.get("sidecar:cliproxy:claude");
		if (sidecar) registry.upsert({ ...sidecar, enabled: true });
		const router = new ProviderRouter({
			registry,
			adapters: {
				cli: fakeAdapter("cli", {
					claude: { available: false, reason: "ENOENT" },
				}),
				sidecar: fakeAdapter("sidecar", {
					"http://127.0.0.1:8317/api/provider/claude/v1": {
						available: true,
						models: ["claude-opus-4-7"],
					},
				}),
				local: fakeAdapter("local", {}),
				byok: fakeAdapter("byok", {}),
			},
		});
		const decision = await router.resolve("cli:claude");
		expect(decision.fallbackUsed).toBe(true);
		expect(decision.chosen.id).toBe("sidecar:cliproxy:claude");
		expect(decision.attempts.map((a) => a.id)).toEqual([
			"cli:claude",
			"sidecar:cliproxy:claude",
		]);
	});

	it("throws when no provider in the chain is available", async () => {
		const sidecar = registry.get("sidecar:cliproxy:claude");
		if (sidecar) registry.upsert({ ...sidecar, enabled: true });
		const router = new ProviderRouter({
			registry,
			adapters: {
				cli: fakeAdapter("cli", {
					claude: { available: false, reason: "missing" },
				}),
				sidecar: fakeAdapter("sidecar", {
					"http://127.0.0.1:8317/api/provider/claude/v1": {
						available: false,
						reason: "ECONNREFUSED",
					},
				}),
				local: fakeAdapter("local", {}),
				byok: fakeAdapter("byok", {}),
			},
		});
		await expect(router.resolve("cli:claude")).rejects.toThrow(
			/no available provider/,
		);
	});

	it("skips disabled fallbacks", async () => {
		// sidecar:cliproxy:claude default is disabled — chain has only the primary.
		const router = new ProviderRouter({
			registry,
			adapters: {
				cli: fakeAdapter("cli", {
					claude: { available: false, reason: "ENOENT" },
				}),
				sidecar: fakeAdapter("sidecar", {
					"http://127.0.0.1:8317/api/provider/claude/v1": {
						available: true,
					},
				}),
				local: fakeAdapter("local", {}),
				byok: fakeAdapter("byok", {}),
			},
		});
		await expect(router.resolve("cli:claude")).rejects.toThrow(
			/no available provider/,
		);
	});

	it("rejects unknown ids", async () => {
		const router = new ProviderRouter({ registry });
		await expect(router.resolve("nope:nada")).rejects.toThrow(/unknown provider/);
	});
});
