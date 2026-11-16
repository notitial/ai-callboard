import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, lstatSync, readFileSync, utimesSync, truncateSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit, render, eachLine, percentile, LEDGER_MAX_BYTES, KIND_CLASS } from './prompt-audit.mjs'
import { ROW_KINDS } from './mod/hooks/prompts.ts'

const SCRIPT = new URL('./prompt-audit.mjs', import.meta.url).pathname
const H = (c) => c.repeat(64)
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SID = '0a1b2c3d-0000-4000-8000-123456789abc'
const NOW = Date.now()
const BASE = NOW - 3600_000
const iso = (ms) => new Date(ms).toISOString()
const month = (ms) => iso(ms).slice(0, 7)

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'pa-'))
  const root = join(d, 'prompts')
  mkdirSync(root)
  return { d, root }
}
const R = (kind, at, f = {}) => ({ t: iso(at), kind, ...f })
const lines = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
function ledger(fx, rows, ms = BASE) {
  writeFileSync(join(fx.root, `ledger-${month(ms)}.jsonl`), lines(rows))
}
const T = { lane: 'api', repo: '/Users/x/api', tool: 'mcp__github__add_issue_comment', pattern: 'mcp__github__add_issue_comment x/y #3', hash: H('a') }
// A whole, ordinary request: on, requested, answered, returned.
function clean(id = uid(1), at = BASE, nonce = uid(101), extra = {}) {
  return [
    R('requested', at, { ...T, id, nonce, tier: 'lead', ...extra }),
    R('answered', at + 40_000, { ...T, id, nonce, tier: 'lead', why: 'reads only', code: 'allow', ...extra }),
    R('returned', at + 45_000, { ...T, id, code: 'allow', tier: 'lead', why: 'reads only', ...extra }),
  ]
}
const ON = (at = BASE - 60_000) => R('answering-on', at, { hash: H('9') })
const run = (fx, extra = {}) => audit({ root: fx.root, now: NOW, ...extra })
const rules = (rep) => rep.anomalies.map((a) => a.code).sort()

const snapshot = (dir) => {
  const out = []
  const walk = (p) => {
    const st = lstatSync(p)
    out.push(`${p} ${st.mtimeMs} ${st.size} ${st.mode}`)
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n))
  }
  walk(dir)
  return out
}

test('a clean ledger has no anomalies, one table row and the right wait', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.table.length, 1)
  const t = rep.table[0]
  assert.equal(t.outcome, 'returned')
  assert.equal(t.decision, 'allow')
  assert.equal(t.age, 45)
  assert.equal(t.hash8, 'aaaaaaaa')
  assert.equal(t.tier, 'lead')
  assert.equal(t.lane, 'api')
  assert.match(render(rep), /ANOMALIES \(must be empty\)\nnone/)
})

test('lead-offer and lead-offer-void rows are read, counted by kind, and are no anomaly beside an ordinary request', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), R('lead-offer', BASE + 1000, { hash: H('c'), repo: '/Users/x/api', lane: 'LEAD-A', nonce: '0123456789abcdef0123456789abcdef', by: SID }), R('lead-offer-void', BASE + 2000, { hash: H('c'), nonce: '0123456789abcdef0123456789abcdef', code: 'brief-write' })])
  const rep = run(fx)
  assert.deepEqual(rules(rep), [])
  assert.equal(rep.counts.rowsByKind['lead-offer'], 1)
  assert.equal(rep.counts.rowsByKind['lead-offer-void'], 1)
})

const N1 = '0123456789abcdef0123456789abcdef'
const N2 = 'fedcba9876543210fedcba9876543210'
const OFFER = (n, at, by = SID, h = 'c') => R('lead-offer', BASE + at, { hash: H(h), repo: '/Users/x/api', lane: 'LEAD-A', nonce: n, by })
const GRANT = (n, at, by = SID, h = 'c') => R('lead-grant', BASE + at, { hash: H(h), repo: '/Users/x/api', lane: 'LEAD-A', nonce: n, by, target: 'a1b2c3d4-0000-4000-8000-123456789abc' })

test('g: a lead-grant after its own offer is no anomaly; one with no offer, another conductor\'s offer or an offer after it is', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), OFFER(N1, 1000), GRANT(N1, 2000)])
  assert.deepEqual(rules(run(fx)), [])
  assert.equal(run(fx).counts.rowsByKind['lead-grant'], 1)
  for (const rows of [[GRANT(N1, 2000)], [OFFER(N1, 1000, 'b1b2c3d4-0000-4000-8000-123456789abc'), GRANT(N1, 2000)], [GRANT(N1, 1000), OFFER(N1, 2000)], [OFFER(N2, 1000), GRANT(N1, 2000)], [OFFER(N1, 1000, SID, 'd'), GRANT(N1, 2000)]]) {
    const f2 = fixture()
    ledger(f2, [ON(), ...clean(), ...rows])
    assert.deepEqual(rules(run(f2)), ['lead-grant-without-offer'])
  }
})

test('g: a grant with a void row of its nonce is listed; the hour is not spent by it', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), OFFER(N1, 1000), GRANT(N1, 2000), R('lead-offer-void', BASE + 3000, { hash: H('c'), nonce: N1, code: 'grant-failed' }), OFFER(N2, 4000), GRANT(N2, 5000)])
  assert.deepEqual(rules(run(fx)), ['lead-grant-voided'])
})

test('g: more than 8 grants by one conductor within an hour are an anomaly; 8, another conductor, or an hour apart are not', () => {
  const nonces = Array.from({ length: 9 }, (_, k) => `${String(k).padStart(2, '0')}`.repeat(16))
  const pair = (n, at, by = SID) => [OFFER(n, at, by), GRANT(n, at + 100, by)]
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), ...nonces.slice(0, 8).flatMap((n, k) => pair(n, 1000 + k * 1000))])
  assert.deepEqual(rules(run(fx)), [])
  const f2 = fixture()
  ledger(f2, [ON(), ...clean(), ...nonces.flatMap((n, k) => pair(n, 1000 + k * 1000))])
  assert.deepEqual(rules(run(f2)), ['lead-grants-over-backstop'])
  const f3 = fixture()
  ledger(f3, [ON(), ...clean(), ...nonces.slice(0, 8).flatMap((n, k) => pair(n, 1000 + k * 1000)), ...pair(nonces[8], 4000, 'b1b2c3d4-0000-4000-8000-123456789abc')])
  assert.deepEqual(rules(run(f3)), [])
  const f4 = fixture()
  ledger(f4, [ON(), ...clean(), ...nonces.slice(0, 8).flatMap((n, k) => pair(n, 1000 + k * 1000)), ...pair(nonces[8], 3_700_000)])
  assert.deepEqual(rules(run(f4)), [])
})

const LEADSID = 'a1b2c3d4-0000-4000-8000-123456789abc'
const OWNER = (code, at, o = {}) => R('lead-owner', BASE + at, { hash: H('c'), repo: '/Users/x/api', lane: 'LEAD-A', target: LEADSID, by: SID, ...o, code })

test('h: a made row after its own lead-grant, a joined row, and a leave then a join are no anomaly; the rows are counted', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), OFFER(N1, 1000), GRANT(N1, 2000), OWNER('made', 2500, { nonce: N1 }), OWNER('left', 3000, { was: SID }), OWNER('joined', 4000), OWNER('off', 5000, { was: SID }), OWNER('joined', 6000)])
  const rep = run(fx)
  assert.deepEqual(rules(rep), [])
  assert.equal(rep.counts.rowsByKind['lead-owner'], 5)
})

test('h: a made row with no earlier lead-grant of its repo, nonce and conductor is an anomaly', () => {
  for (const rows of [[OWNER('made', 2500, { nonce: N1 })], [OFFER(N1, 1000), GRANT(N1, 2000), OWNER('made', 2500, { nonce: N2 })], [OFFER(N1, 1000), GRANT(N1, 2000), OWNER('made', 2500, { nonce: N1, by: 'b1b2c3d4-0000-4000-8000-123456789abc' })], [OFFER(N1, 1000), GRANT(N1, 3000), OWNER('made', 2500, { nonce: N1 })], [OFFER(N1, 1000), GRANT(N1, 2000), OWNER('made', 2500, { nonce: N1, target: 'd1b2c3d4-0000-4000-8000-123456789abc' })]]) {
    const fx = fixture()
    ledger(fx, [ON(), ...clean(), ...rows])
    assert.ok(rules(run(fx)).includes('lead-owner-made-without-grant'), JSON.stringify(rules(run(fx))))
  }
})

test('h: a lead given a conductor twice with no leave between is an anomaly; another lead or another repo is not', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), OWNER('joined', 1000), OWNER('joined', 2000)])
  assert.deepEqual(rules(run(fx)), ['lead-owner-twice'])
  const f2 = fixture()
  ledger(f2, [ON(), ...clean(), OWNER('joined', 1000), OWNER('joined', 2000, { target: 'd1b2c3d4-0000-4000-8000-123456789abc' }), OWNER('joined', 3000, { hash: H('d') })])
  assert.deepEqual(rules(run(f2)), [])
})

test('a: a returned row with no answered row is an anomaly', () => {
  const fx = fixture()
  const rows = clean().filter((r) => r.kind !== 'answered')
  ledger(fx, [ON(), ...rows])
  assert.deepEqual(rules(run(fx)), ['returned-without-answered'])
})

test('a: an answered row whose nonce differs from the requested row is an anomaly', () => {
  const fx = fixture()
  const rows = clean()
  rows[1].nonce = uid(999)
  ledger(fx, [ON(), ...rows])
  assert.deepEqual(rules(run(fx)), ['answered-nonce-mismatch'])
})

test('a: an answered row with no requested row, and one later than the return, are anomalies', () => {
  const fx = fixture()
  const noReq = clean(uid(1)).filter((r) => r.kind !== 'requested')
  const late = clean(uid(2), BASE + 100_000, uid(102))
  late[1].t = iso(BASE + 100_000 + 60_000)
  ledger(fx, [ON(), ...noReq, ...late])
  assert.deepEqual(rules(run(fx)), ['answered-after-returned', 'answered-without-requested'])
})

test('a: dropped rows with a forgery code are anomalies, the ordinary codes are not', () => {
  const fx = fixture()
  const bad = ['no-answered-row', 'id', 'hash', 'nonce', 'by-sid', 'kind', 'answer']
  const fine = ['expired', 'ledger-unreadable', 'file', 'shape', 'dialog']
  const rows = [ON()]
  bad.forEach((code, i) => rows.push(R('requested', BASE + i, { ...T, id: uid(10 + i), nonce: uid(110 + i), tier: 'lead' }), R('dropped', BASE + 1000 + i, { ...T, id: uid(10 + i), code }), R('abandoned', BASE + 2000 + i, { id: uid(10 + i), code: 'swept' })))
  fine.forEach((code, i) => rows.push(R('requested', BASE + i, { ...T, id: uid(30 + i), nonce: uid(130 + i), tier: 'lead' }), R('dropped', BASE + 1000 + i, { ...T, id: uid(30 + i), code }), R('abandoned', BASE + 2000 + i, { id: uid(30 + i), code: 'swept' })))
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rules(rep), bad.map((c) => `dropped-${c}`).sort())
  assert.deepEqual(rep.notAnomalies.dropped.map((d) => d.code).sort(), [...fine].sort())
})

test('b: a request nothing ended for over 24 h is an anomaly; a young one and every abandoned code are not', () => {
  const fx = fixture()
  const old = NOW - 30 * 3600_000
  const rows = [ON(old - 60_000), R('requested', old, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }), R('requested', BASE, { ...T, id: uid(2), nonce: uid(102), tier: 'lead' })]
  ledger(fx, rows, BASE)
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['request-unended'])
  assert.equal(rep.anomalies[0].id, uid(1))
  assert.equal(rep.table.find((t) => t.id === uid(2)).outcome, 'open')
})

test('restarts and failed hooks are abandoned rows, never anomalies', () => {
  const fx = fixture()
  const old = NOW - 30 * 3600_000
  const rows = [ON(old - 60_000)]
  ;['session-gone', 'hook-failed', 'swept'].forEach((code, i) => rows.push(R('requested', old + i, { ...T, id: uid(50 + i), nonce: uid(150 + i), tier: 'lead' }), R('abandoned', old + 1000 + i, { id: uid(50 + i), code })))
  rows.push(R('abandoned', old + 5000, { code: 'hook-failed' }), R('abandoned', old + 6000, { ...T, code: 'no-tier' }))
  ledger(fx, rows, old)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.table.map((t) => t.outcome).sort(), ['abandoned hook-failed', 'abandoned session-gone', 'abandoned swept'])
  assert.equal(rep.notAnomalies.abandoned.length, 5)
})

test('expired-denied, off and superseded end a request cleanly', () => {
  const fx = fixture()
  const rows = [ON()]
  ;['expired-denied', 'off', 'superseded'].forEach((kind, i) => rows.push(R('requested', BASE + i, { ...T, id: uid(60 + i), nonce: uid(160 + i), tier: 'lead' }), R(kind, BASE + 1000 + i, { ...T, id: uid(60 + i) })))
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.table.map((t) => t.outcome).sort(), ['expired-denied', 'off', 'superseded'])
})

test('lost race in the ledger: a returned row and a superseded row for one request', () => {
  const fx = fixture()
  const rows = [ON(), ...clean(), R('superseded', BASE + 46_000, { ...T, id: uid(1) })]
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.lostRaces.length, 1)
  assert.equal(rep.table[0].outcome, 'returned')
})

test('a request for the plan-mode exit is a request like any other: no anomaly', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { tool: 'ExitPlanMode', pattern: 'ExitPlanMode', hash: H('c') })])
  assert.deepEqual(run(fx).anomalies, [])
})
test('a dialog row of an older ledger is read and is not an anomaly', () => {
  const fx = fixture()
  ledger(fx, [ON(), R('dialog', BASE - 1000, { ...T, tool: 'ExitPlanMode', pattern: 'ExitPlanMode' }), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
})

test('e: a request with no earlier answering-on row is an anomaly', () => {
  const fx = fixture()
  ledger(fx, clean())
  assert.deepEqual(rules(run(fx)), ['requested-before-answering-on'])
  ledger(fx, [ON(BASE + 10_000), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-before-answering-on'])
  ledger(fx, [R('answering-off', BASE - 1000, { code: 'off' }), ON(BASE - 500), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
})

test('e: each request is compared with the latest answering row at its time: a later off makes the on row stale, a later on restores it', () => {
  const fx = fixture()
  // On, then off, then a request raised while it was off: flagged.
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE - 1000, { code: 'off' }), ...clean()])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['requested-while-answering-off'])
  assert.match(rep.anomalies[0].detail, /answering was off/)
  // On, off, on again, then the request: fine.
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE - 2000, { code: 'off' }), ON(BASE - 1000), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
  // The questions row (a plain on followed by the asks row) is on.
  ledger(fx, [ON(BASE - 3000), R('answering-on', BASE - 2900, { code: 'asks' }), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
  // An off that only turned the questions off (an earlier mod's answering-off with code asks) leaves permission answering on.
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE - 1000, { code: 'asks' }), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
  // An off written in the same millisecond as the request but after it does not count for it; one written before does.
  ledger(fx, [ON(BASE - 3000), ...clean().slice(0, 1), R('answering-off', BASE, { code: 'off' }), ...clean().slice(1)])
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE, { code: 'off' }), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  // Two requests either side of an off are judged separately; a later off does not touch the earlier one.
  const a = clean(uid(1), BASE, uid(101))
  const b = clean(uid(2), BASE + 20_000, uid(102))
  ledger(fx, [ON(BASE - 3000), ...a, R('answering-off', BASE + 10_000, { code: 'off' }), ...b])
  const two = run(fx)
  assert.deepEqual(rules(two), ['requested-while-answering-off'])
  assert.equal(two.anomalies[0].id, uid(2))
})

test('e: an off typed between the hook\'s switch read and its requested row is not flagged when the request ends with an off row; a request raised while off still is', () => {
  const fx = fixture()
  const closedOff = (at) => [R('requested', at, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }), R('off', at + 5_000, { ...T, id: uid(1) })]
  // on, off, requested, off-closing: the race. Not an anomaly.
  ledger(fx, [ON(BASE - 60_000), R('answering-off', BASE - 2_000, { code: 'off' }), ...closedOff(BASE)])
  assert.deepEqual(run(fx).anomalies, [])
  // The same sequence, but the request was answered and returned: it ran while off. Flagged.
  ledger(fx, [ON(BASE - 60_000), R('answering-off', BASE - 2_000, { code: 'off' }), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  // Ends with off, but the off row is long before the request (not the hook's window): flagged.
  ledger(fx, [ON(BASE - 3_600_000), R('answering-off', BASE - 600_000, { code: 'off' }), ...closedOff(BASE)])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  // A request with no closing row at all: flagged.
  ledger(fx, [ON(BASE - 60_000), R('answering-off', BASE - 2_000, { code: 'off' }), closedOff(BASE)[0]])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
})

test('f: a request file older than 24 h in a session folder is an anomaly, by age only', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const dir = join(fx.root, SID)
  mkdirSync(dir)
  const stale = join(dir, `${uid(7)}.request.json`)
  const fresh = join(dir, `${uid(8)}.request.json`)
  writeFileSync(stale, '{}')
  writeFileSync(fresh, '{}')
  const old = new Date(NOW - 30 * 3600_000)
  utimesSync(stale, old, old)
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['stale-request-file'])
  assert.match(rep.anomalies[0].detail, new RegExp(uid(7)))
  assert.equal(rep.scanned.requestFiles, 2)
})

test('a month boundary: a request in one month and its decision in the next read as one request', () => {
  const fx = fixture()
  const t0 = Date.parse('2026-10-31T23:59:40.000Z')
  writeFileSync(join(fx.root, 'ledger-2026-10.jsonl'), lines([R('answering-on', t0 - 60_000, { hash: H('9') }), clean(uid(1), t0)[0], clean(uid(1), t0)[1]]))
  writeFileSync(join(fx.root, 'ledger-2026-11.jsonl'), lines([clean(uid(1), t0)[2]]))
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.scanned.ledgerFiles, 2)
  assert.equal(rep.table.length, 1)
  assert.equal(rep.table[0].outcome, 'returned')
  assert.equal(rep.table[0].age, 45)
})

test('garbage lines are tolerated, counted and never crash', () => {
  const fx = fixture()
  const rows = [ON(), 'not json', '{"kind":"requested"}', '[]', '{"t":"x","kind":"requested"}', JSON.stringify({ ...clean()[0], tool: 5 }), '\u0000\u0001\u0002', '', ...clean(), 'y'.repeat(70 * 1024)]
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.table.length, 1)
  assert.match(rep.notes.join('\n'), /7 ledger line\(s\) were not valid rows/)
})

test('a legacy floor row is skipped quietly, neither a row nor garbage', () => {
  const fx = fixture()
  ledger(fx, [ON(), JSON.stringify({ t: new Date(BASE).toISOString(), kind: 'floor', id: uid(9), code: 'settings' }), ...clean()])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.table.length, 1)
  assert.doesNotMatch(rep.notes.join('\n'), /not valid rows/)
})

test('--since keeps older requests and their anomalies out', () => {
  const fx = fixture()
  const oldAt = BASE - 5 * 86400_000
  const rows = [ON(oldAt - 60_000), ...clean(uid(1), oldAt, uid(101)).filter((r) => r.kind !== 'answered'), ...clean(uid(2), BASE, uid(102))]
  ledger(fx, rows, BASE)
  assert.deepEqual(rules(run(fx)), ['returned-without-answered'])
  const rep = run(fx, { since: BASE - 3600_000 })
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.table.map((t) => t.id), [uid(2)])
})

test('a symlinked ledger file is ignored and reported as a problem', () => {
  const fx = fixture()
  const real = join(fx.d, 'elsewhere.jsonl')
  writeFileSync(real, lines([ON(), ...clean()]))
  symlinkSync(real, join(fx.root, `ledger-${month(BASE)}.jsonl`))
  const rep = run(fx)
  assert.equal(rep.table.length, 0)
  assert.equal(rep.scanned.rows, 0)
  assert.match(rep.problems[0], /symlink/)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root], { encoding: 'utf8' })
  assert.equal(cli.status, 2)
})

test('an oversize ledger file is rejected cleanly, with the rest still read', () => {
  const fx = fixture()
  const big = join(fx.root, 'ledger-2026-01.jsonl')
  writeFileSync(big, '')
  truncateSync(big, LEDGER_MAX_BYTES + 1)
  ledger(fx, [ON(), ...clean()])
  const rep = run(fx)
  assert.equal(rep.table.length, 1)
  assert.match(rep.problems.join('\n'), /ledger-2026-01\.jsonl: too-large/)
  assert.throws(() => eachLine(big, { maxLine: 100, maxFileBytes: LEDGER_MAX_BYTES }, () => {}), /too-large/)
})

test('it writes nothing: no listing or mtime changes, and no write call in the source', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), 'garbage'])
  mkdirSync(join(fx.root, SID))
  writeFileSync(join(fx.root, SID, `${uid(7)}.request.json`), '{}')
  writeFileSync(join(fx.root, `questions-${month(BASE)}.jsonl`), '{"q":1}\n')
  const before = snapshot(fx.d)
  run(fx)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--json'], { encoding: 'utf8' })
  assert.ok(cli.status === 0 || cli.status === 1)
  assert.deepEqual(snapshot(fx.d), before)
  const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /\b(writeFile\w*|appendFile\w*|unlink\w*|mkdir\w*|rename\w*|rmSync|rmdir\w*|chmod\w*|copyFile\w*|symlinkSync|truncateSync|utimes\w*|createWriteStream)\(/)
  // The two mod sources it imports are pure: they load nothing but each other, so they bring no file access with them.
  const loads = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(?\s*['"]([^'"\n]+)['"]|\b(require)\s*\(/g)].map((m) => m[1] ?? m[2] ?? m[3])
  assert.deepEqual(loads('./mod/hooks/core.ts'), [])
  assert.deepEqual(loads('./mod/hooks/prompts.ts'), ['./core.ts'])
})

test('a questions file is counted and listed raw, truncated', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  writeFileSync(join(fx.root, `questions-${month(BASE)}.jsonl`), lines([{ t: iso(BASE), q: 'a' }, { t: iso(BASE), q: 'b'.repeat(500) }, 'junk']))
  const rep = run(fx)
  assert.equal(rep.questions.count, 3)
  assert.ok(rep.questions.rows[1].length <= 203)
  assert.deepEqual(rep.anomalies, [])
  assert.match(render(rep), /QUESTIONS: 3 row/)
})

test('counts: median and p90 wait per tier and per tool', () => {
  const fx = fixture()
  const rows = [ON()]
  const waits = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  waits.forEach((w, i) => {
    const id = uid(200 + i)
    const at = BASE + i * 1000
    rows.push(R('requested', at, { ...T, id, nonce: uid(300 + i), tier: 'lead' }), R('answered', at + w * 1000 - 1, { ...T, id, nonce: uid(300 + i), tier: 'lead' }), R('returned', at + w * 1000, { ...T, id, code: 'allow', tier: 'lead' }))
  })
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.counts.wait, { n: 10, median: 50, p90: 90 })
  assert.equal(rep.counts.byTier.lead.wait.p90, 90)
  assert.equal(rep.counts.byTool[T.tool].requests, 10)
  assert.equal(percentile([1, 2, 3], 50), 2)
  assert.equal(percentile([], 50), undefined)
})

test('eachLine: a line over the cap is skipped, lines across chunk edges are whole', () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-l-'))
  const p = join(d, 'f.jsonl')
  const a = 'a'.repeat(100_000)
  writeFileSync(p, `short\n${'z'.repeat(2000)}\n${a}\nlast`)
  const got = []
  const s = eachLine(p, { maxLine: 150_000 }, (l) => got.push(l.length))
  assert.deepEqual(got, [5, 2000, 100_000, 4])
  const got2 = []
  const s2 = eachLine(p, { maxLine: 3000 }, (l) => got2.push(l.length))
  assert.deepEqual(got2, [5, 2000, 4])
  assert.equal(s2.skippedLong, 1)
  assert.equal(s.skippedLong, 0)
  rmSync(d, { recursive: true })
})

test('the command line: exit codes, --json, defaults from CLAUDE_CONFIG_DIR, usage errors', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--json'], { encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.deepEqual(JSON.parse(ok.stdout).anomalies, [])
  const text = spawnSync(process.execPath, [SCRIPT, '--root', fx.root], { encoding: 'utf8' })
  assert.equal(text.status, 0)
  assert.match(text.stdout, /REQUESTS[\s\S]*ANOMALIES[\s\S]*NOT ANOMALIES[\s\S]*COUNTS/)

  const cfg = join(fx.d, 'cfg')
  mkdirSync(join(cfg, 'callboard', 'prompts'), { recursive: true })
  writeFileSync(join(cfg, 'callboard', 'prompts', `ledger-${month(BASE)}.jsonl`), lines(clean()))
  const dflt = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } })
  assert.equal(dflt.status, 1)
  assert.deepEqual(JSON.parse(dflt.stdout).anomalies.map((a) => a.code), ['requested-before-answering-on'])

  for (const args of [['--root', join(fx.d, 'nope')], ['--since', 'yesterdayish'], ['--bogus'], ['--projects', fx.d], ['--root']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } })
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /prompt audit:/)
  }
})

test('a1: a returned row that differs from the answered row in decision or author is an anomaly', () => {
  const fx = fixture()
  const BY = uid(900)
  const rows = (ansCode, retCode, ansBy, retBy) => {
    const r = clean()
    r[1] = { ...r[1], code: ansCode, ...(ansBy ? { by: ansBy } : {}) }
    r[2] = { ...r[2], code: retCode, ...(retBy ? { by: retBy } : {}) }
    return [ON(), ...r]
  }
  ledger(fx, rows('deny', 'allow'))
  assert.deepEqual(rules(run(fx)), ['returned-differs-from-answered'])
  ledger(fx, rows('allow', 'allow', BY, uid(901)))
  assert.deepEqual(rules(run(fx)), ['returned-differs-from-answered'])
  ledger(fx, rows('allow', 'allow', BY, BY))
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, rows('allow', 'allow', BY, undefined))
  assert.deepEqual(run(fx).anomalies, [])
})

test('a3: values from a ledger row cannot put control characters into the text output', () => {
  const fx = fixture()
  const evil = { pattern: 'x\u001b[2J\u001b[1;1H\u202eevil', lane: 'l\nnone\u2028X', why: 'a\rb\u0085c\u007fd', tool: 'Bash\u0007' }
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), evil)])
  const text = render(run(fx))
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
  assert.match(text, /x\\u001b\[2J\\u001b\[1;1H\\u202eevil/)
  assert.equal(text.split('\n').filter((l) => l === 'none').length, 1)
  assert.match(text, /l\\u000anone\\u2028X/)
  const json = JSON.parse(JSON.stringify(run(fx)))
  assert.equal(json.table[0].pattern, evil.pattern)
})

test('a4: with problems the text says INCOMPLETE in place of none', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  assert.match(render(run(fx)), /ANOMALIES \(must be empty\)\nnone\n/)
  const big = join(fx.root, 'ledger-2026-01.jsonl')
  writeFileSync(big, '')
  truncateSync(big, LEDGER_MAX_BYTES + 1)
  const text = render(run(fx))
  assert.match(text, /ANOMALIES \(must be empty\)\nINCOMPLETE: 1 problem\(s\), the audit did not see everything\n/)
  assert.doesNotMatch(text, /ANOMALIES \(must be empty\)\nnone/)
})

// ---- live test A fixes ----
const LEAD = 'bbbbbbbb-0000-4000-8000-123456789abc'
test('finding 1: a request with no ending row and no request file is a fault; with its file, or young, or on a lone ledger, it is not', () => {
  const fx = fixture()
  ledger(fx, [ON(), R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' })])
  // A ledger alone (no session folders): absence of files says nothing.
  assert.deepEqual(run(fx).anomalies, [])
  const sdir = join(fx.root, SID)
  mkdirSync(sdir)
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['request-closed-without-row'])
  assert.equal(rep.table[0].outcome, 'closed-no-row')
  // Young: the mod's tick has not had its time yet.
  assert.deepEqual(run(fx, { now: BASE + 5 * 60_000 }).anomalies, [])
  // The file is there: the request is open, not closed.
  writeFileSync(join(sdir, `${uid(1)}.request.json`), '{}')
  const open = run(fx)
  assert.deepEqual(open.anomalies, [])
  assert.equal(open.table[0].outcome, 'open')
  // An ending row of any kind closes it.
  rmSync(join(sdir, `${uid(1)}.request.json`))
  ledger(fx, [ON(), R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }), R('superseded', BASE + 20_000, { ...T, id: uid(1) })])
  assert.deepEqual(run(fx).anomalies, [])
})

// ---- tiers and the person relay ----
const MGR = 'dddddddd-0000-4000-8000-123456789abc'
const SHORT = uid(1).slice(0, 8)
const personRows = (extra = {}) => [
  R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
  R('relayed', BASE + 20_000, { ...T, id: uid(1), nonce: uid(101), code: 'manager', short: SHORT, by: MGR }),
  R('answered', BASE + 40_000, { ...T, id: uid(1), nonce: uid(101), tier: 'manager', why: 'the person said yes', code: 'allow', by: MGR, via: 'person', short: SHORT, ...extra }),
  R('returned', BASE + 45_000, { ...T, id: uid(1), code: 'allow', tier: 'manager', why: 'the person said yes', by: MGR, via: 'person', short: SHORT, ...extra }),
]
test('tiers: the person\'s answer through a relay is no anomaly beside its relayed row, and is counted', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...personRows()])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.problems, [])
  assert.equal(rep.notAnomalies.relay.relayed.n, 1)
  assert.equal(rep.notAnomalies.relay.personAnswers.n, 1)
  ledger(fx, [ON(), ...personRows({ code: 'deny' })])
  assert.deepEqual(run(fx).anomalies, [])
})
test('tiers: the person\'s answer through a lower tier\'s relay (the lead they said they are with, a manager live above it) is no anomaly', () => {
  const fx = fixture()
  const viaLead = (r) => (r.kind === 'requested' ? r : { ...r, by: LEAD, ...(r.kind === 'relayed' ? { code: 'lead' } : { tier: 'lead' }) })
  ledger(fx, [ON(), R('here-on', BASE - 60_000, { by: LEAD, tier: 'lead', end: iso(BASE + 12 * 3600_000) }), ...personRows().map(viaLead), R('here-off', BASE + 50_000, { code: 'off', by: LEAD, was: LEAD })])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.problems, [])
  assert.equal(rep.notAnomalies.relay.personAnswers.n, 1)
  assert.deepEqual([rep.counts.rowsByKind['here-on'], rep.counts.rowsByKind['here-off']], [1, 1])
  // The relayed row must still be that tier's own: a manager's row does not back the lead's answer.
  ledger(fx, [ON(), ...personRows().map((r) => (r.kind === 'relayed' ? r : viaLead(r)))])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relayed-row'])
})
test('tiers: an agent\'s answer while the request is with the person is an anomaly, unless a relay-lost row came first', () => {
  const fx = fixture()
  const rows = (lost) => [
    R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
    R('relayed', BASE + 20_000, { ...T, id: uid(1), nonce: uid(101), code: 'manager', short: SHORT, by: MGR }),
    ...(lost ? [R('relay-lost', BASE + 30_000, { ...T, id: uid(1), code: 'not-asked', short: SHORT, by: MGR, tier: 'manager' })] : []),
    R('answered', BASE + 40_000, { ...T, id: uid(1), nonce: uid(101), tier: 'lead', why: 'reads only', code: 'allow', by: LEAD }),
    R('returned', BASE + 45_000, { ...T, id: uid(1), code: 'allow', tier: 'lead', why: 'reads only', by: LEAD }),
  ]
  ledger(fx, [ON(), ...rows(false)])
  assert.deepEqual(rules(run(fx)), ['answered-while-relayed', 'returned-while-relayed'])
  ledger(fx, [ON(), ...rows(true)])
  const ok = run(fx)
  assert.deepEqual(ok.anomalies, [])
  assert.equal(ok.notAnomalies.relay['relay-lost'].n, 1)
  assert.deepEqual(ok.notAnomalies.relay['relay-lost'].codes, { 'not-asked': 1 })
})
test('tiers: a tier that passed a request up does not answer it afterwards; another tier does', () => {
  const fx = fixture()
  const rows = (answerer) => [
    R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
    R('escalated', BASE + 20_000, { ...T, id: uid(1), code: 'lead', tier: 'lead', why: 'unsure' }),
    R('answered', BASE + 40_000, { ...T, id: uid(1), nonce: uid(101), tier: answerer, why: 'reads only', code: 'allow', by: LEAD }),
    R('returned', BASE + 45_000, { ...T, id: uid(1), code: 'allow', tier: answerer, why: 'reads only', by: LEAD }),
  ]
  ledger(fx, [ON(), ...rows('lead')])
  assert.deepEqual(rules(run(fx)), ['answered-after-own-pass-up'])
  ledger(fx, [ON(), ...rows('conductor')])
  assert.deepEqual(run(fx).anomalies, [])
})
test('tiers: relay-left, relay-late, relay-closed, expired-denied and deny-unclear are listed and counted, never anomalies', () => {
  const fx = fixture()
  ledger(fx, [
    ON(),
    R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
    R('relayed', BASE + 20_000, { ...T, id: uid(1), nonce: uid(101), code: 'conductor', short: SHORT, by: MGR }),
    R('relay-left', BASE + 30_000, { id: uid(1), short: SHORT, by: MGR, tier: 'conductor' }),
    R('relay-late', BASE + 40_000, { short: 'ffffffff', by: MGR, code: 'closed' }),
    R('relay-closed', BASE + 45_000, { id: uid(1), short: SHORT, by: MGR, tier: 'conductor' }),
    R('expired-denied', BASE + 50_000, { ...T, id: uid(1), code: 'timeout' }),
    R('deny-unclear', BASE + 60_000, { ...T, id: uid(2), nonce: uid(102), code: 'deny', by: LEAD }),
  ])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  const r = rep.notAnomalies.relay
  assert.deepEqual([r.relayed.n, r['relay-left'].n, r['relay-late'].n, r['expired-denied'].n, r['deny-unclear'].n], [1, 1, 1, 1, 1])
  const text = render(rep)
  assert.match(text, /relay-late: 1 \(closed 1\)/)
  assert.match(text, /expired-denied: 1 \(timeout 1\)/)
  assert.match(text, /relayed: 1 \(conductor 1\)/)
  // The tier that asked, not "(none)": a relay-left row carries it in `tier`.
  assert.deepEqual(r['relay-left'].codes, { conductor: 1 })
  assert.match(text, /relay-left: 1 \(conductor 1\)/)
  assert.deepEqual(r['relay-closed'], { n: 1, codes: { conductor: 1 } })
  assert.match(text, /relay-closed: 1 \(conductor 1\)/)
})
test('tiers: a person answer needs a relayed row of the same tier session and the request\'s own short id; the row\'s say-so does not count', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...personRows().filter((r) => r.kind !== 'relayed')])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relayed-row'])
  // A relayed row of another tier session, or one written after the answer, does not count.
  ledger(fx, [ON(), ...personRows().map((r) => (r.kind === 'relayed' ? { ...r, by: LEAD } : r))])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relayed-row'])
  ledger(fx, [ON(), ...personRows().map((r) => (r.kind === 'relayed' ? { ...r, t: iso(BASE + 41_000) } : r))])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relayed-row'])
  ledger(fx, [ON(), ...personRows({ short: 'ffffffff' })])
  assert.deepEqual(rules(run(fx)), ['person-answer-short-mismatch'])
})
test('tiers: a person answer through the second tier is backed by that tier\'s own relayed row, not the first (the first relay was lost)', () => {
  const fx = fixture()
  const COND = '00000000-0000-4000-8000-0000000000c1'
  const rows = personRows({}).map((r) => (r.kind === 'answered' || r.kind === 'returned' ? { ...r, by: COND, tier: 'conductor' } : r))
  rows.splice(2, 0, R('relayed', BASE + 30_000, { ...T, id: uid(1), nonce: uid(101), code: 'conductor', short: SHORT, by: COND }))
  ledger(fx, [ON(), ...rows])
  assert.deepEqual(run(fx).anomalies, [])
})
test('tiers: each relayed request is listed with its tool and pattern', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...personRows()])
  const rep = run(fx)
  assert.equal(rep.notAnomalies.relayedRequests.length, 1)
  assert.equal(rep.notAnomalies.relayedRequests[0].laneQuestion, undefined)
  const text = render(rep)
  assert.match(text, /RELAYED \(each request taken to the person/)
  assert.match(text, new RegExp(`${SHORT} manager mcp__github__add_issue_comment`))
})

test('e: the rows the default-on writes (answering-on code default, then asks) cover a request and a question; a guard off row makes the next request stale', () => {
  const fx = fixture()
  const DEFAULT = (at) => R('answering-on', at, { code: 'default', hash: H('7') })
  ledger(fx, [DEFAULT(BASE - 3000), R('answering-on', BASE - 2900, { code: 'asks' }), ...clean(), ...qClean({ id: uid(2), at: BASE + 60_000 })])
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, [DEFAULT(BASE - 3000), R('answering-on', BASE - 2900, { code: 'asks' }), R('answering-off', BASE - 1000, { code: 'guard' }), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  ledger(fx, [...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-before-answering-on'])
})

// ---- questions ----
const lhOf = (id, label) => createHash('sha256').update(`${id}\n${label}`).digest('hex').slice(0, 16)
const QT = { lane: 'api', repo: '/Users/x/api', tool: 'AskUserQuestion', pattern: 'AskUserQuestion', hash: H('q') }
// The second `answering-on` row of `/callboard escalation` (code asks); it comes after the plain ON() row so that it is the one in force.
const ASKS = (at = BASE - 50_000) => R('answering-on', at, { code: 'asks', hash: H('8') })
// A tier's answer to a question: requested, answered, returned (code answer, with opt and the salted label hash).
function qClean({ id = uid(1), at = BASE, nonce = uid(101), label = 'Green', tier = 'lead' } = {}) {
  const f = { ...QT, id, tier, code: 'answer', opt: '1', lh: lhOf(id, label), why: 'settled by the brief' }
  return [R('requested', at, { ...QT, id, nonce, tier }), R('answered', at + 40_000, { ...f, nonce }), R('returned', at + 45_000, f)]
}
// The person's pick through a tier's relay: requested, relayed, answered and returned via person.
function qPerson({ id = uid(1), at = BASE, label = 'Green', lh = lhOf(id, label.trim()), by = MGR } = {}) {
  const short = id.slice(0, 8)
  const f = { ...QT, id, tier: 'manager', code: 'answer', opt: '1', lh, why: 'the person picked option 2', by, via: 'person', short }
  return [
    R('requested', at, { ...QT, id, nonce: uid(101), tier: 'lead' }),
    R('relayed', at + 20_000, { ...QT, id, nonce: uid(101), code: 'manager', short, by }),
    R('answered', at + 40_000, { ...f, nonce: uid(101) }),
    R('returned', at + 45_000, f),
  ]
}
const qrow = (extra = {}) => ({ t: iso(BASE), id: uid(1), lane: 'api', repo: '/Users/x/api', tier: 'lead', by: LEAD, header: 'Color', question: 'Which color?', options: ['Red', 'Green'], label: 'Green', ...extra })
const qfile = (fx, rows, ms = BASE) => writeFileSync(join(fx.root, `questions-${month(ms)}.jsonl`), lines(rows))

test('questions: q-no-asks-on: an asks row in force is needed; a later plain on, any off, or none at all is an anomaly', () => {
  const fx = fixture()
  const q = qClean()
  // `asks LANE`, then `on Y` (clears the questions scope), then a question request.
  ledger(fx, [ON(BASE - 120_000), ASKS(BASE - 90_000), ON(BASE - 60_000), ...q])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['q-no-asks-on'])
  assert.equal(rep.anomalies[0].id, uid(1))
  assert.equal(rep.anomalies[0].rule, 'q')
  ledger(fx, [ON(BASE - 120_000), ASKS(BASE - 90_000), R('answering-off', BASE - 60_000, { code: 'asks' }), ...q])
  assert.deepEqual(rules(run(fx)), ['q-no-asks-on'])
  ledger(fx, [ON(BASE - 120_000), ...q])
  assert.deepEqual(rules(run(fx)), ['q-no-asks-on'])
  // asks on, then asks widened, then the question: in force. An `on Y` after the question changes nothing.
  ledger(fx, [ON(BASE - 120_000), ASKS(BASE - 90_000), ASKS(BASE - 60_000), ...q, ON(BASE + 60_000)])
  assert.deepEqual(run(fx).anomalies, [])
  // Permission requests need no asks row.
  ledger(fx, [ON(), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: the two rows one /callboard escalation writes, in the same millisecond, put a later question in force', () => {
  const fx = fixture()
  ledger(fx, [ON(BASE - 60_000), ASKS(BASE - 60_000), ...qClean()])
  assert.deepEqual(run(fx).anomalies, [])
  // The plain row alone (the asks row never written) is not enough.
  ledger(fx, [ON(BASE - 60_000), ...qClean()])
  assert.deepEqual(rules(run(fx)), ['q-no-asks-on'])
})
test('questions: q-answer-not-question and q-decided-question', () => {
  const fx = fixture()
  const bash = clean(uid(2), BASE, uid(102)).map((r) => (r.kind === 'requested' ? r : { ...r, code: 'answer', opt: '0', lh: lhOf(uid(2), 'Green') }))
  ledger(fx, [ON(), ASKS(), ...bash])
  let rep = run(fx)
  assert.deepEqual(rules(rep), ['q-answer-not-question', 'q-answer-not-question'])
  assert.equal(rep.anomalies[0].id, uid(2))
  // A question decided allow or deny, in an answered row, a returned row or an expired-denied row.
  const decided = clean(uid(3), BASE, uid(103), { tool: 'AskUserQuestion', pattern: 'AskUserQuestion', hash: H('q') })
  const expired = [R('requested', BASE + 1000, { ...QT, id: uid(4), nonce: uid(104), tier: 'lead' }), R('expired-denied', BASE + 2000, { ...QT, id: uid(4), code: 'timeout' })]
  ledger(fx, [ON(), ASKS(), ...decided, ...expired])
  rep = run(fx)
  assert.deepEqual(rules(rep), ['q-decided-question', 'q-decided-question', 'q-decided-question'])
  assert.deepEqual([...new Set(rep.anomalies.map((a) => a.id))].sort(), [uid(3), uid(4)])
  // A question answered properly, with the same shape, has none of them.
  ledger(fx, [ON(), ASKS(), ...qClean()])
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: q-returned-differs: the returned answer must carry the answered row\'s option and label hash', () => {
  const fx = fixture()
  const rows = (ret) => {
    const r = qClean()
    r[2] = { ...r[2], ...ret }
    return [ON(), ASKS(), ...r]
  }
  ledger(fx, rows({}))
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, rows({ opt: '0' }))
  assert.deepEqual(rules(run(fx)), ['q-returned-differs'])
  ledger(fx, rows({ lh: lhOf(uid(1), 'Red') }))
  assert.deepEqual(rules(run(fx)), ['q-returned-differs'])
  ledger(fx, rows({ lh: undefined }))
  assert.deepEqual(rules(run(fx)), ['q-returned-differs'])
})
test('questions: the opt and lh fields are read, and a non-string one drops the row like any other', () => {
  const fx = fixture()
  const r = qClean()
  ledger(fx, [ON(), ASKS(), ...r, JSON.stringify({ ...r[2], opt: 1 })])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.match(rep.notes.join('\n'), /1 ledger line\(s\) were not valid rows/)
})
test('a note counts the agents\' allows of asks a hook, setting, plugin or ceiling raised, by what raised them; a rule\'s ask is not counted', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { raised: 'hook' }), ...clean(uid(2), BASE + 60_000, uid(102), { raised: 'hook' }), ...clean(uid(3), BASE + 120_000, uid(103), { raised: 'ceiling' }), ...clean(uid(4), BASE + 180_000, uid(104), { raised: 'rule' }), ...clean(uid(5), BASE + 240_000, uid(105))])
  const rep = run(fx)
  assert.ok(rep.notes.includes("agents' allows and answers of asks raised by a hook, setting, plugin or ceiling: ceiling 1, hook 2"), rep.notes.join('|'))
  const none = fixture()
  ledger(none, [ON(), ...clean(uid(1), BASE, uid(101), { raised: 'rule' })])
  assert.equal(run(none).notes.some((x) => x.startsWith("agents' allows and answers of asks raised")), false)
})

test('the note counts a tier\'s answer to a question a hook raised', () => {
  const fx = fixture()
  const q = qClean()
  ledger(fx, [ON(), ASKS(), { ...q[0], raised: 'hook' }, q[1], q[2]])
  const rep = run(fx)
  assert.ok(rep.notes.includes("agents' allows and answers of asks raised by a hook, setting, plugin or ceiling: hook 1"), rep.notes.join('|'))
})

test('a: a requested row that names an unknown source of the ask is an anomaly; a known one and a row with none are not', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { raised: 'other' }), ...clean(uid(2), BASE + 60_000, uid(102), { raised: 'guard' }), ...clean(uid(3), BASE + 120_000, uid(103))])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['raised-unknown'])
  assert.equal(rep.anomalies[0].id, uid(1))
})

test('questions: the notes: no questions row, a row past 90 days, not-judgeable counts, and the QUESTIONS table', () => {
  const fx = fixture()
  ledger(fx, [ON(), ASKS(), ...qClean(), R('not-judgeable', BASE + 100, { ...QT, code: 'question-scope' }), R('not-judgeable', BASE + 200, { ...QT, code: 'question-scope' }), R('not-judgeable', BASE + 300, { ...QT, code: 'question-multi' }), R('not-judgeable', BASE + 400, { ...T, code: 'no-check' })])
  let rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.ok(rep.notes.includes('1 returned question answer(s) have no questions row (a failed write, or the row was pruned)'), rep.notes.join('|'))
  assert.ok(rep.notes.includes('not-judgeable question rows by code: question-multi 1, question-scope 2'), rep.notes.join('|'))
  assert.equal(rep.notes.some((n) => /older than 90 days/.test(n)), false)
  const old = BASE - 100 * 86400_000
  qfile(fx, [qrow({ t: iso(BASE) }), qrow({ t: iso(old), id: uid(9), question: 'An old one?' }), qrow({ t: iso(BASE), id: uid(8), tier: 'manager', via: 'person', question: 'q'.repeat(300), header: 'Name', label: 'Beta' }), 'junk'])
  rep = run(fx)
  assert.equal(rep.notes.some((n) => /no questions row/.test(n)), false)
  assert.ok(rep.notes.includes('1 questions row(s) are older than 90 days (the prune is behind)'), rep.notes.join('|'))
  assert.equal(rep.questions.count, 4)
  assert.equal(rep.questions.list.length, 3)
  assert.equal(rep.questions.unreadable, 1)
  const text = render(rep)
  assert.match(text, /QUESTIONS: 4 row\(s\) in 1 file\(s\)/)
  assert.match(text, /time\s+lane\s+tier\s+header\s+question\s+label/)
  assert.match(text, /api\s+lead\s+Color\s+Which color\?\s+Green/)
  assert.match(text, /api\s+person via manager\s+Name\s+q{150,}~?\s+Beta/)
  assert.doesNotMatch(text, /q{201}/)
  assert.match(text, /1 row\(s\) were not valid JSON objects/)
  // --since keeps the old row out of the listing, but the note still counts it.
  rep = run(fx, { since: BASE - 3600_000 })
  assert.equal(rep.questions.list.length, 2)
  assert.ok(rep.notes.some((n) => /1 questions row\(s\) are older than 90 days/.test(n)))
})
test('questions: a relayed question is listed with the lane\'s own question, found by id with no cap on the file', () => {
  const fx = fixture()
  ledger(fx, [ON(), ASKS(), ...qPerson({ label: 'Green' })])
  // 250 earlier rows: the listing keeps 200, the join finds the row at the end all the same.
  const filler = Array.from({ length: 250 }, (_, i) => qrow({ t: iso(BASE - 1000 + i), id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, question: `Filler ${i}?` }))
  qfile(fx, [...filler, qrow({ tier: 'manager', via: 'person', question: 'Which color should the page use?', header: 'Color' })])
  const rep = run(fx)
  assert.equal(rep.questions.count, 251)
  assert.equal(rep.questions.list.length, 200)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notes.some((n) => /no questions row/.test(n)), false)
  assert.equal(rep.notAnomalies.relayedRequests[0].laneQuestion.question, 'Which color should the page use?')
  assert.match(render(rep), /the lane asked: \[Color\] Which color should the page use\? \(options: Red \| Green\)/)
})

// The audit takes its row kinds from the mod's own list, so a row of every kind the mod writes is read as a row; and each kind has a place in the audit, so
// a kind added to the mod fails here until it is placed.
test('the audit reads a row of every kind the mod writes, and has a place for each', () => {
  const fx = fixture()
  assert.ok(ROW_KINDS.length > 10)
  assert.deepEqual(Object.keys(KIND_CLASS).sort(), [...ROW_KINDS].sort())
  assert.deepEqual([...new Set(Object.values(KIND_CLASS))].sort(), ['end', 'go', 'other', 'request'])
  assert.deepEqual(ROW_KINDS.filter((k) => k.startsWith('go-')).sort(), Object.keys(KIND_CLASS).filter((k) => KIND_CLASS[k] === 'go').sort())
  ledger(fx, ROW_KINDS.map((kind, i) => R(kind, BASE + i)))
  const rep = run(fx)
  assert.deepEqual(Object.keys(rep.counts.rowsByKind).sort(), [...ROW_KINDS].sort())
  assert.equal(rep.scanned.rows, ROW_KINDS.length)
  assert.deepEqual(rep.problems, [])
  assert.ok(!rep.notes.some((n) => /not valid rows/.test(n)))
})

test('a row of a kind the mod does not write is a problem that names the kind (exit 2), not a quiet note; --since keeps an older one out', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), R('go-extend', BASE, { id: uid(5) }), R('go-extend', BASE + 1), R('no-such-kind', BASE - 7200_000), { kind: 'no-time' }])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.problems, ['ledger: 4 row(s) of a kind the audit does not know were not read (go-extend 2, no-such-kind 1, no-time 1)'])
  assert.equal(rep.table.length, 1)
  assert.match(render(rep), /INCOMPLETE: 1 problem/)
  assert.match(run(fx, { since: BASE - 3600_000 }).problems[0], /3 row\(s\).*\(go-extend 2, no-time 1\)/)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root], { encoding: 'utf8' })
  assert.equal(cli.status, 2)
})

test('the script copied out of its checkout cannot load the mod\'s definitions: exit 2 with a line that says so', () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-alone-'))
  writeFileSync(join(d, 'prompt-audit.mjs'), readFileSync(SCRIPT))
  const r = spawnSync(process.execPath, [join(d, 'prompt-audit.mjs'), '--root', d], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /prompt audit: cannot load the mod's definitions/)
  rmSync(d, { recursive: true })
})

// ---- i. lead tools and lead stops (ADR 0007) ----
const LSID = 'a1b2c3d4-0000-4000-8000-123456789abc'
const IOWNER = (code, at, by = SID, extra = {}) => R('lead-owner', BASE + at, { code, hash: H('c'), repo: '/Users/x/api', lane: 'LEAD-A', target: LSID, by, ...extra })
const LEADROW = (kind, at, f = {}) => R(kind, BASE + at, { hash: H('c'), repo: '/Users/x/api', lane: 'LEAD-A', by: SID, target: LSID, tier: 'conductor', dialog: 'none', ...f })
const STOP = (code, at, f = {}) => LEADROW('lead-stop', at, { code, ...f })
const RESUME = (at, f = {}) => LEADROW('lead-resume', at, f)
function records(fx, key, leads, repo = '/Users/x/api') {
  const dir = join(fx.d, 'lead-records')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ repo, leads }))
  return dir
}

test('i: a conductor\'s lead rows need it to own the lead by the newest lead-owner row at or before them; a row with no lead session is not judged', () => {
  const fx = fixture()
  ledger(fx, [ON(), IOWNER('joined', 0), STOP('park', 1000), RESUME(2000), STOP('terminate', 3000, { dialog: 'yes' })])
  assert.deepEqual(rules(run(fx)), [])
  assert.equal(run(fx).counts.rowsByKind['lead-stop'], 2)
  const other = uid(77)
  for (const [rows, want] of [
    [[STOP('retire', 1000)], ['lead-stop-not-owner']],
    [[IOWNER('joined', 0, other), RESUME(1000)], ['lead-resume-not-owner']],
    [[IOWNER('joined', 0), IOWNER('left', 500, undefined, { was: SID }), STOP('park', 1000)], ['lead-stop-not-owner']],
    [[STOP('park', 1000), IOWNER('joined', 2000)], ['lead-stop-not-owner']],
    [[IOWNER('joined', 0, SID, { hash: H('d') }), STOP('park', 1000)], ['lead-stop-not-owner']],
    [[STOP('remove', 1000, { target: undefined })], []],
  ]) {
    const f = fixture()
    ledger(f, [ON(), ...rows])
    assert.deepEqual(rules(run(f)), want, rows.map((r) => `${r.kind} ${r.code ?? ''}`).join(', '))
  }
})

test('i: a force stop, and every lead row of the manager, needs a yes from the person\'s dialog', () => {
  for (const [row, want] of [
    [STOP('terminate', 1000), ['lead-stop-no-dialog']],
    [STOP('terminate', 1000, { dialog: 'yes' }), []],
    [STOP('retire', 1000), []],
    [STOP('park', 1000, { tier: 'manager' }), ['lead-stop-no-dialog']],
    [STOP('unpark', 1000, { tier: 'manager', dialog: 'yes' }), []],
    [STOP('remove', 1000, { tier: 'manager', target: undefined }), ['lead-stop-no-dialog']],
    [RESUME(1000, { tier: 'manager' }), ['lead-resume-no-dialog']],
    [RESUME(1000, { tier: 'manager', dialog: 'yes' }), []],
  ]) {
    const f = fixture()
    ledger(f, [ON(), IOWNER('joined', 0), row])
    assert.deepEqual(rules(run(f)), want, JSON.stringify(row))
  }
})

test('i: each lead record with a session needs a lead-owner row giving it its conductor; a rename and a record with no session raise nothing', () => {
  const fx = fixture()
  ledger(fx, [ON(), IOWNER('joined', 0)])
  assert.equal(run(fx).scanned.leadRecordFiles, null)
  assert.match(render(run(fx)), /lead records not checked \(no folder\)/)
  records(fx, H('c'), [
    { name: 'RENAMED', createdAt: 1, how: 'made', conductorSid: SID, sid: LSID },
    { name: 'KEPT', createdAt: 1, how: 'joined', conductorSid: uid(78) },
  ])
  const rep = run(fx)
  assert.equal(rep.scanned.leadRecordFiles, 1)
  assert.deepEqual(rules(rep), [])
  assert.match(render(rep), /lead record files 1/)
  records(fx, H('c'), [{ name: 'LEAD-A', createdAt: 1, how: 'made', conductorSid: uid(77), sid: LSID }])
  assert.deepEqual(rules(run(fx)), ['lead-owner-unlogged'])
  records(fx, H('c'), [{ name: 'LEAD-A', createdAt: 1, how: 'made', conductorSid: SID, sid: LSID }])
  records(fx, H('d'), [{ name: 'LEAD-B', createdAt: 1, how: 'made', conductorSid: SID, sid: uid(79) }])
  assert.deepEqual(rules(run(fx)), ['lead-owner-unlogged'])
  ledger(fx, [ON(), IOWNER('joined', 0), IOWNER('left', 500, undefined, { was: SID })])
  rmSync(join(fx.d, 'lead-records', `${H('d')}.json`))
  assert.deepEqual(rules(run(fx)), ['lead-owner-unlogged'])
})

test('i: --records that cannot be read is a problem (exit 2); a linked or broken record file is a problem, never a pass', () => {
  const fx = fixture()
  ledger(fx, [ON()])
  const missing = join(fx.d, 'nope')
  assert.match(run(fx, { records: missing, recordsExplicit: true }).problems.join('\n'), /--records/)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--records', missing], { encoding: 'utf8' })
  assert.equal(cli.status, 2)
  const dir = records(fx, H('c'), [])
  writeFileSync(join(dir, `${H('e')}.json`), 'not json')
  symlinkSync(join(dir, `${H('c')}.json`), join(dir, `${H('f')}.json`))
  const rep = run(fx)
  assert.equal(rep.scanned.leadRecordFiles, 1)
  const p = rep.problems.join('\n')
  assert.match(p, /e{64}\.json: not a lead record file/)
  assert.match(p, /f{64}\.json: a symlink/)
})

// ---- the go (ADR 0009) ----
const GOID = uid(900)
const goFile = (fx, id, over = {}) => {
  const dir = join(fx.d, 'go')
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify({ v: 1, id, by: { level: 'lead', sid: SID, name: 'LEAD', repo: '/Users/x/api' }, at: BASE, ends: NOW + 3600_000, text: 'Build the API.', covered: [], nonce: '0'.repeat(32), ...over })
  writeFileSync(join(dir, `${id}.json`), body)
  return createHash('sha256').update(body).digest('hex')
}
const GOGRANT = (id, hash, f = {}) => R('go-grant', BASE, { id, by: SID, tier: 'lead', hash, end: iso(NOW + 3600_000), repo: '/Users/x/api', lane: 'LEAD', ...f })

test('j: a go whose file and go-grant row agree raises nothing, is no request, and is listed with its text and its readers', () => {
  const fx = fixture()
  const hash = goFile(fx, GOID)
  ledger(fx, [ON(), GOGRANT(GOID, hash), R('go-read', BASE + 1000, { id: GOID, by: uid(31), code: 'later', lane: 'API' })])
  const rep = run(fx)
  assert.deepEqual(rules(rep), [])
  assert.equal(rep.scanned.goFiles, 1)
  assert.equal(rep.scanned.requests, 0)
  assert.deepEqual(rep.goes, [{ id: GOID, t: iso(BASE), by: SID, lane: 'LEAD', repo: '/Users/x/api', end: iso(NOW + 3600_000), state: 'live', text: 'Build the API.', readers: [{ t: iso(BASE + 1000), by: uid(31), lane: 'API', code: 'later' }] }])
  const text = render(rep)
  assert.match(text, /GOES/)
  assert.match(text, /text: Build the API\./)
  assert.match(text, new RegExp(`read by: API \\(${uid(31)}, later\\)`))
  // With no go folder there are no go files, and no go section when no go was given.
  const bare = fixture()
  ledger(bare, [ON()])
  assert.equal(run(bare).scanned.goFiles, 0)
  assert.doesNotMatch(render(run(bare)), /GOES/)
})

test('j: a go file with no go-grant row, or whose bytes do not hash to its row, is an anomaly', () => {
  const fx = fixture()
  goFile(fx, GOID)
  ledger(fx, [ON()])
  assert.deepEqual(rules(run(fx)), ['go-file-no-row'])
  ledger(fx, [ON(), GOGRANT(GOID, H('b'))])
  assert.deepEqual(rules(run(fx)), ['go-file-no-row'])
  const hash = goFile(fx, GOID)
  ledger(fx, [ON(), GOGRANT(GOID, hash)])
  assert.deepEqual(rules(run(fx)), [])
  goFile(fx, GOID, { text: 'Anything at all.' })
  assert.deepEqual(rules(run(fx)), ['go-file-no-row'])
  // A row of another session than the file names.
  ledger(fx, [ON(), GOGRANT(GOID, goFile(fx, GOID), { by: uid(55) })])
  assert.deepEqual(rules(run(fx)), ['go-file-no-row'])
})

test('j: a go-grant row with its end ahead, no go-end row and no file is an anomaly; an ended or expired one is not', () => {
  const fx = fixture()
  mkdirSync(join(fx.d, 'go'))
  ledger(fx, [ON(), GOGRANT(GOID, H('a'))])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['go-row-no-file'])
  assert.equal(rep.goes[0].text, null)
  assert.match(render(rep), /text: \(no go file\)/)
  for (const code of ['off', 'void', 'grantor-off', 'expired']) {
    ledger(fx, [ON(), GOGRANT(GOID, H('a')), R('go-end', BASE + 5000, { id: GOID, code })])
    const ended = run(fx)
    assert.deepEqual(rules(ended), [], code)
    assert.match(ended.goes[0].state, new RegExp(`^ended \\(${code},`))
  }
  ledger(fx, [ON(), GOGRANT(GOID, H('a'), { end: iso(NOW - 1000) })])
  assert.deepEqual(rules(run(fx)), [])
  assert.equal(run(fx).goes[0].state, 'ended (end time)')
})

test('j: --goes that cannot be read is a problem (exit 2); a linked go file is a problem and is not read', () => {
  const fx = fixture()
  ledger(fx, [ON()])
  const missing = join(fx.d, 'nope')
  const rep = run(fx, { goes: missing, goesExplicit: true })
  assert.match(rep.problems.join('\n'), /--goes/)
  assert.equal(rep.scanned.goFiles, null)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--goes', missing], { encoding: 'utf8' })
  assert.equal(cli.status, 2)
  goFile(fx, GOID)
  symlinkSync(join(fx.d, 'go', `${GOID}.json`), join(fx.d, 'go', `${uid(901)}.json`))
  const linked = run(fx)
  assert.match(linked.problems.join('\n'), /goes: .*\.json: a symlink, not read/)
  assert.deepEqual(rules(linked), ['go-file-no-row'])
})

// ---- PR notices (ADR 0010) ----
test('pr-watch and pr-notice rows are read and counted, never anomalies, and belong to no request', () => {
  const fx = fixture()
  const PR = { lane: 'LANE-A', target: 'acme/api#12' }
  ledger(fx, [ON(), R('pr-watch', BASE + 1000, { code: 'new', ...PR }), R('pr-notice', BASE + 2000, { code: 'green', tier: 'lane', target: PR.target }), R('pr-notice', BASE + 3000, { code: 'merged', tier: 'lead', ...PR }), R('pr-watch', BASE + 3000, { code: 'merged', ...PR })])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.problems, [])
  assert.equal(rep.counts.rowsByKind['pr-watch'], 2)
  assert.equal(rep.counts.rowsByKind['pr-notice'], 2)
})
