'use strict'
// Whether the Claude Code extension in `dir` carries the cwd patch of tools/callboard/patch-claude.py: the marker it writes is there, and the
// sha256 it records is that of the extension.js beside it (so a restored or replaced file, or a marker left behind, counts as unpatched).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function cwdPatched(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'callboard-cwd-patch.json'), 'utf8'))
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'extension.js'))).digest('hex')
    return !!m && m.patch === 1 && m.patched_sha256 === sha
  } catch {
    return false
  }
}

module.exports = { cwdPatched }
