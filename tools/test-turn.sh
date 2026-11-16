#!/bin/bash
# The machine-wide turn of the test scripts, sourced by tools/test-all.sh and tools/callboard/test.sh, so that two
# local runs never overlap: the mod tests start many processes, and several runs side by side freeze a laptop.
#   take_test_turn      take the turn: mkdir of the lock folder. While another run holds it, say so once and poll.
#                       Returns 3 when the folder is older than 25 minutes (a crashed run left it): it says how to
#                       clear it and never deletes it.
#   release_test_turn   give the turn back (rmdir), only if this shell took it. Call it from an EXIT trap.
#   $TEST_TURN_NICE     prefix for the heavy commands: `nice -n 10`, or empty when the caller already holds the turn.
# A script that holds the turn exports AI_MANAGER_TEST_TURN=held, so a test script it calls neither waits on the
# turn nor lowers the priority a second time.
# AI_MANAGER_TEST_LOCK (the lock folder) and AI_MANAGER_TEST_POLL (seconds between tries) exist for the tests.

TEST_TURN_LOCK=${AI_MANAGER_TEST_LOCK:-/tmp/ai-manager-fulltest.lock}
TEST_TURN_MINE=0
TEST_TURN_NICE="nice -n 10"

take_test_turn() {
  if [ "${AI_MANAGER_TEST_TURN:-}" = held ]; then TEST_TURN_NICE=""; return 0; fi
  local said=0
  until mkdir "$TEST_TURN_LOCK" 2>/dev/null; do
    if [ -n "$(find "$TEST_TURN_LOCK" -maxdepth 0 -mmin +25 2>/dev/null)" ]; then
      echo "The test turn $TEST_TURN_LOCK is older than 25 minutes: the run that took it has probably crashed." >&2
      echo "Check that no test run is still going, clear it with: rmdir $TEST_TURN_LOCK  and run this again." >&2
      return 3
    fi
    if [ "$said" = 0 ]; then
      echo "Another test run is in progress ($TEST_TURN_LOCK); waiting for it to finish." >&2
      said=1
    fi
    sleep "${AI_MANAGER_TEST_POLL:-5}"
  done
  TEST_TURN_MINE=1
  export AI_MANAGER_TEST_TURN=held
}

release_test_turn() {
  [ "$TEST_TURN_MINE" = 1 ] || return 0
  TEST_TURN_MINE=0
  rmdir "$TEST_TURN_LOCK" 2>/dev/null
  return 0
}
