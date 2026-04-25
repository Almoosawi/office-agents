#!/usr/bin/env node
// Copy non-TS resources from packages/bridge/src into packages/bridge/dist
// so they're available next to the compiled JS at runtime.
//
// Currently: SQL migration files for the memory layer.
// Add more globs here as the bridge gains other resource types.

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_ROOT = process.cwd();             // expected: packages/bridge
const SRC = path.join(PACKAGE_ROOT, "src");
const DIST = path.join(PACKAGE_ROOT, "dist");

function copyTree(srcDir, dstDir, predicate) {
	let copied = 0;
	if (!fs.existsSync(srcDir)) return copied;
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const srcPath = path.join(srcDir, entry.name);
		const dstPath = path.join(dstDir, entry.name);
		if (entry.isDirectory()) {
			copied += copyTree(srcPath, dstPath, predicate);
		} else if (predicate(srcPath)) {
			fs.mkdirSync(dstDir, { recursive: true });
			fs.copyFileSync(srcPath, dstPath);
			copied++;
		}
	}
	return copied;
}

const sqlCount = copyTree(SRC, DIST, (p) => p.endsWith(".sql"));
process.stdout.write(`bridge resources: copied ${sqlCount} .sql file(s)\n`);
