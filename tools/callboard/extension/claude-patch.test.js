'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { cwdPatched, claudePatched } = require('./claude-patch.js')

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

test('a marker whose cwd field says the folder patch was left out means unpatched; true or no field means patched', () => {
  const marker = (cwd) => ({ patch: 1, original_sha256: sha('original'), patched_sha256: sha('patched code'), ...cwd })
  assert.equal(cwdPatched(folder({ marker: marker({ cwd: false }) })), false, 'the other pieces went in, the folder patch did not')
  assert.equal(cwdPatched(folder({ marker: marker({ cwd: true }) })), true)
  assert.equal(cwdPatched(folder({ marker: marker({}) })), true, 'a marker with no cwd field counts as patched')
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

// What the window reads at start: the Claude extension VS Code loaded. An update is a new folder without the marker, so the patch and its marker leave together.
test('claudePatched: only the loaded Claude extension with a marker that matches its file counts; every other case is unpatched and never throws', () => {
  const ext = (dir) => ({ getExtension: (id) => (id === 'anthropic.claude-code' ? { extensionPath: dir } : undefined) })
  assert.equal(claudePatched(ext(folder())), true)
  assert.equal(claudePatched(ext(folder({ marker: false }))), false, 'an updated extension: a new folder, no marker')
  const replaced = folder()
  fs.writeFileSync(path.join(replaced, 'extension.js'), 'a newer file under the old marker')
  assert.equal(claudePatched(ext(replaced)), false, 'a stale marker never counts')
  assert.equal(claudePatched({ getExtension: () => undefined }), false, 'Claude not installed')
  assert.equal(claudePatched({ getExtension: () => ({}) }), false, 'no path')
  assert.equal(claudePatched({ getExtension: () => { throw new Error('boom') } }), false)
  assert.equal(claudePatched(undefined), false)
})

test('a missing folder or file is unpatched, never an error', () => {
  assert.equal(cwdPatched(path.join(os.tmpdir(), 'cb-claude-none')), false)
  const d = folder()
  fs.unlinkSync(path.join(d, 'extension.js'))
  assert.equal(cwdPatched(d), false)
})
