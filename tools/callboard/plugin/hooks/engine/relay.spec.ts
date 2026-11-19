import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, as, peer, tiers } from '../../test/fake.ts'
import type { Ask } from '../core/model.ts'
import { permissionRequest } from './ask-hook.ts'
import { relayTick } from './relay.ts'
import { getView, readAnswer, readAskLog, readAsks, rmAsk, writeAsk, writeUp } from './store.ts'
import { promptAnswerCall } from './tools-ask.ts'

type F = ReturnType<typeof tiers>
const noop = Object.assign(async () => ({}), { signal: undefined })
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
const tickRelay = (g: ReturnType<typeof peer>) => as(async () => relayTick(g.$, 'sid-boss', await getView(g.$, true), g.h.now))
const mk = (id: string, over: Partial<Ask> = {}): Ask => ({ id, asker: 'sid-me', t0: T0 - 60_000, awake: 60_000, window: null, personOnly: false, tool: 'Bash', raisedBy: 'unknown', input: '{"command":"make"}', cut: false, beat: T0, ...over })
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
  assert.equal(boss.h.asked[0]!.header, 'Ask from lane')
  assert.deepEqual(boss.h.asked[0]!.options, ['Allow', 'Deny'])
  const last = (await readAskLog(f.$, 0))!.at(-1)!
  assert.deepEqual([last.ev, last.by], ['answered', 'PERSON'])
})
test('while unattended no pop-up opens and an ask for the person closes at once', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  window(f)
  f.h.onSleep = async () => {
    const id = (await readAsks(f.$)).asks[0]?.id
    if (id === undefined || boss.h.asked.length > 0 || f.h.now - T0 > 10_000) return
    await as(() => promptAnswerCall(lead.$, { id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
  }
  const r: any = await permissionRequest(f.$, { tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1' }, noop)
  assert.match(r.decision.message, /^\[callboard\] Closed: this needs the person/)
  assert.ok(f.h.now - T0 < 20_000)
  assert.equal(boss.h.asked.length, 0)
  assert.equal((await readAskLog(f.$, 0))!.at(-1)!.ev, 'left-for-person')
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
