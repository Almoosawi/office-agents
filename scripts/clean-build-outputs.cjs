#!/usr/bin/env node
// Cross-platform, junction-safe clean for build outputs.
//
// Why this exists:
//   - Original scripts used `rm -rf dist tsconfig.build.tsbuildinfo` which only
//     works in POSIX shells (broken in cmd.exe / native PowerShell on Windows).
//   - This project's W3 rule junctions `build/` and `dist/` to C:\builds\... so
//     we must NEVER remove the dist/ directory itself (would destroy the junction).
//   - Per global rule #0 we avoid permanent deletion of user/source data; build
//     artifacts under junctions on C: are out-of-tree and out-of-OneDrive and
//     are explicitly regenerable.
//
// Behavior:
//   - Empties the contents of any directories listed in argv[2..] without
//     removing the directories themselves.
//   - Removes individual files listed (e.g. tsconfig.build.tsbuildinfo).
//   - Missing paths are silently ignored.
//
// Usage:
//   node ../../scripts/clean-build-outputs.cjs --dirs dist --files tsconfig.build.tsbuildinfo

const fs = require("node:fs");
const path = require("node:path");

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

function emptyDirContents(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

for (const d of dirs) emptyDirContents(d);
for (const f of files) removeFile(f);
