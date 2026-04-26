// Chat dispatcher — the only place that drives `adapter.chat()` for both
// transports (WS chat_request from a taskpane, NDJSON-streaming HTTP POST
// from the CLI). Owns the in-flight AbortController table so callers can
// cancel a running stream by requestId without holding a reference to the
// adapter or its child process.
//
// Lifecycle per requestId:
//   start() inserts an AbortController, kicks off the chat iterator, pumps
//   chunks into onChunk, then removes the controller on terminal frame
//   (`done` chunk) or on thrown error. abort(requestId) fires the
//   controller's signal — adapters react by killing their CLI/HTTP and
//   yielding a `done` chunk with reason="abort".

import { ProviderRouter } from "./router.js";
import type {
	ChatChunk,
	ChatRequest,
	ProviderAdapter,
	ProviderEntry,
} from "./types.js";

export interface ChatDispatchStart {
	requestId: string;
	providerId: string;
	request: Omit<ChatRequest, "signal">;
	onChunk: (chunk: ChatChunk) => void;
}

export interface ChatDispatchInfo {
	chosen: ProviderEntry;
	fallbackUsed: boolean;
	attempts: Array<{ id: string; reason?: string }>;
}

/**
 * Drives chat across the router. Owns the abort table.
 */
export class ChatDispatcher {
	private readonly active = new Map<string, AbortController>();

	constructor(private readonly router: ProviderRouter) {}

	/**
	 * Resolve the provider, then iterate `adapter.chat()` while pumping
	 * chunks into onChunk. Resolves to a ChatDispatchInfo describing which
	 * entry was actually used. On any error, surfaces an `error` + `done`
	 * chunk and returns normally — callers should treat the chunks as
	 * authoritative, not the resolved value alone.
	 *
	 * Concurrent starts with the same requestId are rejected to avoid
	 * orphaning AbortControllers in the active map.
	 */
	async start(opts: ChatDispatchStart): Promise<ChatDispatchInfo> {
		if (this.active.has(opts.requestId)) {
			throw new Error(`chat already in flight: ${opts.requestId}`);
		}
		const controller = new AbortController();
		this.active.set(opts.requestId, controller);

		try {
			const decision = await this.router.resolve(opts.providerId);
			const adapter: ProviderAdapter = decision.chosenAdapter;
			const enriched: ChatRequest = {
				...opts.request,
				signal: controller.signal,
			};

			let sawDone = false;
			try {
				for await (const chunk of adapter.chat(decision.chosen, enriched)) {
					opts.onChunk(chunk);
					if (chunk.type === "done") {
						sawDone = true;
						break;
					}
				}
			} catch (e) {
				const reason = controller.signal.aborted ? "abort" : "error";
				opts.onChunk({
					type: "error",
					message: (e as Error).message ?? String(e),
				});
				opts.onChunk({ type: "done", reason });
				sawDone = true;
			}
			// Adapters that exit their iterator without a terminal `done` get
			// one synthesized so taskpane state machines don't dangle.
			if (!sawDone) {
				const reason = controller.signal.aborted ? "abort" : "stop";
				opts.onChunk({ type: "done", reason });
			}

			return {
				chosen: decision.chosen,
				fallbackUsed: decision.fallbackUsed,
				attempts: decision.attempts.map((a) => ({
					id: a.id,
					reason: a.probe.reason,
				})),
			};
		} catch (e) {
			// Resolution failure (no available provider, unknown id, etc.).
			// Surface as a chunk pair so the caller's UI doesn't have to
			// branch on resolution-vs-stream errors.
			opts.onChunk({
				type: "error",
				message: (e as Error).message ?? String(e),
			});
			opts.onChunk({ type: "done", reason: "error" });
			throw e;
		} finally {
			this.active.delete(opts.requestId);
		}
	}

	/**
	 * Fire the abort signal for an in-flight chat. Returns true if a chat
	 * was actually in flight; false if no such requestId.
	 */
	abort(requestId: string): boolean {
		const controller = this.active.get(requestId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	/** Number of in-flight chats. Test/observability hook. */
	activeCount(): number {
		return this.active.size;
	}

	/**
	 * Abort everything. Called on bridge shutdown so adapters can kill
	 * their child processes / HTTP sockets cleanly.
	 */
	abortAll(): void {
		for (const c of this.active.values()) c.abort();
		this.active.clear();
	}
}
