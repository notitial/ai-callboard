#!/bin/bash
# The machine-wide turn of the test scripts, sourced by tools/test-all.sh and tools/callboard/test.sh, so that two
# local runs never overlap: the plugin tests start many processes, and several runs side by side freeze a laptop.
#   take_test_turn      take the turn: mkdir of the lock folder, with the holder's pid in its `pid` file. While
#                       another run holds it, say so once and poll. A holder whose pid no longer runs has crashed:
#                       the turn is taken over at once, with one line saying so. Returns 3 when the folder is older
#                       than 25 minutes and cannot be taken over (the holder hangs, or left no pid): it says how to
#                       clear it and never deletes it.
#   release_test_turn   give the turn back, only if the lock carries this shell's pid. Call it from an EXIT trap.
#   $TEST_TURN_NICE     prefix for the heavy commands: `nice -n 10`, or empty when the caller already holds the turn.
# A script that holds the turn exports AI_MANAGER_TEST_TURN=held, so a test script it calls neither waits on the
# turn nor lowers the priority a second time.
# AI_MANAGER_TEST_LOCK (the lock folder) and AI_MANAGER_TEST_POLL (seconds between tries) exist for the tests.

TEST_TURN_LOCK=${AI_MANAGER_TEST_LOCK:-/tmp/ai-manager-fulltest.lock}
TEST_TURN_NICE="nice -n 10"

take_test_turn() {
  if [ "${AI_MANAGER_TEST_TURN:-}" = held ]; then TEST_TURN_NICE=""; return 0; fi
  local said=0 pid
  until mkdir "$TEST_TURN_LOCK" 2>/dev/null; do
    pid=$(cat "$TEST_TURN_LOCK/pid" 2>/dev/null)
    case $pid in
      '' | *[!0-9]*) ;;
      *)
        if ! ps -p "$pid" >/dev/null 2>&1 && take_over_test_turn "$pid"; then
          echo "The test run that held the turn (pid $pid) is gone without giving it back; taking the turn over." >&2
          export AI_MANAGER_TEST_TURN=held
          return 0
        fi
        ;;
    esac
    if [ -n "$(find "$TEST_TURN_LOCK" -maxdepth 0 -mmin +25 2>/dev/null)" ]; then
      echo "The test turn $TEST_TURN_LOCK is older than 25 minutes: the run that took it hangs or has crashed." >&2
      echo "Check that no test run is still going, clear it with: rm -r $TEST_TURN_LOCK  and run this again." >&2
      return 3
    fi
    if [ "$said" = 0 ]; then
      echo "Another test run is in progress ($TEST_TURN_LOCK); waiting for it to finish." >&2
      said=1
    fi
    sleep "${AI_MANAGER_TEST_POLL:-5}"
  done
  echo "$$" > "$TEST_TURN_LOCK/pid"
  export AI_MANAGER_TEST_TURN=held
}

# take_over_test_turn <pid of the dead holder>: put this shell's pid in its place. The `takeover` folder lets one
# waiter at a time try, and the pid is read again under it, so a turn another waiter has just taken over is left alone.
take_over_test_turn() {
  local rc=1
  mkdir "$TEST_TURN_LOCK/takeover" 2>/dev/null || return 1
  if [ "$(cat "$TEST_TURN_LOCK/pid" 2>/dev/null)" = "$1" ]; then
    echo "$$" > "$TEST_TURN_LOCK/pid.$$" && mv "$TEST_TURN_LOCK/pid.$$" "$TEST_TURN_LOCK/pid" && rc=0
  fi
  rmdir "$TEST_TURN_LOCK/takeover"
  return "$rc"
}

release_test_turn() {
  [ "$(cat "$TEST_TURN_LOCK/pid" 2>/dev/null)" = "$$" ] || return 0
  rm "$TEST_TURN_LOCK/pid"
  # A waiter may be looking at the folder for a moment (its `takeover` try): one more try covers that.
  rmdir "$TEST_TURN_LOCK" 2>/dev/null || { sleep 0.2; rmdir "$TEST_TURN_LOCK" 2>/dev/null; }
  return 0
}
