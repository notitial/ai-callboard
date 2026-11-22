'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { showClaudeView, VIEW, FOCUS, AGAIN_MS } = require('./claude-view.js')

// A fake VS Code: `log` records the activation, every command and every wait, in order. `failing` is a command that throws.
function world({ installed = true, failing, activateFails = false } = {}) {
  const log = []
  const vscode = {
    extensions: { getExtension: (id) => (installed && id === 'anthropic.claude-code' ? { activate: async () => { if (activateFails) throw new Error('boom'); log.push('activate') } } : undefined) },
    commands: { executeCommand: async (cmd) => { if (cmd === failing) throw new Error('boom'); log.push(cmd) } },
  }
  return { log, run: () => showClaudeView({ vscode, sleep: async (ms) => { log.push(ms) } }) }
}

test('after Claude activates the view is shown and the editor focused, and once more after a wait', async () => {
  const w = world()
  await w.run()
  assert.deepEqual(w.log, ['activate', VIEW, FOCUS, AGAIN_MS, VIEW, FOCUS])
})

test('without the Claude extension nothing is run', async () => {
  const w = world({ installed: false })
  await w.run()
  assert.deepEqual(w.log, [])
})

test('a failing activation or command is silent and ends it', async () => {
  const a = world({ activateFails: true })
  await a.run()
  assert.deepEqual(a.log, [])
  const v = world({ failing: VIEW })
  await v.run()
  assert.deepEqual(v.log, ['activate'])
  const f = world({ failing: FOCUS })
  await f.run()
  assert.deepEqual(f.log, ['activate', VIEW])
})
