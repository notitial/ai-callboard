import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIGEST_MAX, QUIET_MS, RECEIVES, WAITING_MS, digest, notices, prRoute } from './notices.ts'
import type { NoticeIn } from './notices.ts'
import { capability, children, descendants, liveView } from './model.ts'
import type { Table } from './model.ts'
import { MANAGER, NOW, forAll, pick, reg } from '../../test/gen.ts'

const M = 'sid-manager'
const A = 'sid-lead-a'
const B = 'sid-lead-b'
const L1 = 'sid-lane-1'
const LOOSE = 'sid-loose'
const lanes: Table = { [A]: { name: 'A', folder: '/', lead: { repos: [] } }, [B]: { name: 'B', folder: '/', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/', under: A } }
const base = (x: Partial<NoticeIn>): NoticeIn => ({ me: A, v: liveView([reg(M, MANAGER), reg(A, 'A'), reg(B, 'B'), reg(L1, 'L1', { statusAt: NOW }), reg(LOOSE, 'x')], lanes, MANAGER), now: NOW, since: NOW - 3_600_000, asks: [], log: [], signed: new Set(), asking: new Set(), ...x })
const kinds = (x: Partial<NoticeIn>) => notices(base(x)).map((n) => n.kind).sort()

test('RECEIVES is the only source of event kinds, about sessions in scope now; a gone row routes nothing but its gone; no capability, no events', () => {
  forAll(400, (r, w) => {
    const me = pick(r, w.sids)
    const about = () => pick(r, w.sids)
    const ns = notices({ me, v: w.v, now: NOW, since: 0, asks: [{ id: 'q', asker: about() }], log: [{ t: NOW, ev: 'expired', ask: 'e', asker: about() }], signed: new Set([about()]), asking: new Set() })
    const cap = capability(w.v, me)
    if (cap === 'none') return assert.deepEqual(ns, [])
    const scope = RECEIVES[cap].from === 'children' ? children(w.v, me) : descendants(w.v, me)
    for (const n of ns) {
      assert.ok(RECEIVES[cap].kinds.includes(n.kind), `${cap} got ${n.kind}`)
      assert.ok(scope.includes(n.about), `${me} told about ${n.about}, not under it`)
      if (w.table[n.about]?.goneAt !== undefined) assert.ok(n.kind === 'gone' || n.kind === 'done', `a gone row routed ${n.kind}`)
    }
  })
})

test('the manager is woken only by asks and expired asks; a lead hears every event about its lanes', () => {
  const busy = { asks: [{ id: 'q', asker: L1 }], log: [{ t: NOW, ev: 'expired' as const, ask: 'e', asker: L1 }], signed: new Set([L1]) }
  assert.deepEqual(kinds({ ...busy, me: M }), ['ask', 'expired'])
  assert.deepEqual(kinds({ ...busy, me: A }), ['ask', 'done', 'expired'])
  assert.deepEqual(kinds({ ...busy, me: LOOSE }), [])
  // A loose session's expired ask reaches the manager, not a lead.
  assert.deepEqual(kinds({ me: M, log: [{ t: NOW, ev: 'expired', ask: 'e', asker: LOOSE }] }), ['expired'])
  assert.deepEqual(kinds({ me: A, log: [{ t: NOW, ev: 'expired', ask: 'e', asker: LOOSE }] }), [])
})

test('a lane adopted by another lead: its signed report goes to the new lead only, never to the lead it left', () => {
  const adopted = { ...lanes, [L1]: { ...lanes[L1], under: B } }
  const x = { v: liveView([reg(M, MANAGER), reg(A, 'A'), reg(B, 'B'), reg(L1, 'L1')], adopted, MANAGER), signed: new Set([L1]) }
  assert.deepEqual(kinds({ ...x, me: A }), [])
  assert.deepEqual(kinds({ ...x, me: B }), ['done'])
  // A lead that is no longer one is told nothing about its old lane.
  const demoted = { ...lanes, [A]: { name: 'A', folder: '/' } }
  assert.deepEqual(kinds({ v: liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1')], demoted, MANAGER), signed: new Set([L1]) }), [])
})

test('gone, waiting and quiet: gone once per process, a signed lane that went told as done; waiting only with no open ask; each keyed by its start', () => {
  const goneRow = { ...lanes, [L1]: { ...lanes[L1], goneAt: NOW - 1000 } }
  const v = liveView([reg(M, MANAGER), reg(A, 'A')], goneRow, MANAGER)
  assert.deepEqual(notices(base({ v })).map((n) => n.key), [`gone:${L1}:${NOW - 1000}`])
  assert.deepEqual(kinds({ v, since: NOW }), [])
  assert.deepEqual(kinds({ v, signed: new Set([L1]) }), ['done'])
  assert.deepEqual(kinds({ v: liveView([reg(A, 'A')], { ...goneRow, 'new:L2': { name: 'L2', folder: '/', under: A, goneAt: NOW } }, MANAGER) }), ['gone'])
  const waiting = (x: object) => liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1', { status: 'waiting', waitingFor: 'trust', statusAt: NOW - WAITING_MS, ...x })], lanes, MANAGER)
  assert.deepEqual(kinds({ v: waiting({}) }), ['waiting'])
  assert.deepEqual(kinds({ v: waiting({}), asking: new Set([L1]) }), [])
  assert.deepEqual(kinds({ v: waiting({ statusAt: NOW - WAITING_MS + 1 }) }), [])
  assert.deepEqual(kinds({ v: waiting({ status: 'idle', waitingFor: null, statusAt: NOW - QUIET_MS }) }), ['quiet'])
  assert.deepEqual(kinds({ v: waiting({ status: 'idle', waitingFor: null, statusAt: NOW - QUIET_MS }), signed: new Set([L1]) }), ['done'])
})

test('a PR note: to the registrant while live, else its lead while the row is not gone; a gone or off row routes nothing; an unknown read holds it', () => {
  const v = (rows: string[], t: Table = lanes) => liveView(rows.map((s) => reg(s, s)), t, MANAGER)
  assert.equal(prRoute(v([M, A, L1]), L1), L1)
  assert.equal(prRoute(v([M, A]), L1), A)
  assert.equal(prRoute(v([M, A], { ...lanes, [L1]: { ...lanes[L1], goneAt: 1 } }), L1), 'none')
  assert.equal(prRoute(v([M, A, L1], { ...lanes, [L1]: { ...lanes[L1], off: true } }), L1), 'none')
  assert.equal(prRoute(v([M]), LOOSE), 'none')
  assert.equal(prRoute(v([M, LOOSE]), LOOSE), LOOSE)
  assert.equal(prRoute(liveView('unknown', lanes, MANAGER), L1), 'hold')
})

test('the manager\'s digest: clicks in an asker\'s own panel counted per session, done, gone and ended gos; nothing for a lead, a spent key or a click by anyone else', () => {
  const b = base({ me: M })
  const x = { me: M, v: b.v, since: NOW - 1000, now: NOW, log: [] as NoticeIn['log'], signed: new Set<string>(), goes: [] as { id: string; giver: string; text: string; end: number }[], spent: new Set<string>() }
  const click = (ask: string, asker = L1) => ({ t: NOW, ev: 'closed' as const, ask, asker, code: 'click' })
  assert.deepEqual(digest(x), [])
  const log = [click('a'), click('b'), click('c', A), { ...click('d'), code: 'away' }, { t: NOW, ev: 'answered' as const, ask: 'e', asker: L1 }, click('f', LOOSE)]
  assert.deepEqual(digest({ ...x, log }).map((d) => [d.kind, d.about, d.n]), [['panel', L1, 2], ['panel', A, 1], ['panel', LOOSE, 1]])
  assert.deepEqual(digest({ ...x, log, spent: new Set(['digest:panel:a', 'digest:panel:b']) }).map((d) => [d.about, d.n]), [[A, 1], [LOOSE, 1]])
  assert.deepEqual(digest({ ...x, me: A, log, signed: new Set([L1]) }), [])
  assert.deepEqual(digest({ ...x, signed: new Set([L1]) }).map((d) => [d.kind, d.about]), [['done', L1]])
  const ended = { id: 'g1', giver: A, text: 'work', end: NOW - 10 }
  assert.deepEqual(digest({ ...x, goes: [ended, { ...ended, id: 'g2', end: NOW + 10 }, { ...ended, id: 'g3', end: NOW - 5000 }, { ...ended, id: 'g4', giver: 'sid-nobody' }] }).map((d) => [d.kind, d.about]), [['go', A]])
  assert.equal(digest({ ...x, log: Array.from({ length: 12 }, (_, i) => click(`m${i}`, `sid-x${i}`)) }).length, 0, 'only sessions under the manager count')
  assert.ok(DIGEST_MAX < 8 && digest({ ...x, log: [click('1', L1), click('2', A), click('3', B), click('4', LOOSE)], signed: new Set([L1]), goes: [ended] }).length === DIGEST_MAX)
})
