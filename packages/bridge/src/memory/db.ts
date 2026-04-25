// SQLite memory layer for the assistant-bridge — zero native deps.
//
// Uses Node's built-in `node:sqlite` — Stability 1.1 (active development) on
// Node 24, FTS5 enabled. This is an *accepted* experimental dependency: the
// alternative (better-sqlite3) needs node-gyp + MSVC Build Tools, which would
// require an admin install and violate the "no admin privileges, ever" rule
// (ARCHITECTURE §1a). Node 24+ is pinned at install time; if a future minor
// version tweaks the API, we update this layer alongside the runtime bump.
// `--experimental-sqlite` is no longer required on Node 24 (the module is
// available unflagged), but an `ExperimentalWarning` may still be emitted —
// silence it via `--no-warnings=ExperimentalWarning` in the bridge launcher
// rather than suppressing all warnings globally.
//
// - WAL mode + FTS5
// - Path: %LocalAppData%\OfficeAIAssistant\data\memory.db
// - Migrations: SQL files in ./migrations applied in order, tracked in _schema_versions

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { memoryDbPath } from "./paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _db: DatabaseSync | null = null;

function migrationsDir(): string {
	// Resolved relative to this compiled file. SQL files are copied next to
	// dist/memory/db.js by scripts/copy-bridge-resources.cjs at build time.
	return join(__dirname, "migrations");
}

function listMigrations(): { version: number; file: string }[] {
	const dir = migrationsDir();
	const entries = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
	return entries.map((file) => {
		const m = /^(\d+)_/.exec(file);
		if (!m) throw new Error(`Migration filename must start with NNNN_: ${file}`);
		return { version: Number.parseInt(m[1] ?? "0", 10), file: join(dir, file) };
	});
}

function applyMigrations(db: DatabaseSync): void {
	let appliedVersions: Set<number>;
	try {
		const rows = db
			.prepare("SELECT version FROM _schema_versions ORDER BY version")
			.all() as { version: number }[];
		appliedVersions = new Set(rows.map((r) => r.version));
	} catch {
		// _schema_versions doesn't exist yet — first migration creates it.
		appliedVersions = new Set();
	}
	for (const m of listMigrations()) {
		if (appliedVersions.has(m.version)) continue;
		const sql = readFileSync(m.file, "utf8");
		db.exec(sql);
	}
}

export interface OpenOptions {
	dbPath?: string;
	readonly?: boolean;
	skipMigrations?: boolean;
}

export function openMemoryDb(opts: OpenOptions = {}): DatabaseSync {
	const dbPath = opts.dbPath ?? memoryDbPath();
	const db = new DatabaseSync(dbPath, { readOnly: opts.readonly ?? false });

	// node:sqlite doesn't have a `pragma()` helper — use exec.
	if (!opts.readonly) {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA temp_store = MEMORY");
	} else {
		db.exec("PRAGMA query_only = ON");
	}

	if (!opts.skipMigrations && !opts.readonly) {
		applyMigrations(db);
	}
	return db;
}

/** Lazy singleton for app-wide reuse. Tests should call openMemoryDb directly. */
export function getMemoryDb(): DatabaseSync {
	if (!_db) _db = openMemoryDb();
	return _db;
}

export function closeMemoryDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

export type { DatabaseSync };
