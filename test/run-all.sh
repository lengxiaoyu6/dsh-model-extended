#!/usr/bin/env bash
# model-set: run every layer of the plugin's verification.
#
#   ./test/run-all.sh
#
# patch drives the editor patch (apply/idempotence/revert/injected renderers);
# host drives the adapter overlay against a fake LlmRuntime; e2e drives the
# overlay against the real @deepseek-ai/dsh-llm runtime.
#
# host and e2e redirect the patch to a throwaway bundle copy, so nothing here
# ever modifies the dsh installation. patch.mjs owns real apply/revert and works
# on its own sandbox copy too.
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

run "editor patch (apply / revert / injected fields)" node "$here/patch.mjs"
run "adapter overlay (host half)" node "$here/host.mjs"
run "end-to-end (real LlmRuntime)" node "$here/e2e.mjs"

if [ "$status" -eq 0 ]; then
	echo "ALL SUITES PASS"
else
	echo "SOME SUITE FAILED"
fi
exit "$status"
