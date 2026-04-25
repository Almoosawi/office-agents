// Per-user, no-admin paths (ARCHITECTURE §1a).
// Memory and skills live under %LocalAppData%\OfficeAIAssistant\ on Windows.
// Roaming %APPDATA% is opt-in, not used here.

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const APP_NAME = "OfficeAIAssistant";

function localDataRoot(): string {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) return localAppData;
		// Last-resort fallback (LOCALAPPDATA always exists on Windows post-Vista, but
		// guard anyway for sandboxes that strip env vars).
		return join(homedir(), "AppData", "Local");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support");
	}
	// Linux / other XDG: respect XDG_DATA_HOME if set.
	return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

export function appDataDir(): string {
	const dir = join(localDataRoot(), APP_NAME);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function dataDir(): string {
	const dir = join(appDataDir(), "data");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function memoryDbPath(): string {
	return join(dataDir(), "memory.db");
}

export function skillsDir(): string {
	const dir = join(appDataDir(), "skills");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function logsDir(): string {
	const dir = join(appDataDir(), "logs");
	mkdirSync(dir, { recursive: true });
	return dir;
}
