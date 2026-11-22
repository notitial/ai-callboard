import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN, T0, fake } from '../../test/fake.ts'
import { getUp, mem, patchUp } from './mem.ts'
import { getView } from './store.ts'
import { keepaliveTick, midNudge, nudgeTick, postCompact, promptSubmit, requestCompactCall, requestTick, turnComplete, turnStart } from './upkeep.ts'
import { T } from '../texts.ts'

const next = async (e: unknown) => e
const GOOD = { focus: 'Lane A, building the thing.', continuation: 'Next: run the tests.' }
type F = ReturnType<typeof fake>
function session(tokens = 0, row: object = {}): F {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive', ...row })
  f.h.usage = { context: { tokens } }
  return f
}
const view = (f: F) => getView(f.$, true)
const KEEP = T['keepalive']({})

test('request_compact: the main agent of an interactive session, above the floor, queues one request keyed to its own session id', async () => {
  const f = session(150_000)
  const r = await requestCompactCall(f.$, GOOD, next)
  assert.equal(r.result, T['compact.queued']({}))
  assert.deepEqual({ ...(await getUp(f.$)).req }, { ...GOOD, phase: 'called', at: T0, sid: 'sid-me' })
  const sub = session(150_000)
  assert.match((await requestCompactCall(sub.$, { ...GOOD, agentId: 'a1' }, next)).deny, /a subagent may not call this/)
  assert.equal((await getUp(sub.$)).req, null)
  const small = session(50_000)
  assert.match((await requestCompactCall(small.$, GOOD, next)).deny, /100k/)
  const loose = session(150_000, { kind: 'headless' })
  assert.match((await requestCompactCall(loose.$, GOOD, next)).deny, /only an interactive session can compact itself/)
  assert.equal((await getUp(loose.$)).req, null)
  assert.match((await requestCompactCall(sub.$, { ...GOOD, focus: '/compact now' }, next)).deny, /not start with a slash/)
})
test('the compaction: the answer arms it, the tick starts it once, PostCompact owes the note, the note is sent once and the request ends', async () => {
  const f = session(150_000)
  await requestCompactCall(f.$, GOOD, next)
  await turnComplete(f.$, { reason: 'answer' }, next)
  assert.equal((await getUp(f.$)).req?.phase, 'armed')
  await requestTick(f.$, 'sid-me')
  assert.deepEqual(f.h.compactRuns, [`compact ${GOOD.focus}`])
  assert.equal((await getUp(f.$)).req?.phase, 'compacting')
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.compactRuns.length, 1)
  f.h.now += 20_000
  await postCompact(f.$, {}, next)
  assert.equal((await getUp(f.$)).req?.phase, 'compacted')
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 1)
  assert.match(f.h.submitted[0], /Next: run the tests\./)
  assert.equal((await getUp(f.$)).req, null)
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 1)
})
test('a compaction the tick refuses is toasted as a sentence naming why, not as the refusal code', async () => {
  const f = session(150_000)
  await requestCompactCall(f.$, GOOD, next)
  await turnComplete(f.$, { reason: 'answer' }, next)
  f.h.usage = { context: { tokens: 50_000 } }
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.compactRuns.length, 0)
  assert.equal((await getUp(f.$)).req, null)
  assert.equal(f.h.toasts.length, 1)
  assert.match(f.h.toasts[0], /did not run \(the context is below 100k tokens\)/)
  assert.doesNotMatch(f.h.toasts[0], /compact-floor/)
})
test('a request ends when it is another session\'s, when a turn ends with no answer, when a person prompts, when it waited too long or is stamped from the future; the resume note is not sent after 2 min or over a draft', async () => {
  const f = session(150_000)
  await requestCompactCall(f.$, GOOD, next)
  await patchUp(f.$, (u) => ({ ...u, req: { ...u.req!, sid: 'sid-other' } }))
  await requestTick(f.$, 'sid-me')
  assert.equal((await getUp(f.$)).req, null)
  await requestCompactCall(f.$, GOOD, next)
  await turnComplete(f.$, { reason: 'tool' }, next)
  assert.equal((await getUp(f.$)).req, null)
  await requestCompactCall(f.$, GOOD, next)
  await promptSubmit(f.$, { text: 'hello', origin: { kind: 'plugin' } }, next)
  assert.equal((await getUp(f.$)).req?.phase, 'called')
  await promptSubmit(f.$, { text: 'hello', origin: { kind: 'composer' } }, next)
  assert.equal((await getUp(f.$)).req, null)
  assert.match(f.h.toasts[0], /new prompt/)
  await requestCompactCall(f.$, GOOD, next)
  await turnComplete(f.$, { reason: 'answer' }, next)
  f.h.now += 16 * MIN
  await requestTick(f.$, 'sid-me')
  assert.equal((await getUp(f.$)).req, null)
  assert.equal(f.h.compactRuns.length, 0)
  await requestCompactCall(f.$, GOOD, next)
  await patchUp(f.$, (u) => ({ ...u, req: { ...u.req!, at: f.h.now + 3 * 60 * MIN } }))
  await requestTick(f.$, 'sid-me')
  assert.equal((await getUp(f.$)).req, null)
  for (const [wait, draft] of [[3 * MIN, ''], [MIN, 'half a sentence']] as const) {
    await patchUp(f.$, (u) => ({ ...u, req: { ...GOOD, phase: 'compacted', at: f.h.now, sid: 'sid-me', doneAt: f.h.now } }))
    f.h.now += wait
    f.h.draft = draft
    await requestTick(f.$, 'sid-me')
    assert.equal(f.h.submitted.length, 0)
  }
})
test('the keepalive: one ping per idle gap at 50 minutes, none to a rested, off, signed or woken session, none past 2 h of no real work, none over a draft', async () => {
  const gap = async (f: F, after: object = {}, minutes = 51) => {
    await turnComplete(f.$, { reason: 'answer' }, next)
    f.h.now += minutes * MIN
    Object.assign(mem, after)
    await keepaliveTick(f.$, 'sid-me', await view(f), mem.submits)
  }
  const f = session()
  await gap(f)
  assert.deepEqual(f.h.submitted, [KEEP])
  assert.equal((await getUp(f.$)).pingAt, f.h.now)
  await keepaliveTick(f.$, 'sid-me', await view(f), mem.submits)
  assert.equal(f.h.submitted.length, 1)
  const early = session()
  await gap(early, {}, 40)
  assert.equal(early.h.submitted.length, 0)
  const rested = session()
  await patchUp(rested.$, (u) => ({ ...u, restAt: T0 }))
  await gap(rested)
  assert.equal(rested.h.submitted.length, 0)
  const woke = session()
  await turnComplete(woke.$, { reason: 'answer' }, next)
  mem.woke = T0 + 10 * MIN
  woke.h.now += 51 * MIN
  await keepaliveTick(woke.$, 'sid-me', await view(woke), mem.submits)
  assert.equal(woke.h.submitted.length, 0)
  const signed = session()
  mem.signed.set.add('sid-me')
  await gap(signed)
  assert.equal(signed.h.submitted.length, 0)
  const off = session()
  off.table({ 'sid-me': { name: 'me', folder: '/w/me', off: true } })
  await gap(off)
  assert.equal(off.h.submitted.length, 0)
  const draft = session()
  draft.h.draft = 'typing'
  await gap(draft)
  assert.equal(draft.h.submitted.length, 0)
  const busy = session(0, { status: 'busy' })
  await gap(busy)
  assert.equal(busy.h.submitted.length, 0)
  const cold = session()
  await gap(cold, {}, 59)
  assert.equal(cold.h.submitted.length, 0)
})
test('the keepalive reads the registry only for a gap it would act on: a session past 2 h of no real work runs no ps each tick', async () => {
  const f = session()
  await turnComplete(f.$, { reason: 'answer' }, next)
  f.h.now += 2 * 60 * MIN + 51 * MIN
  const v = await view(f)
  const ps = () => f.h.runs.filter((r) => r.argv[0] === '/bin/ps').length
  const before = ps()
  await keepaliveTick(f.$, 'sid-me', v, mem.submits)
  await keepaliveTick(f.$, 'sid-me', v, mem.submits)
  assert.equal(ps(), before)
  assert.equal(f.h.submitted.length, 0)
  const live = session()
  await turnComplete(live.$, { reason: 'answer' }, next)
  live.h.now += 51 * MIN
  const lv = await view(live)
  const n = live.h.runs.length
  await keepaliveTick(live.$, 'sid-me', lv, mem.submits)
  assert.ok(live.h.runs.slice(n).some((r) => r.argv[0] === '/bin/ps'))
  assert.deepEqual(live.h.submitted, [KEEP])
})
test('a ping or a nudge is not work: the stop clock is the last real turn, which the ping\'s own turn does not move', async () => {
  const f = session()
  await turnComplete(f.$, { reason: 'answer' }, next)
  const realEnd = (await getUp(f.$)).realEnd
  f.h.now += 51 * MIN
  await keepaliveTick(f.$, 'sid-me', await view(f), mem.submits)
  await turnStart(f.$, { text: f.h.submitted[0] }, next)
  assert.equal(mem.turnKind, 'ping')
  await turnComplete(f.$, { reason: 'answer' }, next)
  assert.equal((await getUp(f.$)).realEnd, realEnd)
  f.h.now += 2 * 60 * MIN
  await keepaliveTick(f.$, 'sid-me', await view(f), mem.submits)
  assert.equal(f.h.submitted.length, 1)
})
test('the nudge: recorded at the end of an answer past the level, sent once the session is quiet, dropped when it waited 10 min or the box has a draft', async () => {
  const f = session(320_000)
  await turnComplete(f.$, { reason: 'answer' }, next)
  assert.equal((await getUp(f.$)).due?.at, T0)
  f.h.draft = 'typing'
  await nudgeTick(f.$, 'sid-me', await view(f))
  assert.equal(f.h.submitted.length, 0)
  f.h.draft = ''
  await nudgeTick(f.$, 'sid-me', await view(f))
  assert.equal(f.h.submitted.length, 1)
  assert.match(f.h.submitted[0], /300k/)
  assert.equal((await getUp(f.$)).due, null)
  await turnComplete(f.$, { reason: 'answer' }, next)
  assert.equal((await getUp(f.$)).due, null)
  const g = session(320_000)
  await turnComplete(g.$, { reason: 'answer' }, next)
  g.h.now += 11 * MIN
  await nudgeTick(g.$, 'sid-me', await view(g))
  assert.equal(g.h.submitted.length, 0)
  assert.equal((await getUp(g.$)).due, null)
})
test('a nudge mid-turn comes back as text for the tool result, once, then a resend is allowed at the next answer', async () => {
  const f = session(320_000)
  await view(f)
  const t = await midNudge(f.$, {})
  assert.match(t!, /300k/)
  assert.equal(await midNudge(f.$, {}), undefined)
  assert.equal(await midNudge(f.$, { agentId: 'sub' }), undefined)
  f.h.now += MIN
  await turnComplete(f.$, { reason: 'answer' }, next)
  assert.equal((await getUp(f.$)).due?.again, true)
  const small = session(100_000)
  await view(small)
  assert.equal(await midNudge(small.$, {}), undefined)
})
test('a turn that carries the plugin\'s own text is counted down; a text of a person is not', async () => {
  const f = session()
  f.h.now += 51 * MIN
  await turnComplete(f.$, { reason: 'answer' }, next)
  f.h.now += 51 * MIN
  await keepaliveTick(f.$, 'sid-me', await view(f), mem.submits)
  assert.equal(mem.own.size, 1)
  await turnStart(f.$, { text: 'what the person typed' }, next)
  assert.equal(mem.own.size, 1)
  await turnStart(f.$, { text: KEEP }, next)
  assert.equal(mem.own.size, 0)
})
test('a prompt that lands while the compaction starts, or while the resume note is claimed, stops it: no command, no note', async () => {
  const f = session(150_000)
  await requestCompactCall(f.$, GOOD, next)
  await turnComplete(f.$, { reason: 'answer' }, next)
  const set = f.$.state.set
  let raced = false
  f.$.state.set = async (key: unknown, value: any, o: unknown) => {
    if (!raced && value?.req?.phase === 'compacting') {
      raced = true
      await set(key, { ...value, req: null }, undefined)
    }
    return set(key, value, o)
  }
  await requestTick(f.$, 'sid-me')
  assert.equal(raced, true)
  assert.equal(f.h.compactRuns.length, 0)
  assert.equal(f.h.toasts.length, 0)
  f.$.state.set = set
  await patchUp(f.$, (u) => ({ ...u, req: { ...GOOD, phase: 'compacted', at: f.h.now, sid: 'sid-me', doneAt: f.h.now } }))
  raced = false
  f.$.state.set = async (key: unknown, value: any, o: unknown) => {
    if (!raced && value?.req === null) {
      raced = true
      await set(key, { ...value, req: null }, undefined)
    }
    return set(key, value, o)
  }
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 0)
})

test('the turn that signs a lane\'s report leaves no nudge due, and the lane counts as signed at once, not after the 30 s refresh', async () => {
  const f = session(320_000)
  const report = '/w/me/.archive/me/REPORT.md'
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-lead', report } })
  f.h.files.set(report, 'done\nstatus: done sid-me\n')
  await turnComplete(f.$, { reason: 'answer' }, next)
  assert.equal((await getUp(f.$)).due, null)
  assert.ok(mem.signed.set.has('sid-me'))
  await nudgeTick(f.$, 'sid-me', await view(f))
  assert.equal(f.h.submitted.length, 0)
})
