'use strict'
// Whether a process the session registry names is still the one that wrote the row, the way the plugin checks it: the registry keeps the rows of
// processes that died, and a pid can be reused.
const { execFile } = require('node:child_process')

// Start time of a process as `ps` prints it in UTC, the way the session registry records procStart; undefined when it cannot be read.
function psStart(pid) {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { TZ: 'UTC', LC_ALL: 'C' } }, (err, out) =>
      resolve(err ? undefined : String(out)),
    )
  })
}
const startKey = (s) => (typeof s === 'string' && s.trim() !== '' ? s.trim().replace(/\s+/g, ' ') : undefined)

// The state of a registry row's process, with `alive` (pid answers) and `startOf` (ps start time) injected:
//   'dead'  its pid is not a valid pid, does not answer, or `ps` gave a start time that differs from a recorded one;
//   'live'  its pid answers and `ps` gave the recorded start time;
//   'maybe' its pid answers but nothing proves it is the same process: no start time was recorded, or `ps` failed or timed out.
// starts: a caller's own pid -> start time map (only a start that was read is kept, so a failed `ps` is asked again).
const procStateWith = ({ alive, startOf = psStart }) => async (pid, procStart, starts) => {
  if (!Number.isInteger(pid) || pid < 2 || !alive(pid)) return 'dead'
  const want = startKey(procStart)
  if (want === undefined) return 'maybe'
  let got = starts && starts.get(pid)
  if (got === undefined) {
    got = startKey(await startOf(pid))
    if (got !== undefined && starts) starts.set(pid, got)
  }
  if (got === undefined) return 'maybe'
  return got === want ? 'live' : 'dead'
}

module.exports = { psStart, procStateWith }
