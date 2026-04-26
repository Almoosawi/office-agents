// HTTP streaming chat endpoint. POST /api/providers/:id/chat with a JSON
// body, get back NDJSON (one JSON object per line) of ChatChunk frames.
// NDJSON is intentional over SSE: simpler to parse from CLI tools, no
// `data:` envelope, works with curl + plain `for await (line of stdin)`.
//
// Auth: bearer token gate identical to mutating /api/providers/* routes.
//
// Cancellation: client disconnect aborts the dispatcher entry. The CLI
// sends SIGINT → fetch aborts → res.on("close") fires → we abort the
// in-flight chat → adapter kills its child process / fetch.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	extractBearer,
	timingSafeEqualString,
} from "../auth/token.js";
import {
	chatChunkToWire,
	createBridgeId,
	type BridgeChatRequestPayload,
} from "../protocol.js";
import type { ChatDispatcher } from "./chat-dispatcher.js";

export interface ProvidersChatHttpDeps {
	dispatcher: ChatDispatcher;
	authToken?: string;
}

interface JsonBody {
	(req: IncomingMessage): Promise<unknown>;
}

interface JsonResponse {
	(res: ServerResponse, statusCode: number, payload: unknown): void;
}

function isAuthorized(req: IncomingMessage, expected: string | undefined): boolean {
	if (!expected) return true;
	const got = extractBearer(req.headers.authorization);
	if (!got) return false;
	return timingSafeEqualString(got, expected);
}

function isChatPayload(value: unknown): value is BridgeChatRequestPayload {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.messages)) return false;
	for (const m of v.messages) {
		if (typeof m !== "object" || m === null) return false;
		const role = (m as Record<string, unknown>).role;
		const content = (m as Record<string, unknown>).content;
		if (
			role !== "system" &&
			role !== "user" &&
			role !== "assistant" &&
			role !== "tool"
		) {
			return false;
		}
		if (typeof content !== "string") return false;
	}
	return true;
}

/**
 * Try to handle as POST /api/providers/:id/chat. Returns true if handled.
 */
export async function handleProvidersChat(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	deps: ProvidersChatHttpDeps,
	helpers: { readJson: JsonBody; writeJson: JsonResponse },
): Promise<boolean> {
	const match = pathname.match(/^\/api\/providers\/([^/]+)\/chat$/);
	if (!match) return false;
	if (req.method !== "POST") {
		helpers.writeJson(res, 405, {
			ok: false,
			error: { message: "method not allowed" },
		});
		return true;
	}
	if (!isAuthorized(req, deps.authToken)) {
		helpers.writeJson(res, 401, {
			ok: false,
			error: { message: "missing or invalid bearer token" },
		});
		return true;
	}

	const providerId = decodeURIComponent(match[1]!);

	let body: unknown;
	try {
		body = await helpers.readJson(req);
	} catch (e) {
		helpers.writeJson(res, 400, {
			ok: false,
			error: { message: `invalid JSON: ${(e as Error).message}` },
		});
		return true;
	}
	if (!isChatPayload(body)) {
		helpers.writeJson(res, 400, {
			ok: false,
			error: {
				message:
					"body must be { messages: [{role, content}, ...], model?, temperature?, top_p?, max_tokens? }",
			},
		});
		return true;
	}

	// Switch to streaming mode. We DON'T use Transfer-Encoding: chunked
	// explicitly — Node sets it automatically when statusCode is written
	// with no Content-Length and the response is left open.
	res.statusCode = 200;
	res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	// Disable any reverse-proxy buffering so chunks land at the client
	// the moment the adapter yields them.
	res.setHeader("x-accel-buffering", "no");

	const requestId = createBridgeId("chat");

	const writeLine = (payload: unknown): void => {
		// Best-effort write — if the client has hung up, just drop. Don't
		// throw; the dispatch loop's onChunk shouldn't crash mid-stream.
		try {
			res.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// res may already be closed — fine, abort below cleans up.
		}
	};

	// Surface routing metadata as the first NDJSON line so the CLI can
	// show "using cli:claude (fallback from sidecar:cliproxy:claude)".
	let info: { chosen: string; fallbackUsed: boolean } | null = null;

	const aborted = { value: false };
	res.on("close", () => {
		if (!res.writableEnded) {
			aborted.value = true;
			deps.dispatcher.abort(requestId);
		}
	});

	try {
		const result = await deps.dispatcher.start({
			requestId,
			providerId,
			request: body,
			onChunk: (chunk) => {
				writeLine({ kind: "chunk", chunk: chatChunkToWire(chunk) });
			},
		});
		info = { chosen: result.chosen.id, fallbackUsed: result.fallbackUsed };
		// Trailing routing summary so the CLI can verify what got picked.
		writeLine({ kind: "info", ...info });
	} catch {
		// Dispatcher already wrote error+done chunks via onChunk; the throw
		// is just the resolution failure surface, not a separate signal.
	}

	if (!res.writableEnded) res.end();
	return true;
}
