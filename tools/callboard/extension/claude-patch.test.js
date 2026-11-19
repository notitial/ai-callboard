'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { cwdPatched } = require('./claude-patch.js')

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
// A Claude extension folder as patch-claude.py leaves it: extension.js and the marker that records its sha256.
function folder({ js = 'patched code', marker = { patch: 1, version: '2.1.328', original_sha256: sha('original'), patched_sha256: sha(js) } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-claude-'))
  fs.writeFileSync(path.join(dir, 'extension.js'), js)
  if (marker !== false) fs.writeFileSync(path.join(dir, 'callboard-cwd-patch.json'), typeof marker === 'string' ? marker : JSON.stringify(marker))
  return dir
}

test('the marker with the sha of the file beside it means patched', () => {
  assert.equal(cwdPatched(folder()), true)
})

test('no marker, a file that no longer matches it, another patch number, or a marker that is not JSON mean unpatched', () => {
  assert.equal(cwdPatched(folder({ marker: false })), false)
  const d = folder()
  fs.writeFileSync(path.join(d, 'extension.js'), 'original')
  assert.equal(cwdPatched(d), false)
  assert.equal(cwdPatched(folder({ marker: { patch: 2, patched_sha256: sha('patched code') } })), false)
  assert.equal(cwdPatched(folder({ marker: 'not json' })), false)
  assert.equal(cwdPatched(folder({ marker: 'null' })), false)
})

test('a missing folder or file is unpatched, never an error', () => {
  assert.equal(cwdPatched(path.join(os.tmpdir(), 'cb-claude-none')), false)
  const d = folder()
  fs.unlinkSync(path.join(d, 'extension.js'))
  assert.equal(cwdPatched(d), false)
})
