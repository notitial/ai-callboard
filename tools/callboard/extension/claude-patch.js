'use strict'
// Whether the Claude Code extension in `dir` carries the folder patch of tools/callboard/patch-claude.py: the marker it writes is there, the
// sha256 it records is that of the extension.js beside it (so a restored or replaced file, or a marker left behind, counts as unpatched), and its
// `cwd` field does not say the folder patch was left out (a marker without the field is from a script that always put it in).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function cwdPatched(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'callboard-cwd-patch.json'), 'utf8'))
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'extension.js'))).digest('hex')
    return !!m && m.patch === 1 && m.patched_sha256 === sha && m.cwd !== false
  } catch {
    return false
  }
}

// Whether the installed Claude Code extension (vscode.extensions) carries the patch. Anything that goes wrong, a missing extension included, means no.
function claudePatched(extensions) {
  try {
    const claude = extensions.getExtension('anthropic.claude-code')
    return !!claude && cwdPatched(claude.extensionPath)
  } catch {
    return false
  }
}

module.exports = { cwdPatched, claudePatched }
