// HTTP route handlers for the providers module. The bridge server delegates
// `/api/providers/*` requests here so server.ts stays manageable and the
// provider surface can grow (chat streaming, write ops) without dragging
// the whole server along.
//
// Endpoints (all loopback-only, JSON):
//   GET    /api/providers                  -> ProviderEntry[]
//   POST   /api/providers/reset            -> ProviderEntry[] (defaults)   [bearer]
//   GET    /api/providers/:id              -> ProviderEntry | 404
//   PUT    /api/providers/:id              -> ProviderEntry (upsert)       [bearer]
//   DELETE /api/providers/:id              -> { ok: boolean }              [bearer]
//   POST   /api/providers/:id/probe        -> ProbeResult                  [bearer]
//   GET    /api/providers/:id/models       -> { models: string[] }
//
// Auth: mutating endpoints require `Authorization: Bearer <token>` matching
// `deps.authToken` — TLS alone won't stop a hostile web origin from POSTing
// to 127.0.0.1. When `deps.authToken` is undefined, the gate is open (used
// by tests that exercise validation logic without auth coupling).
//
// Privacy: ProviderEntry payloads NEVER contain secrets — `api_key_ref`
// holds an opaque keychain reference, not the key itself. Even so, the
// bridge binds 127.0.0.1 only (ARCHITECTURE §1a), so this surface is
// loopback-restricted.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	extractBearer,
	timingSafeEqualString,
} from "../auth/token.js";
import type { ProviderRegistry } from "./registry.js";
import type { ProviderRouter } from "./router.js";
import type { ProviderEntry } from "./types.js";
import { validateProviderEntry } from "./validation.js";

export interface ProvidersHttpDeps {
	registry: ProviderRegistry;
	router: ProviderRouter;
	/**
	 * Bearer token required for mutating endpoints. When undefined, the gate
	 * is open — use only in tests that don't need to exercise auth.
	 */
	authToken?: string;
}

interface JsonBody {
	(req: IncomingMessage): Promise<unknown>;
}

interface JsonResponse {
	(res: ServerResponse, statusCode: number, payload: unknown): void;
}

function sanitize(entry: ProviderEntry): ProviderEntry {
	// Future-proofing: if we ever introduce secret-bearing fields on the
	// entry, redact them here. For now `api_key_ref` is a keychain handle,
	// not a secret, so we pass it through.
	return entry;
}

function isAuthorized(req: IncomingMessage, expected: string | undefined): boolean {
	if (!expected) return true; // gate disabled
	const got = extractBearer(req.headers.authorization);
	if (!got) return false;
	return timingSafeEqualString(got, expected);
}

/**
 * Try to handle the request as a /api/providers/* route. Returns `true` if
 * the request was handled (and the response was written), `false` otherwise.
 */
export async function handleProvidersRoute(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	deps: ProvidersHttpDeps,
	helpers: { readJson: JsonBody; writeJson: JsonResponse },
): Promise<boolean> {
	const { registry, router, authToken } = deps;
	const { readJson, writeJson } = helpers;

	if (!pathname.startsWith("/api/providers")) return false;

	// Collection routes
	if (pathname === "/api/providers") {
		if (req.method === "GET") {
			writeJson(res, 200, {
				ok: true,
				providers: registry.load().map(sanitize),
			});
			return true;
		}
		writeJson(res, 405, { ok: false, error: { message: "method not allowed" } });
		return true;
	}

	if (pathname === "/api/providers/reset") {
		if (req.method === "POST") {
			if (!isAuthorized(req, authToken)) {
				writeJson(res, 401, {
					ok: false,
					error: { message: "missing or invalid bearer token" },
				});
				return true;
			}
			const fresh = registry.resetToDefaults();
			writeJson(res, 200, { ok: true, providers: fresh.map(sanitize) });
			return true;
		}
		writeJson(res, 405, { ok: false, error: { message: "method not allowed" } });
		return true;
	}

	// Item routes: /api/providers/:id, /api/providers/:id/probe, /api/providers/:id/models
	const match = pathname.match(/^\/api\/providers\/([^/]+)(\/[^/]+)?$/);
	if (!match) return false;
	const id = decodeURIComponent(match[1]!);
	const sub = match[2];

	if (!sub) {
		// /api/providers/:id
		if (req.method === "GET") {
			const entry = registry.get(id);
			if (!entry) {
				writeJson(res, 404, { ok: false, error: { message: "not found" } });
				return true;
			}
			writeJson(res, 200, { ok: true, provider: sanitize(entry) });
			return true;
		}
		if (req.method === "PUT") {
			if (!isAuthorized(req, authToken)) {
				writeJson(res, 401, {
					ok: false,
					error: { message: "missing or invalid bearer token" },
				});
				return true;
			}
			let body: unknown;
			try {
				body = await readJson(req);
			} catch (e) {
				writeJson(res, 400, {
					ok: false,
					error: { message: `invalid JSON: ${(e as Error).message}` },
				});
				return true;
			}
			const validated = validateProviderEntry(body);
			if (validated.ok !== true) {
				writeJson(res, 400, {
					ok: false,
					error: { message: validated.error },
				});
				return true;
			}
			const entry = validated.entry;
			if (entry.id !== id) {
				writeJson(res, 400, {
					ok: false,
					error: {
						message: `body.id (${entry.id}) must match URL id (${id})`,
					},
				});
				return true;
			}
			registry.upsert(entry);
			writeJson(res, 200, { ok: true, provider: sanitize(entry) });
			return true;
		}
		if (req.method === "DELETE") {
			if (!isAuthorized(req, authToken)) {
				writeJson(res, 401, {
					ok: false,
					error: { message: "missing or invalid bearer token" },
				});
				return true;
			}
			const removed = registry.remove(id);
			writeJson(res, removed ? 200 : 404, { ok: removed });
			return true;
		}
		writeJson(res, 405, { ok: false, error: { message: "method not allowed" } });
		return true;
	}

	if (sub === "/probe" && req.method === "POST") {
		if (!isAuthorized(req, authToken)) {
			writeJson(res, 401, {
				ok: false,
				error: { message: "missing or invalid bearer token" },
			});
			return true;
		}
		try {
			const decision = await router.resolve(id);
			writeJson(res, 200, {
				ok: true,
				probe: decision.probe,
				chosen: sanitize(decision.chosen),
				fallbackUsed: decision.fallbackUsed,
				attempts: decision.attempts,
			});
		} catch (e) {
			writeJson(res, 200, {
				ok: false,
				error: { message: (e as Error).message },
			});
		}
		return true;
	}

	if (sub === "/models" && req.method === "GET") {
		const entry = registry.get(id);
		if (!entry) {
			writeJson(res, 404, { ok: false, error: { message: "not found" } });
			return true;
		}
		try {
			const adapter = router.getAdapter(entry);
			const models = await adapter.listModels(entry);
			writeJson(res, 200, { ok: true, models });
		} catch (e) {
			writeJson(res, 200, {
				ok: false,
				error: { message: (e as Error).message },
				models: [],
			});
		}
		return true;
	}

	writeJson(res, 405, { ok: false, error: { message: "method not allowed" } });
	return true;
}
