#!/bin/bash
# Runs every callboard suite: the plugin's specs, the extension, `claude plugin validate` and `claude plugin test` on the plugin, and the link and patch scripts. Needs nothing outside tools/callboard but ../test-turn.sh.
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
step "plugin core logic" node --test plugin/hooks/*.spec.ts plugin/hooks/core/*.spec.ts plugin/hooks/engine/*.spec.ts
step "extension" node --test extension/*.test.js
step "plugin validate" claude plugin validate plugin
step "plugin tests" claude plugin test plugin
echo "== plugin code lines (no blank or comment lines; a line over 160 characters counts once per 160). For information: no limit."
for f in plugin/hooks/*.ts plugin/hooks/core/*.ts plugin/hooks/engine/*.ts; do
  case $f in *.spec.ts) ;; *) awk '!/^[[:space:]]*(\/\/|$)/ { n += int((length($0) + 159) / 160) } END { printf "%6d  %s\n", n, FILENAME }' "$f" ;; esac
done | sort -k2 | awk '{ print; t += $1 } END { printf "%6d  total\n", t }'
step "extension link" /usr/bin/python3 -I test_link_extension.py
step "claude patch" /usr/bin/python3 -I test_patch_claude.py
exit "$rc"
