import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TOOLS } from './core/model.ts'
import { TOOL_SCHEMAS } from './tool-schemas.ts'

test('the tool list, the schemas and register.ts name the same 19 tools; fourteen are for a lead or the manager', () => {
  assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), [...TOOLS].sort())
  assert.equal(TOOLS.length, 19)
  assert.equal(Object.values(TOOL_SCHEMAS).filter((t) => t.cap === 'parent').length, 14)
  const wired = readFileSync(new URL('./register.ts', import.meta.url), 'utf8')
  for (const name of TOOLS) {
    const loop = /^lane_(rename|start|resume|park|retire|terminate)$/.test(name)
    assert.ok(loop || wired.includes(`mcp__callboard__${name}'`), `register.ts does not wire ${name}`)
  }
})
