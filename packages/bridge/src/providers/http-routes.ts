// HTTP route handlers for the providers module. The bridge server delegates
// `/api/providers/*` requests here so server.ts stays manageable and the
// provider surface can grow (chat streaming, write ops) without dragging
// the whole server along.
//
// Endpoints (all loopback-only, JSON):
//   GET    /api/providers                  -> ProviderEntry[]
//   POST   /api/providers/reset            -> ProviderEntry[] (defaults)
//   GET    /api/providers/:id              -> ProviderEntry | 404
//   PUT    /api/providers/:id              -> ProviderEntry (upsert; body = entry)
//   DELETE /api/providers/:id              -> { ok: boolean }
//   POST   /api/providers/:id/probe        -> ProbeResult
//   GET    /api/providers/:id/models       -> { models: string[] }
//
// Privacy: ProviderEntry payloads NEVER contain secrets — `api_key_ref`
// holds an opaque keychain reference, not the key itself. Even so, the
// bridge binds 127.0.0.1 only (ARCHITECTURE §1a), so this surface is
// loopback-restricted.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRegistry } from "./registry.js";
import type { ProviderRouter } from "./router.js";
import type { ProviderEntry } from "./types.js";

export interface ProvidersHttpDeps {
	registry: ProviderRegistry;
	router: ProviderRouter;
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

function isProviderEntry(value: unknown): value is ProviderEntry {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || !v.id) return false;
	if (
		v.kind !== "cli" &&
		v.kind !== "sidecar" &&
		v.kind !== "local" &&
		v.kind !== "byok"
	)
		return false;
	if (typeof v.label !== "string") return false;
	if (typeof v.enabled !== "boolean") return false;
	return true;
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
	const { registry, router } = deps;
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
			if (!isProviderEntry(body)) {
				writeJson(res, 400, {
					ok: false,
					error: { message: "body must be a ProviderEntry" },
				});
				return true;
			}
			if (body.id !== id) {
				writeJson(res, 400, {
					ok: false,
					error: { message: `body.id (${body.id}) must match URL id (${id})` },
				});
				return true;
			}
			registry.upsert(body);
			writeJson(res, 200, { ok: true, provider: sanitize(body) });
			return true;
		}
		if (req.method === "DELETE") {
			const removed = registry.remove(id);
			writeJson(res, removed ? 200 : 404, { ok: removed });
			return true;
		}
		writeJson(res, 405, { ok: false, error: { message: "method not allowed" } });
		return true;
	}

	if (sub === "/probe" && req.method === "POST") {
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
