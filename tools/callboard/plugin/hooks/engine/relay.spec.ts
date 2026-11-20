import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, as, peer, tiers } from '../../test/fake.ts'
import type { Ask } from '../core/model.ts'
import { permissionRequest } from './ask-hook.ts'
import { mem } from './mem.ts'
import { relayTick } from './relay.ts'
import { getView, readAnswer, readAskLog, readAsks, rmAsk, writeAsk, writeUp } from './store.ts'
import { promptAnswerCall } from './tools-ask.ts'

type F = ReturnType<typeof tiers>
const noop = Object.assign(async () => ({}), { signal: undefined })
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
const tickRelay = (g: ReturnType<typeof peer>) => as(async () => relayTick(g.$, 'sid-boss', await getView(g.$, true), g.h.now))
const mk = (id: string, over: Partial<Ask> = {}): Ask => ({ id, asker: 'sid-me', t0: T0 - 60_000, awake: 60_000, tool: 'Bash', raisedBy: 'unknown', input: '{"command":"make"}', cut: false, beat: T0, ...over })
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
  await tickRelay(boss)
  assert.equal(boss.h.toasts.length, 1)
  assert.match(boss.h.toasts[0]!, /^The pop-up for .+'s ask is out of date/)
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
