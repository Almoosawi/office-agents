import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { requestJson } from "../src/http-client";
import {
  createBridgeServer,
  type BridgeServerHandle,
} from "../src/server";
import type {
  BridgeResponseMessage,
  BridgeSessionSnapshot,
  BridgeWireMessage,
} from "../src/protocol";

const requireCjs = createRequire(import.meta.url);
const { recycle } = requireCjs("../../../scripts/recycle.cjs") as {
  recycle: (paths: string[]) => number;
};

const silentLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createSnapshot(
  overrides: Partial<BridgeSessionSnapshot> = {},
): BridgeSessionSnapshot {
  const now = Date.now();
  return {
    sessionId: "excel:test-session",
    instanceId: "instance-1",
    app: "excel",
    appName: "Excel",
    appVersion: "1.0.0",
    metadataTag: "doc_context",
    documentId: "doc-123",
    documentMetadata: { sheetCount: 3 },
    tools: [{ name: "echo" }, { name: "eval_officejs" }],
    host: {
      host: "excel",
      platform: "desktop",
      href: "https://localhost/taskpane.html",
      title: "Office Agents",
    },
    connectedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createTempTlsMaterial() {
  const dir = mkdtempSync(path.join(tmpdir(), "office-bridge-test-"));
  const keyPath = path.join(dir, "localhost.key");
  const certPath = path.join(dir, "localhost.crt");

  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-days",
    "1",
  ]);

  return { dir, keyPath, certPath };
}

async function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      rejectUnauthorized: false,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitForParsedMessage(socket: WebSocket): Promise<BridgeWireMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      cleanup();
      resolve(JSON.parse(raw.toString("utf8")) as BridgeWireMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

describe("bridge server", () => {
  let tlsDir = "";
  let server: BridgeServerHandle | null = null;
  let socket: WebSocket | null = null;

  beforeEach(() => {
    tlsDir = "";
  });

  afterEach(async () => {
    if (socket) {
      socket.terminate();
      socket = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
    if (tlsDir) {
      recycle([tlsDir]);
      tlsDir = "";
    }
  });

  it("registers a session, records bounded event history, and exposes session data over HTTPS", async () => {
    const tls = createTempTlsMaterial();
    tlsDir = tls.dir;
    const port = await getFreePort();
    server = await createBridgeServer({
      host: "127.0.0.1",
      port,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      eventLimit: 3,
      logger: silentLogger,
    });

    socket = await connectClient(server.wsUrl);
    socket.send(
      JSON.stringify({
        type: "hello",
        role: "office-addin",
        protocolVersion: 1,
        snapshot: createSnapshot(),
      }),
    );

    await waitForParsedMessage(socket);

    socket.send(
      JSON.stringify({ type: "event", event: "selection_changed", ts: 1 }),
    );
    socket.send(JSON.stringify({ type: "event", event: "tool_executed", ts: 2 }));
    socket.send(JSON.stringify({ type: "event", event: "session_updated", ts: 3, payload: createSnapshot({
      documentMetadata: { sheetCount: 4, activeSheet: "Summary" },
      updatedAt: Date.now() + 1,
    }) }));

    const health = (await requestJson(
      "GET",
      "/health",
      undefined,
      { baseUrl: server.httpUrl },
    )) as { ok: boolean; sessions: number };
    const sessionsResponse = (await requestJson(
      "GET",
      "/sessions",
      undefined,
      { baseUrl: server.httpUrl },
    )) as { ok: boolean; sessions: Array<{ snapshot: BridgeSessionSnapshot }> };
    const events = server.getEvents("excel:test-session", 10);

    expect(health.ok).toBe(true);
    expect(health.sessions).toBe(1);
    expect(sessionsResponse.sessions).toHaveLength(1);
    expect(sessionsResponse.sessions[0].snapshot.documentMetadata).toEqual({
      sheetCount: 4,
      activeSheet: "Summary",
    });
    expect(events.map((event) => event.event)).toEqual([
      "selection_changed",
      "tool_executed",
      "session_updated",
    ]);
  });

  it("forwards tool invocations over WebSocket and returns the response to the HTTPS caller", async () => {
    const tls = createTempTlsMaterial();
    tlsDir = tls.dir;
    const port = await getFreePort();
    server = await createBridgeServer({
      host: "127.0.0.1",
      port,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      logger: silentLogger,
    });

    socket = await connectClient(server.wsUrl);
    socket.send(
      JSON.stringify({
        type: "hello",
        role: "office-addin",
        protocolVersion: 1,
        snapshot: createSnapshot(),
      }),
    );
    await waitForParsedMessage(socket);

    const invokePromise = waitForParsedMessage(socket).then((message) => {
      if (message.type !== "invoke") {
        throw new Error(`Expected invoke message, got ${message.type}`);
      }

      expect(message.method).toBe("execute_tool");
      expect(message.params).toEqual({
        toolName: "echo",
        args: { value: 42, format: "json" },
      });

      const response: BridgeResponseMessage = {
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: {
          toolCallId: "tool_123",
          toolName: "echo",
          isError: false,
          result: {
            content: [{ type: "text", text: "42" }],
          },
          resultText: "42",
          images: [],
        },
      };
      socket?.send(JSON.stringify(response));
    });

    const result = (await requestJson(
      "POST",
      "/sessions/excel%3Atest-session/tools/echo",
      { args: { value: 42, format: "json" } },
      { baseUrl: server.httpUrl },
    )) as {
      ok: boolean;
      result: { resultText: string; toolName: string };
    };

    await invokePromise;

    expect(result.ok).toBe(true);
    expect(result.result.toolName).toBe("echo");
    expect(result.result.resultText).toBe("42");
  });

  it("dispatches chat_request via WebSocket and streams chat_chunk frames back", async () => {
    const { closeMemoryDb, openMemoryDb } = await import("../src/memory/db");
    const { MemoryRepository } = await import("../src/memory/repository");
    const { ProviderRegistry } = await import("../src/providers/registry");
    const { ProviderRouter } = await import("../src/providers/router");
    const { ChatDispatcher } = await import("../src/providers/chat-dispatcher");

    const db = openMemoryDb({ dbPath: ":memory:" });
    const repo = new MemoryRepository(db);
    const registry = new ProviderRegistry(repo);
    registry.load();

    const router = new ProviderRouter({
      registry,
      adapters: {
        cli: {
          kind: "cli",
          async probe() {
            return { available: true };
          },
          async listModels() {
            return [];
          },
          async *chat() {
            yield { type: "text", delta: "ping " } as const;
            yield { type: "text", delta: "pong" } as const;
            yield { type: "done", reason: "stop" } as const;
          },
        },
      },
    });
    const dispatcher = new ChatDispatcher(router);

    const tls = createTempTlsMaterial();
    tlsDir = tls.dir;
    const port = await getFreePort();
    server = await createBridgeServer({
      host: "127.0.0.1",
      port,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      logger: silentLogger,
      chat: { dispatcher },
    });

    try {
      socket = await connectClient(server.wsUrl);
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "office-addin",
          protocolVersion: 1,
          snapshot: createSnapshot(),
        }),
      );
      await waitForParsedMessage(socket); // welcome

      const collected: BridgeWireMessage[] = [];
      const allChunks = new Promise<void>((resolve) => {
        socket!.on("message", (raw: Buffer) => {
          const msg = JSON.parse(raw.toString("utf8")) as BridgeWireMessage;
          if (msg.type !== "chat_chunk") return;
          collected.push(msg);
          if (
            msg.chunk.kind === "done" ||
            msg.chunk.kind === "error"
          ) {
            resolve();
          }
        });
      });

      socket.send(
        JSON.stringify({
          type: "chat_request",
          requestId: "ws-r1",
          providerId: "cli:claude",
          request: { messages: [{ role: "user", content: "hi" }] },
        }),
      );

      await allChunks;

      expect(collected).toHaveLength(3);
      const kinds = collected.map(
        (m) => (m as { chunk: { kind: string } }).chunk.kind,
      );
      expect(kinds).toEqual(["text", "text", "done"]);
      expect(collected.every((m) => (m as { requestId: string }).requestId === "ws-r1")).toBe(true);
    } finally {
      db.close();
      closeMemoryDb();
    }
  });

  it("aborts in-flight chat when the WebSocket session disconnects", async () => {
    const { closeMemoryDb, openMemoryDb } = await import("../src/memory/db");
    const { MemoryRepository } = await import("../src/memory/repository");
    const { ProviderRegistry } = await import("../src/providers/registry");
    const { ProviderRouter } = await import("../src/providers/router");
    const { ChatDispatcher } = await import("../src/providers/chat-dispatcher");

    const db = openMemoryDb({ dbPath: ":memory:" });
    const repo = new MemoryRepository(db);
    const registry = new ProviderRegistry(repo);
    registry.load();

    // Adapter that yields one chunk then waits forever — only req.signal
    // can break it out. If WS-disconnect cleanup is wired correctly, the
    // dispatcher will fire the signal and the iterator exits cleanly.
    const router = new ProviderRouter({
      registry,
      adapters: {
        cli: {
          kind: "cli",
          async probe() {
            return { available: true };
          },
          async listModels() {
            return [];
          },
          async *chat(_e, req) {
            yield { type: "text", delta: "first" } as const;
            await new Promise<void>((resolve) => {
              if (req.signal?.aborted) return resolve();
              req.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            yield { type: "done", reason: "abort" } as const;
          },
        },
      },
    });
    const dispatcher = new ChatDispatcher(router);

    const tls = createTempTlsMaterial();
    tlsDir = tls.dir;
    const port = await getFreePort();
    server = await createBridgeServer({
      host: "127.0.0.1",
      port,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      logger: silentLogger,
      chat: { dispatcher },
    });

    try {
      socket = await connectClient(server.wsUrl);
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "office-addin",
          protocolVersion: 1,
          snapshot: createSnapshot(),
        }),
      );
      await waitForParsedMessage(socket); // welcome

      const firstChunk = waitForParsedMessage(socket);
      socket.send(
        JSON.stringify({
          type: "chat_request",
          requestId: "ws-disconnect",
          providerId: "cli:claude",
          request: { messages: [{ role: "user", content: "x" }] },
        }),
      );
      await firstChunk;
      expect(dispatcher.activeCount()).toBe(1);

      // Drop the socket — server's removeSession should abort the chat.
      socket.terminate();
      socket = null;

      // Wait for dispatcher to clear the abort table.
      const start = Date.now();
      while (dispatcher.activeCount() !== 0 && Date.now() - start < 2_000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(dispatcher.activeCount()).toBe(0);
    } finally {
      db.close();
      closeMemoryDb();
    }
  });

  it("isolates chat requestIds across sessions (no cross-session abort)", async () => {
    const { closeMemoryDb, openMemoryDb } = await import("../src/memory/db");
    const { MemoryRepository } = await import("../src/memory/repository");
    const { ProviderRegistry } = await import("../src/providers/registry");
    const { ProviderRouter } = await import("../src/providers/router");
    const { ChatDispatcher } = await import("../src/providers/chat-dispatcher");

    const db = openMemoryDb({ dbPath: ":memory:" });
    const repo = new MemoryRepository(db);
    const registry = new ProviderRegistry(repo);
    registry.load();

    // Adapter yields one chunk, then blocks on signal. Test holds two
    // concurrent chats with the SAME wire requestId across two sessions.
    const router = new ProviderRouter({
      registry,
      adapters: {
        cli: {
          kind: "cli",
          async probe() {
            return { available: true };
          },
          async listModels() {
            return [];
          },
          async *chat(_e, req) {
            yield { type: "text", delta: "tag" } as const;
            await new Promise<void>((resolve) => {
              if (req.signal?.aborted) return resolve();
              req.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            yield { type: "done", reason: "abort" } as const;
          },
        },
      },
    });
    const dispatcher = new ChatDispatcher(router);

    const tls = createTempTlsMaterial();
    tlsDir = tls.dir;
    const port = await getFreePort();
    server = await createBridgeServer({
      host: "127.0.0.1",
      port,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      logger: silentLogger,
      chat: { dispatcher },
    });

    let socketA: WebSocket | null = null;
    let socketB: WebSocket | null = null;
    try {
      socketA = await connectClient(server.wsUrl);
      socketB = await connectClient(server.wsUrl);

      socketA.send(
        JSON.stringify({
          type: "hello",
          role: "office-addin",
          protocolVersion: 1,
          snapshot: createSnapshot({ sessionId: "excel:A" }),
        }),
      );
      socketB.send(
        JSON.stringify({
          type: "hello",
          role: "office-addin",
          protocolVersion: 1,
          snapshot: createSnapshot({ sessionId: "excel:B" }),
        }),
      );
      await waitForParsedMessage(socketA);
      await waitForParsedMessage(socketB);

      const firstA = waitForParsedMessage(socketA);
      const firstB = waitForParsedMessage(socketB);
      const SHARED_ID = "shared-r1";
      socketA.send(
        JSON.stringify({
          type: "chat_request",
          requestId: SHARED_ID,
          providerId: "cli:claude",
          request: { messages: [{ role: "user", content: "a" }] },
        }),
      );
      socketB.send(
        JSON.stringify({
          type: "chat_request",
          requestId: SHARED_ID,
          providerId: "cli:claude",
          request: { messages: [{ role: "user", content: "b" }] },
        }),
      );
      await Promise.all([firstA, firstB]);
      expect(dispatcher.activeCount()).toBe(2);

      // Session A aborts ITS request — must NOT abort B's.
      socketA.send(
        JSON.stringify({ type: "chat_abort", requestId: SHARED_ID }),
      );

      // A should observe done(abort); B should still be running.
      const aDone = await waitForParsedMessage(socketA);
      expect(aDone.type).toBe("chat_chunk");
      expect((aDone as { chunk: { kind: string; reason?: string } }).chunk).toEqual({
        kind: "done",
        reason: "abort",
      });
      // dispatcher.activeCount drops by exactly one.
      expect(dispatcher.activeCount()).toBe(1);

      // Now abort B for cleanup.
      socketB.send(
        JSON.stringify({ type: "chat_abort", requestId: SHARED_ID }),
      );
      const bDone = await waitForParsedMessage(socketB);
      expect((bDone as { chunk: { kind: string } }).chunk.kind).toBe("done");
      expect(dispatcher.activeCount()).toBe(0);
    } finally {
      socketA?.terminate();
      socketB?.terminate();
      db.close();
      closeMemoryDb();
    }
  });

  it("rejects pending invocations when the WebSocket session disconnects mid-request", async () => {
    const tls = createTempTlsMaterial();
    tlsDir = tls.dir;
    const port = await getFreePort();
    server = await createBridgeServer({
      host: "127.0.0.1",
      port,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      logger: silentLogger,
    });

    socket = await connectClient(server.wsUrl);
    socket.send(
      JSON.stringify({
        type: "hello",
        role: "office-addin",
        protocolVersion: 1,
        snapshot: createSnapshot(),
      }),
    );
    await waitForParsedMessage(socket);

    const invocation = server.invokeSession({
      sessionId: "excel:test-session",
      method: "ping",
      timeoutMs: 5_000,
    });

    const message = await waitForParsedMessage(socket);
    expect(message.type).toBe("invoke");
    socket.close();

    await expect(invocation).rejects.toThrow(/disconnected/i);
  });
});
