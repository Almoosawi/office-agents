# Office AI Assistant — Implementation Plan

Pair with `ARCHITECTURE.md`. This file is the build sequence.

> **Revision log**
> - r2 (2026-04-25): integrated GPT/codex Checkpoint-2 review. 7 fixes applied: CLI text-only boundary; MSAL NAA (not legacy SSO) for Graph; Graph-primary on M365 (not EWS-first); per-user startup app instead of Windows service (Outlook COM requires user session); HTTPS port-range probe instead of `%APPDATA%` handshake; dual-side gate enforcement; untrusted-content envelope for prompt-injection defence.

---

## Sprint 0 — Bootstrap (no functional changes)

**Goal:** clean fork, junctioned tooling, compiles + sideloads as-is.

1. `git init` `office-ai-assistant/`. Initial commit = empty (per CLAUDE.md U2 snapshot rule).
2. Junctions before any installs (CLAUDE.md W2/W3):
   - `node_modules` -> `C:\node_modules\office-ai-assistant\`
   - `build`, `dist` -> `C:\builds\office-ai-assistant\{build,dist}`
3. Copy `office-agents-word-v0.0.4/` contents into `office-ai-assistant/`. Drop: `.git/` (we'll have our own), CHANGELOG entries, dev-only TODO.
4. Rename packages:
   - `@office-agents/sdk` -> `@office-ai/sdk`
   - `@office-agents/core` -> `@office-ai/core`
   - `@office-agents/bridge` -> `@office-ai/bridge`
   - `@office-agents/{word,excel,powerpoint}` -> `@office-ai/{word,excel,powerpoint}`
   - new: `@office-ai/outlook`
5. `pnpm install`, `pnpm build`, sideload Word add-in to verify the fork still works.
6. Commit: `chore: fork office-agents-word and rename to office-ai-assistant`.

**Deliverable:** the existing Word/Excel/PPT add-ins build and sideload under the new name. Outlook package is empty stub.

---

## Sprint 1 — Bridge upgrade (`@office-ai/bridge`)

**Goal:** turn the dev bridge into the production assistant-bridge.

Add to `packages/bridge/src/`:

- `providers/cli-claude.ts` — spawn `claude` in **text-only completion mode** (`--print` non-interactive, no `--mcp-config`, no allowed tools). Parse plain-text/stream-text stdout.
- `providers/cli-codex.ts` — spawn `codex` in **text-only mode** (no agent loop, no shell tools). Whichever flag combination on `codex 0.117.0` disables its agentic tool execution — Sprint 1 first task is `codex exec --help` to confirm flag names.
- `providers/cli-gemini.ts` — spawn `gemini` in **text-only mode** (no built-in tool execution).

**Critical:** CLI adapters NEVER use the CLI's native tool system in v1. Each CLI is treated as a pure text-completion endpoint. Tool calls are extracted from the model's plain-text output via a custom marker protocol the system prompt instructs the model to emit:

```
<office_tool name="excel.set_range" id="t1">
{"address":"Sheet1!A1:B3","values":[[1,2],[3,4]]}
</office_tool>
```

The bridge parses these markers, dispatches them via WSS `tool.invoke` to the taskpane (where Office.js executes), pushes the result back as `tool.result`, and continues the conversation. This guarantees Office tools are the ONLY tools — claude/codex/gemini cannot reach the filesystem, shell, or web on their own. v2 may upgrade individual CLIs to native tool calling with a constrained MCP server, but only after this boundary is rock-solid.
- `providers/oauth-anthropic.ts` — already in fork; verify
- `providers/oauth-codex.ts` — already in fork; verify
- `providers/byok.ts` — generic OpenAI-compatible
- `providers/router.ts` — single `selectProvider()` based on settings + health
- `memory/db.ts` — SQLite via `better-sqlite3`; migrations in `memory/migrations/`
- `memory/sessions.ts`, `memory/messages.ts`, `memory/facts.ts`, `memory/settings.ts`, `memory/handles.ts`, `memory/skill_state.ts`
- `secrets/keychain.ts` — `keytar` wrapper, namespace `office-ai-assistant`
- `skills/loader.ts` — fs walker over `%APPDATA%\OfficeAIAssistant\skills\`, parses frontmatter, exposes `list()` + `load(name)`
- `outlook/tier-router.ts` — runtime tier 1/2/3 resolver
- `outlook/com-sidecar.ts` — spawn the bundled `outlook-com.exe`, manage lifecycle, MCP-stdio bridge

WebSocket protocol additions (extend existing `protocol.ts`):

| Direction | Method | Payload |
|---|---|---|
| client -> bridge | `chat.send` | { sessionId, message, host, host_context, skills_active, instructions, provider } |
| bridge -> client | `chat.delta` | { sessionId, role, content_chunk \| tool_call_chunk } |
| bridge -> client | `tool.invoke` | { sessionId, tool_name, args } -- for built-in host tools |
| client -> bridge | `tool.result` | { sessionId, tool_call_id, result } |
| client -> bridge | `memory.facts.list / put / delete` | ... |
| client -> bridge | `skills.list / load / install` | ... |
| client -> bridge | `outlook.tier_probe` | -> { tier1: ok, tier2: { backend: "graph"|"ews"|"none" }, tier3: { available, started } } |

Tests: bridge unit tests for each provider adapter (mock subprocess); integration test for SQLite migrations; tier-router unit tests with mocked `mailbox.diagnostics`.

**Deliverable:** bridge can route a chat through any of `claude`/`codex`/`gemini` CLI, persist messages to SQLite, store one secret in keychain, list installed skills.

---

## Sprint 2 — Outlook AppAdapter + Tier-1/2 tools

**Goal:** new `@office-ai/outlook` package with a working chat sidebar + the 15-tool surface from your `outlook_mcp` design spec, in TypeScript.

`packages/outlook/src/lib/`:

- `adapter.ts` — `AppAdapter` impl (system prompt, metadata, host capabilities)
- `tools/current-item/` — Tier 1 tools (Office.js mailbox)
  - `get-current-item.ts` (subject, sender, recipients, date, body, attachments)
  - `set-body.ts` (compose only)
  - `insert-text-at-cursor.ts` (compose)
  - `set-recipients.ts` (compose: to/cc/bcc)
  - `set-subject.ts` (compose)
  - `add-attachment.ts` (compose)
  - `send-current.ts` (compose, hard confirm gate)
- `tools/mailbox/` — Tier 2 tools (EWS or Graph via NAA, dispatched by tier-router)
  - `list-emails.ts`
  - `search-emails.ts`
  - `get-email.ts`
  - `send-email.ts` (mailbox-wide)
  - `reply-email.ts`
  - `list-events.ts`, `get-event.ts`, `create-event.ts`, `update-event.ts`, `respond-to-invite.ts`
  - `list-tasks.ts`, `get-task.ts`, `create-task.ts`, `update-task.ts`
  - `list-accounts.ts`
- `tools/ews/` — EWS SOAP request builders + parsers (port subset of EWS used by Tier-2)
- `tools/graph/` — Graph fetch wrappers using **MSAL.js Nested App Authentication** (`@azure/msal-browser`'s `createNestablePublicClientApplication()` + `acquireTokenSilent` with `acquireTokenPopup` fallback). `OfficeRuntime.auth.getAccessToken` (legacy SSO/OBO) only kept as a deprecated fallback for environments where NAA isn't available. Requires an Azure AD app registration declared in the unified manifest's `webApplicationInfo`/`authorization` block — first Sprint-2 task is to create the registration and wire its client ID into the build.
- `tools/index.ts` — dispatch table; each tool tries Tier 1 then escalates

Selection-aware context:
- read mode -> attach current-item summary
- compose mode -> attach draft state (recipients, subject, body, selection)

Manifest: extend root `manifest.json` to add Outlook scope + commands (compose pin, read pin).

**Deliverable:** open Outlook -> open Mait sidebar -> "summarize this email" works (Tier 1) -> "find emails from Alice last week" works (Tier 2 EWS or Graph).

---

## Sprint 3 — Tier-3 outlook-com sidecar

**Goal:** bundle your `outlook_mcp` Python COM server as a fallback that the bridge auto-spawns.

1. Copy `MCPs/Email MCP/` into `office-ai-assistant/sidecars/outlook-com/`. Keep your existing `pyproject.toml`, `src/outlook_mcp/`.
2. Add `sidecars/outlook-com/build.ps1` -> PyInstaller one-file exe. Output to `C:\builds\office-ai-assistant\sidecars\outlook-com.exe`.
3. Embed sidecar binary into bridge package on `pnpm build` (copy step in vite/tsup config).
4. Bridge spawns sidecar lazily: only on first `outlook.tier3` call. Communicates over stdio MCP. Idle-shutdown after 5 minutes.
5. Tier 3 tool surface = same 15 tools, dispatched through MCP-stdio. Tier router falls back automatically when Tier 2 returns auth/network/operation-not-supported errors.
6. CLAUDE.md W4 verification: build outlook-com.exe with stderr visible during dev, confirm zero stderr on startup before switching to silent.

**Deliverable:** unplug from internet -> mailbox-wide tools still work via COM. Tier 1 still prefers Office.js for current-item.

---

## Sprint 4 — Skills + persona + selection awareness across all hosts

**Goal:** match Claude-for-Excel feature parity, then surpass.

1. `packages/sdk/src/skills/` — port from existing fork; extend frontmatter schema with `host_scope`, `priority`, `trigger_keywords`.
2. Default skills shipped with installer (in `installer/skills-seed/`):
   - `mait-persona/SKILL.md` (the seed prompt from ARCHITECTURE.md s7)
   - `excel-formulas/SKILL.md` + patterns/pivots resources
   - `word-writeup/SKILL.md` + tone presets
   - `powerpoint-design/SKILL.md` + layouts/colors/charts
   - `email-tone/SKILL.md`
3. Settings panel addition (in `packages/core/src/chat/settings-panel.svelte`):
   - "Persona" textarea (writes `mait-persona/SKILL.md`)
   - "Instructions for this host" textarea per host (writes `settings` table)
   - Skill list with toggle on/off + "Install from URL" (clones a folder from a Git URL into skills dir)
4. Selection-aware context blob composer (`packages/core/src/chat/context-builder.ts`):
   - implement per-host inspectors using APIs in ARCHITECTURE.md s5
   - clip to 8KB; "expand" link in UI to include full
5. Cross-host shared context: when user switches Office host, the new sidebar reads `messages` from the most recent session and offers "Continue from <host>" — matches the March 2026 Anthropic Shared Context feature.

**Deliverable:** drop a skill folder in `%APPDATA%\OfficeAIAssistant\skills\` -> it shows up in settings and gets auto-loaded when triggers match. Persona is editable. Same conversation accessible from any host.

---

## Sprint 5 — Confirmation gates + safety + tests + installer

**Goal:** ship-ready.

1. Implement gate UI components (`packages/core/src/chat/confirmation/`):
   - send-email gate (preview + recipients + Send button)
   - bulk-edit gate (diff preview)
   - destructive-op gate (highlight what will change/delete)
2. Bridge-side gate enforcement (`packages/bridge/src/gates.ts`) — server refuses tool calls flagged as destructive unless paired with a `gate_token` issued by user click.
3. Tests: vitest in each package; e2e via office-bridge harness against a real Word/Excel/PPT/Outlook session.
4. Wix MSI installer (`installer/`):
   - bundles taskpane static files, bridge binary, outlook-com sidecar, default skills
   - registers manifest for sideload
   - **bridge runs as a per-user startup app, NOT a Windows service.** Registers via `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (or Task Scheduler logon trigger). Reason: Tier-3 Outlook COM automation requires the interactive logged-in user session and profile — Outlook Object Model is not supported from a service/unattended context.
   - bridge spawns the outlook-com sidecar as a child process in the same user context, so COM operations have a valid user session
5. Telemetry off by default; opt-in only.

**Deliverable:** an MSI you double-click. After install, opening any of the four Office hosts shows a Mait button on the ribbon -> sidebar -> works.

---

## Final file tree (post-Sprint 5)

```
office-ai-assistant/
  manifest.json                          # unified manifest, all 4 scopes
  manifest.outlook-only.json             # split fallback if M365 regresses W/E/P preview
  manifest.docs-only.json                # split fallback companion
  package.json                           # workspace root
  pnpm-workspace.yaml
  biome.json
  README.md
  ARCHITECTURE.md
  PLAN.md
  CLAUDE.md                              # AC3 project-local policy (after init)

  packages/
    sdk/                                 # @office-ai/sdk
      src/
        runtime.ts
        skills/
          loader.ts
          frontmatter.ts
        storage/
        tools/
        vfs/
    core/                                # @office-ai/core (Svelte chat)
      src/
        chat/
          chat-interface.svelte
          chat-controller.ts
          settings-panel.svelte
          context-builder.ts
          confirmation/
            send-email-gate.svelte
            bulk-edit-gate.svelte
            destructive-op-gate.svelte
    bridge/                              # @office-ai/bridge (Node)
      src/
        server.ts
        protocol.ts
        providers/
          cli-claude.ts
          cli-codex.ts
          cli-gemini.ts
          oauth-anthropic.ts
          oauth-codex.ts
          byok.ts
          router.ts
        memory/
          db.ts
          migrations/0001_init.sql
          sessions.ts
          messages.ts
          facts.ts
          settings.ts
          handles.ts
          skill_state.ts
        skills/
          loader.ts
        secrets/
          keychain.ts
        outlook/
          tier-router.ts
          com-sidecar.ts
        gates.ts
        cli.ts
    word/                                # @office-ai/word
      manifest.fragment.json
      src/lib/
        adapter.ts
        tools/
          ...existing office-agents-word tools...
    excel/                               # @office-ai/excel
      manifest.fragment.json
      src/lib/
        adapter.ts
        tools/
          ...existing...
    powerpoint/                          # @office-ai/powerpoint
      manifest.fragment.json
      src/lib/
        adapter.ts
        tools/
          ...existing...
    outlook/                             # @office-ai/outlook (NEW)
      manifest.fragment.json
      src/lib/
        adapter.ts
        tools/
          current-item/
          mailbox/
          ews/
          graph/
          index.ts

  sidecars/
    outlook-com/                         # vendored from MCPs/Email MCP
      pyproject.toml
      src/outlook_mcp/
      build.ps1
      tests/

  installer/
    wix/
      Product.wxs
    skills-seed/
      mait-persona/SKILL.md
      excel-formulas/
      word-writeup/
      powerpoint-design/
      email-tone/

  scripts/
    bootstrap-junctions.ps1              # creates W2/W3 junctions
    sideload-dev.ps1                     # office-addin-debugging start
    package-msi.ps1
```

---

## Manifest skeleton (extract)

```jsonc
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/vDevPreview/MicrosoftTeams.schema.json",
  "manifestVersion": "devPreview",
  "id": "REPLACE-GUID",
  "version": "0.1.0",
  "developer": { "name": "Dark", "websiteUrl": "https://example.invalid" },
  "name": { "short": "Mait", "full": "Mait — Office AI Assistant" },
  "description": { "short": "AI assistant inside Office", "full": "..." },
  "icons": { "color": "icon-128.png", "outline": "icon-32.png" },
  "accentColor": "#5B7EFF",
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "Mailbox.ReadWrite.User", "type": "Delegated" },
        { "name": "Document.ReadWrite.User", "type": "Delegated" }
      ]
    }
  },
  "webApplicationInfo": {
    "id": "REPLACE-AZURE-APP-CLIENT-ID",
    "resource": "api://localhost/REPLACE-AZURE-APP-CLIENT-ID"
  },
  "extensions": [
    {
      "requirements": {
        "scopes": ["mail", "workbook", "document", "presentation"]
      },
      "runtimes": [ /* per-host taskpane runtimes */ ],
      "ribbons":  [ /* per-host ribbon buttons -> open Mait sidebar */ ]
    }
  ],
  "validDomains": ["localhost"]
}
```

---

## SQLite schema (initial migration)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL CHECK (host IN ('word','excel','powerpoint','outlook')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT,
  persona_version INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,        -- JSON
  tool_results TEXT,      -- JSON
  host_context_id INTEGER REFERENCES host_contexts(id)
);

CREATE TABLE host_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  blob TEXT NOT NULL      -- JSON snapshot (selection, sheet, etc.)
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,    -- 'global' | 'word' | 'excel' | ...
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, key)
);

CREATE TABLE settings (
  scope TEXT NOT NULL,    -- 'global' | host
  key TEXT NOT NULL,      -- 'instructions' | 'provider' | etc.
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE outlook_handles (
  handle TEXT PRIMARY KEY,
  kind TEXT NOT NULL,     -- 'mail' | 'event' | 'task' | 'folder'
  store_id TEXT,
  entry_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE skill_state (
  skill_name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_loaded_at INTEGER,
  load_count INTEGER NOT NULL DEFAULT 0
);
```

---

## CLI adapter contracts (provider abstraction extension)

Each `providers/cli-*.ts` implements:

```ts
interface CliProvider {
  name: 'claude' | 'codex' | 'gemini';
  health(): Promise<{ ok: boolean; version?: string }>;
  stream(req: ChatRequest): AsyncIterable<ProviderDelta>;
}
```

Mapping per CLI (verified flags from this PC's installed versions):

| CLI | Spawn args | stdout format | Maps to |
|---|---|---|---|
| `claude 2.1.119` | `claude --print --output-format=stream-json --input-format=stream-json` | newline-delimited JSON events | `content_block_delta` -> ProviderDelta.text; `tool_use` -> ProviderDelta.tool_call |
| `codex 0.117.0` | `codex exec --json --skip-git-repo-check` | JSON events | similar mapping; codex tool calls map directly |
| `gemini 0.36.0` | `gemini --output=json` (TBD: confirm flag set in v0.36) | JSON | text-only initially; tool calling added when CLI exposes it |

(We will lock the exact spawn args in Sprint 1 by running `--help` on each CLI and reading current docs; assumptions above are the starting point.)

---

## Risks & open items

| Risk | Mitigation |
|---|---|
| Word/Excel/PPT unified manifest still preview | Keep manifest fragments separable; can split into 2 manifests on submit |
| Legacy Exchange Online tokens off; EWS no longer the M365 path | Graph via MSAL NAA is primary on M365; EWS only runs on on-prem Exchange; routing is backend-probe-based, not date-based |
| MSAL NAA requires Azure app registration | Sprint-2 first task: register app, declare client ID in manifest `webApplicationInfo`/`authorization`, document setup in `docs/AZURE_SETUP.md` |
| CLI native tool execution would bypass our boundary | All CLI adapters run text-only; tool calls extracted from model output via `<office_tool>` markers; CLI's own filesystem/shell tools are never engaged in v1 |
| Bridge as Windows service blocks Outlook COM | Bridge runs as per-user startup app (HKCU Run key); COM sidecar inherits the user session |
| Prompt injection from email/document content | All host-derived text wrapped in `<untrusted_data>` markers; system prompt forbids treating as instructions; tool calls still hit confirmation gates regardless of source |
| New Outlook (web) on Windows lacks COM | Tier 3 only fires on classic Outlook; auto-disabled on new Outlook (`mailbox.diagnostics.hostName === 'OutlookWebApp'` -> Tier 2 only) |
| Gemini CLI tool-calling immaturity | v1 ships text-only Gemini; mark as "limited" in provider selector |
| PyInstaller exe size + AV false positives | Prefer signing binary in installer build; document AV exception steps in README |
| OneDrive sync chewing on `node_modules`/`build` | Junctions enforced by `bootstrap-junctions.ps1` and CLAUDE.md hooks |

---

## Self-review refinements (from Checkpoint-2 self-critique; codex timed out)

To fold into the relevant sprints before any code lands:

1. **Tier-2 routing should be probe-based, not date-based.** Instead of "if date >= 2026-10 use Graph", attempt EWS first; on `ErrorAccessDenied` / network error / 410, fall through to Graph-NAA. Survives whatever Microsoft's actual sunset cadence ends up being.
2. **NAA needs explicit manifest declaration.** Add `webApplicationInfo` block (Azure app registration, client ID, MS Graph scopes) to the unified manifest. Without this, `OfficeRuntime.auth.getAccessToken` returns nothing. Sprint-2 task: register the Azure app, store IDs in build-time env.
3. **Bridge port collision.** 4017 is the office-agents-word default — if the user still has that running, we collide. Bridge binds 4017 first, falls back through 4018..4029. The taskpane (sandboxed WebView2, no filesystem access) discovers the port by HTTPS-probing `https://localhost:4017..4029/health` until one returns the expected signature `{"ok":true,"app":"office-ai-assistant","version":"..."}`. NO filesystem-based handshake.
4. **Self-signed localhost cert.** Office.js taskpanes inside Office require a trusted cert when talking to localhost HTTPS. office-agents-word ships an auto-install dev cert; for production we either re-use that or generate one at install time (Wix custom action). Document in Sprint-5.
5. **Multi-host concurrency.** User opens Word + Excel at the same time -> two taskpanes -> two clients on one bridge. The bridge already handles this; SQLite WAL mode should be enabled in `memory/db.ts` to avoid writer contention.
6. **CLI health visibility.** If the chosen CLI provider becomes unhealthy (claude logged out, codex token expired, gemini quota), the sidebar should show an inline banner with "Switch provider" rather than fail silently. Bridge `health` ping every 30s.
7. **NDJSON streaming robustness.** Each CLI adapter must use a line-buffered NDJSON parser that tolerates partial lines and recovers from a single malformed event without killing the stream. Reference impl: `readline.createInterface(process.stdout)`.
8. **Skill eviction algorithm.** When total active skill content exceeds the host budget (default 6KB), evict by ascending `priority` then descending `last_loaded_at`. Always pin `mait-persona` as un-evictable.
9. **First-run flow.** On first sidebar open, probe: which CLIs are healthy, which Outlook backend is reachable, default provider preference. Persist to `settings`. Skip on subsequent opens.
10. **Compose vs read mode in Outlook.** Manifest needs separate `LaunchEvent` configurations for compose vs read pinning so the right tool subset is exposed in each. Add to Sprint-2 manifest fragment.
11. **Tier-3 sidecar lifecycle.** Auto-spawn on first tier-3 call; idle-shutdown after 5 min of inactivity; if Outlook itself closes, kill the sidecar (it's holding a COM reference).
12. **Telemetry scope (if user opts in later).** Provider/model used per turn, tier resolution path, gate-trigger counts. Never message bodies, recipients, document content. Locally aggregated, no remote send in v1.
13. **Test surface.** Per-package vitest for unit; office-bridge harness for live e2e against Word/Excel/PPT/Outlook; manual smoke checklist in `docs/SMOKE.md` per release.

Each of these is a 1–4 hour task during the relevant sprint; none are blockers.

---

## Approval gate

This document and `ARCHITECTURE.md` are the proposal. **No code changes, no `git init`, no copying of `office-agents-word` until you approve both.**

After approval, work order is: Sprint 0 -> 1 -> 2 -> 3 -> 4 -> 5. Each sprint commits to its own feature branch and merges to `main` only after passing tests and a manual sideload smoke test.
