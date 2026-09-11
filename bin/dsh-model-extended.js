#!/usr/bin/env node
// Editor-patch maintenance, for the one thing the plugin cannot do from inside
// dsh: cleaning up after itself once it is no longer installed.
//
// Installing the plugin patches the Models editor bundle on every dsh start.
// Removing the plugin stops that, but the last patch stays on disk, since the
// plugin that would undo it is gone. Run this from the checkout before removing
// the package:
//
//   node bin/dsh-model-extended.js status
//   node bin/dsh-model-extended.js revert
//   node bin/dsh-model-extended.js apply
//
import { apply, revert, status, locateBundle } from "../lib/patch.js";

const command = (process.argv[2] ?? "status").toLowerCase();

const describe = (state) => {
	if (state.found !== true) {
		console.log("Models editor bundle: not found");
		console.log("No dsh installation was located. Install dsh, or point at one with");
		console.log("DSH_MODEL_EXTENDED_CLIENT_BUNDLE=<path to dsh-client-ui-settings-models/lib/client.js>");
		return;
	}
	console.log(`bundle    : ${state.bundle}`);
	console.log(`patched   : ${state.patched ? "yes" : "no"}`);
	// While patched, the anchors are what the patch consumed, so they can only
	// be checked in the unpatched state.
	console.log(`patchable : ${state.patched ? "yes (patched)" : state.anchorPresent ? "yes" : "no (upstream editor markup changed)"}`);
	console.log(`backup    : ${state.backedUp ? "present" : "none"}`);
};

switch (command) {
	case "status": {
		const before = locateBundle();
		const state = status();
		describe(state);
		if (before === undefined && state.found !== true) process.exitCode = 1;
		break;
	}
	case "apply": {
		const outcome = apply();
		describe(status());
		console.log("");
		console.log(`apply -> ${outcome.action}`);
		if (outcome.error !== undefined) console.log(`  ${outcome.error}`);
		if (outcome.action === "applied") console.log("Restart dsh (or reload the page) for the editor to serve the patched bundle.");
		if (outcome.ok !== true) process.exitCode = 1;
		break;
	}
	case "revert": {
		const outcome = revert();
		describe(status());
		console.log("");
		console.log(`revert -> ${outcome.action}`);
		if (outcome.error !== undefined) console.log(`  ${outcome.error}`);
		if (outcome.action === "reverted") console.log("The bundle is byte-identical to what dsh shipped. Restart dsh.");
		if (outcome.ok !== true) process.exitCode = 1;
		break;
	}
	default:
		console.log("usage: dsh-model-extended [status|apply|revert]");
		process.exitCode = 1;
}
