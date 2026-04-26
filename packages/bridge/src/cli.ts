#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  type BridgeRequestOptions,
  probeBridge,
  requestJson,
} from "./http-client.js";
import {
  type BridgeInvokeMethod,
  type BridgeSessionSnapshot,
  type BridgeStoredEvent,
  type BridgeVfsEntry,
  type BridgeVfsReadResult,
  DEFAULT_BRIDGE_HTTP_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getDefaultRawExecutionTool,
  normalizeBridgeUrl,
  serializeForJson,
} from "./protocol.js";
import {
  type BridgeServerHandle,
  type BridgeSessionRecord,
  createBridgeServer,
  findMatchingSession,
  summarizeExecutionError,
} from "./server.js";

const OPTIONS = {
  help: { type: "boolean" as const },
  json: { type: "boolean" as const },
  stdin: { type: "boolean" as const },
  sandbox: { type: "boolean" as const },
  url: { type: "string" as const },
  host: { type: "string" as const },
  port: { type: "string" as const },
  timeout: { type: "string" as const },
  input: { type: "string" as const },
  file: { type: "string" as const },
  code: { type: "string" as const },
  explanation: { type: "string" as const },
  out: { type: "string" as const },
  limit: { type: "string" as const },
  app: { type: "string" as const },
  document: { type: "string" as const },
  pages: { type: "string" as const },
  "sheet-id": { type: "string" as const },
  range: { type: "string" as const },
  "slide-index": { type: "string" as const },
  slide: { type: "string" as const },
  provider: { type: "string" as const },
  message: { type: "string" as const },
  system: { type: "string" as const },
  model: { type: "string" as const },
  token: { type: "string" as const },
};

interface Cli {
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

function parseCli(): Cli {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
  });
  return {
    positionals,
    values: values as Record<string, string | boolean | undefined>,
  };
}

function str(cli: Cli, name: string): string | undefined {
  const v = cli.values[name];
  return typeof v === "string" ? v : undefined;
}

function flag(cli: Cli, name: string): boolean {
  return cli.values[name] === true;
}

function int(cli: Cli, name: string, fallback: number): number {
  const v = str(cli, name);
  return v ? Number.parseInt(v, 10) : fallback;
}

function reqOpts(cli: Cli): BridgeRequestOptions {
  return {
    baseUrl: str(cli, "url"),
    timeoutMs: int(cli, "timeout", DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

function baseUrl(cli: Cli): string {
  return normalizeBridgeUrl(str(cli, "url") || DEFAULT_BRIDGE_HTTP_URL, "http");
}

function printUsage() {
  console.log(`office-bridge

Commands:
  serve [--host HOST] [--port PORT]
  stop [--url URL]
  list [--json]
  wait [selector] [--app APP] [--document DOCUMENT] [--timeout MS] [--json]
  inspect [session]
  metadata [session]
  events [session] [--limit N]
  tool [session] <toolName> [--input JSON | --file PATH | --stdin]
  exec [session] [--code JS | --file PATH | --stdin] [--sandbox]
  rpc [session] <method> [--input JSON | --file PATH | --stdin]
  screenshot [session] [--pages PAGES | --sheet-id ID --range A1:B2 | --slide-index N] [--out PATH]
  vfs ls [session] [prefix]
  vfs pull [session] <remotePath> [localPath]
  vfs push [session] <localPath> <remotePath>
  vfs rm [session] <remotePath>
  chat --provider <id> --message <text> [--system <text>] [--model <name>] [--token <bearer>]

Examples:
  office-bridge serve
  office-bridge stop
  office-bridge list
  office-bridge inspect word
  office-bridge exec word --code "return { href: window.location.href, title: document.title }"
  office-bridge exec word --sandbox --code "const body = context.document.body; body.load('text'); await context.sync(); return body.text;"
  office-bridge tool excel screenshot_range --input '{"sheetId":1,"range":"A1:F20"}' --out range.png
  office-bridge screenshot word --pages 1 --out page1.png
  office-bridge vfs ls word /home/user
  office-bridge vfs pull word /home/user/uploads/report.docx ./report.docx
`);
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadJsonPayload(cli: Cli): Promise<unknown> {
  const inline = str(cli, "input");
  if (inline) return JSON.parse(inline);

  const file = str(cli, "file");
  if (file) return JSON.parse(await readFile(file, "utf8"));

  if (flag(cli, "stdin") || !process.stdin.isTTY) {
    const content = (await readStdin()).trim();
    return content ? JSON.parse(content) : {};
  }

  return {};
}

async function loadCode(cli: Cli): Promise<string> {
  const inline = str(cli, "code");
  if (inline) return inline;

  const file = str(cli, "file");
  if (file) return readFile(file, "utf8");

  if (flag(cli, "stdin") || !process.stdin.isTTY) return readStdin();

  throw new Error("Missing code. Use --code, --file, or --stdin.");
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

async function fetchSessions(cli: Cli): Promise<BridgeSessionRecord[]> {
  const response = await requestJson<{
    ok: true;
    sessions: BridgeSessionRecord[];
  }>("GET", "/sessions", undefined, reqOpts(cli));
  return response.sessions;
}

function filterSessions(
  sessions: BridgeSessionRecord[],
  cli: Cli,
): BridgeSessionRecord[] {
  const app = str(cli, "app")?.toLowerCase();
  const documentId = str(cli, "document")?.toLowerCase();

  return sessions.filter((s) => {
    if (app && s.snapshot.app.toLowerCase() !== app) return false;
    if (documentId && !s.snapshot.documentId.toLowerCase().includes(documentId))
      return false;
    return true;
  });
}

async function resolveSession(
  cli: Cli,
  selector: string | undefined,
): Promise<BridgeSessionRecord> {
  const filtered = filterSessions(await fetchSessions(cli), cli);
  if (filtered.length === 0) {
    throw new Error(
      "No bridge sessions available. Start the server and open an add-in.",
    );
  }

  if (!selector) {
    if (filtered.length === 1) return filtered[0];
    throw new Error("Multiple sessions available. Pass a session selector.");
  }

  const matches = findMatchingSession(filtered, selector);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No session matches "${selector}"`);
  throw new Error(
    `Session selector "${selector}" is ambiguous: ${matches.map((s) => s.snapshot.sessionId).join(", ")}`,
  );
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function sanitizeImagesForOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeImagesForOutput);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(record)) {
    sanitized[key] = sanitizeImagesForOutput(v);
  }

  const mimeType = typeof record.mimeType === "string" ? record.mimeType : null;
  const imageType = typeof record.type === "string" ? record.type : null;
  const data = typeof record.data === "string" ? record.data : null;

  if (
    data !== null &&
    (mimeType?.startsWith("image/") || imageType === "image")
  ) {
    sanitized.data = "[omitted image base64]";
    sanitized.base64Length = data.length;
  }

  return sanitized;
}

function printJson(value: unknown) {
  console.log(
    JSON.stringify(serializeForJson(sanitizeImagesForOutput(value)), null, 2),
  );
}

function describeSession(session: BridgeSessionRecord): string {
  const ago = Math.round((Date.now() - session.lastSeenAt) / 1000);
  return `${session.snapshot.sessionId}  app=${session.snapshot.app}  document=${session.snapshot.documentId}  tools=${session.snapshot.tools.length}  lastSeen=${ago}s ago`;
}

// ---------------------------------------------------------------------------
// Image save helpers
// ---------------------------------------------------------------------------

function imageExtForMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
  };
  return map[mimeType] ?? ".bin";
}

function extractImages(
  value: unknown,
): Array<{ data: string; mimeType: string }> {
  if (!value || typeof value !== "object") return [];
  const images = (value as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images.filter(
    (img): img is { data: string; mimeType: string } =>
      !!img &&
      typeof img === "object" &&
      typeof (img as Record<string, unknown>).data === "string" &&
      typeof (img as Record<string, unknown>).mimeType === "string",
  );
}

function buildImagePath(
  basePath: string,
  index: number,
  count: number,
  mimeType: string,
): string {
  if (basePath.includes("{n}"))
    return basePath.replaceAll("{n}", String(index + 1));

  const ext = path.extname(basePath);
  const fallbackExt = imageExtForMime(mimeType);
  if (count === 1) return ext ? basePath : `${basePath}${fallbackExt}`;

  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  return `${stem}-${index + 1}${ext || fallbackExt}`;
}

async function saveFile(localPath: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, data);
}

async function saveImages(
  images: Array<{ data: string; mimeType: string }>,
  outputPath: string,
): Promise<string[]> {
  const saved: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const dest = buildImagePath(outputPath, i, images.length, img.mimeType);
    await saveFile(dest, Buffer.from(img.data, "base64"));
    saved.push(dest);
  }
  return saved;
}

async function maybeSaveToolImages(
  value: unknown,
  outputPath: string | undefined,
): Promise<string[]> {
  if (!outputPath) return [];
  const images = extractImages(value);
  if (images.length === 0)
    throw new Error("No images were returned by this command");
  return saveImages(images, outputPath);
}

function logSavedImages(cli: Cli, savedPaths: string[]) {
  if (savedPaths.length > 0 && !flag(cli, "json")) {
    for (const p of savedPaths) console.log(`Saved image: ${p}`);
  }
}

// ---------------------------------------------------------------------------
// Positional arg splitter for commands with optional [session] prefix
//
// Many commands accept `[session] <required> [optional]`. When there are
// more positionals than the command strictly needs, we try to resolve the
// first one as a session selector. If it matches we consume it; otherwise
// we fall back and treat every positional as a regular arg.
// ---------------------------------------------------------------------------

interface SplitResult {
  session: BridgeSessionRecord;
  args: string[];
}

async function splitSessionArgs(
  cli: Cli,
  positionals: string[],
  minArgs: number,
): Promise<SplitResult> {
  // No positionals at all — resolve session with no selector.
  if (positionals.length === 0) {
    return { session: await resolveSession(cli, undefined), args: [] };
  }

  // Exactly the minimum required — no session selector present.
  if (positionals.length <= minArgs) {
    return { session: await resolveSession(cli, undefined), args: positionals };
  }

  // More positionals than minimum — try treating the first as a session
  // selector. If it doesn't match any session, treat all as regular args.
  const sessions = filterSessions(await fetchSessions(cli), cli);
  const candidate = positionals[0];
  const matches = findMatchingSession(sessions, candidate);

  if (matches.length === 1) {
    return { session: matches[0], args: positionals.slice(1) };
  }

  if (matches.length > 1) {
    throw new Error(
      `Session selector "${candidate}" is ambiguous: ${matches.map((s) => s.snapshot.sessionId).join(", ")}`,
    );
  }

  // No session match — resolve without selector (auto-pick single session)
  return { session: await resolveSession(cli, undefined), args: positionals };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandServe(cli: Cli) {
  const host = str(cli, "host");
  const port = str(cli, "port")
    ? Number.parseInt(str(cli, "port")!, 10)
    : undefined;
  const url = normalizeBridgeUrl(
    `https://${host || "localhost"}:${port || 4017}`,
    "http",
  );

  // Open the persistent memory DB and stand up the provider registry/router
  // so /api/providers/* routes are available. If this fails (corrupt DB,
  // permissions, etc.), the bridge still serves session RPC — provider
  // routes just won't be mounted.
  let providersDeps: import("./server.js").BridgeServerOptions["providers"];
  let chatDeps: import("./server.js").BridgeServerOptions["chat"];
  try {
    const { openMemoryDb } = await import("./memory/db.js");
    const { MemoryRepository } = await import("./memory/repository.js");
    const { ProviderRegistry } = await import("./providers/registry.js");
    const { ProviderRouter } = await import("./providers/router.js");
    const { createSidecarAdapter } = await import("./providers/sidecar.js");
    const { ChatDispatcher } = await import("./providers/chat-dispatcher.js");
    const { loadOrCreateToken } = await import("./auth/token.js");
    const db = openMemoryDb();
    const repo = new MemoryRepository(db);
    const registry = new ProviderRegistry(repo);
    // Sidecar adapter without a key supplier yet — the CliProxyManager
    // is started lazily by the user (or a future auto-spawn-on-enable
    // hook). Until then, sidecar probes return 401 / unavailable, which
    // is the correct UX.
    const router = new ProviderRouter({
      registry,
      adapters: { sidecar: createSidecarAdapter() },
    });
    // Bearer token gates mutating /api/providers/* endpoints. First run
    // creates it under %LocalAppData%\OfficeAIAssistant\auth\.
    const auth = loadOrCreateToken();
    providersDeps = { registry, router, authToken: auth.token };
    chatDeps = {
      dispatcher: new ChatDispatcher(router),
      authToken: auth.token,
    };
    if (auth.source === "generated") {
      console.log(
        `[bridge] generated bridge auth token at ${auth.path}`,
      );
    } else if (auth.source === "env") {
      console.log("[bridge] using bridge auth token from OFFICE_AI_BRIDGE_TOKEN");
    } else if (auth.source === "file") {
      console.log(`[bridge] loaded bridge auth token from ${auth.path}`);
    }
  } catch (e) {
    console.warn(
      `[bridge] provider routes disabled: ${(e as Error).message}`,
    );
  }

  let server: BridgeServerHandle | null = null;
  try {
    server = await createBridgeServer({
      host,
      port,
      providers: providersDeps,
      chat: chatDeps,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "EADDRINUSE"
    ) {
      try {
        await probeBridge(url);
        console.log(`Bridge server already running at ${url}`);
        return;
      } catch {
        throw error;
      }
    }
    throw error;
  }

  const shutdown = async () => {
    if (server) await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown().catch(() => process.exit(1)));
  process.on("SIGTERM", () => shutdown().catch(() => process.exit(1)));

  console.log(`Bridge server running at ${server.httpUrl}`);
  await new Promise(() => undefined);
}

async function commandStop(cli: Cli) {
  try {
    const response = await requestJson<{ ok: true; message: string }>(
      "POST",
      "/shutdown",
      {},
      reqOpts(cli),
    );
    console.log(response.message);
  } catch {
    try {
      await probeBridge(baseUrl(cli));
      throw new Error("Failed to stop bridge server");
    } catch {
      console.log("Bridge server is not running.");
    }
  }
}

async function commandList(cli: Cli) {
  const sessions = filterSessions(await fetchSessions(cli), cli);
  if (flag(cli, "json")) {
    printJson(sessions);
    return;
  }
  if (sessions.length === 0) {
    console.log("No sessions connected.");
    return;
  }
  for (const s of sessions) console.log(describeSession(s));
}

async function commandWait(cli: Cli) {
  const selector = cli.positionals[1];
  const timeoutMs = int(cli, "timeout", DEFAULT_REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const sessions = filterSessions(await fetchSessions(cli), cli);
    const matches = selector
      ? findMatchingSession(sessions, selector)
      : sessions;
    if (matches.length > 0) {
      if (flag(cli, "json")) {
        printJson(matches[0]);
      } else {
        console.log(describeSession(matches[0]));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  throw new Error(`Timed out waiting for bridge session after ${timeoutMs}ms`);
}

async function commandInspect(cli: Cli) {
  const session = await resolveSession(cli, cli.positionals[1]);
  const response = await requestJson<{
    ok: true;
    session: BridgeSessionRecord;
  }>("GET", sessionPath(session.snapshot.sessionId), undefined, reqOpts(cli));
  printJson(response.session);
}

async function commandMetadata(cli: Cli) {
  const session = await resolveSession(cli, cli.positionals[1]);
  const response = await requestJson<{
    ok: true;
    metadata: unknown;
    snapshot: BridgeSessionSnapshot;
  }>(
    "POST",
    sessionPath(session.snapshot.sessionId, "/metadata"),
    {},
    reqOpts(cli),
  );
  printJson(response);
}

async function commandEvents(cli: Cli) {
  const session = await resolveSession(cli, cli.positionals[1]);
  const limit = int(cli, "limit", 50);
  const response = await requestJson<{ ok: true; events: BridgeStoredEvent[] }>(
    "GET",
    sessionPath(
      session.snapshot.sessionId,
      `/events?limit=${Math.max(1, limit)}`,
    ),
    undefined,
    reqOpts(cli),
  );
  printJson(response.events);
}

async function commandTool(cli: Cli) {
  // tool [session] <toolName>  — toolName is required (minArgs=1)
  const { session, args } = await splitSessionArgs(
    cli,
    cli.positionals.slice(1),
    1,
  );
  const toolName = args[0];
  if (!toolName) {
    throw new Error(
      "Usage: office-bridge tool [session] <toolName> [--input JSON | --file PATH] [--out PATH]",
    );
  }

  const payload = await loadJsonPayload(cli);
  const response = await requestJson<{ ok: true; result: unknown }>(
    "POST",
    sessionPath(
      session.snapshot.sessionId,
      `/tools/${encodeURIComponent(toolName)}`,
    ),
    { args: payload },
    reqOpts(cli),
  );
  logSavedImages(
    cli,
    await maybeSaveToolImages(response.result, str(cli, "out")),
  );
  printJson(response.result);
}

async function commandExec(cli: Cli) {
  const session = await resolveSession(cli, cli.positionals[1]);
  const code = await loadCode(cli);
  const explanation = str(cli, "explanation");
  const sandbox = flag(cli, "sandbox");

  if (sandbox && !getDefaultRawExecutionTool(session.snapshot.app)) {
    throw new Error(
      `No default raw execution tool for app ${session.snapshot.app}`,
    );
  }

  const response = await requestJson<{
    ok: true;
    result: unknown;
    toolName?: string;
    mode: "unsafe" | "sandbox";
  }>(
    "POST",
    sessionPath(session.snapshot.sessionId, "/exec"),
    { code, explanation, unsafe: !sandbox },
    reqOpts(cli),
  );

  if (response.mode === "sandbox") {
    const summaryError = summarizeExecutionError(response.result);
    if (summaryError)
      console.error(
        `Tool ${response.toolName} reported an error: ${summaryError}`,
      );
  }

  logSavedImages(
    cli,
    await maybeSaveToolImages(response.result, str(cli, "out")),
  );
  printJson(response);
}

async function commandRpc(cli: Cli) {
  // rpc [session] <method>  — method is required (minArgs=1)
  const { session, args } = await splitSessionArgs(
    cli,
    cli.positionals.slice(1),
    1,
  );
  const method = args[0] as BridgeInvokeMethod | undefined;
  if (!method) {
    throw new Error(
      "Usage: office-bridge rpc [session] <method> [--input JSON | --file PATH]",
    );
  }

  const payload = await loadJsonPayload(cli);
  const response = await requestJson<{ ok: true; result: unknown }>(
    "POST",
    "/rpc",
    {
      sessionId: session.snapshot.sessionId,
      method,
      params: payload,
      timeoutMs: int(cli, "timeout", DEFAULT_REQUEST_TIMEOUT_MS),
    },
    reqOpts(cli),
  );
  printJson(response.result);
}

async function commandScreenshot(cli: Cli) {
  const session = await resolveSession(cli, cli.positionals[1]);
  const explanation = str(cli, "explanation");

  let toolName: string;
  let payload: Record<string, unknown> = {};
  let defaultOutputBase: string;

  switch (session.snapshot.app) {
    case "word": {
      toolName = "screenshot_document";
      const pages = str(cli, "pages");
      if (pages) payload.page = Number.parseInt(pages, 10);
      if (explanation) payload.explanation = explanation;
      defaultOutputBase = "word-screenshot.png";
      break;
    }
    case "excel": {
      toolName = "screenshot_range";
      const sheetId = str(cli, "sheet-id");
      const range = str(cli, "range");
      if (!sheetId || !range)
        throw new Error(
          "Excel screenshots require --sheet-id <id> and --range <A1:B2>",
        );
      const parsedSheetId = Number.parseInt(sheetId, 10);
      if (Number.isNaN(parsedSheetId))
        throw new Error(`Invalid --sheet-id: ${sheetId}`);
      payload = { sheetId: parsedSheetId, range };
      if (explanation) payload.explanation = explanation;
      defaultOutputBase = `excel-${range.replaceAll(/[^A-Za-z0-9_-]/g, "_")}.png`;
      break;
    }
    case "powerpoint": {
      toolName = "screenshot_slide";
      const slideIndex = str(cli, "slide-index") || str(cli, "slide");
      if (!slideIndex)
        throw new Error(
          "PowerPoint screenshots require --slide-index <0-based index>",
        );
      const parsedIndex = Number.parseInt(slideIndex, 10);
      if (Number.isNaN(parsedIndex))
        throw new Error(`Invalid --slide-index: ${slideIndex}`);
      payload = { slide_index: parsedIndex };
      if (explanation) payload.explanation = explanation;
      defaultOutputBase = `powerpoint-slide-${parsedIndex}.png`;
      break;
    }
    default:
      throw new Error(
        `Screenshot is not supported for app ${session.snapshot.app}`,
      );
  }

  const response = await requestJson<{ ok: true; result: unknown }>(
    "POST",
    sessionPath(
      session.snapshot.sessionId,
      `/tools/${encodeURIComponent(toolName)}`,
    ),
    { args: payload },
    reqOpts(cli),
  );

  const outputPath = str(cli, "out") || defaultOutputBase;
  const savedPaths = await maybeSaveToolImages(response.result, outputPath);
  if (flag(cli, "json")) {
    printJson({ toolName, savedPaths, result: response.result });
    return;
  }
  for (const p of savedPaths) console.log(`Saved screenshot: ${p}`);
}

// ---------------------------------------------------------------------------
// VFS — each subcommand has explicit positional definitions
// ---------------------------------------------------------------------------

async function commandChat(cli: Cli): Promise<void> {
  const provider = str(cli, "provider");
  const message = str(cli, "message");
  if (!provider) {
    throw new Error("Usage: office-bridge chat --provider <id> --message <text>");
  }
  if (!message && !flag(cli, "stdin") && process.stdin.isTTY) {
    throw new Error(
      "Provide --message <text>, --stdin, or pipe input on stdin.",
    );
  }
  const userText = message ?? (await readStdin());
  if (!userText.trim()) throw new Error("empty message");

  const messages: Array<{ role: string; content: string }> = [];
  const sys = str(cli, "system");
  if (sys) messages.push({ role: "system", content: sys });
  messages.push({ role: "user", content: userText });

  // Bearer token: explicit flag wins; otherwise pull from disk so the
  // user doesn't have to think about it. Mirrors loadOrCreateToken's
  // resolution order so launcher + CLI agree on the same file.
  let token = str(cli, "token");
  if (!token) {
    try {
      const { loadOrCreateToken } = await import("./auth/token.js");
      token = loadOrCreateToken().token;
    } catch (e) {
      throw new Error(
        `could not load bridge auth token (${(e as Error).message}); pass --token or set OFFICE_AI_BRIDGE_TOKEN`,
      );
    }
  }

  const target = new URL(
    `${baseUrl(cli)}/api/providers/${encodeURIComponent(provider)}/chat`,
  );
  const body: Record<string, unknown> = { messages };
  const model = str(cli, "model");
  if (model) body.model = model;
  const payload = JSON.stringify(body);

  // Use node:https.request directly. Global fetch on Node is undici-based
  // and rejects a node:https.Agent passed as `dispatcher` with
  // "agent.dispatch is not a function". The existing http-client uses the
  // same direct-https pattern, so we mirror it here.
  const { request: httpsRequest } = await import("node:https");
  let info: { chosen?: string; fallbackUsed?: boolean } | null = null;

  await new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${
                  Buffer.concat(chunks).toString("utf8") || "(no body)"
                }`,
              ),
            );
          });
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx = buf.indexOf("\n");
          while (idx >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) handleNdjsonLine(cli, line, (i) => (info = i));
            idx = buf.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (buf.trim()) handleNdjsonLine(cli, buf.trim(), (i) => (info = i));
          resolve();
        });
        res.on("error", reject);
      },
    );

    const onSig = () => req.destroy();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    req.on("close", () => {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
    });
    req.on("error", reject);

    req.write(payload);
    req.end();
  });

  if (info && !flag(cli, "json")) {
    process.stderr.write(
      `\n[chat] provider=${info.chosen}${info.fallbackUsed ? " (fallback)" : ""}\n`,
    );
  }
}

function handleNdjsonLine(
  cli: Cli,
  line: string,
  setInfo: (info: { chosen?: string; fallbackUsed?: boolean }) => void,
): void {
  let parsed: { kind: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // ignore malformed line
  }
  if (flag(cli, "json")) {
    console.log(line);
    return;
  }
  if (parsed.kind === "chunk") {
    const chunk = parsed.chunk as { kind: string } & Record<string, unknown>;
    if (chunk.kind === "text") process.stdout.write(chunk.delta as string);
    else if (chunk.kind === "error")
      process.stderr.write(`\n[error] ${chunk.message}\n`);
    else if (chunk.kind === "tool_call")
      process.stderr.write(
        `\n[tool_call] ${chunk.name as string} ${chunk.argsJson as string}\n`,
      );
    else if (chunk.kind === "done") process.stdout.write("\n");
    return;
  }
  if (parsed.kind === "info") {
    setInfo({
      chosen: parsed.chosen as string,
      fallbackUsed: parsed.fallbackUsed as boolean,
    });
  }
}

async function commandVfs(cli: Cli) {
  const subcommand = cli.positionals[1];
  if (!subcommand)
    throw new Error("Usage: office-bridge vfs <ls|pull|push|rm> [session] ...");

  // Positionals after the subcommand: e.g. `vfs pull word /remote ./local`
  const rest = cli.positionals.slice(2);

  switch (subcommand) {
    case "ls": {
      // ls [session] [prefix]  — 0 required args
      const { session, args } = await splitSessionArgs(cli, rest, 0);
      const prefix = args[0];
      const response = await requestJson<{
        ok: true;
        result: BridgeVfsEntry[];
      }>(
        "POST",
        sessionPath(session.snapshot.sessionId, "/vfs/list"),
        prefix ? { prefix } : {},
        reqOpts(cli),
      );
      if (flag(cli, "json")) {
        printJson(response.result);
        return;
      }
      for (const entry of response.result)
        console.log(`${entry.path}\t${entry.byteLength}`);
      return;
    }
    case "pull": {
      // pull [session] <remotePath> [localPath]  — 1 required arg
      const { session, args } = await splitSessionArgs(cli, rest, 1);
      const remotePath = args[0];
      if (!remotePath)
        throw new Error(
          "Usage: office-bridge vfs pull [session] <remotePath> [localPath]",
        );
      const localPath = args[1] || path.basename(remotePath);

      const response = await requestJson<{
        ok: true;
        result: BridgeVfsReadResult;
      }>(
        "POST",
        sessionPath(session.snapshot.sessionId, "/vfs/read"),
        { path: remotePath, encoding: "base64" },
        reqOpts(cli),
      );
      if (!response.result.dataBase64)
        throw new Error(`No binary data returned for ${remotePath}`);

      await saveFile(
        localPath,
        Buffer.from(response.result.dataBase64, "base64"),
      );
      if (flag(cli, "json")) {
        printJson({
          remotePath,
          localPath,
          byteLength: response.result.byteLength,
        });
        return;
      }
      console.log(
        `Pulled ${remotePath} -> ${localPath} (${response.result.byteLength} bytes)`,
      );
      return;
    }
    case "push": {
      // push [session] <localPath> <remotePath>  — 2 required args
      const { session, args } = await splitSessionArgs(cli, rest, 2);
      const localPath = args[0];
      const remotePath = args[1];
      if (!localPath || !remotePath) {
        throw new Error(
          "Usage: office-bridge vfs push [session] <localPath> <remotePath>",
        );
      }

      const data = await readFile(localPath);
      const response = await requestJson<{ ok: true; result: unknown }>(
        "POST",
        sessionPath(session.snapshot.sessionId, "/vfs/write"),
        { path: remotePath, dataBase64: data.toString("base64") },
        reqOpts(cli),
      );
      if (flag(cli, "json")) {
        printJson(response.result);
        return;
      }
      console.log(`Pushed ${localPath} -> ${remotePath}`);
      return;
    }
    case "rm": {
      // rm [session] <remotePath>  — 1 required arg
      const { session, args } = await splitSessionArgs(cli, rest, 1);
      const remotePath = args[0];
      if (!remotePath)
        throw new Error("Usage: office-bridge vfs rm [session] <remotePath>");

      const response = await requestJson<{ ok: true; result: unknown }>(
        "POST",
        sessionPath(session.snapshot.sessionId, "/vfs/delete"),
        { path: remotePath },
        reqOpts(cli),
      );
      if (flag(cli, "json")) {
        printJson(response.result);
        return;
      }
      console.log(`Deleted ${remotePath}`);
      return;
    }
    default:
      throw new Error(`Unknown vfs subcommand: ${subcommand}`);
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (cli: Cli) => Promise<void>> = {
  serve: commandServe,
  stop: commandStop,
  list: commandList,
  wait: commandWait,
  inspect: commandInspect,
  metadata: commandMetadata,
  events: commandEvents,
  tool: commandTool,
  exec: commandExec,
  rpc: commandRpc,
  screenshot: commandScreenshot,
  vfs: commandVfs,
  chat: commandChat,
};

async function main() {
  const cli = parseCli();
  const command = cli.positionals[0];

  if (!command || command === "help" || flag(cli, "help")) {
    printUsage();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  await handler(cli);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
