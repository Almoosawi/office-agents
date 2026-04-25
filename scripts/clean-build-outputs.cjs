#!/usr/bin/env node
// Cross-platform, junction-safe, Recycle-Bin-respecting clean for build outputs.
//
// Why this exists:
//   - Original scripts used `rm -rf dist tsconfig.build.tsbuildinfo` which only
//     works in POSIX shells (broken in cmd.exe / native PowerShell on Windows).
//   - This project's W3 rule junctions `build/` and `dist/` to C:\builds\... so
//     we must NEVER remove the dist/ directory itself (would destroy the
//     junction reparse point and break subsequent builds).
//   - Per global rule #0, ALL file removals must go through Recycle Bin / trash.
//     We delegate to scripts/recycle.cjs which uses PowerShell + Microsoft.VisualBasic
//     on Windows. There's no `fs.rmSync` permanent-delete fallback on Windows.
//
// Behavior:
//   - Empties the contents of any directories listed in `--dirs <name> ...`
//     by sending each child to Recycle Bin. Leaves the parent dir / junction alone.
//   - Sends individual files listed in `--files <name> ...` to Recycle Bin.
//   - Missing paths are silently ignored.
//
// Usage:
//   node ../../scripts/clean-build-outputs.cjs --dirs dist --files tsconfig.build.tsbuildinfo

const fs = require("node:fs");
const path = require("node:path");
const { recycle } = require("./recycle.cjs");

const args = process.argv.slice(2);
const dirs = [];
const files = [];
let mode = null;
for (const a of args) {
	if (a === "--dirs") { mode = "dirs"; continue; }
	if (a === "--files") { mode = "files"; continue; }
	if (mode === "dirs") dirs.push(a);
	else if (mode === "files") files.push(a);
}

function listDirContents(dir) {
	try {
		return fs.readdirSync(dir).map((entry) => path.join(dir, entry));
	} catch (e) {
		if (e && e.code === "ENOENT") return [];
		throw e;
	}
}

const toRecycle = [];
for (const d of dirs) toRecycle.push(...listDirContents(d));
for (const f of files) toRecycle.push(f);

const n = recycle(toRecycle);
process.stdout.write(`clean-build-outputs: recycled ${n} path(s)\n`);
