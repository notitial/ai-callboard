#!/bin/bash
# Runs every callboard suite, the mod and the plugin beside it, side by side. Needs nothing outside tools/callboard but ../test-turn.sh.
# CALLBOARD_SKIP_MOD_TESTS=1 skips only `claude plugin test mod` (the slow part: about 2 minutes), and says so. It is for a quick
# local run; CI does not set it. Run this script without it before any PR that touches tools/callboard/mod.
# It takes the machine-wide test turn first (../test-turn.sh) and waits while another run holds it, then runs every
# step under `nice -n 10`. Exit 2: ../test-turn.sh is missing. Exit 3: the turn is stale (older than 25 minutes, its
# holder not known to be gone); the message says how to clear it.
set -uo pipefail
cd "$(dirname "$0")"
. ../test-turn.sh || exit 2
trap release_test_turn EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
take_test_turn || exit 3
rc=0
step() { echo "== $1"; shift; $TEST_TURN_NICE "$@" || rc=1; }
step "core logic" node --test mod/hooks/*.spec.ts
step "plugin core logic" node --test plugin/hooks/*.spec.ts plugin/hooks/core/*.spec.ts plugin/hooks/engine/*.spec.ts
step "prompt audit" node --test prompt-audit.test.mjs
step "extension" node --test extension/*.test.js
step "mod validate" claude plugin validate mod
step "plugin validate" claude plugin validate plugin
step "plugin tests" claude plugin test plugin
echo "== plugin code lines (no blank or comment lines; a line over 160 characters counts once per 160). For information: no limit."
for f in plugin/hooks/*.ts plugin/hooks/core/*.ts plugin/hooks/engine/*.ts; do
  case $f in *.spec.ts) ;; *) awk '!/^[[:space:]]*(\/\/|$)/ { n += int((length($0) + 159) / 160) } END { printf "%6d  %s\n", n, FILENAME }' "$f" ;; esac
done | sort -k2 | awk '{ print; t += $1 } END { printf "%6d  total\n", t }'
if [ "${CALLBOARD_SKIP_MOD_TESTS:-}" = 1 ]; then
  echo "== mod tests"
  echo "SKIPPED: CALLBOARD_SKIP_MOD_TESTS=1. Not run here; run this script without it before any mod PR."
else
  step "mod tests" claude plugin test mod
fi
step "extension link" /usr/bin/python3 -I test_link_extension.py
exit "$rc"
