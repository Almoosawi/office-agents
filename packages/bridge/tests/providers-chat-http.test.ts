import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { closeMemoryDb, openMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";
import { ChatDispatcher } from "../src/providers/chat-dispatcher.js";
import { handleProvidersChat } from "../src/providers/chat-http.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderRouter } from "../src/providers/router.js";
import type {
	ChatChunk,
	ChatRequest,
	ProviderAdapter,
	ProviderEntry,
} from "../src/providers/types.js";

const TEST_TOKEN = "test-token-1234567890abcdef1234567890abcdef";

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

function fakeAdapter(chunks: ChatChunk[]): ProviderAdapter {
	return {
		kind: "cli",
		async probe() {
			return { available: true };
		},
		async listModels() {
			return [];
		},
		async *chat(_e: ProviderEntry, req: ChatRequest) {
			for (const c of chunks) {
				if (req.signal?.aborted) {
					yield { type: "done", reason: "abort" } as ChatChunk;
					return;
				}
				yield c;
			}
		},
	};
}

let server: Server;
let port: number;
let dispatcher: ChatDispatcher;

beforeEach(async () => {
	const db = openMemoryDb({ dbPath: ":memory:" });
	const repo = new MemoryRepository(db);
	const registry = new ProviderRegistry(repo);
	registry.load();
	const router = new ProviderRouter({
		registry,
		adapters: {
			cli: fakeAdapter([
				{ type: "text", delta: "hello " },
				{ type: "text", delta: "world" },
				{ type: "done", reason: "stop" },
			]),
		},
	});
	dispatcher = new ChatDispatcher(router);

	server = createServer(async (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		const handled = await handleProvidersChat(
			req,
			res,
			pathname,
			{ dispatcher, authToken: TEST_TOKEN },
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
	closeMemoryDb();
});

const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

async function readNdjson(body: ReadableStream<Uint8Array>): Promise<unknown[]> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const lines: unknown[] = [];
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (line) lines.push(JSON.parse(line));
			idx = buf.indexOf("\n");
		}
	}
	if (buf.trim()) lines.push(JSON.parse(buf.trim()));
	return lines;
}

describe("POST /api/providers/:id/chat", () => {
	it("streams NDJSON chunks and trailing info line", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/chat"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TEST_TOKEN}`,
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const lines = await readNdjson(res.body!);
		const chunkLines = lines.filter(
			(l) => (l as { kind: string }).kind === "chunk",
		) as Array<{ chunk: { kind: string; delta?: string } }>;
		expect(chunkLines.map((l) => l.chunk.kind)).toEqual([
			"text",
			"text",
			"done",
		]);
		expect(chunkLines.map((l) => l.chunk.delta).filter(Boolean)).toEqual([
			"hello ",
			"world",
		]);
		const info = lines.find(
			(l) => (l as { kind: string }).kind === "info",
		) as { chosen: string; fallbackUsed: boolean };
		expect(info.chosen).toBe("cli:claude");
		expect(info.fallbackUsed).toBe(false);
	});

	it("401s without bearer token", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/chat"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "x" }],
			}),
		});
		expect(res.status).toBe(401);
	});

	it("400s on missing/malformed messages", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/chat"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TEST_TOKEN}`,
			},
			body: JSON.stringify({ messages: "not-array" }),
		});
		expect(res.status).toBe(400);
	});

	it("400s on bad role enum", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/chat"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TEST_TOKEN}`,
			},
			body: JSON.stringify({
				messages: [{ role: "weird", content: "x" }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("405s on non-POST", async () => {
		const res = await fetch(url("/api/providers/cli%3Aclaude/chat"), {
			method: "GET",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(res.status).toBe(405);
	});

	it("emits error+done chunks for unknown provider id", async () => {
		const res = await fetch(url("/api/providers/cli%3Anope/chat"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TEST_TOKEN}`,
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "x" }],
			}),
		});
		// The endpoint commits 200 + headers as soon as auth+shape pass; the
		// actual resolution failure surfaces inside the NDJSON stream.
		expect(res.status).toBe(200);
		const lines = await readNdjson(res.body!);
		const errors = lines.filter(
			(l) =>
				(l as { kind: string }).kind === "chunk" &&
				((l as { chunk: { kind: string } }).chunk.kind === "error"),
		);
		expect(errors.length).toBeGreaterThan(0);
		const dones = lines.filter(
			(l) =>
				(l as { kind: string }).kind === "chunk" &&
				((l as { chunk: { kind: string } }).chunk.kind === "done"),
		);
		expect(dones.length).toBeGreaterThan(0);
	});
});
