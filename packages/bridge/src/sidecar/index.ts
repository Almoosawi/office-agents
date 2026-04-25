// Public surface for the sidecar module.

export {
	CliProxyManager,
	type CliProxyManagerOptions,
	type CliProxyStartResult,
} from "./cliproxy.js";

export {
	cliproxyAuthDir,
	cliproxyConfigDir,
	loadVersionPin,
	resolveCliproxyBinary,
	type ResolvedBinary,
} from "./paths.js";
