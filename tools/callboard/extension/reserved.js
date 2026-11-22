'use strict'
// Rules the extension's files share: the session id grammar, the tab label a close request names, and the pid check.
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A close request names the tab by its label, the name of any session (spaces allowed). Claude Code cuts a label over 25 characters, so a longer one matches no tab.
const LABEL_RE = /^[^\u0000-\u001f\u007f-\u009f]{1,25}$/

// Whether a process answers a signal 0 (one owned by another user answers EPERM, and is alive).
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!err && err.code === 'EPERM'
  }
}

module.exports = { SID_RE, LABEL_RE, pidAlive }
