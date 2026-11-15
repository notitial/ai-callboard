'use strict'
// Which build of the extension is running: the commit the checkout it was loaded from stood on. The extension's version is fixed, so this is how a person tells
// whether a window has loaded the code a pull brought. Kept apart from extension.js, which needs VS Code, so it can be tested.
const fs = require('node:fs')
const path = require('node:path')

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

// `<short commit> (<branch>)` read from the checkout's .git as plain files, with no git call: HEAD, then the branch's ref file or packed-refs. A detached HEAD
// shows the commit alone. `unknown` where the checkout can't be told (not a checkout, a worktree, an unreadable or odd HEAD).
function buildId(extensionDir) {
  const gitDir = path.join(extensionDir, '..', '..', '..', '.git')
  const head = (read(path.join(gitDir, 'HEAD')) || '').trim()
  // Each name segment starts with a letter, digit or underscore, so `.` and `..` never match.
  const ref = /^ref: (refs\/heads\/[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*)$/.exec(head)
  let sha = head
  if (ref) {
    sha = (read(path.join(gitDir, ref[1])) || '').trim()
    if (!sha) {
      const line = (read(path.join(gitDir, 'packed-refs')) || '').split('\n').find((l) => l.endsWith(` ${ref[1]}`))
      sha = line ? line.split(' ')[0] : ''
    }
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) return 'unknown'
  return ref ? `${sha.slice(0, 12)} (${ref[1].slice('refs/heads/'.length)})` : sha.slice(0, 12)
}

module.exports = { buildId }
