// Provider router — resolves a registry id to an adapter, walks fallback
// chains on probe failure, surfaces "X is unavailable, switched to Y" events
// to the bridge protocol layer (wired in module 6).
//
// Routing rule (the user's "C first, A fallback" ask):
//   1. Look up entry by id.
//   2. Probe it.
//   3. On failure: walk `entry.fallbacks[]` in order, probe each.
//   4. Yield (chosen entry, adapter).
//   5. If everything fails → throw a structured error the UI can render.

import { cliAdapter } from "./cli.js";
import { localAdapter } from "./local.js";
import type { ProviderRegistry } from "./registry.js";
import { sidecarAdapter } from "./sidecar.js";
import type {
	ChatChunk,
	ChatRequest,
	ProbeResult,
	ProviderAdapter,
	ProviderEntry,
} from "./types.js";

export interface RouteDecision {
	requested: ProviderEntry;
	chosen: ProviderEntry;
	chosenAdapter: ProviderAdapter;
	probe: ProbeResult;
	/** True if the chosen entry differs from the requested one. */
	fallbackUsed: boolean;
	/** Probes attempted (in order). */
	attempts: Array<{ id: string; probe: ProbeResult }>;
}

export interface RouterOptions {
	registry: ProviderRegistry;
	/** Override per-kind adapters (used by tests). */
	adapters?: Partial<Record<ProviderEntry["kind"], ProviderAdapter>>;
}

export class ProviderRouter {
	private readonly registry: ProviderRegistry;
	private readonly adapters: Record<ProviderEntry["kind"], ProviderAdapter>;

	constructor(opts: RouterOptions) {
		this.registry = opts.registry;
		this.adapters = {
			cli: opts.adapters?.cli ?? cliAdapter,
			sidecar: opts.adapters?.sidecar ?? sidecarAdapter,
			local: opts.adapters?.local ?? localAdapter,
			// `byok` adapter ships in module 4. Until then, treat it as unavailable
			// by routing through the sidecar adapter, which will fail-fast on
			// missing base_url.
			byok: opts.adapters?.byok ?? sidecarAdapter,
		};
	}

	getAdapter(entry: ProviderEntry): ProviderAdapter {
		return this.adapters[entry.kind];
	}

	/**
	 * Probe `id` and walk its fallback chain. Returns the first available
	 * (entry, adapter) pair, or throws if the chain is exhausted.
	 */
	async resolve(id: string): Promise<RouteDecision> {
		const requested = this.registry.get(id);
		if (!requested) {
			throw new Error(`unknown provider id: ${id}`);
		}
		const attempts: RouteDecision["attempts"] = [];
		const tryEntry = async (entry: ProviderEntry): Promise<ProbeResult> => {
			const probe = await this.adapters[entry.kind].probe(entry);
			attempts.push({ id: entry.id, probe });
			return probe;
		};

		const firstProbe = await tryEntry(requested);
		if (firstProbe.available) {
			return {
				requested,
				chosen: requested,
				chosenAdapter: this.adapters[requested.kind],
				probe: firstProbe,
				fallbackUsed: false,
				attempts,
			};
		}
		for (const fid of requested.fallbacks ?? []) {
			const fallback = this.registry.get(fid);
			if (!fallback || !fallback.enabled) continue;
			const probe = await tryEntry(fallback);
			if (probe.available) {
				return {
					requested,
					chosen: fallback,
					chosenAdapter: this.adapters[fallback.kind],
					probe,
					fallbackUsed: true,
					attempts,
				};
			}
		}
		const summary = attempts
			.map((a) => `${a.id}: ${a.probe.reason ?? "(unknown)"}`)
			.join("; ");
		throw new Error(
			`no available provider for ${id}; tried ${attempts.length}: ${summary}`,
		);
	}

	chat(entry: ProviderEntry, req: ChatRequest): AsyncIterable<ChatChunk> {
		return this.adapters[entry.kind].chat(entry, req);
	}
}
