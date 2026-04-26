<script lang="ts">
  import {
    AgentContext,
    ChatInterface,
    ErrorBoundary,
  } from "@office-agents/core";
  import { onMount } from "svelte";
  import { createExcelAdapter } from "../../lib/adapter";
  import DevBridgePanel from "./dev-bridge-panel.svelte";
  import type { OfficeBridgeController } from "@office-agents/bridge/client";

  const adapter = createExcelAdapter();
  const ctx = new AgentContext({
    namespace: adapter.storageNamespace,
    staticFiles: adapter.staticFiles,
    customCommands: adapter.customCommands,
  });

  // DEV-only bridge state. Production builds tree-shake the panel and
  // controller because the import.meta.env.DEV branch is dead code.
  let bridgeController = $state<OfficeBridgeController | null>(null);
  let bridgeHttpUrl = $state<string | null>(null);

  onMount(() => {
    if (!import.meta.env.DEV) return undefined;

    let stopped = false;
    let stopBridge: (() => void) | undefined;

    void Promise.all([
      import("@office-agents/bridge/client"),
      import("@office-agents/bridge/protocol"),
    ]).then(([{ startOfficeBridge }, { normalizeBridgeUrl }]) => {
      if (stopped) return;

      const bridge = startOfficeBridge({
        app: "excel",
        adapter,
        vfs: ctx,
      });
      bridgeController = bridge;
      try {
        bridgeHttpUrl = normalizeBridgeUrl(undefined, "http");
      } catch {
        bridgeHttpUrl = "https://127.0.0.1:4017";
      }
      stopBridge = () => {
        bridgeController = null;
        bridgeHttpUrl = null;
        bridge.stop();
      };
    });

    return () => {
      stopped = true;
      stopBridge?.();
    };
  });
</script>

<ErrorBoundary>
  <div class="h-screen w-full overflow-hidden">
    <ChatInterface {adapter} context={ctx} />
  </div>
  {#if import.meta.env.DEV && bridgeController && bridgeHttpUrl}
    <DevBridgePanel
      controller={bridgeController}
      bridgeHttpUrl={bridgeHttpUrl}
    />
  {/if}
</ErrorBoundary>
