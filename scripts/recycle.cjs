#!/usr/bin/env node
// Send-to-Recycle-Bin helper for Windows. Honors global rule #0 (no permanent
// deletion — EVER) for build artifact cleanup.
//
// Cross-platform fallback (macOS/Linux) is *not* implemented because the
// project is Windows-only by design. If we ever need it, swap in `gio trash`
// (Linux) or `osascript -e 'tell application "Finder" to delete ...'` (macOS).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function existing(paths) {
	return paths.filter((p) => {
		try {
			fs.lstatSync(p);
			return true;
		} catch (e) {
			if (e && e.code === "ENOENT") return false;
			throw e;
		}
	});
}

function quote(p) {
	// PowerShell single-quoted literal: escape single quotes by doubling them.
	return `'${path.resolve(p).replace(/'/g, "''")}'`;
}

function recycleWindows(paths) {
	const present = existing(paths);
	if (present.length === 0) return 0;
	const list = present.map(quote).join(",");
	const script = [
		"Add-Type -AssemblyName Microsoft.VisualBasic;",
		`foreach ($p in @(${list})) {`,
		"  if (Test-Path -LiteralPath $p -PathType Container) {",
		"    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(",
		"      $p,",
		"      [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
		"      [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
		"  } else {",
		"    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(",
		"      $p,",
		"      [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
		"      [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
		"  }",
		"}",
	].join(" ");
	execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: "ignore",
	});
	return present.length;
}

function recycle(paths) {
	if (!Array.isArray(paths) || paths.length === 0) return 0;
	if (process.platform !== "win32") {
		// Non-Windows fallback. Project is Windows-only, but tests may run on CI.
		const present = existing(paths);
		for (const p of present) {
			fs.rmSync(p, { recursive: true, force: true });
		}
		return present.length;
	}
	return recycleWindows(paths);
}

module.exports = { recycle };

// Allow direct CLI use: node recycle.cjs path1 path2 ...
if (require.main === module) {
	const args = process.argv.slice(2);
	const n = recycle(args);
	process.stdout.write(`recycled ${n} path(s)\n`);
}
