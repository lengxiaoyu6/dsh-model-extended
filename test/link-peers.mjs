// Creates the peer links the tests need.
//
// `test/e2e.mjs` imports dsh's own packages (`@deepseek-ai/cordis`,
// `@deepseek-ai/dsh-llm`), which are not dependencies of this plugin and
// therefore are not present in a fresh clone. Rather than vendoring them or
// hardcoding an install path, this resolves them out of the dsh installation
// that `locateBundle()` finds and links them into `node_modules/@deepseek-ai/`.
//
// `node_modules/` is gitignored, so these links are a local, disposable build
// step. Re-run this any time after a fresh clone or a dsh upgrade:
//
//   node test/link-peers.mjs
//
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { locateBundle } from "../lib/patch.js";

/** Packages the tests import from dsh rather than from this plugin. */
const PEERS = ["@deepseek-ai/cordis", "@deepseek-ai/dsh-llm"];

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scopeDir = path.join(here, "node_modules", "@deepseek-ai");

const bundle = locateBundle();
if (bundle === undefined) {
	console.error("dsh installation not found.");
	console.error("");
	console.error("These tests exercise a dsh plugin against dsh's own runtime, so a local");
	console.error("dsh install is required. Install dsh, or point the lookup at it:");
	console.error("");
	console.error("  DSH_MODEL_EXTENDED_CLIENT_BUNDLE=/path/to/dsh/node_modules/@deepseek-ai/\\");
	console.error("    dsh-client-ui-settings-models/lib/client.js node test/link-peers.mjs");
	process.exit(1);
}

// Resolving from inside dsh's tree reaches dsh's own node_modules.
const require = createRequire(path.join(path.dirname(bundle), "package.json"));

fs.mkdirSync(scopeDir, { recursive: true });

let linked = 0;
let failed = 0;
for (const peer of PEERS) {
	let target;
	try {
		target = path.dirname(require.resolve(peer + "/package.json"));
	} catch (error) {
		console.error(`  FAIL  ${peer} — not resolvable from dsh (${error.code ?? error})`);
		failed++;
		continue;
	}
	const link = path.join(scopeDir, path.basename(peer));
	try {
		fs.rmSync(link, { recursive: true, force: true });
		fs.symlinkSync(target, link, "dir");
		console.log(`  linked ${peer}`);
		console.log(`         -> ${target}`);
		linked++;
	} catch (error) {
		console.error(`  FAIL  ${peer} — could not link (${error.message})`);
		failed++;
	}
}

console.log("");
console.log(`located: ${bundle}`);
console.log(`${linked} peer link(s) ready${failed === 0 ? "" : `, ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
