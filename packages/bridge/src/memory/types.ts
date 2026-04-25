// TypeScript types matching the SQLite schema in migrations/0001_init.sql.
// Times are stored as INTEGER milliseconds since epoch.

export type Host = "word" | "excel" | "powerpoint" | "outlook";

export type ObservationKind =
	| "chat.send"
	| "tool.invoke"
	| "tool.result"
	| "selection.changed"
	| "gate.confirmed"
	| "gate.refused";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface SessionRow {
	id: string;
	host: Host;
	started_at: number;
	ended_at: number | null;
	summary_id: number | null;
	persona_version: number;
	provider: string;
}

export interface MessageRow {
	id: number;
	session_id: string;
	ts: number;
	role: MessageRole;
	content: string | null;
	tool_calls: string | null;
	tool_results: string | null;
	host_context_id: number | null;
	is_private: 0 | 1;
}

export interface HostContextRow {
	id: number;
	session_id: string;
	ts: number;
	blob: string;
}

export interface ObservationRow {
	id: number;
	session_id: string;
	ts: number;
	kind: ObservationKind;
	source_host: Host;
	payload: string;
	is_private: 0 | 1;
	redacted: 0 | 1;
}

export interface SessionSummaryRow {
	id: number;
	session_id: string;
	generated_at: number;
	text: string;
	citation_ids: string;
	redacted: 0 | 1;
}

export interface FactRow {
	id: number;
	scope: string;
	key: string;
	value: string;
	created_at: number;
	updated_at: number;
}

export interface SettingRow {
	scope: string;
	key: string;
	value: string;
}

export interface OutlookHandleRow {
	handle: string;
	kind: "mail" | "event" | "task" | "folder";
	store_id: string | null;
	entry_id: string | null;
	created_at: number;
	last_seen_at: number;
}

export interface SkillStateRow {
	skill_name: string;
	enabled: 0 | 1;
	last_loaded_at: number | null;
	load_count: number;
}

export interface FtsHit {
	body: string;
	source: "msg" | "obs" | "sum" | "fact";
	source_id: number;
	session_id: string | null;
	ts: number;
	rank: number;
}
