#!/usr/bin/env node
// Pulls the pinned CLIProxyAPI Windows release, verifies the SHA-256, and
// extracts `CLIProxyAPI.exe` (+ LICENSE) into vendor/cliproxy/. The binary
// is .gitignored — repo only stores the pin and the script.
//
// Usage:
//   node scripts/fetch-cliproxy.cjs                # download + verify pinned
//   node scripts/fetch-cliproxy.cjs --verify       # only verify existing files
//   node scripts/fetch-cliproxy.cjs --pin v6.9.38  # rewrite VERSION.json then fetch
//   node scripts/fetch-cliproxy.cjs --latest       # auto-resolve newest release, repin, fetch
//
// Update flow (zero code changes):
//   pnpm cliproxy:update    -> --latest under the hood
//   pnpm fetch:cliproxy:pin <tag> -> if you want a specific version
// VERSION.json is the only source of truth for the pin; the bridge manager
// reads `binary` from it and knows nothing else version-specific.
//
// Why Node (not PowerShell):
//   - Cross-shell (works from bash, cmd, pwsh, IDE terminals)
//   - Same script runs at install time inside the per-user installer
//   - We delegate ZIP extraction to PowerShell's `Expand-Archive` to avoid
//     adding a zip dep — fine because the project is Windows-only.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const VENDOR_DIR = path.resolve(__dirname, "..", "vendor", "cliproxy");
const VERSION_FILE = path.join(VENDOR_DIR, "VERSION.json");

function loadPin() {
	const raw = fs.readFileSync(VERSION_FILE, "utf8");
	return JSON.parse(raw);
}

function savePin(pin) {
	fs.writeFileSync(VERSION_FILE, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
}

async function fetchAssetMetadata(tag) {
	// Hit GitHub releases API to resolve the pinned tag's Windows asset.
	const apiUrl = `https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/${tag}`;
	const data = await httpsGetJson(apiUrl);
	const asset = (data.assets ?? []).find(
		(a) => a.name && /windows_amd64\.zip$/i.test(a.name),
	);
	if (!asset) throw new Error(`no windows_amd64 zip in release ${tag}`);
	return {
		name: asset.name,
		url: asset.browser_download_url,
		size: asset.size,
		publishedAt: data.published_at,
	};
}

function httpsGetJson(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{
				headers: {
					"user-agent": "office-ai-assistant-fetch-cliproxy/1.0",
					accept: "application/vnd.github+json",
					...headers,
				},
			},
			(res) => {
				if (res.statusCode === 302 || res.statusCode === 301) {
					return resolve(httpsGetJson(res.headers.location, headers));
				}
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error(`GET ${url} -> ${res.statusCode}`));
				}
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (c) => (body += c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(body));
					} catch (e) {
						reject(e);
					}
				});
			},
		);
		req.on("error", reject);
	});
}

function downloadTo(url, destPath) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(destPath);
		const onError = (err) => {
			file.close();
			fs.rmSync(destPath, { force: true });
			reject(err);
		};
		https
			.get(
				url,
				{
					headers: {
						"user-agent": "office-ai-assistant-fetch-cliproxy/1.0",
					},
				},
				(res) => {
					if (res.statusCode === 302 || res.statusCode === 301) {
						file.close();
						fs.rmSync(destPath, { force: true });
						return resolve(downloadTo(res.headers.location, destPath));
					}
					if (res.statusCode !== 200) {
						res.resume();
						return onError(new Error(`GET ${url} -> ${res.statusCode}`));
					}
					res.pipe(file);
					file.on("finish", () => file.close(resolve));
				},
			)
			.on("error", onError);
	});
}

function sha256(filePath) {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(filePath));
	return hash.digest("hex");
}

function expandZip(zipPath, destDir) {
	if (process.platform !== "win32") {
		throw new Error(
			"fetch-cliproxy is Windows-only (Office classic-Outlook + COM sidecar require Windows)",
		);
	}
	// PowerShell Expand-Archive is built in on Windows 10+. -Force overwrites.
	execFileSync(
		"powershell",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
		],
		{ stdio: "inherit" },
	);
}

function findArchiveContents(rootDir) {
	// Walk the extracted tree. CLIProxyAPI's zip layout has flipped between
	// versions (PascalCase, kebab-case, with/without subfolder). We don't
	// hardcode names — we just pick: the lone .exe (binary), the LICENSE,
	// and any config.example.* (we ship it as a template alongside).
	const candidates = [];
	const walk = (dir, depth) => {
		if (depth > 2) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else candidates.push(full);
		}
	};
	walk(rootDir, 0);
	const exes = candidates.filter((p) => /\.exe$/i.test(p));
	if (exes.length !== 1) {
		throw new Error(
			`expected exactly one .exe in archive, found ${exes.length}: ${exes.join(", ")}`,
		);
	}
	return {
		exe: exes[0],
		license: candidates.find((p) => /[\\/]LICENSE(\.[^\\/]*)?$/i.test(p)),
		configExample: candidates.find((p) => /config\.example\./i.test(p)),
	};
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const pinIndex = process.argv.indexOf("--pin");
	const pin = loadPin();
	let pinChanged = false;

	if (args.has("--latest")) {
		const latest = await httpsGetJson(
			"https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest",
		);
		const newTag = latest.tag_name;
		if (!newTag) throw new Error("could not resolve latest release tag");
		if (newTag === pin.tag) {
			console.log(`[fetch-cliproxy] already on latest: ${newTag}`);
		} else {
			const meta = await fetchAssetMetadata(newTag);
			pin.tag = newTag;
			pin.asset = meta.name;
			pin.url = meta.url;
			pin.publishedAt = meta.publishedAt;
			pinChanged = true;
			console.log(`[fetch-cliproxy] re-pinned to latest ${newTag} (${meta.name})`);
		}
	}

	if (pinIndex >= 0) {
		const newTag = process.argv[pinIndex + 1];
		if (!newTag) throw new Error("--pin requires a version tag");
		const meta = await fetchAssetMetadata(newTag);
		// SHA needs the actual file — we'll fill it after download below.
		pin.tag = newTag;
		pin.asset = meta.name;
		pin.url = meta.url;
		pin.publishedAt = meta.publishedAt;
		pinChanged = true;
		console.log(`[fetch-cliproxy] re-pinned to ${newTag} (${meta.name})`);
	}

	const exePath = path.join(VENDOR_DIR, pin.binary);
	const zipPath = path.join(VENDOR_DIR, pin.asset);

	if (args.has("--verify") && fs.existsSync(exePath)) {
		console.log(`[fetch-cliproxy] verifying ${exePath} (no download)`);
		// We verify the zip's SHA, not the exe (zip is what the upstream signs).
		if (!fs.existsSync(zipPath)) {
			console.log(
				"[fetch-cliproxy] no zip on disk to verify against; re-run without --verify to download",
			);
			return;
		}
		const got = sha256(zipPath);
		if (got !== pin.sha256) {
			throw new Error(
				`sha256 mismatch — pinned ${pin.sha256}, got ${got}`,
			);
		}
		console.log(`[fetch-cliproxy] verified: ${got}`);
		return;
	}

	if (!fs.existsSync(zipPath)) {
		console.log(`[fetch-cliproxy] downloading ${pin.url}`);
		await downloadTo(pin.url, zipPath);
	} else {
		console.log(`[fetch-cliproxy] zip already present: ${zipPath}`);
	}

	const got = sha256(zipPath);
	if (pinChanged) {
		// New pin (--pin or --latest): record the freshly computed sha.
		pin.sha256 = got;
		savePin(pin);
		console.log(`[fetch-cliproxy] recorded sha256 ${got}`);
	} else if (got !== pin.sha256) {
		throw new Error(
			`sha256 mismatch — pinned ${pin.sha256}, got ${got}. Refusing to extract a tampered archive.`,
		);
	} else {
		console.log(`[fetch-cliproxy] sha256 ok: ${got}`);
	}

	// Extract into a scratch dir then move the exe + LICENSE into VENDOR_DIR.
	const scratch = path.join(VENDOR_DIR, ".scratch");
	fs.rmSync(scratch, { recursive: true, force: true });
	fs.mkdirSync(scratch, { recursive: true });
	expandZip(zipPath, scratch);

	const { exe, license, configExample } = findArchiveContents(scratch);

	// If the upstream binary name changed since the pin was last set, sync it
	// into VERSION.json so the bridge sidecar manager knows where to look. The
	// goal: a user running `pnpm cliproxy:update` never needs to touch code.
	const actualBinaryName = path.basename(exe);
	if (actualBinaryName !== pin.binary) {
		console.log(
			`[fetch-cliproxy] binary name shifted: ${pin.binary} -> ${actualBinaryName}; updating VERSION.json`,
		);
		pin.binary = actualBinaryName;
		savePin(pin);
	}
	const finalExePath = path.join(VENDOR_DIR, pin.binary);

	fs.copyFileSync(exe, finalExePath);
	if (license) {
		fs.copyFileSync(license, path.join(VENDOR_DIR, "LICENSE.upstream"));
	}
	if (configExample) {
		fs.copyFileSync(
			configExample,
			path.join(VENDOR_DIR, path.basename(configExample)),
		);
	}
	fs.rmSync(scratch, { recursive: true, force: true });
	// Keep the zip cached so re-runs don't re-download. .gitignored.

	console.log(`[fetch-cliproxy] installed -> ${finalExePath}`);
	console.log(`[fetch-cliproxy] size: ${fs.statSync(finalExePath).size} bytes`);
}

main().catch((e) => {
	console.error(`[fetch-cliproxy] ERROR: ${e.message}`);
	process.exit(1);
});
