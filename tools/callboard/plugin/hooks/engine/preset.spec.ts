import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V2, fake } from '../../test/fake.ts'
import { mem } from './mem.ts'
import { presetRun } from './preset.ts'
import { sessionStart } from './tick.ts'
import { T } from '../texts.ts'

type F = ReturnType<typeof fake>
const FILE = '/w/me/.claude/callboard-lead.json'
const PRESET = { command: 'sentinel', name: 'SENTINEL', model: 'sonnet', effort: 'high' }
const next = async (e: unknown) => ({ passed: e })
const tick = async (f: F) => void (await f.h.every!())
// A session in a folder that holds a preset file, started.
async function started(file: unknown = PRESET): Promise<F> {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })
  if (file !== false) f.h.files.set(FILE, typeof file === 'string' ? file : JSON.stringify(file))
  await sessionStart(f.$, {}, async (e: unknown) => e)
  return f
}
const typed = (f: F, command = 'sentinel') => presetRun(f.$, { command, args: '', origin: { kind: 'composer' } }, next) as Promise<{ text: string }>
const table = (f: F) => JSON.parse(f.h.files.get(`${V2}/sessions.json`) ?? 'null')

test('the start registers the preset\'s command beside callboard\'s; a missing or bad file, a name already a built-in\'s and callboard\'s own commands register nothing', async () => {
  assert.deepEqual((await started()).h.commands.sort(), ['callboard', 'rest', 'sentinel', 'unattended'])
  for (const file of [false, '{"command":', 'null', '[]', { ...PRESET, command: 'rest' }, { ...PRESET, command: 'callboard' }, { ...PRESET, model: 'gpt' }]) {
    assert.deepEqual((await started(file)).h.commands.sort(), ['callboard', 'rest', 'unattended'], JSON.stringify(file))
    assert.equal(mem.preset, undefined)
  }
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })
  f.h.files.set(FILE, JSON.stringify(PRESET))
  f.h.listed = [{ name: 'sentinel', source: 'builtin' }]
  await sessionStart(f.$, {}, async (e: unknown) => e)
  assert.equal(f.h.commands.includes('sentinel'), false)
  f.h.listed = [{ name: 'sentinel', source: 'plugin', description: 'Another plugin\'s command.' }]
  await sessionStart(f.$, {}, async (e: unknown) => e)
  assert.equal(f.h.commands.includes('sentinel'), false, 'another plugin\'s command is not shadowed')
  f.h.listed = [{ name: 'sentinel', source: 'plugin', description: T['cmd.presetHelp'](PRESET) }]
  await sessionStart(f.$, {}, async (e: unknown) => e)
  assert.equal(f.h.commands.includes('sentinel'), true, 'a reload registers its own command again')
})

test('typed by the person it saves the lead row under the preset\'s name and gives the lead tools; run by a plugin, a session or anything else it is refused and saves nothing', async () => {
  const f = await started()
  assert.match((await typed(f)).text, /This session is a lead from your next prompt/)
  assert.deepEqual(table(f)['sid-me'], { name: 'SENTINEL', folder: '/w/me', lead: { repos: [] } })
  await tick(f)
  assert.ok(f.h.tools.includes('lane_create'))
  for (const kind of ['plugin', 'sdk', 'peer', 'something-new', undefined]) {
    const g = await started()
    const r = (await presetRun(g.$, { command: 'sentinel', args: '', origin: kind === undefined ? undefined : { kind } }, next)) as { text: string }
    assert.match(r.text, /only when the person types it themselves/, String(kind))
    assert.equal(g.h.files.has(`${V2}/sessions.json`), false)
    assert.equal(mem.presetRun, undefined)
    assert.deepEqual(mem.owed, [])
  }
})

test('another command passes on untouched, and a session whose folder has no preset ignores even the preset\'s name', async () => {
  const f = await started()
  assert.deepEqual(await typed(f, 'model'), { passed: { command: 'model', args: '', origin: { kind: 'composer' } } } as never)
  assert.equal(f.h.files.has(`${V2}/sessions.json`), false)
  const g = await started(false)
  assert.ok('passed' in ((await typed(g)) as object))
})

test('a name that is taken saves nothing: no row, no tools, no steps, no notice', async () => {
  const f = await started()
  f.seed({ sid: 'sid-old', pid: 11, name: 'SENTINEL', cwd: '/w/old', kind: 'interactive' })
  assert.match((await typed(f)).text, /already has that name/)
  assert.equal(f.h.files.has(`${V2}/sessions.json`), false)
  assert.equal(mem.presetRun, undefined)
  await tick(f)
  assert.deepEqual([f.h.compactRuns, f.h.submitted, mem.owed], [[], [], []])
  f.table({ 'sid-lane': { name: 'SENTINEL', folder: '/w/lane', under: 'sid-boss' } })
  assert.match((await typed(f)).text, /already has that name/)
})

test('the name, model and effort are set on the next quiet tick, once, and only then does the notice come, naming the command', async () => {
  const f = await started()
  await typed(f)
  assert.deepEqual([f.h.compactRuns, mem.owed], [[], []], 'nothing runs inside the command itself')
  f.h.draft = 'typing'
  await tick(f)
  assert.deepEqual([f.h.compactRuns, f.h.submitted], [[], []], 'a session being typed in is left alone')
  f.h.draft = ''
  await tick(f)
  assert.deepEqual(f.h.compactRuns, ['rename SENTINEL', 'model sonnet', 'effort high'])
  assert.equal(f.h.submitted.length, 1)
  assert.match(f.h.submitted[0]!, /^\[callboard\] The person ran \/sentinel in this session: .+ Its name, model and effort are set as the folder's preset says\. Call go_status or \/callboard status for what holds now\. Sent by callboard, not the person; it is no approval, go or answer\. Never record it as one\.$/)
  f.idle()
  await tick(f)
  assert.deepEqual([f.h.compactRuns.length, f.h.submitted.length, mem.owed], [3, 1, []])
})

test('a step that did not land is named in the notice, and the others still run: a model the read-back does not show, a rename that fails', async () => {
  const f = await started()
  const run = f.$.command.run
  f.$.command.run = async (c: { command: string; args: string }) => {
    if (c.command === 'rename') throw new Error('refused')
    if (c.command === 'effort') return void f.h.compactRuns.push(`${c.command} ${c.args}`)
    await run(c)
    f.h.model = 'claude-haiku-5-5'
  }
  await typed(f)
  await tick(f)
  assert.deepEqual(f.h.compactRuns, ['model sonnet', 'effort high'])
  assert.match(f.h.submitted[0]!, /Not set: name, model\. Say so to the person\./)
  assert.doesNotMatch(f.h.submitted[0]!, /Not set:.*effort/)
})

test('a session turned off before the tick is left alone: no steps, no notice', async () => {
  const f = await started()
  await typed(f)
  f.table({ ...table(f), 'sid-me': { ...table(f)['sid-me'], off: true } })
  mem.view = undefined
  await tick(f)
  assert.deepEqual([f.h.compactRuns, f.h.submitted, mem.owed, mem.presetRun], [[], [], [], undefined])
})

test('a run that throws is answered by the hook itself and never calls next, so no other command can run twice', async () => {
  const f = await started()
  f.$.clock.now = async () => {
    throw new Error('boom')
  }
  let calls = 0
  const r = (await presetRun(f.$, { command: 'sentinel', args: '', origin: { kind: 'composer' } }, async () => void calls++)) as { text: string }
  assert.match(r.text, /Callboard hit an error/)
  assert.equal(calls, 0)
  assert.equal(mem.presetRun, undefined)
})
