import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CUE_MAX_AGE_MS, IDLE_MS, LANE_ROW_KEEP_MS, PARKED_ROW_KEEP_MS, childState, cueAnswer, cueReply, parseCue, reportPath, signedBy, tidy, verbPlan } from './lifecycle.ts'
import type { Verb } from './lifecycle.ts'
import { MAX_LIVE_CHILDREN, liveView, mayActOn, nameOf } from './model.ts'
import type { Table } from './model.ts'
import { MANAGER, NOW, WINDOWS, forAll, pick, reg } from '../../test/gen.ts'

const M = 'sid-manager'
const A = 'sid-lead-a'
const L1 = 'sid-lane-1'
const VERBS: Verb[] = ['rename', 'start', 'resume', 'park', 'retire', 'terminate', 'unpark']
const lanes: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: A, report: reportPath('/Users/x/repo', 'L1') } }
const view = (l1: Partial<Parameters<typeof reg>[2]> | null, table = lanes) => liveView([reg(M, MANAGER), reg(A, 'A'), ...(l1 === null ? [] : [reg(L1, 'L1', l1)])], table, MANAGER)
const plan = (verb: Verb, v = view({}), x: Partial<Parameters<typeof verbPlan>[4]> = {}) => verbPlan(verb, v, A, L1, { signed: false, win: WINDOWS[0], now: NOW, ...x })

test('a verb acts only on a descendant of the caller now; nothing acts on an unknown reading', () => {
  forAll(300, (r, w) => {
    const actor = pick(r, w.sids)
    const target = pick(r, w.sids)
    const p = verbPlan(pick(r, VERBS), w.v, actor, target, { signed: r() < 0.5, win: pick(r, WINDOWS), now: NOW, name: 'fresh-name' })
    if (p.act !== 'refuse') assert.ok(mayActOn(w.v, actor, target), `${actor} acted on ${target}`)
  })
  for (const verb of VERBS) assert.equal(verbPlan(verb, liveView('unknown', lanes, MANAGER), A, L1, { signed: true, win: WINDOWS[0], now: NOW }).msg, 'refuse.unknown-liveness')
})

test('park, resume and retire open no dialog; a force stop opens one only while the window is read off; a lead\'s row is never removed', () => {
  assert.equal(plan('resume').act, 'cue')
  assert.deepEqual([plan('park').act, plan('park').dialog], ['stop', undefined])
  assert.deepEqual([plan('retire', undefined, { signed: true }).act, plan('retire', undefined, { signed: true }).dialog], ['stop', undefined])
  assert.deepEqual([plan('terminate').act, plan('terminate').dialog], ['stop', true])
  assert.equal(plan('terminate', undefined, { win: WINDOWS[2] }).msg, 'refuse.unattended')
  assert.equal(plan('terminate', undefined, { win: WINDOWS[1] }).msg, 'refuse.unattended')
  // A gone lead's row holds its grant and repos: the manager above it cannot remove it.
  const leadGone = liveView([reg(M, MANAGER)], lanes, MANAGER)
  for (const verb of ['retire', 'terminate'] as const) assert.equal(verbPlan(verb, leadGone, M, A, { signed: true, win: WINDOWS[0], now: NOW }).msg, 'refuse.is-lead')
  // A row no live session carries is removed with no dialog, in a window too.
  assert.equal(plan('terminate', view(null), { win: WINDOWS[2] }).act, 'remove')
})

test('a retire needs the report signed by the child\'s own session id; a park or retire waits for the child to be idle', () => {
  assert.equal(plan('retire').msg, 'refuse.report-unsigned')
  assert.equal(plan('park', view({ status: 'busy' })).msg, 'refuse.not-idle')
  assert.equal(plan('park', view({ statusAt: NOW - IDLE_MS + 1 })).msg, 'refuse.not-idle')
  assert.ok(signedBy('work\nstatus: done old-sid\nmore\nstatus: done sid-lane-1\n\n', L1))
  assert.ok(!signedBy('status: done sid-lane-1\nlater work', L1))
  assert.ok(!signedBy('status: done sid-lane-10', L1))
})

test('unpark reopens a parked child under the cap; the other verbs need a live session', () => {
  const parked = { ...lanes, [L1]: { ...lanes[L1], parked: NOW - 1 } }
  assert.deepEqual(plan('unpark', view(null, parked)), { act: 'reopen', msg: 'lane.unparked', p: { name: 'L1', sid: L1 } })
  assert.equal(plan('start', view(null, parked)).msg, 'refuse.no-live-session')
  assert.equal(plan('unpark').msg, 'refuse.has-live-session')
  const full: Table = { ...parked }
  const others = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `sid-o${i}`)
  for (const o of others) full[o] = { name: o, folder: '/', under: A }
  const fullView = liveView([reg(M, MANAGER), reg(A, 'A'), ...others.map((o) => reg(o, o))], full, MANAGER)
  // The cap is the child's lead's, whoever acts: the manager above that lead meets it too.
  for (const actor of [A, M]) assert.equal(verbPlan('unpark', fullView, actor, L1, { signed: false, win: WINDOWS[0], now: NOW }).msg, 'refuse.cap')
  // The manager's own children (loose sessions) are not capped.
  const loose: Table = { 'sid-p': { name: 'p', folder: '/Users/x/repo', parked: NOW - 1 } }
  for (const o of others) loose[o] = { name: o, folder: '/Users/x/repo' }
  assert.equal(verbPlan('unpark', liveView([reg(M, MANAGER), ...others.map((o) => reg(o, o))], loose, MANAGER), M, 'sid-p', { signed: false, win: WINDOWS[0], now: NOW }).act, 'reopen')
  assert.equal(plan('rename', undefined, { name: MANAGER }).msg, 'refuse.name-reserved')
})

test('the state lane_list shows', () => {
  assert.equal(childState(view({}), L1, false, NOW), 'live')
  assert.equal(childState(view({ status: 'busy' }), L1, false, NOW), 'busy')
  assert.equal(childState(view({}), L1, true, NOW), 'done')
  assert.equal(childState(view(null), L1, false, NOW), 'gone')
  assert.equal(childState(view(null, { ...lanes, [L1]: { ...lanes[L1], parked: 1 } }), L1, false, NOW), 'parked')
  assert.equal(childState(view({}), 'new:L2', false, NOW), 'notOpened')
  assert.equal(childState(liveView('unknown', lanes, MANAGER), L1, false, NOW), 'unknown')
})

test('the cue: acted on only when its sender is above the child now and it is fresh; held while a turn runs', () => {
  const cue = parseCue({ id: 'c', verb: 'start', from: A, at: NOW })!
  assert.equal(cueAnswer(view({}), L1, cue, false, NOW + CUE_MAX_AGE_MS).outcome, 'ok')
  assert.equal(cueAnswer(view({}), L1, cue, true, NOW).outcome, 'held')
  assert.deepEqual(cueAnswer(view({}), L1, cue, false, NOW + CUE_MAX_AGE_MS + 1), { id: 'c', outcome: 'refused', code: 'cue-stale' })
  assert.deepEqual(cueAnswer(view({}), L1, { ...cue, from: 'sid-other' }, false, NOW), { id: 'c', outcome: 'refused', code: 'not-a-parent' })
  assert.equal(parseCue({ id: 'c', verb: 'terminate', from: A, at: NOW }), undefined)
  assert.equal(cueReply(undefined, 'start', 'L1').msg, 'refuse.cue-refused')
  assert.equal(cueReply({ id: 'c', outcome: 'held' }, 'start', 'L1').msg, 'refuse.cue-held')
})

test('the table\'s upkeep: gone after two reads 30 s apart, back clears it; a plain lane row expires 24 h after, a lead or off row never, a parked one after 28 days', () => {
  const t: Table = { ...lanes, 'sid-off': { name: 'o', folder: '/', off: true }, 'sid-parked': { name: 'p', folder: '/', under: A, parked: NOW - PARKED_ROW_KEEP_MS } }
  const v = liveView([reg(M, MANAGER), reg(A, 'renamed-lead')], t, MANAGER)
  assert.equal(tidy(t, v, () => NOW - 10_000, NOW)[L1].goneAt, undefined)
  const gone = tidy(t, v, () => NOW - 30_000, NOW)
  assert.equal(gone[L1].goneAt, NOW)
  assert.equal(gone[A].name, 'renamed-lead')
  assert.equal(gone['sid-parked'], undefined)
  // A parked row whose session came back is kept, however old the parking.
  assert.ok(tidy(t, liveView([reg(M, MANAGER), reg('sid-parked', 'p')], t, MANAGER), () => undefined, NOW)['sid-parked'])
  assert.equal(tidy(gone, liveView([reg(L1, 'L1')], gone, MANAGER), () => undefined, NOW + 1)[L1].goneAt, undefined)
  // The laptop shut three days: the lead's row keeps its capability and allowlist; the plain lane row is removed.
  const later = NOW + 3 * 24 * 3_600_000
  const back = tidy(gone, liveView([], gone, MANAGER), () => NOW, later)
  assert.deepEqual(back[A].lead, { repos: [] })
  assert.ok(back['sid-off']?.off)
  assert.equal(back[L1], undefined)
  assert.ok(later - NOW > LANE_ROW_KEEP_MS)
  // A rename never moves the report path; an unknown read changes nothing.
  assert.equal(tidy(t, liveView([reg(L1, 'renamed')], t, MANAGER), () => undefined, NOW)[L1].report, '/Users/x/repo/.archive/L1/REPORT.md')
  assert.equal(tidy(t, liveView('unknown', t, MANAGER), () => 0, NOW), t)
})

test('the upkeep in every world: an unknown read changes nothing; a typed lead row, an off row and a row a live session carries are never dropped', () => {
  forAll(300, (r, w) => {
    const now = NOW + Math.floor(r() * 40 * 86_400_000)
    const out = tidy(w.table, w.v, () => (r() < 0.5 ? undefined : now - 60_000), now)
    if (w.v.rows === 'unknown') return assert.equal(out, w.table)
    for (const [k, row] of Object.entries(w.table)) {
      if ((row.lead !== undefined && !row.lead.minted) || row.off || w.v.rows.has(k)) assert.ok(out[k], `${k} dropped`)
      if (w.v.rows.has(k)) assert.equal(out[k].goneAt, undefined)
    }
  })
})

test('a name Claude generated for a new panel (source auto or derived) never replaces the row\'s name; a name given by /rename does; a loose session keeps its generated one', () => {
  for (const nameSource of ['auto', 'derived']) {
    const gen = liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'ai-manager-ef', { nameSource })], lanes, MANAGER)
    assert.equal(nameOf(gen, L1), 'L1')
    assert.equal(tidy(lanes, gen, () => undefined, NOW)[L1].name, 'L1')
  }
  const given = liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1b', { nameSource: 'user' })], lanes, MANAGER)
  assert.equal(nameOf(given, L1), 'L1b')
  assert.equal(tidy(lanes, given, () => undefined, NOW)[L1].name, 'L1b')
  assert.equal(nameOf(liveView([reg('sid-loose', 'ai-manager-17', { nameSource: 'auto' })], {}, MANAGER), 'sid-loose'), 'ai-manager-17')
})

test('a signed lane retires as soon as it is out of its turn; a park still waits IDLE_MS; a lane in a turn or waiting is refused either way', () => {
  const justIdle = view({ statusAt: NOW })
  assert.equal(plan('retire', justIdle, { signed: true }).act, 'stop')
  assert.equal(plan('park', justIdle).msg, 'refuse.not-idle')
  assert.equal(plan('retire', view({ status: 'busy' }), { signed: true }).msg, 'refuse.not-idle')
  assert.equal(plan('retire', view({ waitingFor: 'permission' }), { signed: true }).msg, 'refuse.not-idle')
  assert.equal(childState(justIdle, L1, false, NOW), 'live')
})
