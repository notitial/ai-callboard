import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPIRE_MS, HEAD_START_MS, MANAGER_AT_MS, decide, stage } from './asks.ts'
import type { Ask, Answer, Table } from './model.ts'
import { MAX_LIVE_CHILDREN, PERSON, ancestors, capability, chain, descendants, isConductor, isMinted, liveView, mayActOn, mayAdopt, mayCreate, parent } from './model.ts'
import { LANE_ROW_KEEP_MS, tidy, verbPlan } from './lifecycle.ts'
import { notices } from './notices.ts'
import { planCommand } from './commands.ts'
import { MANAGER, NOW, WINDOWS, forAll, reg } from './gen.spec.ts'

const M = 'sid-manager'
const C = 'sid-conductor'
const ML = 'sid-minted'
const A = 'sid-lead-a'
const L1 = 'sid-lane-1'
const LOOSE = 'sid-loose'
const table: Table = {
  [C]: { name: 'C', folder: '/Users/x/cond', lead: { repos: ['/Users/x/repo', '/Users/x/other'], conductor: true } },
  [ML]: { name: 'ML', folder: '/Users/x/repo', under: C, lead: { repos: [], minted: true } },
  [A]: { name: 'A', folder: '/Users/x/a', lead: { repos: [] } },
  [L1]: { name: 'L1', folder: '/Users/x/repo', under: ML },
}
const rows = [reg(M, MANAGER), reg(C, 'C', { folder: '/Users/x/cond' }), reg(ML, 'ML'), reg(A, 'A', { folder: '/Users/x/a' }), reg(L1, 'L1'), reg(LOOSE, 'loose')]
const v = liveView(rows, table, MANAGER)

test('a minted lead is the conductor\'s child while the conductor lives; otherwise the manager\'s; its lanes are the conductor\'s descendants', () => {
  assert.deepEqual([capability(v, C), isConductor(v, C), isMinted(v, C)], ['lead', true, false])
  assert.deepEqual([capability(v, ML), isConductor(v, ML), isMinted(v, ML)], ['lead', false, true])
  assert.equal(parent(v, ML), C)
  assert.equal(parent(v, C), M)
  assert.deepEqual(chain(v, L1), { up: [ML, C, M], top: PERSON })
  assert.deepEqual(descendants(v, C).sort(), [ML, L1].sort())
  assert.ok(mayActOn(v, C, ML) && mayActOn(v, C, L1) && mayActOn(v, ML, L1) && mayActOn(v, M, L1))
  assert.ok(!mayActOn(v, ML, C) && !mayActOn(v, A, ML) && !mayActOn(v, L1, ML))
  // The conductor gone, off or no longer a conductor: the minted lead falls to the manager and keeps only its own folder.
  assert.equal(parent(liveView(rows.filter((r) => r.sid !== C), table, MANAGER), ML), M)
  assert.equal(parent(liveView(rows, { ...table, [C]: { ...table[C], off: true } }, MANAGER), ML), M)
  assert.equal(parent(liveView(rows, { ...table, [C]: { ...table[C], lead: { repos: ['/Users/x/repo'] } } }, MANAGER), ML), M)
  assert.equal(parent(liveView('unknown', table, MANAGER), ML), C) // an unread registry keeps the stored parent, as for a lane
})

test('only a minted lead\'s `under` is read: a typed lead or a conductor under another conductor, and a minted lead under a plain lead, go to the manager', () => {
  const typedUnder = { ...table, [A]: { ...table[A], under: C } }
  assert.equal(parent(liveView(rows, typedUnder, MANAGER), A), M)
  assert.equal(parent(liveView(rows, { ...table, [C]: { ...table[C], under: ML } }, MANAGER), C), M)
  assert.equal(parent(liveView(rows, { ...table, [ML]: { ...table[ML], under: A } }, MANAGER), ML), M)
  assert.equal(parent(liveView(rows, { ...table, [ML]: { ...table[ML], under: LOOSE } }, MANAGER), ML), M)
  // A conductor is never the child of its own minted lead, so no loop.
  assert.deepEqual(ancestors(liveView(rows, { ...table, [C]: { ...table[C], under: ML } }, MANAGER), C), [M])
})

test('over every world: a lead above a lead is a conductor, a chain is at most three above, and a minted lead is never a conductor\'s ancestor', () => {
  forAll(600, (_r, w) => {
    for (const s of w.sids) {
      const up = chain(w.v, s).up
      assert.ok(up.length <= 3, `chain of ${s} is ${up.join(' > ')}`)
      if (w.table[s]?.lead) assert.ok(up.length <= 2, 'a lead has at most a conductor and the manager above it')
      up.forEach((a, i) => {
        if (i > 0 && a !== w.v.manager && up[i - 1] !== undefined && w.table[up[i - 1]!]?.lead) assert.ok(isConductor(w.v, a), `${a} is above the lead ${up[i - 1]} and is no conductor`)
      })
      for (const a of up) if (isMinted(w.v, a) && a !== w.v.manager) assert.ok(s !== a && !(w.table[s]?.lead), `${s} (a lead) has the minted lead ${a} above it`)
    }
  })
})

test('lane_create role lead: only a conductor, only inside its saved repos (not its own folder), under the same name and cap rules; a minted lead and a plain lead may not', () => {
  assert.equal(mayCreate(v, C, 'new-lead', '/Users/x/repo', 'lead'), undefined)
  assert.equal(mayCreate(v, C, 'new-lead', '/Users/x/other/deep', 'lead'), undefined)
  assert.equal(mayCreate(v, C, 'new-lead', '/Users/x/cond', 'lead'), 'folder-outside')
  assert.equal(mayCreate(v, C, 'new-lead', '/Users/x/elsewhere', 'lead'), 'folder-outside')
  assert.equal(mayCreate(v, C, 'new-lead', '/Users/x/repository', 'lead'), 'folder-outside')
  assert.equal(mayCreate(v, C, 'L1', '/Users/x/repo', 'lead'), 'name-taken')
  assert.equal(mayCreate(v, C, MANAGER, '/Users/x/repo', 'lead'), 'name-reserved')
  assert.equal(mayCreate(v, A, 'new-lead', '/Users/x/a', 'lead'), 'not-conductor')
  assert.equal(mayCreate(v, ML, 'new-lead', '/Users/x/repo', 'lead'), 'not-conductor')
  assert.equal(mayCreate(v, LOOSE, 'new-lead', '/Users/x/repo', 'lead'), 'not-lead')
  assert.equal(mayCreate(v, M, 'new-lead', '/Users/x/repo', 'lead'), 'not-lead')
  // A conductor is a lead for lanes too: its own folder and the repos are its allowlist.
  assert.equal(mayCreate(v, C, 'new-lane', '/Users/x/cond'), undefined)
  assert.equal(mayCreate(v, C, 'new-lane', '/Users/x/repo/sub'), undefined)
  // A minted lead's allowlist is its own folder.
  assert.equal(mayCreate(v, ML, 'new-lane', '/Users/x/repo/sub'), undefined)
  assert.equal(mayCreate(v, ML, 'new-lane', '/Users/x/other'), 'folder-outside')
  // A conductor adopts like a lead, never a lead.
  assert.deepEqual(mayAdopt(v, C, 'ML'), { no: 'is-lead' })
})

test('the one cap counts leads and lanes together: eight live children of any mix', () => {
  const kids = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `sid-k${i}`)
  const t: Table = { [C]: table[C]! }
  kids.forEach((k, i) => (t[k] = i % 2 === 0 ? { name: k, folder: '/Users/x/repo', under: C, lead: { repos: [], minted: true } } : { name: k, folder: '/Users/x/repo', under: C }))
  const full = liveView([reg(C, 'C'), ...kids.map((k) => reg(k, k))], t, MANAGER)
  assert.equal(mayCreate(full, C, 'one-more', '/Users/x/repo', 'lead'), 'cap')
  assert.equal(mayCreate(full, C, 'one-more', '/Users/x/repo'), 'cap')
  t[kids[0]!] = { ...t[kids[0]!]!, parked: 1 }
  assert.equal(mayCreate(liveView([reg(C, 'C'), ...kids.slice(1).map((k) => reg(k, k))], t, MANAGER), C, 'one-more', '/Users/x/repo', 'lead'), undefined)
})

test('a minted lead\'s row goes like a lane\'s: a verb removes it once no session carries it, and the upkeep expires it; a typed lead\'s row and a conductor\'s stay', () => {
  const x = { signed: true, win: WINDOWS[0], now: NOW }
  const gone = liveView(rows.filter((r) => r.sid !== ML), table, MANAGER)
  for (const verb of ['retire', 'terminate'] as const) {
    assert.equal(verbPlan(verb, gone, C, ML, x).act, 'remove', verb)
    assert.equal(verbPlan(verb, gone, M, ML, x).act, 'remove', verb)
  }
  assert.equal(verbPlan('retire', liveView(rows.filter((r) => r.sid !== A), table, MANAGER), M, A, x).msg, 'refuse.is-lead')
  assert.equal(verbPlan('retire', liveView(rows.filter((r) => r.sid !== C), table, MANAGER), M, C, x).msg, 'refuse.is-lead')
  // A live minted lead is stopped like a live lane: park and retire by its conductor, a force stop through the person's dialog.
  assert.equal(verbPlan('terminate', v, C, ML, x).dialog, true)
  assert.equal(verbPlan('retire', v, C, ML, x).act, 'stop')
  // The upkeep: a minted row gone for a day is dropped; the typed rows are kept.
  const later = NOW + LANE_ROW_KEEP_MS + 1
  const away = liveView([reg(M, MANAGER)], { ...table, [ML]: { ...table[ML]!, goneAt: NOW } }, MANAGER)
  const out = tidy(away.table, away, () => undefined, later)
  assert.equal(out[ML], undefined)
  assert.ok(out[C] && out[A])
})

test('a conductor is told of asks and expired asks from everything under it, and of the other events from its children only', () => {
  const x = { v, now: NOW, since: NOW - 3_600_000, asks: [{ id: 'q', asker: L1 }], log: [{ t: NOW, ev: 'expired' as const, ask: 'e', asker: L1 }], reports: [{ about: L1, code: 'cap', at: 1 }], signed: new Set([L1, ML]), asking: new Set<string>() }
  const kinds = (me: string) => notices({ ...x, me }).map((n) => `${n.kind}:${n.about}`).sort()
  assert.deepEqual(kinds(C), [`ask:${L1}`, `done:${ML}`, `expired:${L1}`])
  assert.deepEqual(kinds(ML), [`ask:${L1}`, `done:${L1}`, `expired:${L1}`, `report:${L1}`])
  assert.deepEqual(kinds(M), [`ask:${L1}`, `expired:${L1}`])
  assert.deepEqual(kinds(A), [])
})

test('the ask chain through a conductor: the minted lead first, the conductor when the lead passes it up or with the manager at 5 minutes, then the person', () => {
  const a = (x: Partial<Ask> = {}): Ask => ({ id: 'ask-1', asker: L1, t0: NOW, awake: 0, tool: 'Bash', raisedBy: 'mode', input: '{}', cut: false, beat: NOW, ...x })
  const s = (ask: Ask, ups: { kind: 'escalated' | 'told'; by: string }[] = []) => {
    const st = stage({ ask, now: NOW + HEAD_START_MS, ups: ups.map((u) => ({ ...u, at: NOW })), v })
    assert.ok(st.open)
    return st
  }
  assert.deepEqual(s(a()).eligible, [ML])
  assert.deepEqual(s(a(), [{ kind: 'escalated', by: ML }]).eligible, [C])
  const late = s(a({ awake: MANAGER_AT_MS }))
  assert.deepEqual(late.eligible, [ML, C, M])
  assert.equal(late.toPerson, false)
  assert.deepEqual(s(a(), [{ kind: 'escalated', by: ML }, { kind: 'escalated', by: C }]).eligible, [M])
  assert.equal(s(a(), [{ kind: 'escalated', by: ML }, { kind: 'escalated', by: C }, { kind: 'escalated', by: M }]).toPerson, true)
  assert.equal(stage({ ask: a({ awake: EXPIRE_MS }), now: NOW, ups: [], v }).open, false)
  // A minted lead's own ask: the conductor above it, then the manager.
  assert.deepEqual(stage({ ask: a({ asker: ML }), now: NOW + HEAD_START_MS, ups: [], v }).open && s(a({ asker: ML })).eligible, [C])
  // The conductor decides an ask of a lane two levels down; a plain lead may not.
  const ans = (by: string): Answer => ({ ask: 'ask-1', by, decision: 'deny', at: NOW })
  const open = s(a(), [{ kind: 'escalated', by: ML }])
  assert.equal(decide(ans(C), a(), open, v, {}).act, 'deny')
  assert.equal(decide(ans(A), a(), open, v, {}).act, 'ignore')
  assert.equal(decide(ans(ML), a(), open, v, {}).act, 'ignore')
})

test('/callboard conductor runs only from his typed turn, takes paths or none, and refuses a path that is not one', () => {
  assert.deepEqual(planCommand('conductor', 'typed', NOW), { act: 'run', cmd: { op: 'conductor', paths: [] } })
  assert.deepEqual(planCommand('conductor /Users/x/a ~/b', 'typed', NOW), { act: 'run', cmd: { op: 'conductor', paths: ['/Users/x/a', '~/b'] } })
  assert.deepEqual(planCommand('conductor', 'other', NOW), { act: 'refuse', msg: 'refuse.bad-origin', p: { tool: 'callboard', target: 'conductor' } })
  assert.deepEqual(planCommand('conductor /Users/x/a', 'other', NOW).msg, 'refuse.bad-origin')
  assert.equal(planCommand('conductor rel/path', 'typed', NOW).msg, 'cmd.usage')
  assert.equal(planCommand('conductor /a\u0007b', 'typed', NOW).msg, 'cmd.usage')
  assert.equal(planCommand('conductor off', 'typed', NOW).msg, 'cmd.usage')
})
