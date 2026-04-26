import { describe, expect, it } from "vitest";
import { closeMemoryDb, openMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";
import { ChatDispatcher } from "../src/providers/chat-dispatcher.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderRouter } from "../src/providers/router.js";
import type {
	ChatChunk,
	ChatRequest,
	ProbeResult,
	ProviderAdapter,
	ProviderEntry,
} from "../src/providers/types.js";

interface AdapterOpts {
	probe?: ProbeResult;
	chunks?: ChatChunk[];
	/** Hold the chat iterator open until the test calls release(). */
	hold?: { release: () => void };
}

function fakeAdapter(opts: AdapterOpts): ProviderAdapter {
	return {
		kind: "cli",
		async probe() {
			return opts.probe ?? { available: true };
		},
		async listModels() {
			return [];
		},
		async *chat(_entry: ProviderEntry, req: ChatRequest): AsyncIterable<ChatChunk> {
			for (const c of opts.chunks ?? []) {
				if (req.signal?.aborted) {
					yield { type: "done", reason: "abort" };
					return;
				}
				yield c;
			}
			if (opts.hold) {
				await new Promise<void>((resolve) => {
					opts.hold!.release = resolve;
					req.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				if (req.signal?.aborted) {
					yield { type: "done", reason: "abort" };
				}
			}
		},
	};
}

function setup(adapter: ProviderAdapter): {
	registry: ProviderRegistry;
	router: ProviderRouter;
	dispatcher: ChatDispatcher;
	cleanup: () => void;
} {
	const db = openMemoryDb({ dbPath: ":memory:" });
	const repo = new MemoryRepository(db);
	const registry = new ProviderRegistry(repo);
	registry.load();
	const router = new ProviderRouter({ registry, adapters: { cli: adapter } });
	const dispatcher = new ChatDispatcher(router);
	return {
		registry,
		router,
		dispatcher,
		cleanup: () => {
			db.close();
			closeMemoryDb();
		},
	};
}

describe("ChatDispatcher.start — happy path", () => {
	it("pumps chunks in order and resolves with chosen entry", async () => {
		const adapter = fakeAdapter({
			chunks: [
				{ type: "text", delta: "hi" },
				{ type: "text", delta: " there" },
				{ type: "done", reason: "stop" },
			],
		});
		const { dispatcher, cleanup } = setup(adapter);
		try {
			const got: ChatChunk[] = [];
			const info = await dispatcher.start({
				requestId: "r1",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "hi" }] },
				onChunk: (c) => got.push(c),
			});
			expect(got).toEqual([
				{ type: "text", delta: "hi" },
				{ type: "text", delta: " there" },
				{ type: "done", reason: "stop" },
			]);
			expect(info.chosen.id).toBe("cli:claude");
			expect(info.fallbackUsed).toBe(false);
			expect(dispatcher.activeCount()).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("synthesizes a done chunk if the adapter exits without one", async () => {
		const adapter = fakeAdapter({
			chunks: [{ type: "text", delta: "abrupt" }],
		});
		const { dispatcher, cleanup } = setup(adapter);
		try {
			const got: ChatChunk[] = [];
			await dispatcher.start({
				requestId: "r1",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "x" }] },
				onChunk: (c) => got.push(c),
			});
			expect(got.at(-1)).toEqual({ type: "done", reason: "stop" });
		} finally {
			cleanup();
		}
	});
});

describe("ChatDispatcher.start — failures", () => {
	it("emits error+done and rejects when the provider is unknown", async () => {
		const adapter = fakeAdapter({});
		const { dispatcher, cleanup } = setup(adapter);
		try {
			const got: ChatChunk[] = [];
			await expect(
				dispatcher.start({
					requestId: "r1",
					providerId: "cli:does-not-exist",
					request: { messages: [{ role: "user", content: "x" }] },
					onChunk: (c) => got.push(c),
				}),
			).rejects.toThrow(/unknown provider/);
			expect(got[0]?.type).toBe("error");
			expect(got.at(-1)).toEqual({ type: "done", reason: "error" });
		} finally {
			cleanup();
		}
	});

	it("emits error+done when the adapter throws mid-stream", async () => {
		const adapter: ProviderAdapter = {
			kind: "cli",
			async probe() {
				return { available: true };
			},
			async listModels() {
				return [];
			},
			async *chat() {
				yield { type: "text", delta: "before-boom" };
				throw new Error("boom");
			},
		};
		const { dispatcher, cleanup } = setup(adapter);
		try {
			const got: ChatChunk[] = [];
			await dispatcher.start({
				requestId: "r1",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "x" }] },
				onChunk: (c) => got.push(c),
			});
			expect(got).toContainEqual({ type: "text", delta: "before-boom" });
			expect(got.some((c) => c.type === "error")).toBe(true);
			expect(got.at(-1)).toEqual({ type: "done", reason: "error" });
		} finally {
			cleanup();
		}
	});

	it("rejects concurrent reuse of the same requestId", async () => {
		const hold = { release: () => undefined };
		const adapter = fakeAdapter({ hold });
		const { dispatcher, cleanup } = setup(adapter);
		try {
			const first = dispatcher.start({
				requestId: "r-collide",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "x" }] },
				onChunk: () => undefined,
			});
			// Give it a tick to register in the active map.
			await new Promise((r) => setTimeout(r, 5));
			await expect(
				dispatcher.start({
					requestId: "r-collide",
					providerId: "cli:claude",
					request: { messages: [{ role: "user", content: "y" }] },
					onChunk: () => undefined,
				}),
			).rejects.toThrow(/already in flight/);
			dispatcher.abort("r-collide");
			hold.release();
			await first;
		} finally {
			cleanup();
		}
	});
});

describe("ChatDispatcher.abort", () => {
	it("aborts an in-flight chat and yields done(abort)", async () => {
		const hold = { release: () => undefined };
		const adapter = fakeAdapter({
			chunks: [{ type: "text", delta: "first" }],
			hold,
		});
		const { dispatcher, cleanup } = setup(adapter);
		try {
			const got: ChatChunk[] = [];
			const promise = dispatcher.start({
				requestId: "r-abort",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "x" }] },
				onChunk: (c) => got.push(c),
			});
			// Wait for the first chunk to ensure the iterator is running.
			await new Promise((r) => setTimeout(r, 20));
			expect(dispatcher.activeCount()).toBe(1);
			expect(dispatcher.abort("r-abort")).toBe(true);
			await promise;
			expect(got.at(-1)).toEqual({ type: "done", reason: "abort" });
			expect(dispatcher.activeCount()).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("returns false when aborting an unknown requestId", async () => {
		const adapter = fakeAdapter({});
		const { dispatcher, cleanup } = setup(adapter);
		try {
			expect(dispatcher.abort("nope")).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("abortAll fires every controller and clears the table", async () => {
		const hold1 = { release: () => undefined };
		const hold2 = { release: () => undefined };
		const adapter = fakeAdapter({ hold: hold1 });
		const adapter2 = fakeAdapter({ hold: hold2 });
		const { registry, cleanup } = setup(adapter);
		try {
			// Two independent dispatchers sharing a registry, each with its
			// own router/adapter — keeps the test focused on abortAll.
			const router1 = new ProviderRouter({
				registry,
				adapters: { cli: adapter },
			});
			const router2 = new ProviderRouter({
				registry,
				adapters: { cli: adapter2 },
			});
			const d1 = new ChatDispatcher(router1);
			const d2 = new ChatDispatcher(router2);
			const p1 = d1.start({
				requestId: "r-1",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "a" }] },
				onChunk: () => undefined,
			});
			const p2 = d2.start({
				requestId: "r-2",
				providerId: "cli:claude",
				request: { messages: [{ role: "user", content: "b" }] },
				onChunk: () => undefined,
			});
			await new Promise((r) => setTimeout(r, 10));
			d1.abortAll();
			d2.abortAll();
			expect(d1.activeCount()).toBe(0);
			expect(d2.activeCount()).toBe(0);
			await Promise.all([p1, p2]);
		} finally {
			cleanup();
		}
	});
});
