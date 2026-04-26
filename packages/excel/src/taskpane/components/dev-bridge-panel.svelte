<script lang="ts">
  // Dev-only floating panel that exercises the bridge WS chat path.
  // Lets you smoke-test cli:claude / cli:codex / cli:gemini / sidecar
  // entries against a live bridge without leaving Excel. Production
  // builds tree-shake this out via the import.meta.env.DEV gate in
  // app.svelte.

  import { onDestroy } from "svelte";
  import type {
    BridgeChatChunk,
    BridgeChatHandle,
    OfficeBridgeController,
  } from "@office-agents/bridge/client";

  interface Props {
    controller: OfficeBridgeController;
    bridgeHttpUrl: string;
  }

  interface ProviderRow {
    id: string;
    label: string;
    kind: string;
    enabled: boolean;
  }

  let { controller, bridgeHttpUrl }: Props = $props();

  let open = $state(false);
  let providers = $state<ProviderRow[]>([]);
  let providerError = $state<string | null>(null);
  let selected = $state<string>("");
  let message = $state<string>("Say hi in three words.");
  let transcript = $state<string>("");
  let info = $state<string>("");
  let busy = $state<boolean>(false);
  let activeHandle: BridgeChatHandle | null = null;

  async function refreshProviders(): Promise<void> {
    providerError = null;
    try {
      const res = await fetch(`${bridgeHttpUrl}/api/providers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { providers: ProviderRow[] };
      providers = body.providers;
      if (!selected && providers.length > 0) {
        const firstEnabled = providers.find((p) => p.enabled);
        selected = (firstEnabled ?? providers[0]).id;
      }
    } catch (e) {
      providerError = (e as Error).message;
    }
  }

  function chunkToText(c: BridgeChatChunk): string {
    if (c.kind === "text") return c.delta;
    if (c.kind === "error") return `\n[error] ${c.message}\n`;
    if (c.kind === "tool_call")
      return `\n[tool_call ${c.name}] ${c.argsJson}\n`;
    return "";
  }

  async function send(): Promise<void> {
    if (!selected || !message.trim() || busy) return;
    busy = true;
    transcript = "";
    info = "";
    try {
      const handle = controller.chat(selected, {
        messages: [{ role: "user", content: message }],
      });
      activeHandle = handle;
      for await (const chunk of handle.chunks) {
        if (chunk.kind === "done") {
          info = `done (${chunk.reason ?? "stop"}) — provider=${selected}`;
          break;
        }
        const piece = chunkToText(chunk);
        if (piece) transcript += piece;
      }
    } catch (e) {
      info = `[client error] ${(e as Error).message}`;
    } finally {
      activeHandle = null;
      busy = false;
    }
  }

  function abort(): void {
    activeHandle?.abort();
  }

  function togglePanel(): void {
    open = !open;
    if (open && providers.length === 0) {
      void refreshProviders();
    }
  }

  onDestroy(() => {
    activeHandle?.abort();
  });
</script>

<div class="bridge-dev-root">
  <button
    class="bridge-dev-fab"
    title="Dev: bridge chat"
    aria-label="Open bridge dev chat panel"
    onclick={togglePanel}
  >
    {open ? "×" : "⚡"}
  </button>

  {#if open}
    <div class="bridge-dev-panel" role="dialog" aria-label="Bridge dev chat">
      <header>
        <strong>Bridge dev chat</strong>
        <span class="muted">{bridgeHttpUrl}</span>
      </header>

      <div class="row">
        <label for="bridge-dev-provider">Provider</label>
        <select id="bridge-dev-provider" bind:value={selected} disabled={busy}>
          {#each providers as p (p.id)}
            <option value={p.id} disabled={!p.enabled}>
              {p.label} {p.enabled ? "" : "(disabled)"}
            </option>
          {/each}
        </select>
        <button onclick={refreshProviders} disabled={busy} type="button">
          Refresh
        </button>
      </div>

      {#if providerError}
        <div class="error">Failed to load providers: {providerError}</div>
      {/if}

      <textarea
        bind:value={message}
        rows="3"
        placeholder="Message…"
        disabled={busy}
      ></textarea>

      <div class="row">
        <button onclick={send} disabled={busy || !selected} type="button">
          {busy ? "Streaming…" : "Send"}
        </button>
        <button onclick={abort} disabled={!busy} type="button">
          Abort
        </button>
      </div>

      <pre class="transcript" aria-live="polite">{transcript || "(no output yet)"}</pre>

      {#if info}
        <div class="info">{info}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bridge-dev-root {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 99999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px;
  }
  .bridge-dev-fab {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid #888;
    background: #222;
    color: #fff;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .bridge-dev-fab:hover {
    background: #333;
  }
  .bridge-dev-panel {
    position: absolute;
    right: 0;
    bottom: 44px;
    width: 380px;
    max-height: 70vh;
    overflow: auto;
    background: #1e1e1e;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .muted {
    color: #888;
    font-size: 11px;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .row label {
    font-weight: 600;
  }
  select,
  textarea,
  button {
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 4px 6px;
    font: inherit;
  }
  select {
    flex: 1;
  }
  textarea {
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
  }
  button {
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #333;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .transcript {
    background: #111;
    color: #eee;
    padding: 8px;
    border-radius: 4px;
    min-height: 60px;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px;
    margin: 0;
  }
  .info {
    color: #8a8;
    font-size: 11px;
  }
  .error {
    color: #f88;
    font-size: 11px;
  }
</style>
