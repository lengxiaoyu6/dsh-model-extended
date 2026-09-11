#!/usr/bin/env bash
# Runs every layer of the plugin's verification.
#
#   ./test/run-all.sh
#
# Requires a local dsh installation: test/e2e.mjs drives the plugin against
# dsh's own LlmRuntime, and test/patch.mjs patches a copy of the Models editor
# bundle dsh ships. test/link-peers.mjs resolves both out of that install.
#
# Nothing here modifies the dsh installation. patch.mjs, host.mjs and e2e.mjs
# all redirect the editor patch to a throwaway copy of the bundle.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0

run() {
	local label="$1"; shift
	echo "──────────── $label"
	if "$@"; then
		:
	else
		status=1
	fi
	echo
}

run "peer links" node "$here/link-peers.mjs"
run "editor patch (apply / revert / injected fields)" node "$here/patch.mjs"
run "adapter overlay (host half)" node "$here/host.mjs"
run "end-to-end (real LlmRuntime)" node "$here/e2e.mjs"

if [ "$status" -eq 0 ]; then
	echo "ALL SUITES PASS"
else
	echo "SOME SUITE FAILED"
fi
exit "$status"
