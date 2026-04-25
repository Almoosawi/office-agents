// Typed repository over the SQLite memory schema (migrations/0001_init.sql).
// All time values are milliseconds since epoch.
// Privacy: callers must pass is_private explicitly when inserting; FTS triggers
// only index rows with is_private=0.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
	FactRow,
	FtsHit,
	Host,
	HostContextRow,
	MessageRole,
	MessageRow,
	ObservationKind,
	ObservationRow,
	SessionRow,
	SessionSummaryRow,
	SettingRow,
} from "./types.js";

const now = (): number => Date.now();

export class MemoryRepository {
	constructor(private readonly db: DatabaseSync) {}

	// ---------------- sessions ----------------

	createSession(args: { host: Host; provider: string; personaVersion?: number }): SessionRow {
		const id = randomUUID();
		const startedAt = now();
		this.db
			.prepare(
				"INSERT INTO sessions (id, host, started_at, persona_version, provider) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, args.host, startedAt, args.personaVersion ?? 1, args.provider);
		return {
			id,
			host: args.host,
			started_at: startedAt,
			ended_at: null,
			summary_id: null,
			persona_version: args.personaVersion ?? 1,
			provider: args.provider,
		};
	}

	endSession(sessionId: string): void {
		this.db
			.prepare("UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
			.run(now(), sessionId);
	}

	getSession(sessionId: string): SessionRow | null {
		return (
			(this.db
				.prepare("SELECT * FROM sessions WHERE id = ?")
				.get(sessionId) as unknown as SessionRow | undefined) ?? null
		);
	}

	listRecentSessions(limit = 50): SessionRow[] {
		return this.db
			.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
			.all(limit) as unknown as SessionRow[];
	}

	// ---------------- host_contexts ----------------

	insertHostContext(sessionId: string, blob: unknown): HostContextRow {
		const ts = now();
		const text = typeof blob === "string" ? blob : JSON.stringify(blob);
		const info = this.db
			.prepare("INSERT INTO host_contexts (session_id, ts, blob) VALUES (?, ?, ?)")
			.run(sessionId, ts, text);
		return { id: Number(info.lastInsertRowid), session_id: sessionId, ts, blob: text };
	}

	// ---------------- messages ----------------

	insertMessage(args: {
		sessionId: string;
		role: MessageRole;
		content?: string | null;
		toolCalls?: unknown;
		toolResults?: unknown;
		hostContextId?: number | null;
		isPrivate?: boolean;
	}): MessageRow {
		const ts = now();
		const tc = args.toolCalls ? JSON.stringify(args.toolCalls) : null;
		const tr = args.toolResults ? JSON.stringify(args.toolResults) : null;
		const info = this.db
			.prepare(
				`INSERT INTO messages (session_id, ts, role, content, tool_calls, tool_results, host_context_id, is_private)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				args.sessionId,
				ts,
				args.role,
				args.content ?? null,
				tc,
				tr,
				args.hostContextId ?? null,
				args.isPrivate ? 1 : 0,
			);
		return {
			id: Number(info.lastInsertRowid),
			session_id: args.sessionId,
			ts,
			role: args.role,
			content: args.content ?? null,
			tool_calls: tc,
			tool_results: tr,
			host_context_id: args.hostContextId ?? null,
			is_private: args.isPrivate ? 1 : 0,
		};
	}

	listMessages(sessionId: string, limit = 200): MessageRow[] {
		return this.db
			.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC LIMIT ?")
			.all(sessionId, limit) as unknown as MessageRow[];
	}

	// ---------------- observations ----------------

	insertObservation(args: {
		sessionId: string;
		kind: ObservationKind;
		sourceHost: Host;
		payload: unknown;
		isPrivate?: boolean;
		redacted?: boolean;
	}): ObservationRow {
		const ts = now();
		const text = typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
		const info = this.db
			.prepare(
				`INSERT INTO observations (session_id, ts, kind, source_host, payload, is_private, redacted)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				args.sessionId,
				ts,
				args.kind,
				args.sourceHost,
				text,
				args.isPrivate ? 1 : 0,
				args.redacted ? 1 : 0,
			);
		return {
			id: Number(info.lastInsertRowid),
			session_id: args.sessionId,
			ts,
			kind: args.kind,
			source_host: args.sourceHost,
			payload: text,
			is_private: args.isPrivate ? 1 : 0,
			redacted: args.redacted ? 1 : 0,
		};
	}

	timeline(args: {
		sessionId?: string;
		host?: Host;
		since?: number;
		until?: number;
		limit?: number;
	}): ObservationRow[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (args.sessionId) {
			where.push("session_id = ?");
			params.push(args.sessionId);
		}
		if (args.host) {
			where.push("source_host = ?");
			params.push(args.host);
		}
		if (typeof args.since === "number") {
			where.push("ts >= ?");
			params.push(args.since);
		}
		if (typeof args.until === "number") {
			where.push("ts <= ?");
			params.push(args.until);
		}
		const sql = `SELECT * FROM observations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`;
		params.push(args.limit ?? 100);
		return this.db.prepare(sql).all(...params) as unknown as ObservationRow[];
	}

	// ---------------- session summaries ----------------

	insertSummary(args: { sessionId: string; text: string; citationIds: number[] }): SessionSummaryRow {
		const ts = now();
		const ids = JSON.stringify(args.citationIds);
		const info = this.db
			.prepare(
				"INSERT INTO session_summaries (session_id, generated_at, text, citation_ids) VALUES (?, ?, ?, ?)",
			)
			.run(args.sessionId, ts, args.text, ids);
		const id = Number(info.lastInsertRowid);
		this.db.prepare("UPDATE sessions SET summary_id = ? WHERE id = ?").run(id, args.sessionId);
		return {
			id,
			session_id: args.sessionId,
			generated_at: ts,
			text: args.text,
			citation_ids: ids,
			redacted: 0,
		};
	}

	// ---------------- facts ----------------

	putFact(scope: string, key: string, value: string): FactRow {
		const ts = now();
		this.db
			.prepare(
				`INSERT INTO facts (scope, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run(scope, key, value, ts, ts);
		return this.db
			.prepare("SELECT * FROM facts WHERE scope = ? AND key = ?")
			.get(scope, key) as unknown as FactRow;
	}

	deleteFact(scope: string, key: string): boolean {
		const info = this.db
			.prepare("DELETE FROM facts WHERE scope = ? AND key = ?")
			.run(scope, key);
		return info.changes > 0;
	}

	listFacts(scope?: string): FactRow[] {
		if (scope) {
			return this.db
				.prepare("SELECT * FROM facts WHERE scope = ? ORDER BY updated_at DESC")
				.all(scope) as unknown as FactRow[];
		}
		return this.db
			.prepare("SELECT * FROM facts ORDER BY updated_at DESC")
			.all() as unknown as FactRow[];
	}

	// ---------------- settings ----------------

	getSetting(scope: string, key: string): string | null {
		const row = this.db
			.prepare("SELECT value FROM settings WHERE scope = ? AND key = ?")
			.get(scope, key) as unknown as SettingRow | undefined;
		return row?.value ?? null;
	}

	setSetting(scope: string, key: string, value: string): void {
		this.db
			.prepare(
				`INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
				 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
			)
			.run(scope, key, value);
	}

	// ---------------- FTS5 search ----------------

	search(args: {
		query: string;
		host?: Host;
		since?: number;
		until?: number;
		limit?: number;
	}): FtsHit[] {
		const where: string[] = ["memory_fts MATCH ?"];
		const params: (string | number)[] = [args.query];
		// host filter requires joining — for simplicity, filter post-hit via session lookup.
		// Time filter uses the unindexed ts column (works in WHERE, just not in MATCH).
		if (typeof args.since === "number") {
			where.push("ts >= ?");
			params.push(args.since);
		}
		if (typeof args.until === "number") {
			where.push("ts <= ?");
			params.push(args.until);
		}
		const sql = `
			SELECT body, source, source_id, session_id, ts, rank
			FROM memory_fts
			WHERE ${where.join(" AND ")}
			ORDER BY rank
			LIMIT ?
		`;
		params.push(args.limit ?? 25);
		const rows = this.db.prepare(sql).all(...params) as unknown as FtsHit[];
		if (!args.host) return rows;
		// Post-filter by host via session lookup. Cheap because limit is small.
		const sessionHosts = new Map<string, Host>();
		for (const hit of rows) {
			if (hit.session_id && !sessionHosts.has(hit.session_id)) {
				const s = this.getSession(hit.session_id);
				if (s) sessionHosts.set(hit.session_id, s.host);
			}
		}
		return rows.filter(
			(h) => !h.session_id || sessionHosts.get(h.session_id) === args.host,
		);
	}
}
