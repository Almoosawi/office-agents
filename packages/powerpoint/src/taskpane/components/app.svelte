<script lang="ts">
  import { AgentContext, ChatInterface, ErrorBoundary } from "@office-agents/core";
  import DevBridgePanel from "@office-agents/core/dev/dev-bridge-panel.svelte";
  import { onMount } from "svelte";
  import { createPowerPointAdapter } from "../../lib/adapter";
  import type { OfficeBridgeController } from "@office-agents/bridge/client";

  const adapter = createPowerPointAdapter();
  const ctx = new AgentContext({
    namespace: adapter.storageNamespace,
    staticFiles: adapter.staticFiles,
    customCommands: adapter.customCommands,
  });

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
        app: "powerpoint",
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
