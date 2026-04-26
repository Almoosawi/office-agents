// SidecarSupervisor — owns the lifecycle of a single CliProxyManager
// instance shared by every sidecar provider entry. Lazy-starts on the
// first probe/chat so the user never has to manually launch the proxy.
//
// Why a separate class instead of folding into CliProxyManager:
//   - The manager is a thin spawn/wait wrapper. The supervisor adds the
//     "idempotent ensure-running with concurrent-call dedup" semantics
//     the adapter actually needs.
//   - Tests can mock the manager factory without touching spawn/fetch.
//   - Future: when we add per-vendor login flows ("Sign in with Claude")
//     the supervisor is the natural place to surface them.
//
// Failure semantics: if the binary is missing or fails to start, every
// caller gets the same error message; the supervisor stays in "no
// manager" state and the next call will retry from scratch.

import { CliProxyManager, type CliProxyManagerOptions } from "./cliproxy.js";

export interface SidecarSupervisorOptions {
	/**
	 * Inject a manager factory for tests. Production calls leave this off
	 * so we get a real CliProxyManager.
	 */
	managerFactory?: () => CliProxyManager;
	/** Forwarded to CliProxyManager when no factory is supplied. */
	managerOptions?: CliProxyManagerOptions;
	/** start() readiness timeout. Defaults to manager's own default. */
	readyTimeoutMs?: number;
}

export class SidecarSupervisor {
	private manager: CliProxyManager | null = null;
	/** In-flight start promise — dedups concurrent ensureRunning calls. */
	private starting: Promise<string> | null = null;
	private readonly factory: () => CliProxyManager;
	private readonly readyTimeoutMs: number | undefined;

	constructor(opts: SidecarSupervisorOptions = {}) {
		this.factory =
			opts.managerFactory ??
			(() => new CliProxyManager(opts.managerOptions ?? {}));
		this.readyTimeoutMs = opts.readyTimeoutMs;
	}

	/**
	 * Idempotent start. Resolves with the API key once the proxy is up.
	 * Concurrent callers share a single in-flight start. Callers should
	 * NOT cache the returned key — it rotates across restarts. Use
	 * apiKey() each time instead.
	 */
	async ensureRunning(): Promise<string> {
		if (this.manager?.isRunning()) {
			const key = this.manager.getApiKey();
			if (key) return key;
		}
		if (this.starting) return this.starting;
		this.starting = (async () => {
			try {
				const mgr = this.factory();
				const result = await mgr.start({
					readyTimeoutMs: this.readyTimeoutMs,
				});
				this.manager = mgr;
				return result.apiKey;
			} catch (e) {
				// Roll back so the next call retries cleanly. Without this,
				// a transient start failure would stick the supervisor in a
				// half-started state.
				if (this.manager) {
					try {
						await this.manager.stop();
					} catch {
						// best-effort
					}
				}
				this.manager = null;
				throw e;
			} finally {
				this.starting = null;
			}
		})();
		return this.starting;
	}

	/** Synchronous accessor — undefined until ensureRunning has resolved. */
	apiKey(): string | undefined {
		if (!this.manager?.isRunning()) return undefined;
		return this.manager.getApiKey() ?? undefined;
	}

	isRunning(): boolean {
		return this.manager?.isRunning() ?? false;
	}

	/**
	 * Stop the proxy if it's running. Called from bridge close() so the
	 * child process tears down before the bridge exits. Safe to call
	 * when nothing's running.
	 */
	async stop(): Promise<void> {
		const mgr = this.manager;
		this.manager = null;
		this.starting = null;
		if (mgr) await mgr.stop();
	}
}
