import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CUE_VERBS, STOP_VERBS, TOOLS } from './core/model.ts'
import { TOOL_SCHEMAS } from './tool-schemas.ts'

test('the tool list and the schemas name the same 19 tools, the six lane verbs are among them, and thirteen are for a lead or the manager', () => {
  assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), [...TOOLS].sort())
  assert.equal(TOOLS.length, 19)
  for (const verb of [...CUE_VERBS, ...STOP_VERBS]) assert.ok((TOOLS as readonly string[]).includes(`lane_${verb}`), `lane_${verb} is not a tool`)
  assert.equal(Object.values(TOOL_SCHEMAS).filter((t) => t.cap === 'parent').length, 13)
})
