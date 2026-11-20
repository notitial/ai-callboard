import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, as, peer, tiers } from '../../test/fake.ts'
import type { Ask } from '../core/model.ts'
import { T } from '../texts.ts'
import { permissionRequest, toolCheck } from './ask-hook.ts'
import { mem } from './mem.ts'
import { relayTick } from './relay.ts'
import { askOpen, getView, readAnswer, readAskLog, readAsks, rmAsk, writeAsk, writeUp } from './store.ts'
import { promptAnswerCall } from './tools-ask.ts'

type F = ReturnType<typeof tiers>
const noop = Object.assign(async () => ({}), { signal: undefined })
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
const tickRelay = (g: ReturnType<typeof peer>) => as(async () => relayTick(g.$, 'sid-boss', await getView(g.$, true), g.h.now))
const mk = (id: string, over: Partial<Ask> = {}): Ask => ({ id, asker: 'sid-me', t0: T0 - 60_000, awake: 60_000, tool: 'Bash', raisedBy: 'unknown', input: '{"command":"make"}', cut: false, beat: T0, ...over })
const logRows = (f: F, event: string): string[] => (f.h.files.get(`${V2}/log/sid-boss.jsonl`) ?? '').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).filter((r) => r.event === event).map((r) => r.reason)
const reach = async (f: F, id: string) => {
  await writeUp(f.$, id, 'sid-lead', 'escalated', T0)
  await writeUp(f.$, id, 'sid-boss', 'escalated', T0)
}
const window = (f: F) => f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0, end: T0 + 8 * 60 * MIN, readAt: T0 }))

test('by day an ask escalated past the manager shows one pop-up in the manager\'s session, and his Allow there applies to that ask only', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  boss.h.askAnswer = async () => 'Allow'
  const out: Record<string, any> = {}
  f.h.onSleep = async () => {
    if (out.done || f.h.now - T0 < 40_000) return
    out.done = true
    const id = (await readAsks(f.$)).asks[0]!.id
    await as(() => promptAnswerCall(lead.$, { id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
    await tickRelay(boss)
    await settle()
  }
  assert.deepEqual(await permissionRequest(f.$, { tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1' }, noop), { decision: { behavior: 'allow' } })
  assert.equal(boss.h.asked.length, 1)
  assert.equal(boss.h.asked[0]!.header, 'Your call')
  assert.deepEqual(boss.h.asked[0]!.options, ['Allow', 'Deny'])
  const last = (await readAskLog(f.$, 0))!.at(-1)!
  assert.deepEqual([last.ev, last.by], ['answered', 'PERSON'])
})
test('while unattended no pop-up opens: an ask that reached the person waits for a reply and closes only at 15 minutes', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  window(f)
  const out: Record<string, any> = {}
  f.h.onSleep = async () => {
    if (out.done || f.h.now - T0 < 40_000) return
    out.done = true
    const id = (await readAsks(f.$)).asks[0]!.id
    await as(() => promptAnswerCall(lead.$, { id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
    await tickRelay(boss)
    await settle()
  }
  const r: any = await permissionRequest(f.$, { tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1' }, noop)
  assert.match(r.decision.message, /^\[callboard\] Expired/)
  assert.equal(boss.h.asked.length, 0)
  assert.equal((await readAskLog(f.$, 0))!.at(-1)!.ev, 'expired')
})
test('a pop-up clicked after its ask closed writes nothing and says so, and the next ask\'s pop-up does not stack on an open one', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const [a, b] = ['aa11bb22cc', 'dd33ee44ff']
  for (const id of [a, b]) (await writeAsk(f.$, mk(id)), await reach(f, id))
  let click: (l: string) => void = () => undefined
  boss.h.askAnswer = () => new Promise((r) => (click = r))
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
  await rmAsk(f.$, a)
  click('Allow')
  await settle()
  assert.equal(await readAnswer(f.$, a), undefined)
  assert.deepEqual(boss.h.toasts, ['That ask is closed; your click wrote nothing.'])
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 2)
})
test('a pop-up whose ask closed elsewhere is named once in a toast while it stays on screen', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = () => new Promise(() => undefined)
  await tickRelay(boss)
  await settle()
  await tickRelay(boss)
  assert.deepEqual(boss.h.toasts, [], 'an open ask is not named')
  await rmAsk(f.$, 'aa11bb22cc')
  await tickRelay(boss)
  assert.deepEqual(boss.h.toasts, [], 'the ask hook closes the pop-up first')
  boss.h.now += 10_000
  await tickRelay(boss)
  await tickRelay(boss)
  assert.equal(boss.h.toasts.length, 1)
  assert.match(boss.h.toasts[0]!, /^The pop-up for .+'s ask is out of date/)
  assert.deepEqual(boss.h.notices, [], 'no call id was seen for the pop-up, so there is nothing to put a line under')
  assert.deepEqual(logRows(f, 'relay-stale'), ['no-call-id:aa11bb22cc', 'toast:aa11bb22cc'])
})
test('a pop-up whose call tool.check saw gets a line under it as soon as its ask is seen closed, then the toast', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = () => new Promise(() => undefined)
  await tickRelay(boss)
  await settle()
  const [first, second] = [boss.h.asked[0]!, 'u9']
  const input = { questions: [{ header: first.header, question: first.question, options: first.options.map((label) => ({ label, description: '' })), multiSelect: false }] }
  await as(() => toolCheck(boss.$, { tool: 'AskUserQuestion', input, tool_use_id: second, approver: 'person' }, async () => ({ decision: 'ask' })))
  assert.equal(mem.shown?.tid, second)
  await tickRelay(boss)
  assert.deepEqual(boss.h.notices, [], 'an open ask gets no line')
  await rmAsk(f.$, 'aa11bb22cc')
  await tickRelay(boss)
  await tickRelay(boss)
  assert.deepEqual(boss.h.notices, [[second, T['notice.askDecided']({})]])
  assert.deepEqual(boss.h.toasts, [])
  boss.h.now += 10_000
  await tickRelay(boss)
  assert.equal(boss.h.toasts.length, 1)
  assert.deepEqual(logRows(f, 'relay-stale'), ['notice:aa11bb22cc', 'toast:aa11bb22cc'])
})
test('a single question is relayed as a step: header and question, the numbered list only with a description, and his pick lands as that option', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const question = { header: 'H', question: 'Which?', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }
  await writeAsk(f.$, mk('aa11bb22cc', { tool: 'AskUserQuestion', input: '{"questions":[]}', question }))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = async () => 'B'
  await tickRelay(boss)
  await settle()
  assert.deepEqual(boss.h.asked.map((a) => [a.header, a.options]), [['Your call', ['A', 'B', 'Deny']]])
  assert.match(boss.h.asked[0]!.question, /^`.+` asks H:\n\nWhich\?$/)
  const a = await readAnswer(f.$, 'aa11bb22cc')
  assert.deepEqual([a?.by, a?.decision, a?.option], ['PERSON', 'answer', 2])
  const g = tiers()
  const boss2 = peer(g, 'sid-boss')
  g.h.sleepMoves = false
  await writeAsk(g.$, mk('dd11ee22ff', { tool: 'AskUserQuestion', input: '{}', question: { ...question, options: [{ label: 'A', description: 'why' }, { label: 'B', description: '' }] } }))
  await reach(g, 'dd11ee22ff')
  boss2.h.askAnswer = async () => 'Deny'
  await tickRelay(boss2)
  await settle()
  assert.match(boss2.h.asked[0]!.question, /\n\n1\. A - why\n2\. B$/)
  assert.equal((await readAnswer(g.$, 'dd11ee22ff'))?.decision, 'deny')
})
test('the ask hook closes the relay pop-up once its ask is closed, and leaves it while the ask is open', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  let click: (l: string) => void = () => undefined
  boss.h.askAnswer = () => new Promise((r) => (click = r))
  await tickRelay(boss)
  await settle()
  const own = (o: { header: string; question: string }) => ({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: o.header, question: o.question, options: [{ label: 'Allow' }, { label: 'Deny' }] }] }, tool_use_id: 'u1' })
  const shown = own(boss.h.asked[0]!)
  boss.h.sleepFails = true
  assert.deepEqual(await as(() => permissionRequest(boss.$, shown, noop)), {}, 'an open ask leaves the pop-up (the polls here fail, so the hook gives up)')
  boss.h.sleepFails = false
  await rmAsk(f.$, 'aa11bb22cc')
  const r: any = await as(() => permissionRequest(boss.$, shown, noop))
  assert.equal(r.decision.behavior, 'deny')
  assert.deepEqual(logRows(f, 'relay-hook'), ['start:aa11bb22cc', 'gave-up:aa11bb22cc', 'start:aa11bb22cc', 'denied:aa11bb22cc'])
  click('Allow')
})
test('a failure inside the pop-up close leaves the dialog to the person, as the loop does when it gives up', async () => {
  const boss = peer(tiers(), 'sid-boss')
  const own = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: T['dialog.relay.header']({}), question: 'q', options: [{ label: 'Allow' }] }] }, tool_use_id: 'u1' }
  mem.dialogs.add(`${own.tool_input.questions[0]!.header}\nq`)
  Object.defineProperty(mem, 'shown', { configurable: true, get: () => { throw new Error('read failed') } })
  try {
    assert.deepEqual(await as(() => permissionRequest(boss.$, own, async () => ({ beneath: true }))), {})
  } finally {
    Object.defineProperty(mem, 'shown', { configurable: true, writable: true, value: undefined })
    mem.dialogs.clear()
  }
})
test('a call of several questions is relayed as one pop-up each, one combined answer lands, and it reaches the asker with the plugin\'s note on every answer', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  const q = (question: string, labels: string[]) => ({ header: 'H', question, multiSelect: false, options: labels.map((label) => ({ label, description: 'd' })) })
  const input = { questions: [q('Which?', ['Yes', 'No']), q('Where?', ['Here', 'There', 'Nowhere'])] }
  boss.h.askAnswer = async (text: string) => (text.includes('(1 of 2)') ? 'No' : 'There')
  const out: Record<string, any> = {}
  f.h.onSleep = async () => {
    if (out.done || f.h.now - T0 < 40_000) return
    out.done = true
    const id = (await readAsks(f.$)).asks[0]!.id
    assert.equal((await readAsks(f.$)).asks[0]!.questions?.length, 2)
    await as(() => promptAnswerCall(lead.$, { id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
  }
  const r: any = await permissionRequest(f.$, { tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: 't1' }, noop)
  assert.equal(boss.h.asked.length, 2)
  assert.deepEqual(boss.h.asked.map((a) => a.options), [['Yes', 'No', 'Deny'], ['Here', 'There', 'Nowhere', 'Deny']])
  assert.match(boss.h.asked[0]!.question, /1\. Yes - d/, 'the option descriptions are shown')
  assert.equal(r.decision.behavior, 'allow')
  assert.deepEqual(Object.keys(r.decision.updatedInput.answers), ['Which?', 'Where?'])
  assert.match(r.decision.updatedInput.answers['Which?'], /^No \(chosen by the person/)
  assert.match(r.decision.updatedInput.answers['Where?'], /^There \(chosen by the person/)
  const last = (await readAskLog(f.$, 0))!.at(-1)!
  assert.deepEqual([last.ev, last.by], ['answered', 'PERSON'])
})
test('a step of several that is cut offers Deny only', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const q = (question: string) => ({ header: 'H', question, options: [{ label: 'A' }, { label: 'B' }] })
  await writeAsk(f.$, mk('dd11ee22ff', { tool: 'AskUserQuestion', input: '{}', questions: [q('One?'), q('x'.repeat(5000))] }))
  await reach(f, 'dd11ee22ff')
  boss.h.askAnswer = async (text: string) => (text.includes('(2 of 2)') ? 'Deny' : 'A')
  await tickRelay(boss)
  await settle()
  assert.deepEqual(boss.h.asked.map((a) => a.options), [['A', 'B', 'Deny'], ['Deny']], 'the cut step cannot be answered, only denied')
  assert.equal((await readAnswer(f.$, 'dd11ee22ff'))?.decision, 'deny')
})
test('with the guard missing at the last click of several, the picks are not written, the guard is named, and the ask is offered again', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const q = (question: string) => ({ header: 'H', question, options: [{ label: 'A' }, { label: 'B' }] })
  await writeAsk(f.$, mk('aa11bb22cc', { tool: 'AskUserQuestion', input: '{}', questions: [q('One?'), q('Two?')] }))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = async (text: string) => {
    if (text.includes('(2 of 2)')) {
      f.h.files.delete(`${HOME}/.claude/callboard/.protected-checkout`)
      mem.guard = undefined
    }
    return 'A'
  }
  await tickRelay(boss)
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  assert.match(boss.h.toasts[0]!, /guard/)
  f.h.files.set(`${HOME}/.claude/callboard/.protected-checkout`, '')
  mem.guard = undefined
  boss.h.asked.length = 0
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 2, 'the ask is offered again, from its first question')
})
test('leaving one pop-up of several writes no answer and the ask is not offered again', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const q = (question: string) => ({ header: 'H', question, options: [{ label: 'A' }, { label: 'B' }] })
  await writeAsk(f.$, mk('aa11bb22cc', { tool: 'AskUserQuestion', input: '{}', questions: [q('One?'), q('Two?')] }))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = async () => { throw new Error('dismissed') }
  await tickRelay(boss)
  await settle()
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
})
test('his own click on a pop-up names nothing out of date, even when it lands while the tick reads the ask', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  let click: (l: string) => void = () => undefined
  boss.h.askAnswer = () => new Promise((r) => (click = r))
  await tickRelay(boss)
  await settle()
  const list = boss.$.fs.list
  let release: () => void = () => undefined
  boss.$.fs.list = async (d: string) => {
    if (!d.endsWith('/asks')) return list(d)
    boss.$.fs.list = list
    await new Promise<void>((r) => (release = r))
    return list(d)
  }
  const t = tickRelay(boss)
  await settle()
  click('Allow')
  for (let i = 0; i < 20 && (await readAnswer(f.$, 'aa11bb22cc')) === undefined; i++) await settle()
  release()
  await t
  await tickRelay(boss)
  assert.equal((await readAnswer(f.$, 'aa11bb22cc'))?.by, 'PERSON')
  assert.deepEqual(boss.h.toasts, [])
})
test('the OFF file and a busy manager open no pop-up', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  f.h.files.set(`${HOME}/.claude/callboard/OFF`, '')
  await tickRelay(boss)
  f.h.files.delete(`${HOME}/.claude/callboard/OFF`)
  boss.h.draft = 'half a sentence'
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 0)
  boss.h.draft = ''
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
})
test('with the guard missing no pop-up opens, and a click that finds it missing says so and leaves the ask to be offered again', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  let click: (l: string) => void = () => undefined
  boss.h.askAnswer = () => new Promise((r) => (click = r))
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
  f.h.files.delete(`${HOME}/.claude/callboard/.protected-checkout`)
  mem.guard = undefined
  click('Allow')
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  assert.match(boss.h.toasts[0]!, /guard/)
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
  f.h.files.set(`${HOME}/.claude/callboard/.protected-checkout`, '')
  mem.guard = undefined
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 2)
})
test('a Deny on a pop-up of several writes the person\'s deny at once, and a cut call offers Deny only', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const q = (question: string) => ({ header: 'H', question, options: [{ label: 'A' }, { label: 'B' }] })
  await writeAsk(f.$, mk('aa11bb22cc', { tool: 'AskUserQuestion', input: '{}', questions: [q('One?'), q('Two?')] }))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = async () => 'Deny'
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.asked.length, 1)
  assert.deepEqual(boss.h.asked[0]!.options, ['A', 'B', 'Deny'])
  assert.equal((await readAnswer(f.$, 'aa11bb22cc'))?.decision, 'deny')
  await writeAsk(f.$, mk('dd11ee22ff', { tool: 'AskUserQuestion', input: '{}', cut: true, questions: [q('One?'), q('Two?')] }))
  await reach(f, 'dd11ee22ff')
  boss.h.askAnswer = async () => 'A'
  await tickRelay(boss)
  await settle()
  assert.deepEqual(boss.h.asked.at(-1)!.options, ['Deny'], 'a call not shown whole cannot be answered, only denied')
})
test('a folder that cannot be listed leaves the pop-up open: the read failed, the ask did not close', async () => {
  const f = tiers()
  await writeAsk(f.$, mk('aa11bb22cc'))
  assert.equal(await askOpen(f.$, 'aa11bb22cc'), true)
  assert.equal(await askOpen(f.$, 'ee11ff22aa'), false)
  const broken = { ...f.$, fs: { ...f.$.fs, list: () => Promise.reject(new Error('x')) } }
  assert.equal(await askOpen(broken, 'ee11ff22aa'), true)
})
