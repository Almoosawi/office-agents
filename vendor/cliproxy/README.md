# vendor/cliproxy

This folder hosts the **CLIProxyAPI** Go binary that backs the Office AI
Assistant's "lane A" provider fallback. The binary itself is **not committed**
— `pnpm fetch:cliproxy` resolves the pinned release in `VERSION.json`,
verifies the SHA-256, and extracts `CLIProxyAPI.exe` into this directory.

## What is CLIProxyAPI?

[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
is an MIT-licensed Go HTTP server that exposes OpenAI / Anthropic / Gemini
compatible endpoints, backed by the OAuth tokens already stored on disk
by the user's `claude` / `codex` / `gemini` CLIs. We use it as a sidecar:
the bridge spawns it on `127.0.0.1:7860`, talks plain OpenAI-compatible
HTTP, and the proxy translates upstream.

## Why a sidecar?

The Office AI Assistant's primary "lane C" spawns the user's CLI binaries
directly per chat turn. That works, but each call pays cold-start latency
and the CLIs' streaming-tool surfaces vary. CLIProxyAPI gives us:

- One persistent HTTP process (no per-call spawn)
- Native streaming + tool calling + multimodal across all 5 vendors
  (Claude, Codex, Gemini, Antigravity, Amp)
- Reuses the OAuth tokens the user already has — no separate login flow
- Multi-account round-robin if the user is signed into multiple

The router (`packages/bridge/src/providers/router.ts`) probes the CLI
binary first; on failure (binary missing, version drift, etc.) it falls
back to the sidecar via `entry.fallbacks[]`.

## License

CLIProxyAPI is MIT-licensed. Attribution + license text is mirrored in
`LICENSE.upstream` after `pnpm fetch:cliproxy` runs (the script extracts
the upstream `LICENSE` file alongside the binary).

## Install / refresh

```bash
pnpm fetch:cliproxy            # download pinned version
pnpm fetch:cliproxy --verify   # re-verify existing local files
pnpm fetch:cliproxy --pin v6.9.38   # rewrite VERSION.json + refetch
```

The script is Windows-only by design; macOS/Linux fetches are not wired
because the project is Windows-only (Office classic-Outlook + COM sidecar
require Windows).

## Where the binary ends up at install time

The repo's `vendor/cliproxy/CLIProxyAPI.exe` is the dev copy. The per-user
portable installer copies it (along with `LICENSE.upstream`) into:

```
%LocalAppData%\OfficeAIAssistant\bin\CLIProxyAPI.exe
%LocalAppData%\OfficeAIAssistant\bin\LICENSE.cliproxy
```

…and writes its config to:

```
%LocalAppData%\OfficeAIAssistant\config\cliproxy\config.yaml
```

The bridge's `sidecar/cliproxy.ts` manager handles the spawn / health /
restart lifecycle.
