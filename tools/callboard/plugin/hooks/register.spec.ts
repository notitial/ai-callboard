import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SELF_TEST } from './engine/ask-hook.ts'
import { register } from './register.ts'

test('the relay\'s tool.run hook is matched on the flat fields of that event: Bash with the relayed description, and no other run', () => {
  const hooks: { ev: string; m: unknown }[] = []
  register(((ev: string, m: unknown) => (hooks.push({ ev, m }), { catch: () => undefined })) as any)
  const runs = hooks.filter((h) => h.ev === 'tool.run')
  assert.equal(runs.length, 1)
  const m = runs[0]!.m as Record<string, unknown>
  assert.deepEqual(Object.keys(m).sort(), ['description', 'tool'], 'top-level keys of the flat event, never a nested input')
  // A field matches its string as written, or a pattern its string value, as the engine matches a tool.run event.
  const hit = (e: Record<string, unknown>) => Object.entries(m).every(([k, v]) => (v instanceof RegExp ? typeof e[k] === 'string' && v.test(e[k] as string) : e[k] === v))
  assert.equal(hit({ tool: 'Bash', command: 'make', description: 'Relayed from lane: Build it' }), true)
  assert.equal(hit({ tool: 'Bash', ...SELF_TEST }), true)
  assert.equal(hit({ tool: 'Bash', command: 'make', description: 'Build it' }), false)
  assert.equal(hit({ tool: 'Bash', command: 'make' }), false)
  assert.equal(hit({ tool: 'Bash', input: { command: 'make', description: 'Relayed from lane' } }), false)
  assert.equal(hit({ tool: 'Read', description: 'Relayed from lane' }), false)
})
