import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { closeMemoryDb, openMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";
import { handleProvidersRoute } from "../src/providers/http-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderRouter } from "../src/providers/router.js";
import type {
	ChatChunk,
	ProbeResult,
	ProviderAdapter,
} from "../src/providers/types.js";

// Minimal helpers replicating what server.ts passes in.
function writeJson(res: ServerResponse, status: number, payload: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (chunks.length === 0) return undefined;
	const body = Buffer.concat(chunks).toString("utf8").trim();
	if (!body) return undefined;
	return JSON.parse(body);
}

function fakeAdapter(
	kind: "cli" | "sidecar" | "local" | "byok",
	probeBy: Record<string, ProbeResult>,
	models: string[],
): ProviderAdapter {
	return {
		kind,
		async probe(entry) {
			const key = entry.command ?? entry.base_url ?? entry.id;
			return probeBy[key] ?? { available: false, reason: "no probe" };
		},
		async listModels() {
			return models;
		},
		// biome-ignore lint/correctness/useYield: stub
		async *chat(): AsyncIterable<ChatChunk> {
			return;
		},
	};
}

let server: Server;
let port: number;
let db: DatabaseSync;
let repo: MemoryRepository;
let registry: ProviderRegistry;
let router: ProviderRouter;

beforeEach(async () => {
	db = openMemoryDb({ dbPath: ":memory:" });
	repo = new MemoryRepository(db);
	registry = new ProviderRegistry(repo);
	registry.load(); // seed defaults
	router = new ProviderRouter({
		registry,
		adapters: {
			cli: fakeAdapter(
				"cli",
				{
					claude: { available: true, version: "2.1" },
					codex: { available: false, reason: "ENOENT" },
					gemini: { available: true, version: "0.39" },
				},
				["claude-opus-4-7"],
			),
			sidecar: fakeAdapter("sidecar", {}, []),
			local: fakeAdapter("local", {}, []),
			byok: fakeAdapter("byok", {}, []),
		},
	});

	server = createServer(async (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		const handled = await handleProvidersRoute(
			req,
			res,
			pathname,
			{ registry, router },
			{ readJson, writeJson },
		);
		if (!handled) {
			res.statusCode = 404;
			res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	db.close();
	closeMemoryDb();
});

const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

describe("provider HTTP routes", () => {
	it("GET /api/providers returns the seeded registry", async () => {
		const res = await fetch(url("/api/providers"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			providers: Array<{ id: string }>;
		};
		expect(body.ok).toBe(true);
		expect(body.providers.map((p) => p.id)).toContain("cli:claude");
		expect(body.providers.map((p) => p.id)).toContain("sidecar:cliproxy:claude");
	});

	it("GET /api/providers/:id returns one entry or 404", async () => {
		const ok = await fetch(url("/api/providers/cli%3Aclaude"));
		expect(ok.status).toBe(200);
		const okBody = (await ok.json()) as { provider: { id: string } };
		expect(okBody.provider.id).toBe("cli:claude");

		const missing = await fetch(url("/api/providers/no%3Asuch"));
		expect(missing.status).toBe(404);
	});

	it("PUT /api/providers/:id upserts the entry", async () => {
		const entry = {
			id: "byok:openai",
			kind: "byok",
			label: "OpenAI BYOK",
			enabled: true,
			base_url: "https://api.openai.com/v1",
		};
		const res = await fetch(url("/api/providers/byok%3Aopenai"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(entry),
		});
		expect(res.status).toBe(200);
		expect(registry.get("byok:openai")?.label).toBe("OpenAI BYOK");
	});

	it("PUT /api/providers/:id 400s on body/url id mismatch", async () => {
		const res = await fetch(url("/api/providers/byok%3Aopenai"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "byok:wrong",
				kind: "byok",
				label: "X",
				enabled: true,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("DELETE /api/providers/:id removes the entry", async () => {
		const ok = await fetch(url("/api/providers/local%3Aollama"), {
			method: "DELETE",
		});
		expect(ok.status).toBe(200);
		expect(registry.get("local:ollama")).toBeNull();

		const gone = await fetch(url("/api/providers/local%3Aollama"), {
			method: "DELETE",
		});
		expect(gone.status).toBe(404);
	});

	it("POST /api/providers/:id/probe returns probe + chosen", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/probe"), {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			probe: ProbeResult;
			chosen: { id: string };
			fallbackUsed: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.probe.available).toBe(true);
		expect(body.chosen.id).toBe("cli:claude");
		expect(body.fallbackUsed).toBe(false);
	});

	it("POST /api/providers/:id/probe surfaces ok=false when chain exhausted", async () => {
		// codex has no fallback enabled (sidecar:cliproxy:codex defaults to disabled)
		const res = await fetch(url("/api/providers/cli%3Acodex/probe"), {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; error?: { message: string } };
		expect(body.ok).toBe(false);
		expect(body.error?.message).toMatch(/no available provider/);
	});

	it("GET /api/providers/:id/models returns the curated list", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/models"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: string[] };
		expect(body.models).toEqual(["claude-opus-4-7"]);
	});

	it("POST /api/providers/reset restores defaults", async () => {
		registry.remove("cli:claude");
		expect(registry.get("cli:claude")).toBeNull();
		const res = await fetch(url("/api/providers/reset"), { method: "POST" });
		expect(res.status).toBe(200);
		expect(registry.get("cli:claude")?.id).toBe("cli:claude");
	});
});
