'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildId } = require('./build.js')

const SHA = '0123456789abcdef0123456789abcdef01234567'

// A checkout shaped like the real one: <root>/.git and <root>/tools/callboard/extension.
function checkout(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-build-'))
  const ext = path.join(root, 'tools', 'callboard', 'extension')
  fs.mkdirSync(ext, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, '.git', name)), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', name), text)
  }
  return ext
}

test('a branch shows its commit and name', () => {
  assert.equal(buildId(checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${SHA}\n` })), '0123456789ab (main)')
})

test('a branch that only packed-refs lists is found there', () => {
  const packed = `# pack-refs\n${'f'.repeat(40)} refs/heads/other\n${SHA} refs/heads/feat/x\n`
  assert.equal(buildId(checkout({ HEAD: 'ref: refs/heads/feat/x\n', 'packed-refs': packed })), '0123456789ab (feat/x)')
})

test('a detached HEAD shows the commit alone', () => {
  assert.equal(buildId(checkout({ HEAD: `${SHA}\n` })), '0123456789ab')
})

test('anything that cannot be told is unknown', () => {
  assert.equal(buildId(checkout({})), 'unknown')
  assert.equal(buildId(checkout({ HEAD: 'ref: refs/heads/gone\n' })), 'unknown')
  assert.equal(buildId(checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': 'not a sha\n' })), 'unknown')
  assert.equal(buildId(checkout({ HEAD: 'ref: refs/heads/../../x\n', x: `${SHA}\n` })), 'unknown')
  assert.equal(buildId(path.join(os.tmpdir(), 'cb-build-nowhere', 'a', 'b', 'c')), 'unknown')
})
