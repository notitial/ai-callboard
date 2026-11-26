#!/bin/bash
# Tests of the machine-wide test turn: tools/test-turn.sh, and its wiring in tools/test-all.sh and
# tools/callboard/test.sh. Every case uses a lock folder of its own in a temp dir, never the real one, so it can run
# inside a test-all.sh run that holds the real turn. Exit 0 when every case passes, 1 otherwise.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd -P) || exit 1
TMP=$(mktemp -d "${TMPDIR:-/tmp}/test-turn-XXXXXX") || exit 1
trap 'rm -r "$TMP"' EXIT
export AI_CALLBOARD_TEST_LOCK="$TMP/lock" AI_CALLBOARD_TEST_POLL=0.2
unset AI_CALLBOARD_TEST_TURN
LOCK=$AI_CALLBOARD_TEST_LOCK
FAILED=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAILED=1; }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
wait_for() {  # wait_for <seconds> <command…>: true as soon as the command is, false after the limit
  local n=$(($1 * 10)); shift
  while [ "$n" -gt 0 ]; do "$@" && return 0; sleep 0.1; n=$((n - 1)); done
  return 1
}
said_waiting() { grep -q 'Another test run is in progress' "$1"; }
make_stale() { touch -d '30 minutes ago' "$1" 2>/dev/null || touch -A -003000 "$1"; }

# A free turn is taken and given back.
out=$(bash -c '. "$0/tools/test-turn.sh"; take_test_turn || exit 9; [ -d "$AI_CALLBOARD_TEST_LOCK" ] || exit 8
  echo "$AI_CALLBOARD_TEST_TURN/$TEST_TURN_NICE"; release_test_turn; [ ! -e "$AI_CALLBOARD_TEST_LOCK" ]' "$ROOT" 2>&1)
check "a free turn is taken, marked held and given back" [ "$?/$out" = "0/held/nice -n 10" ]

# A caller that holds the turn: no wait, no lock of its own, no second nice, and its lock is left alone.
mkdir "$LOCK"
out=$(AI_CALLBOARD_TEST_TURN=held bash -c '. "$0/tools/test-turn.sh"; take_test_turn || exit 9
  echo "[$TEST_TURN_NICE]"; release_test_turn' "$ROOT" 2>&1)
check "under a caller that holds the turn: no wait, no nice" [ "$?/$out" = "0/[]" ]
check "under a caller that holds the turn: its lock is left alone" [ -d "$LOCK" ]

# A held turn: the next run says so once, waits, and takes it when it is free.
bash -c '. "$0/tools/test-turn.sh"; take_test_turn || exit 9; echo taken; release_test_turn' "$ROOT" > "$TMP/wait.out" 2>&1 &
pid=$!
check "a held turn: the next run says a run is in progress" wait_for 5 said_waiting "$TMP/wait.out"
sleep 0.5
check "a held turn: the next run waits" [ "$(grep -c . "$TMP/wait.out")" = 1 ]
rmdir "$LOCK"
wait "$pid"
check "a freed turn is taken by the waiting run" [ "$?/$(tail -n 1 "$TMP/wait.out")" = "0/taken" ]
check "the waiting run gives the turn back" [ ! -e "$LOCK" ]

# A stale turn: exit 3, the way to clear it, and the folder still there.
mkdir "$LOCK"
make_stale "$LOCK"
out=$(bash -c '. "$0/tools/test-turn.sh"; take_test_turn; rc=$?; release_test_turn; exit "$rc"' "$ROOT" 2>&1)
check "a stale turn: exit 3" [ "$?" = 3 ]
check "a stale turn: says how to clear it" grep -q "older than 25 minutes.*rm -r $LOCK" <<< "$(echo "$out" | tr '\n' ' ')"
check "a stale turn: never deleted" [ -d "$LOCK" ]
out=$(bash "$ROOT/tools/test-all.sh" --quick callboard 2>&1)
check "test-all.sh: a stale turn is exit 3 and stays" [ "$?" = 3 -a -d "$LOCK" ]
out=$(bash "$ROOT/tools/callboard/test.sh" 2>&1)
check "callboard/test.sh: a stale turn is exit 3 and stays" [ "$?" = 3 -a -d "$LOCK" ]
echo "$$" > "$LOCK/pid"
make_stale "$LOCK"
out=$(bash -c '. "$0/tools/test-turn.sh"; take_test_turn' "$ROOT" 2>&1)
check "a stale turn whose holder still runs: exit 3, the lock stays" [ "$?" = 3 -a "$(cat "$LOCK/pid")" = "$$" ]
rm "$LOCK/pid"
rmdir "$LOCK"

# The lock carries its holder's pid, and only that run gives it back.
out=$(bash -c '. "$0/tools/test-turn.sh"; take_test_turn || exit 9; [ "$(cat "$AI_CALLBOARD_TEST_LOCK/pid")" = "$$" ] || exit 8
  echo 1 > "$AI_CALLBOARD_TEST_LOCK/pid"; release_test_turn; [ -d "$AI_CALLBOARD_TEST_LOCK" ]' "$ROOT" 2>&1)
check "the lock carries the holder's pid; another run's lock is not given back" [ "$?" = 0 ]
rm "$LOCK/pid"
rmdir "$LOCK"

# A holder that still runs is waited for; one that is gone loses the turn at once, with one line saying so.
mkdir "$LOCK"
echo "$$" > "$LOCK/pid"
bash -c '. "$0/tools/test-turn.sh"; take_test_turn || exit 9; echo taken; release_test_turn' "$ROOT" > "$TMP/live.out" 2>&1 &
pid=$!
check "a holder that still runs: the next run waits" wait_for 5 said_waiting "$TMP/live.out"
sleep 0.5
check "a holder that still runs: its turn is not taken over" [ "$(cat "$LOCK/pid")/$(grep -c . "$TMP/live.out")" = "$$/1" ]
sleep 0 &
gone=$!
wait "$gone"
echo "$gone" > "$LOCK/pid"
wait "$pid"
check "a holder that is gone: the waiting run takes the turn over" [ "$?/$(tail -n 1 "$TMP/live.out")" = "0/taken" ]
check "a holder that is gone: one line says so" [ "$(grep -c "pid $gone) is gone" "$TMP/live.out")" = 1 ]
check "a turn taken over is given back" [ ! -e "$LOCK" ]
mkdir "$LOCK"
echo "$gone" > "$LOCK/pid"
make_stale "$LOCK"
out=$(bash "$ROOT/tools/test-all.sh" --quick callboard 2>&1)
check "test-all.sh: takes over a gone holder's turn, however old, and gives it back" [ "$?" = 0 -a ! -e "$LOCK" ]

# test-all.sh takes the turn for its run and gives it back; a wrong argument never takes it.
out=$(bash "$ROOT/tools/test-all.sh" --quick callboard 2>&1)
check "test-all.sh: runs and gives the turn back" [ "$?" = 0 -a ! -e "$LOCK" ]
mkdir "$LOCK"
out=$(bash "$ROOT/tools/test-all.sh" no-such-suite 2>&1)
check "test-all.sh: a wrong suite name exits 2 without waiting" [ "$?" = 2 ]

# Both scripts wait on a held turn, and stopping one that waits leaves the holder's lock alone.
for script in tools/test-all.sh tools/callboard/test.sh; do
  bash "$ROOT/$script" --quick callboard > "$TMP/script.out" 2>&1 &
  pid=$!
  check "$script: waits on a held turn" wait_for 5 said_waiting "$TMP/script.out"
  check "$script: runs nothing while it waits" [ "$(grep -c . "$TMP/script.out")" = 1 ]
  kill -TERM "$pid"
  wait "$pid"
  check "$script: stopped while waiting, exit 143 and the lock stays" [ "$?" = 143 -a -d "$LOCK" ]
done
out=$(cd "$TMP" && cp "$ROOT/tools/callboard/test.sh" . && bash ./test.sh 2>&1)
check "callboard/test.sh: a missing test-turn.sh is exit 2, not a stale turn" [ "$?" = 2 ]
rmdir "$LOCK"

# A run that is stopped while it holds the turn gives it back.
bash -c '. "$0/tools/test-turn.sh"; trap release_test_turn EXIT; trap "exit 143" TERM
  take_test_turn || exit 9; echo taken; while :; do sleep 0.1; done' "$ROOT" > "$TMP/hold.out" 2>&1 &
pid=$!
check "a run takes the turn" wait_for 5 grep -q taken "$TMP/hold.out"
kill -TERM "$pid"
wait "$pid"
check "a stopped run gives the turn back" [ "$?" = 143 -a ! -e "$LOCK" ]

echo
[ "$FAILED" = 0 ] && echo "all passed" || echo "some FAILED"
exit "$FAILED"
