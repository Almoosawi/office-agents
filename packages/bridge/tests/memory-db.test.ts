// Smoke test for the memory layer: schema applies, basic inserts work,
// FTS5 search round-trips, privacy flag suppresses indexing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb, closeMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";

let tmp: string;
let db: DatabaseSync;
let repo: MemoryRepository;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "office-ai-mem-"));
	db = openMemoryDb({ dbPath: join(tmp, "test.db") });
	repo = new MemoryRepository(db);
});

afterEach(() => {
	db.close();
	closeMemoryDb();
	rmSync(tmp, { recursive: true, force: true });
});

describe("memory schema", () => {
	it("applies migrations and records version 1", () => {
		const row = db.prepare("SELECT version FROM _schema_versions").get() as { version: number };
		expect(row.version).toBe(1);
	});

	it("creates sessions, messages, observations and queries them", () => {
		const session = repo.createSession({ host: "word", provider: "cli:claude" });
		expect(session.id).toMatch(/^[0-9a-f-]{36}$/);

		repo.insertMessage({
			sessionId: session.id,
			role: "user",
			content: "Summarize the third paragraph.",
		});
		repo.insertObservation({
			sessionId: session.id,
			kind: "chat.send",
			sourceHost: "word",
			payload: { route: "user-input" },
		});

		expect(repo.listMessages(session.id)).toHaveLength(1);
		expect(repo.timeline({ sessionId: session.id })).toHaveLength(1);
	});

	it("FTS5 indexes non-private content and excludes private", () => {
		const session = repo.createSession({ host: "excel", provider: "local:ollama" });
		repo.insertMessage({
			sessionId: session.id,
			role: "user",
			content: "The pivot table on Sheet2 looks broken.",
		});
		repo.insertMessage({
			sessionId: session.id,
			role: "user",
			content: "Confidential salary numbers in B7.",
			isPrivate: true,
		});

		const publicHits = repo.search({ query: "pivot table" });
		expect(publicHits.length).toBeGreaterThan(0);
		expect(publicHits[0]?.body).toContain("pivot table");

		const privateHits = repo.search({ query: "Confidential salary" });
		expect(privateHits).toHaveLength(0);
	});

	it("facts upsert by (scope, key) and round-trip", () => {
		const f1 = repo.putFact("global", "preferred_provider", "cli:claude");
		expect(f1.value).toBe("cli:claude");
		const f2 = repo.putFact("global", "preferred_provider", "local:ollama");
		expect(f2.value).toBe("local:ollama");
		expect(repo.listFacts("global")).toHaveLength(1);
		expect(repo.deleteFact("global", "preferred_provider")).toBe(true);
		expect(repo.listFacts("global")).toHaveLength(0);
	});

	it("settings round-trip and overwrite", () => {
		repo.setSetting("provider:cli:claude", "temperature", "0.7");
		expect(repo.getSetting("provider:cli:claude", "temperature")).toBe("0.7");
		repo.setSetting("provider:cli:claude", "temperature", "1.2");
		expect(repo.getSetting("provider:cli:claude", "temperature")).toBe("1.2");
	});

	it("session summary updates session.summary_id", () => {
		const session = repo.createSession({ host: "powerpoint", provider: "byok:openai" });
		const m = repo.insertMessage({
			sessionId: session.id,
			role: "assistant",
			content: "Designed three slide options.",
		});
		const sum = repo.insertSummary({
			sessionId: session.id,
			text: "User asked for three slide layout options.",
			citationIds: [m.id],
		});
		const refreshed = repo.getSession(session.id);
		expect(refreshed?.summary_id).toBe(sum.id);
	});
});
