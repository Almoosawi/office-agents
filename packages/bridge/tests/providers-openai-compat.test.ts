import { describe, expect, it, vi } from "vitest";
import {
	chatOpenAiCompat,
	probeOpenAiCompat,
	toChatChunks,
} from "../src/providers/openai-compat.js";
import type { ProviderEntry } from "../src/providers/types.js";

const sidecarEntry: ProviderEntry = {
	id: "sidecar:cliproxy:claude",
	kind: "sidecar",
	label: "Sidecar Claude",
	enabled: true,
	base_url: "http://127.0.0.1:8317/api/provider/claude/v1",
};

describe("toChatChunks (SSE parser)", () => {
	it("emits text deltas", () => {
		const out = toChatChunks(
			`data: ${JSON.stringify({
				choices: [{ delta: { content: "hello" } }],
			})}`,
		);
		expect(out).toEqual([{ type: "text", delta: "hello" }]);
	});

	it("emits tool_call from function-call deltas", () => {
		const out = toChatChunks(
			`data: ${JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									id: "tc_1",
									function: { name: "search", arguments: '{"q":"x"}' },
								},
							],
						},
					},
				],
			})}`,
		);
		expect(out).toEqual([
			{
				type: "tool_call",
				id: "tc_1",
				name: "search",
				argsJson: '{"q":"x"}',
			},
		]);
	});

	it("translates finish_reason into a done chunk", () => {
		const out = toChatChunks(
			`data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
		);
		expect(out).toContainEqual({ type: "done", reason: "stop" });
	});

	it("handles [DONE] terminator and ignores keepalives", () => {
		expect(toChatChunks("data: [DONE]")).toEqual([{ type: "done", reason: "stop" }]);
		expect(toChatChunks(": keepalive")).toEqual([]);
		expect(toChatChunks("")).toEqual([]);
	});
});

describe("probeOpenAiCompat", () => {
	it("returns available + models on 200", async () => {
		const fetchFn = vi.fn(async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "model-a" }, { id: "model-b" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const probe = await probeOpenAiCompat(sidecarEntry, undefined, {
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(probe.available).toBe(true);
		expect(probe.models).toEqual(["model-a", "model-b"]);
	});

	it("returns unavailable on 5xx", async () => {
		const fetchFn = vi.fn(
			async () => new Response("nope", { status: 502, statusText: "Bad Gateway" }),
		);
		const probe = await probeOpenAiCompat(sidecarEntry, undefined, {
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/502/);
	});

	it("handles network errors gracefully", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const probe = await probeOpenAiCompat(sidecarEntry, undefined, {
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(probe.available).toBe(false);
		expect(probe.reason).toContain("ECONNREFUSED");
	});

	it("flags missing base_url", async () => {
		const probe = await probeOpenAiCompat({
			...sidecarEntry,
			base_url: undefined,
		});
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/base_url/);
	});
});

describe("chatOpenAiCompat", () => {
	function sseStream(...lines: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const l of lines) controller.enqueue(encoder.encode(`${l}\n`));
				controller.close();
			},
		});
	}

	it("yields text chunks then done from an SSE response", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(
					sseStream(
						`data: ${JSON.stringify({
							choices: [{ delta: { content: "Hi " } }],
						})}`,
						`data: ${JSON.stringify({
							choices: [{ delta: { content: "there" } }],
						})}`,
						`data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
						"data: [DONE]",
					),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		const out = [];
		for await (const c of chatOpenAiCompat(
			sidecarEntry,
			{ messages: [{ role: "user", content: "ping" }] },
			undefined,
			{ fetchFn: fetchFn as unknown as typeof fetch },
		)) {
			out.push(c);
		}
		const texts = out
			.filter((c): c is { type: "text"; delta: string } => c.type === "text")
			.map((c) => c.delta)
			.join("");
		expect(texts).toBe("Hi there");
		expect(out.some((c) => c.type === "done" && c.reason === "stop")).toBe(true);
	});

	it("emits error chunk on non-2xx", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response("rate limited", {
					status: 429,
					statusText: "Too Many Requests",
				}),
		);
		const out = [];
		for await (const c of chatOpenAiCompat(
			sidecarEntry,
			{ messages: [{ role: "user", content: "ping" }] },
			undefined,
			{ fetchFn: fetchFn as unknown as typeof fetch },
		)) {
			out.push(c);
		}
		expect(out[0]).toMatchObject({ type: "error" });
		expect(out.at(-1)).toEqual({ type: "done", reason: "error" });
	});
});
