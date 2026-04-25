// Smoke test for the memory layer: schema applies, basic inserts work,
// FTS5 search round-trips, privacy flag suppresses indexing.
//
// Uses an in-memory SQLite (`:memory:`) so the test never touches the
// filesystem — no tmpdir, no permanent deletion (rule #0), no leftover
// artifacts inside OneDrive between runs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb, closeMemoryDb } from "../src/memory/db.js";
import { MemoryRepository } from "../src/memory/repository.js";

let db: DatabaseSync;
let repo: MemoryRepository;

beforeEach(() => {
	db = openMemoryDb({ dbPath: ":memory:" });
	repo = new MemoryRepository(db);
});

afterEach(() => {
	db.close();
	closeMemoryDb();
});

describe("memory schema", () => {
	it("applies migrations and records latest version", () => {
		const row = db
			.prepare("SELECT MAX(version) AS v FROM _schema_versions")
			.get() as { v: number };
		// 0001_init.sql + 0002_fts_lifecycle.sql -> latest = 2
		expect(row.v).toBeGreaterThanOrEqual(2);
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

	it("timeline excludes private observations by default and includes them with opt-in", () => {
		const session = repo.createSession({ host: "outlook", provider: "cli:claude" });
		repo.insertObservation({
			sessionId: session.id,
			kind: "chat.send",
			sourceHost: "outlook",
			payload: { route: "user-input" },
		});
		repo.insertObservation({
			sessionId: session.id,
			kind: "chat.send",
			sourceHost: "outlook",
			payload: { secret: "redactable" },
			isPrivate: true,
		});

		const safe = repo.timeline({ sessionId: session.id });
		expect(safe).toHaveLength(1);
		expect(safe[0]?.is_private).toBe(0);

		const all = repo.timeline({ sessionId: session.id, includePrivate: true });
		expect(all).toHaveLength(2);
	});

	it("FTS lifecycle: deleting a message purges its FTS row", () => {
		const session = repo.createSession({ host: "word", provider: "cli:claude" });
		const m = repo.insertMessage({
			sessionId: session.id,
			role: "user",
			content: "Quick brown fox jumps over.",
		});
		expect(repo.search({ query: "quick brown" })).not.toHaveLength(0);

		db.prepare("DELETE FROM messages WHERE id = ?").run(m.id);
		expect(repo.search({ query: "quick brown" })).toHaveLength(0);
	});

	it("FTS lifecycle: flipping is_private=1 removes the row from FTS", () => {
		const session = repo.createSession({ host: "word", provider: "cli:claude" });
		const m = repo.insertMessage({
			sessionId: session.id,
			role: "user",
			content: "Sphinx of black quartz.",
		});
		expect(repo.search({ query: "sphinx" })).not.toHaveLength(0);

		db.prepare("UPDATE messages SET is_private = 1 WHERE id = ?").run(m.id);
		expect(repo.search({ query: "sphinx" })).toHaveLength(0);
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
