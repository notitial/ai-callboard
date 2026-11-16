#!/bin/bash
# Runs every callboard suite. Needs nothing outside tools/callboard but ../test-turn.sh.
# CALLBOARD_SKIP_MOD_TESTS=1 skips only `claude plugin test mod` (the slow part: about 2 minutes), and says so. It is for a quick
# local run; CI does not set it. Run this script without it before any PR that touches tools/callboard/mod.
# It takes the machine-wide test turn first (../test-turn.sh) and waits while another run holds it, then runs every
# step under `nice -n 10`. Exit 3: the turn is stale (older than 25 minutes); the message says how to clear it.
set -uo pipefail
cd "$(dirname "$0")"
. ../test-turn.sh
trap release_test_turn EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
take_test_turn || exit 3
rc=0
step() { echo "== $1"; shift; $TEST_TURN_NICE "$@" || rc=1; }
step "core logic" node --test mod/hooks/*.spec.ts
step "prompt audit" node --test prompt-audit.test.mjs
step "extension" node --test extension/*.test.js
step "mod validate" claude plugin validate mod
if [ "${CALLBOARD_SKIP_MOD_TESTS:-}" = 1 ]; then
  echo "== mod tests"
  echo "SKIPPED: CALLBOARD_SKIP_MOD_TESTS=1. Not run here; run this script without it before any mod PR."
else
  step "mod tests" claude plugin test mod
fi
step "extension link" /usr/bin/python3 -I test_link_extension.py
exit "$rc"
