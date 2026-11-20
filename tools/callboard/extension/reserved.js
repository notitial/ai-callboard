'use strict'
// Rules the extension's files share: the session id and lane name grammars, the pid check and reserved lane names.
// Reserved lane names, matched by skeleton: upper case, no - or _, no trailing digits, look-alike digits read as letters (1 is I or L).
// MANAGER_, MANAGER-2 and MANAG3R are reserved. The built-in list only: the extension does not read the names a machine reserves with
// /callboard reserve.
const RESERVED = ['MANAGER']

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

// Whether a process answers a signal 0 (one owned by another user answers EPERM, and is alive).
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!err && err.code === 'EPERM'
  }
}

const FOLD = { L: 'I', 1: 'I', 0: 'O', 5: 'S', 3: 'E', 4: 'A', 8: 'B', 7: 'T', 6: 'G', 9: 'G', 2: 'Z' }
function skeletons(name) {
  const base = String(name).toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').toUpperCase().replace(/[-_]/g, '')
  const out = new Set()
  for (const v of [base, base.replace(/[0-9]+$/, '')]) out.add(v.replace(/[L0-9]/g, (ch) => FOLD[ch] ?? ch))
  return [...out]
}

const RESERVED_SKELETONS = RESERVED.flatMap(skeletons)
function reservedHit(name) {
  return RESERVED.includes(String(name).toUpperCase()) || skeletons(name).some((k) => RESERVED_SKELETONS.includes(k))
}

module.exports = { reservedHit, SID_RE, NAME_RE, pidAlive }
