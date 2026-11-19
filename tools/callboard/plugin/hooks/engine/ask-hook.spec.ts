import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, as, peer, tiers } from '../../test/fake.ts'
import { goDialog, stopDialog } from '../ui.ts'
import { personDialog } from './io.ts'
import { permissionRequest, toolCheck } from './ask-hook.ts'
import { mem, staleView } from './mem.ts'
import { readAskLog, readAsks } from './store.ts'
import { postToolHook, sessionStart } from './tick.ts'
import { promptAnswerCall, promptListCall } from './tools-ask.ts'

type F = ReturnType<typeof tiers>
const nx = (r: unknown = {}) => Object.assign(async () => r, { signal: undefined as AbortSignal | undefined })
const bash = (id = 't1') => ({ tool_name: 'Bash', tool_input: { command: 'make test' }, tool_use_id: id })
const QUESTION = { questions: [{ header: 'Pick', question: 'Which branch?', options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }], multiSelect: false }] }
const ask = (f: F, e: unknown = bash(), n = nx()) => permissionRequest(f.$, e, n) as Promise<any>
const rows = async (f: F) => ((await readAskLog(f.$, 0)) ?? []).map((r) => (r.code === undefined ? r.ev : `${r.ev}:${r.code}`))
const window = (f: F, end = T0 + 8 * 60 * MIN) => f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0, end, readAt: T0 }))
const loose = (f: F) => f.table({})
// Steps that run inside the asker's sleeps once their time has come, in order.
const script = (f: F, steps: [number, () => Promise<unknown>][]) => {
  const todo = [...steps]
  f.h.onSleep = async () => {
    while (todo.length > 0 && f.h.now - T0 >= todo[0]![0]) await todo.shift()![1]()
  }
}
const noop = nx({})
const idOf = async (f: F) => (await readAsks(f.$)).asks[0]!.id
const answer = (g: ReturnType<typeof peer>, input: object) => as(() => promptAnswerCall(g.$, input, noop)) as Promise<{ result?: string; deny?: string }>
const list = async (g: ReturnType<typeof peer>) => ((await as(() => promptListCall(g.$, {}, noop))) as { result?: string; deny?: string })
const patchRow = (f: F, pid: number, patch: object) => f.h.files.set(`${HOME}/.claude/sessions/${pid}.json`, JSON.stringify({ ...JSON.parse(f.h.files.get(`${HOME}/.claude/sessions/${pid}.json`)!), ...patch }))
const events = async (g: ReturnType<typeof peer>) => JSON.stringify(await as(() => postToolHook(g.$, { tool_name: 'Read' }, noop)))

test('a question nobody answers closes at 15 minutes awake with the expired text, and its ask file is gone', async () => {
  const f = tiers()
  const r = await ask(f, { tool_name: 'AskUserQuestion', tool_input: QUESTION, tool_use_id: 't1' })
  assert.equal(r.decision.behavior, 'deny')
  assert.match(r.decision.message, /^\[callboard\] Expired: no one answered this within 15 minutes/)
  assert.ok(f.h.now - T0 >= 15 * MIN && f.h.now - T0 < 15 * MIN + 10_000)
  assert.deepEqual(await rows(f), ['raised:AskUserQuestion', 'expired:AskUserQuestion'])
  assert.deepEqual((await readAsks(f.$)).asks, [])
})
test('a loose session\'s prompt: the manager is told after the head start, nobody answers, and it closes at 15 minutes awake', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  loose(f)
  let told = ''
  script(f, [[40_000, async () => void (told = await events(boss))]])
  const r = await ask(f)
  assert.match(told, /is yours to decide/)
  assert.match(r.decision.message, /Expired/)
  assert.match(await events(boss), /was closed with no decision/)
})
test('a go dialog or a force-stop dialog open in the session is the person\'s alone: its question gets no decision from the hook and no ask', async () => {
  for (const spec of [goDialog('lane', 'finish the tests', '2026-11-20 10:00'), stopDialog('kid', 'terminate')]) {
    const f = tiers()
    f.h.askAnswer = () => new Promise(() => undefined)
    void personDialog(f.$, spec)
    await new Promise((r) => setImmediate(r))
    assert.equal(mem.dialogs.size, 1)
    const q = { questions: [{ header: spec.header, question: spec.question, options: spec.options.map((o) => ({ label: o.label })) }] }
    assert.deepEqual(await ask(f, { tool_name: 'AskUserQuestion', tool_input: q, tool_use_id: 't9' }), {})
    assert.deepEqual(await rows(f), [])
  }
})

test('the lead escalates and the manager owns the ask from then on: the lead\'s own answer is refused, the manager\'s allow lands, and the log says who did what', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  const out: Record<string, any> = {}
  script(f, [[40_000, async () => {
    const id = await idOf(f)
    out.listed = (await list(lead)).result
    out.esc = await answer(lead, { id, decision: 'escalate' })
    out.again = await answer(lead, { id, decision: 'allow' })
    out.boss = (await list(boss)).result
    out.ok = await answer(boss, { id, decision: 'allow' })
  }]])
  assert.deepEqual(await ask(f), { decision: { behavior: 'allow' } })
  assert.match(out.listed, /is yours to decide/)
  assert.match(out.esc.result, /passed up to `BOSS`/)
  assert.equal(out.again.result, undefined)
  assert.match(out.boss, /is yours to decide/)
  assert.match(out.ok.result, /allowed/)
  const log = (await readAskLog(f.$, 0))!
  assert.deepEqual(log.map((r) => r.ev), ['raised', 'told', 'escalated', 'told', 'answered'])
  assert.equal(log.at(-1)!.by, 'sid-boss')
})
test('at 5 minutes awake the manager is reached and the lead, busy compacting, may still decide the ask', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  patchRow(f, 11, { status: 'busy' })
  const out: Record<string, any> = {}
  script(f, [
    [40_000, async () => void (out.early = (await list(lead)).result)],
    [330_000, async () => {
      out.boss = (await list(boss)).result
      out.lead = (await list(lead)).result
      out.ok = await answer(lead, { id: await idOf(f), decision: 'deny', note: 'not now' })
    }],
  ])
  const r = await ask(f)
  assert.match(out.early, /is yours to decide/)
  assert.match(out.boss, /is yours to decide/)
  assert.match(out.lead, /is yours to decide/)
  assert.match(r.decision.message, /Denied by `lead`, not the person: not now/)
})
test('a registry that cannot be read closes nothing, in a window too', async () => {
  const f = tiers()
  loose(f)
  window(f)
  f.h.psFails = true
  const ac = new AbortController()
  script(f, [[240_000, async () => void ac.abort()]])
  assert.deepEqual(await ask(f, bash(), Object.assign(nx(), { signal: ac.signal })), {})
  assert.deepEqual(await rows(f), ['raised:Bash', 'closed:click'])
  assert.ok(f.h.now - T0 >= 240_000)
})
test('an off session is left alone in a window too, and its child\'s ask goes to the manager', async () => {
  const f = tiers()
  f.table({ 'sid-me': { name: 'lane', folder: '/w/me', off: true } })
  window(f)
  assert.deepEqual(await ask(f), {})
  assert.deepEqual(await rows(f), [])
  const g = tiers()
  const [lead, boss] = [peer(g, 'sid-lead'), peer(g, 'sid-boss')]
  g.table({ 'sid-me': { name: 'lane', folder: '/w/me', under: 'sid-lead' }, 'sid-lead': { name: 'lead', folder: '/w/lead', lead: { repos: [] }, off: true } })
  const out: Record<string, any> = {}
  script(g, [[40_000, async () => {
    out.lead = await list(lead)
    out.boss = (await list(boss)).result
    out.ok = await answer(boss, { id: await idOf(g), decision: 'allow' })
  }]])
  assert.deepEqual(await ask(g), { decision: { behavior: 'allow' } })
  assert.match(out.lead.deny ?? '', /off/i)
  assert.match(out.boss, /is yours to decide/)
})
test('the OFF file: no ask is raised while it is there, one running leaves at once, and no tier may answer', async () => {
  const f = tiers()
  const off = `${HOME}/.claude/callboard/OFF`
  const lead = peer(f, 'sid-lead')
  f.h.files.set(off, '')
  window(f)
  assert.deepEqual(await ask(f), {})
  assert.deepEqual(await rows(f), [])
  f.h.files.delete(off)
  const out: Record<string, any> = {}
  script(f, [[50_000, async () => {
    out.id = await idOf(f)
    f.h.files.set(off, '')
    out.lead = await list(lead)
    out.ans = await answer(lead, { id: out.id, decision: 'allow' })
  }]])
  assert.deepEqual(await ask(f), {})
  assert.ok(out.lead.deny && out.ans.deny)
  assert.deepEqual(await rows(f), ['raised:Bash', 'closed:off'])
})
test('a Yes click that fires no signal is seen, by the registry row or by the call\'s end, and no expiry follows', async () => {
  const f = tiers()
  script(f, [[20_000, async () => void patchRow(f, 10, { status: 'busy', waitingFor: undefined })]])
  assert.deepEqual(await ask(f), {})
  assert.deepEqual(await rows(f), ['raised:Bash', 'closed:click'])
  assert.ok(f.h.now - T0 < 30_000)
  const g = tiers()
  await toolCheck(g.$, { tool: 'Bash', input: { command: 'make test' }, tool_use_id: 't1', approver: 'person' }, nx({ decision: 'ask' }))
  script(g, [[20_000, async () => void (await postToolHook(g.$, { tool_name: 'Bash', tool_use_id: 't1' }, noop))]])
  assert.deepEqual(await ask(g), {})
  assert.deepEqual(await rows(g), ['raised:Bash', 'closed:click'])
  const h = tiers()
  await toolCheck(h.$, { tool: 'Bash', input: { command: 'make test' }, tool_use_id: 't1', approver: 'hook' }, nx({ decision: 'ask' }))
  assert.deepEqual(await ask(h), {})
  assert.deepEqual(await rows(h), [])
})
test('the Mac sleeps 10 minutes during an ask: the sweep leaves the live asker\'s file alone and the ask keeps its deadline in awake time', async () => {
  const f = tiers()
  const lead = peer(f, 'sid-lead')
  await as(() => sessionStart(lead.$, {}, noop))
  const tick = () => as(async () => void (await lead.h.every!()))
  script(f, [
    [50_000, async () => void (await tick())],
    [60_000, async () => void ((f.h.now += 10 * MIN), await tick())],
  ])
  const r = await ask(f)
  assert.match(r.decision.message, /Expired/)
  assert.ok(f.h.now - T0 >= 25 * MIN - 60_000, String((f.h.now - T0) / MIN))
  assert.deepEqual(lead.h.toasts.filter((t) => /no process to answer/.test(t)), [])
})

test('a slow hook beneath does not cost the join entry or the start: a Yes click that fires only the call\'s end is still seen', async () => {
  const f = tiers()
  await toolCheck(f.$, { tool: 'Bash', input: { command: 'make test' }, tool_use_id: 't1', approver: 'person' }, nx({ decision: 'ask' }))
  script(f, [[100_000, async () => void (await postToolHook(f.$, { tool_name: 'Bash', tool_use_id: 't1' }, noop))]])
  const slow = Object.assign(async () => ((f.h.now += 70_000), {}), { signal: undefined as AbortSignal | undefined })
  assert.deepEqual(await ask(f, bash(), slow), {})
  assert.deepEqual(await rows(f), ['raised:Bash', 'closed:click'])
})
test('a plan exit and a question with no answer form are asks like any other: a session above decides them', async () => {
  const f = tiers()
  const lead = peer(f, 'sid-lead')
  await toolCheck(f.$, { tool: 'ExitPlanMode', input: { plan: 'x' }, tool_use_id: 't1', approver: 'person' }, nx({ decision: 'passthrough' }))
  script(f, [[40_000, async () => void (await answer(lead, { id: await idOf(f), decision: 'allow' }))]])
  assert.deepEqual(await ask(f, { tool_name: 'ExitPlanMode', tool_input: { plan: 'x' }, tool_use_id: 't1' }), { decision: { behavior: 'allow' } })
  const g = tiers()
  const boss = peer(g, 'sid-lead')
  const bad = { questions: [{ header: 'Pick', question: 'Which?', options: [{ label: 'only' }] }] }
  await toolCheck(g.$, { tool: 'AskUserQuestion', input: bad, tool_use_id: 't2', approver: 'person' }, nx({ decision: 'ask' }))
  script(g, [[40_000, async () => void (await answer(boss, { id: await idOf(g), decision: 'deny', note: 'the person is away' }))]])
  assert.match((await ask(g, { tool_name: 'AskUserQuestion', tool_input: bad, tool_use_id: 't2' })).decision.message, /Denied by .*the person is away/)
})
test('an answer file written by hand for a session that may not decide is dropped, and the ask stays open', async () => {
  const f = tiers()
  script(f, [[40_000, async () => {
    const id = await idOf(f)
    f.h.files.set(`${V2}/asks/${id}.answer`, JSON.stringify({ ask: id, by: 'sid-boss', decision: 'allow', at: f.h.now }))
  }]])
  const r = await ask(f)
  assert.match(r.decision.message, /Expired/)
  assert.deepEqual([...f.h.files.keys()].filter((k) => k.endsWith('.answer')), [])
})
test('a subagent\'s dialog gets the chain beneath, or a deny that sends the call to the main agent only where an ask could rise', async () => {
  const f = tiers()
  const sub = (id: string) => ({ ...bash(id), agentId: 'sub1' })
  const r = await ask(f, sub('t1'))
  assert.match(r.decision.message, /subagent asked/)
  assert.deepEqual(await ask(f, sub('t2'), nx({ decision: { behavior: 'allow' } })), { decision: { behavior: 'allow' } })
  loose(f)
  staleView()
  assert.deepEqual(await ask(f, sub('t3')), {})
  assert.deepEqual(await rows(f), [])
  const g = tiers()
  loose(g)
  window(g)
  assert.match((await ask(g, sub('t4'))).decision.message, /subagent asked/)
})
test('a loop whose waits keep failing ends with the dialog left to the person, and one that throws ends its ask file too', async () => {
  const f = tiers()
  f.h.sleepFails = true
  assert.deepEqual(await ask(f), {})
  assert.deepEqual(await rows(f), ['raised:Bash', 'closed:hook-failed'])
  assert.deepEqual((await readAsks(f.$)).asks, [])
})
test('without the protected-paths guard an answer file is dropped: the ask stays with the person', async () => {
  const f = tiers()
  const lead = peer(f, 'sid-lead')
  const out: Record<string, any> = {}
  script(f, [[40_000, async () => {
    out.a = await answer(lead, { id: await idOf(f), decision: 'allow' })
    f.h.files.delete(`${HOME}/.claude/settings.json`)
    mem.guard = undefined
  }]])
  const r = await ask(f)
  assert.match(out.a.result, /allowed/)
  assert.match(r.decision.message, /Expired/)
})
