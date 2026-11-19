import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, as, peer, tiers } from '../../test/fake.ts'
import type { Ask } from '../core/model.ts'
import { mem } from './mem.ts'
import { readAnswer, readAsks, writeAsk, writeGo } from './store.ts'
import { postToolHook } from './tick.ts'
import { goRequestCall, goStatusCall, promptAnswerCall, promptListCall, unattendedOffCall } from './tools-ask.ts'

type F = ReturnType<typeof tiers>
type R = { result?: string; deny?: string }
const noop = Object.assign(async () => ({}), { signal: undefined })
const call = (g: ReturnType<typeof peer>, fn: typeof promptListCall, input: object = {}, extra: object = {}) => as(() => fn(g.$, { ...input, ...extra }, noop)) as Promise<R>
const ID = 'ab12cd34ef'
const mk = (over: Partial<Ask> = {}): Ask => ({ id: ID, asker: 'sid-me', t0: T0 - 40_000, awake: 40_000, window: null, personOnly: false, tool: 'Bash', raisedBy: 'unknown', input: '{"command":"make"}', cut: false, beat: T0, ...over })
const QUESTION = { header: 'Pick', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }
function world(over: Partial<Ask> = {}) {
  const f = tiers()
  f.h.sleepMoves = false
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  return { f, lead, boss, put: () => writeAsk(f.$, mk(over)) }
}

test('prompt_list: the manager gets its rules file first, a lead only its asks, and a session with no capability, a subagent or an off session is refused', async () => {
  const { f, lead, boss, put } = world({ t0: T0 - 6 * MIN, awake: 6 * MIN })
  const stranger = peer(f, 'sid-x')
  f.seed({ sid: 'sid-x', pid: 13, name: 'x', kind: 'interactive' })
  f.h.files.set(`${HOME}/.claude/callboard/manager-rules.md`, 'Never allow a merge.')
  await put()
  const m = (await call(boss, promptListCall)).result!
  assert.ok(m.startsWith("**The person's standing rules**"))
  assert.match(m, /Never allow a merge\.[\s\S]*Ask ab12cd34ef/)
  const l = (await call(lead, promptListCall)).result!
  assert.ok(l.startsWith('**Ask ab12cd34ef**'))
  assert.match((await call(stranger, promptListCall)).deny!, /lead or the manager/)
  assert.match((await call(lead, promptListCall, {}, { agentId: 'sub1' })).deny!, /input is not valid/)
  f.table({ 'sid-lead': { name: 'lead', folder: '/w/lead', lead: { repos: [] }, off: true } })
  mem.view = undefined
  assert.match((await call(lead, promptListCall)).deny!, /off/)
})
test('prompt_answer: the author is the caller\'s own id whatever the input says, and the first answer wins', async () => {
  const { f, lead, boss, put } = world()
  await put()
  const first = await call(lead, promptAnswerCall, { id: ID, decision: 'allow' }, { by: 'sid-boss', agentId: undefined })
  assert.match(first.result!, /allowed/)
  assert.equal((await readAnswer(f.$, ID))!.by, 'sid-lead')
  const second = await call(lead, promptAnswerCall, { id: ID, decision: 'deny' })
  assert.match(second.deny!, /closed/)
  assert.equal((await readAnswer(f.$, ID))!.decision, 'allow')
  void boss
})
test('prompt_answer: eligibility is checked at the write, not at the list; an input not shown whole cannot be allowed; a bad id and a bad option are refused', async () => {
  const { f, lead, boss, put } = world()
  await put()
  const other = peer(f, 'sid-x')
  f.seed({ sid: 'sid-x', pid: 13, name: 'x', kind: 'interactive' })
  f.table({ 'sid-me': { name: 'lane', folder: '/w/me', under: 'sid-lead' }, 'sid-lead': { name: 'lead', folder: '/w/lead', lead: { repos: [] } }, 'sid-x': { name: 'x', folder: '/w/x', lead: { repos: [] } } })
  mem.view = undefined
  assert.match((await call(other, promptAnswerCall, { id: ID, decision: 'allow' })).deny!, /not.*(eligible|yours)|may not/i)
  assert.match((await call(other, promptAnswerCall, { id: ID, decision: 'escalate' })).deny!, /not.*(eligible|yours)|may not/i)
  assert.equal(await readAnswer(f.$, ID), undefined)
  assert.match((await call(lead, promptAnswerCall, { id: '../x', decision: 'allow' })).deny!, /no ask|not found|no such/i)
  assert.match((await call(lead, promptAnswerCall, { id: ID, decision: 'nope' })).deny!, /input is not valid/)
  await writeAsk(f.$, mk({ cut: true }))
  assert.match((await call(lead, promptAnswerCall, { id: ID, decision: 'allow' })).deny!, /not shown all/)
  assert.equal(await readAnswer(f.$, ID), undefined)
  assert.match((await call(lead, promptAnswerCall, { id: ID, decision: 'deny', note: 'x'.repeat(1000) })).result!, /denied/)
  assert.equal((await readAnswer(f.$, ID))!.note!.length, 300)
  void boss
})
test('prompt_answer: a question is answered by an option of the live question; an allow or a bad option is refused', async () => {
  const { f, lead, put } = world({ tool: 'AskUserQuestion', input: '{}', question: QUESTION })
  await put()
  assert.ok((await call(lead, promptAnswerCall, { id: ID, decision: 'allow' })).deny)
  assert.ok((await call(lead, promptAnswerCall, { id: ID, decision: 'answer', option: 3 })).deny)
  assert.equal(await readAnswer(f.$, ID), undefined)
  assert.match((await call(lead, promptAnswerCall, { id: ID, decision: 'answer', option: 2 })).result!, /answered/)
  assert.equal((await readAnswer(f.$, ID))!.option, 2)
})
test('an ask already answered is not told again', async () => {
  const { f, lead, boss, put } = world()
  await put()
  await call(lead, promptAnswerCall, { id: ID, decision: 'allow' })
  const said = async (g: typeof lead) => JSON.stringify(await as(() => postToolHook(g.$, { tool_name: 'Read' }, noop)))
  assert.doesNotMatch(await said(lead), /yours to decide/)
  assert.deepEqual((await readAsks(f.$)).answered, new Set([ID]))
})
test('go_request opens one dialog and its Yes writes a go for 24 h; No, a bad text, a window and an open dialog write nothing', async () => {
  const { f, lead } = world()
  const goes = () => [...f.h.files.keys()].filter((k) => k.startsWith(`${V2}/go/`))
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  assert.match((await call(lead, goRequestCall, { text: ' padded ' })).deny!, /go/i)
  lead.h.askAnswer = async () => 'No'
  assert.match((await call(lead, goRequestCall, { text: 'Build the ask tools' })).result!, /go dialog is open/)
  await settle()
  assert.equal(lead.h.asked.length, 1)
  assert.deepEqual(goes(), [])
  lead.h.askAnswer = async () => 'Yes'
  await call(lead, goRequestCall, { text: 'Build the ask tools' })
  await settle()
  const [file] = goes()
  const g = JSON.parse(f.h.files.get(file!)!)
  assert.deepEqual([g.giver, g.text, g.end], ['sid-lead', 'Build the ask tools', T0 + 24 * 60 * MIN])
  mem.dialogs.add('open')
  assert.match((await call(lead, goRequestCall, { text: 'Another go' })).deny!, /go/i)
  mem.dialogs.clear()
  f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0, end: T0 + 60 * MIN, readAt: T0 }))
  mem.win = undefined
  assert.match((await call(lead, goRequestCall, { text: 'Another go' })).deny!, /unattended|window/i)
  assert.equal(lead.h.asked.length, 2)
})
test('go_status reports a go only while the protected-paths guard is in place, and only to the giver and the sessions under it', async () => {
  const { f, lead, boss } = world()
  await writeGo(f.$, { id: 'g0ab12', giver: 'sid-lead', text: 'Build the ask tools', end: T0 + 60 * MIN })
  assert.match((await call(lead, goStatusCall)).result!, /guard/)
  f.h.files.set(`${HOME}/.claude/settings.json`, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'bash ~/guards/protected-paths-guard.sh' }] }] } }))
  mem.guard = undefined
  assert.match((await call(lead, goStatusCall)).result!, /guard/)
  f.h.files.set(`${HOME}/.claude/callboard/.protected-checkout`, '')
  mem.guard = undefined
  assert.match((await call(lead, goStatusCall)).result!, /Build the ask tools/)
  assert.match((await call(boss, goStatusCall)).result!, /No go of the person/)
  const lane = peer(f, 'sid-me')
  assert.match((await call(lane, goStatusCall)).result!, /Build the ask tools/)
  f.h.files.set(`${HOME}/.claude/settings.json`, JSON.stringify({ disableAllHooks: true, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'protected-paths-guard.sh' }] }] } }))
  mem.guard = undefined
  assert.match((await call(lead, goStatusCall)).result!, /guard/)
})
test('unattended_off: only the manager ends the window, and it gets the list back', async () => {
  const { f, lead, boss } = world()
  f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0, end: T0 + 60 * MIN, readAt: T0 }))
  mem.win = undefined
  assert.match((await call(lead, unattendedOffCall)).deny!, /lead or the manager/)
  assert.ok(f.h.files.has(`${V2}/unattended.json`))
  assert.match((await call(boss, unattendedOffCall)).result!, /Unattended mode is off/)
  assert.equal(f.h.files.has(`${V2}/unattended.json`), false)
})
