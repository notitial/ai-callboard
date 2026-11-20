import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LIVE_CHILDREN, PERSON, ancestors, capability, chain, children, descendants, isLead, isOff, liveView, liveness, mayActOn, mayAdopt, mayCreate, nameOf, nameRefusal, parent } from './model.ts'
import type { Table } from './model.ts'
import { MANAGER, forAll, reg } from './gen.spec.ts'

const M = 'sid-manager'
const A = 'sid-lead-a'
const B = 'sid-lead-b'
const L1 = 'sid-lane-1'
const LOOSE = 'sid-loose'

test('parent() gives every session a value, chains end within four steps, and no session is its own ancestor', () => {
  forAll(400, (_r, w) => {
    for (const s of w.sids) {
      const p = parent(w.v, s)
      assert.ok(p === PERSON || p === 'unknown' || typeof p === 'string')
      const c = chain(w.v, s)
      assert.ok(c.up.length <= 3, `chain of ${s} is ${c.up.join(' > ')}`)
      assert.ok(!c.up.includes(s))
      // A parent is the manager or a lead that is not off and not known gone.
      for (const a of c.up) assert.ok(a === w.v.manager || (isLead(w.v, a) && liveness(w.v, a) !== 'no'), `${a} above ${s} is neither the manager nor a live lead`)
    }
  })
})

test('an off session is nobody\'s parent and nobody\'s child: no tool of a parent reaches it', () => {
  forAll(400, (_r, w) => {
    for (const s of w.sids.filter((x) => isOff(w.v, x))) {
      assert.equal(parent(w.v, s), PERSON)
      for (const a of w.sids) {
        assert.notEqual(parent(w.v, a), s)
        assert.ok(!mayActOn(w.v, a, s))
        assert.ok(!children(w.v, a).includes(s))
      }
    }
  })
})

test('unknown is not nobody: an unreadable registry keeps a lane under its stored lead and names no manager', () => {
  forAll(400, (_r, w) => {
    const v = liveView('unknown', w.table, MANAGER)
    assert.equal(v.manager, 'unknown')
    for (const s of w.sids) {
      const p = parent(v, s)
      const u = w.table[s]?.under
      if (isOff(v, s) || w.table[s]?.lead) continue
      assert.equal(p, u !== undefined && isLead(v, u) ? u : 'unknown')
    }
  })
  // The manager-name file that cannot be read is unknown too, not "no manager".
  assert.equal(liveView([reg(M, MANAGER)], {}, 'unknown').manager, 'unknown')
  assert.equal(parent(liveView([reg(LOOSE, 'x')], {}, 'unknown'), LOOSE), 'unknown')
})

test('the manager: found by name only, the older of two, never an off one; renamed away or with no file there is none', () => {
  const two = liveView([reg('sid-new', MANAGER, { procStart: 'Thu Nov 19 09:00:00 2026' }), reg('sid-old', MANAGER, { procStart: 'Thu Nov 19 07:00:00 2026' })], {}, MANAGER)
  assert.equal(two.manager, 'sid-old')
  assert.deepEqual(two.managers, ['sid-old', 'sid-new'])
  assert.equal(liveView([reg('sid-old', MANAGER), reg('sid-new', MANAGER)], { 'sid-old': { name: MANAGER, folder: '/', off: true } }, MANAGER).manager, 'sid-new')
  assert.equal(liveView([reg(M, 'renamed')], {}, MANAGER).manager, null)
  assert.equal(liveView([reg(M, MANAGER)], {}, null).manager, null)
  // With no manager a loose session's parent is the person; the manager's own parent is always the person.
  assert.equal(parent(liveView([reg(LOOSE, 'x')], {}, MANAGER), LOOSE), PERSON)
  assert.equal(parent(liveView([reg(M, MANAGER)], { [M]: { name: MANAGER, folder: '/', under: A } }, MANAGER), M), PERSON)
})

test('a session with no row is managed, its parent the manager; the manager reaches every lane of every lead', () => {
  const table: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: A } }
  const v = liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1'), reg(LOOSE, 'x')], table, MANAGER)
  assert.equal(parent(v, LOOSE), M)
  assert.equal(parent(v, A), M)
  assert.deepEqual(ancestors(v, L1), [A, M])
  assert.deepEqual(descendants(v, M).sort(), [A, L1, LOOSE].sort())
  assert.ok(mayActOn(v, M, L1) && mayActOn(v, A, L1) && !mayActOn(v, L1, A) && !mayActOn(v, A, LOOSE))
  assert.equal(capability(v, M), 'manager')
  assert.equal(capability(v, A), 'lead')
  assert.equal(capability(v, LOOSE), 'none')
})

test('a busy parent is live: a lead compacting and a manager inside a question still own their children', () => {
  const table: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: A } }
  const v = liveView([reg(M, MANAGER, { status: 'waiting', waitingFor: 'question' }), reg(A, 'A', { status: 'compacting' }), reg(L1, 'L1')], table, MANAGER)
  assert.deepEqual(ancestors(v, L1), [A, M])
})

test('rows bind by session id: a renamed lane keeps its lead, and a stale lane row of a lead that is gone or no longer a lead routes to the manager', () => {
  const table: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: A } }
  assert.equal(parent(liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'renamed-by-auto-title')], table, MANAGER), L1), A)
  assert.equal(parent(liveView([reg(M, MANAGER), reg(L1, 'L1')], table, MANAGER), L1), M)
  const notLead = { ...table, [A]: { name: 'A', folder: '/Users/x/repo' } }
  assert.equal(parent(liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1')], notLead, MANAGER), L1), M)
  const offLead = { ...table, [A]: { ...table[A], off: true as const } }
  assert.equal(parent(liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1')], offLead, MANAGER), L1), M)
})

test('create and adopt: only a lead, only inside its allowlist, only a loose session of one name, under the one cap', () => {
  const table: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: ['/Users/x/other'] } }, [B]: { name: 'B', folder: '/Users/x/b', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: B } }
  const rows = [reg(M, MANAGER), reg(A, 'A'), reg(B, 'B', { folder: '/Users/x/b' }), reg(L1, 'L1'), reg(LOOSE, 'loose', { folder: '/Users/x/repo/sub' }), reg('sid-far', 'far', { folder: '/Users/x/repository' })]
  const v = liveView(rows, table, MANAGER)
  assert.equal(mayCreate(v, LOOSE, 'n', '/Users/x/repo'), 'not-lead')
  assert.equal(mayCreate(v, M, 'n', '/Users/x/repo'), 'not-lead')
  assert.equal(mayCreate(v, A, 'n', '/Users/x/repository'), 'folder-outside')
  assert.equal(mayCreate(v, A, 'n', '/Users/x/other/deep'), undefined)
  for (const odd of ['/Users/x/repo/../etc', '/Users/x/repo/./sub', '/Users/x/repo//sub', 'Users/x/repo', '/Users/x/repo/']) assert.equal(mayCreate(v, A, 'n', odd), 'folder-outside', odd)
  // An empty or root entry in a lead's repos contains nothing.
  const wide = liveView(rows, { ...table, [A]: { ...table[A], lead: { repos: ['/', ''] } } }, MANAGER)
  assert.equal(mayCreate(wide, A, 'n', '/Users/x/elsewhere'), 'folder-outside')
  assert.equal(mayCreate(v, A, MANAGER, '/Users/x/repo'), 'name-reserved')
  assert.equal(mayCreate(v, A, 'MANAGER', '/Users/x/repo'), 'name-reserved')
  assert.equal(mayCreate(v, A, 'L1', '/Users/x/repo'), 'name-taken')
  assert.equal(mayCreate(v, A, 'bad name', '/Users/x/repo'), 'name-bad')
  assert.deepEqual(mayAdopt(v, A, 'loose'), { ok: LOOSE })
  assert.deepEqual(mayAdopt(v, A, 'L1'), { no: 'not-loose' })
  assert.deepEqual(mayAdopt(v, A, 'B'), { no: 'is-lead' })
  assert.deepEqual(mayAdopt(v, A, MANAGER), { no: 'is-manager' })
  assert.deepEqual(mayAdopt(v, A, 'far'), { no: 'folder-outside' })
  assert.deepEqual(mayAdopt(v, A, 'none'), { no: 'not-found' })
  assert.deepEqual(mayAdopt(liveView([...rows, reg('sid-twin', 'loose')], table, MANAGER), A, 'loose'), { no: 'ambiguous' })
  assert.deepEqual(mayAdopt(liveView(rows, { ...table, [LOOSE]: { name: 'loose', folder: '/Users/x/repo/sub', off: true } }, MANAGER), A, 'loose'), { no: 'is-off' })
  assert.deepEqual(mayAdopt(liveView('unknown', table, MANAGER), A, 'loose'), { no: 'unknown-liveness' })
  // A lane whose lead is gone is loose, so another lead may adopt it.
  assert.deepEqual(mayAdopt(liveView(rows.filter((r) => r.sid !== B), table, MANAGER), A, 'L1'), { ok: L1 })
})

test('the one cap on live children counts live, unparked children only; many lanes opened through a window meet only it', () => {
  const lanes = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `sid-l${i}`)
  const table: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } } }
  for (const l of lanes) table[l] = { name: l, folder: '/Users/x/repo', under: A }
  const full = liveView([reg(A, 'A'), ...lanes.map((l) => reg(l, l))], table, MANAGER)
  assert.equal(mayCreate(full, A, 'one-more', '/Users/x/repo'), 'cap')
  table[lanes[0]].parked = 1
  assert.equal(mayCreate(liveView([reg(A, 'A'), ...lanes.slice(1).map((l) => reg(l, l))], table, MANAGER), A, 'one-more', '/Users/x/repo'), undefined)
})

test('the name rule: a renamed session keeps its own name free for itself; an unknown read refuses', () => {
  const v = liveView([reg(L1, 'L1')], { [L1]: { name: 'L1', folder: '/' } }, MANAGER)
  assert.equal(nameRefusal(v, 'L1', L1), undefined)
  assert.equal(nameRefusal(v, 'L1'), 'name-taken')
  assert.equal(nameRefusal(liveView('unknown', {}, MANAGER), 'free'), 'unknown-liveness')
})

test('a session named like a sentinel shows as its id, never as the person or as an unknown parent', () => {
  const t: Table = { [A]: { name: 'PERSON', folder: '/Users/x/a' }, [B]: { name: 'unknown', folder: '/Users/x/b' } }
  const v = liveView([reg(A, 'PERSON'), reg(B, 'unknown'), reg(L1, 'lane')], t, MANAGER)
  assert.deepEqual([nameOf(v, A), nameOf(v, B), nameOf(v, L1), nameOf(v, 'sid-gone')], [A, B, 'lane', 'sid-gone'])
  assert.equal(nameOf(liveView('unknown', t, MANAGER), A), A)
})
