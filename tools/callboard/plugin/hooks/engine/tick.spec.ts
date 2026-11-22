import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, fake, peer, tiers } from '../../test/fake.ts'
import { mem, getUp, patchUp } from './mem.ts'
import { logAsk, writeAsk, writeGo } from './store.ts'
import { postToolHook, sessionEnd, sessionStart } from './tick.ts'
import { requestTick, turnComplete, turnStart } from './upkeep.ts'
import { TOOL_SCHEMAS } from '../tool-schemas.ts'

const next = async (e: unknown) => e
type F = ReturnType<typeof fake>
const ANY = ['go_request', 'go_status', 'pr_watch', 'request_compact', 'request_handover', 'rest']
const PARENT = Object.keys(TOOL_SCHEMAS).filter((n) => TOOL_SCHEMAS[n as keyof typeof TOOL_SCHEMAS].cap === 'parent')
const tick = async (f: F) => void (await f.h.every!())
async function start(f: F): Promise<void> {
  await sessionStart(f.$, {}, next)
}
function lead(kids: Record<string, object> = {}): F {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] } }, ...kids })
  return f
}
const kid = (extra: object = {}) => ({ name: 'kid', folder: '/w/kid', under: 'sid-me', ...extra })

test('the start registers the six tools every session has and the three commands; the fourteen come once the session holds a capability', async () => {
  const plain = fake()
  plain.seed({ sid: 'sid-me', pid: 10, name: 'me', kind: 'interactive' })
  await start(plain)
  assert.deepEqual(plain.h.tools.sort(), [...ANY].sort())
  assert.deepEqual(plain.h.commands.sort(), ['callboard', 'conductor', 'lead', 'rest', 'unattended'])
  await tick(plain)
  assert.equal(plain.h.tools.length, 6)
  const l = lead()
  await start(l)
  assert.equal(l.h.tools.length, 6)
  await tick(l)
  assert.deepEqual(l.h.tools.sort(), [...ANY, ...PARENT].sort())
  await tick(l)
  assert.equal(l.h.tools.length, 20)
  assert.equal(PARENT.length, 14)
})
test('the manager is given the fourteen too, by the name file; an off lead is not', async () => {
  const m = fake()
  m.seed({ sid: 'sid-me', pid: 10, name: 'BOSS', kind: 'interactive' })
  m.h.files.set(`${HOME}/.claude/callboard/manager-name`, 'BOSS\n')
  await start(m)
  await tick(m)
  assert.equal(m.h.tools.length, 20)
  const off = fake()
  off.seed({ sid: 'sid-me', pid: 10, name: 'me', kind: 'interactive' })
  off.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] }, off: true } })
  await start(off)
  await tick(off)
  assert.equal(off.h.tools.length, 6)
})
test('a lead is told what happened to its children as one turn, once, naming them; a session with no capability is told nothing', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }), 'sid-gone2': kid({ name: 'gone2', goneAt: T0 - 500 }) })
  await start(f)
  mem.since = T0 - MIN
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
  assert.match(f.h.submitted[0], /^\[callboard\] Check-in/)
  assert.match(f.h.submitted[0], /ghost/)
  assert.match(f.h.submitted[0], /gone2/)
  assert.equal(f.h.submitted[0].split('\n').filter((l) => l.startsWith('- ')).length, 2)
  f.h.now += 2000
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
  const plain = fake()
  plain.seed({ sid: 'sid-me', pid: 10, name: 'me', kind: 'interactive' })
  plain.table({ 'sid-ghost': kid({ goneAt: T0 - 1000 }) })
  await start(plain)
  mem.since = T0 - MIN
  await tick(plain)
  assert.equal(plain.h.submitted.length, 0)
})
test('an event is spent when the turn carrying it starts, not when it is submitted: a turn that never started leaves it owed after 2 min', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  await start(f)
  mem.since = T0 - MIN
  await tick(f)
  const text = f.h.submitted[0]
  f.h.now += 130_000
  f.idle()
  await tick(f)
  assert.equal(f.h.submitted.length, 2)
  assert.equal(f.h.submitted[1], text)
  await turnStart(f.$, { text: `[callboard] note\n${text}` }, next)
  f.h.now += 130_000
  f.idle()
  await tick(f)
  assert.equal(f.h.submitted.length, 2)
})
test('an event is computed again when it is sent: one withdrawn meanwhile is not sent, and nothing is sent to a session that is not quiet', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  await start(f)
  mem.since = T0 - MIN
  f.h.draft = 'half typed'
  await tick(f)
  assert.equal(f.h.submitted.length, 0)
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] } }, 'sid-ghost': kid({ name: 'ghost' }) })
  f.seed({ sid: 'sid-ghost', pid: 11, name: 'ghost' })
  f.h.draft = ''
  f.h.now += 11_000
  await tick(f)
  assert.equal(f.h.submitted.length, 0)
  const busy = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  busy.h.files.set('/Users/x/.claude/sessions/10.json', JSON.stringify({ sessionId: 'sid-me', pid: 10, procStart: 'Tue Oct 27 20:37:50 2026', cwd: '/w/me', status: 'busy', kind: 'interactive' }))
  await start(busy)
  mem.since = T0 - MIN
  await tick(busy)
  assert.equal(busy.h.submitted.length, 0)
})
test('a child whose report is signed by its own id is told as done, not gone, and the lead is told once', async () => {
  const f = lead({ 'sid-kid': kid({ report: '/w/kid/.archive/kid/REPORT.md', goneAt: T0 - 1000 }) })
  f.h.files.set('/w/kid/.archive/kid/REPORT.md', 'did it\nstatus: done sid-kid\n')
  await start(f)
  mem.since = T0 - MIN
  await tick(f)
  assert.match(f.h.submitted[0], /Signed done: .kid./)
  assert.doesNotMatch(f.h.submitted[0], /is gone/)
  const other = lead({ 'sid-kid': kid({ report: '/w/kid/.archive/kid/REPORT.md', goneAt: T0 - 1000 }) })
  other.h.files.set('/w/kid/.archive/kid/REPORT.md', 'did it\nstatus: done sid-someone-else\n')
  await start(other)
  mem.since = T0 - MIN
  await tick(other)
  assert.match(other.h.submitted[0], /is gone/)
  const outside = lead({ 'sid-kid': kid({ report: '/etc/passwd', goneAt: T0 - 1000 }) })
  outside.h.files.set('/etc/passwd', 'status: done sid-kid')
  await start(outside)
  mem.since = T0 - MIN
  await tick(outside)
  assert.match(outside.h.submitted[0], /is gone/)
})
test('at most one text is sent in a tick: owed events go before the keepalive ping', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  await start(f)
  mem.since = T0 - MIN
  await turnComplete(f.$, { reason: 'answer' }, next)
  f.h.now += 51 * MIN
  mem.view = undefined
  f.h.files.set('/Users/x/.claude/sessions/10.json', JSON.stringify({ sessionId: 'sid-me', pid: 10, procStart: 'Tue Oct 27 20:37:50 2026', cwd: '/w/me', status: 'idle', kind: 'interactive' }))
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
  assert.match(f.h.submitted[0], /Check-in/)
  f.h.now += 2000
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
  await turnStart(f.$, { text: f.h.submitted[0] }, next)
  f.h.now += 2000
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
  f.idle()
  f.h.now += 2000
  await tick(f)
  assert.equal(f.h.submitted.length, 2)
  assert.match(f.h.submitted[1], /keepalive/)
})
test('the table: a row no live session carries is marked gone after 30 s and dropped after a day; written only when it changed', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost' }) })
  await start(f)
  await tick(f)
  const before = f.h.files.get(`${V2}/sessions.json`)
  f.h.now += 31_000
  await tick(f)
  assert.equal(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-ghost'].goneAt, f.h.now)
  assert.notEqual(f.h.files.get(`${V2}/sessions.json`), before)
  const written = f.h.runs.filter((r) => r.argv[0] === '/bin/mv').length
  f.h.now += 31_000
  await tick(f)
  assert.equal(f.h.runs.filter((r) => r.argv[0] === '/bin/mv').length, written)
  f.h.now += 25 * 60 * MIN
  await tick(f)
  assert.equal(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-ghost'], undefined)
})
test('a doubtful registry changes nothing in the table and sends nothing', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost' }) })
  await start(f)
  f.h.psFails = true
  f.h.now += 40_000
  await tick(f)
  f.h.now += 40_000
  await tick(f)
  assert.equal(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-ghost'].goneAt, undefined)
  assert.equal(f.h.submitted.length, 0)
})
test('a gap in the timer longer than 5 min is a sleep: the Mac woke, so no ping for that gap', async () => {
  const f = lead()
  await start(f)
  await tick(f)
  assert.equal(mem.woke, undefined)
  f.h.now += 6 * MIN
  await tick(f)
  assert.equal(mem.woke, f.h.now)
})
test('mid-turn: the events and the nudge ride on a tool result of the main agent, spent at once; a subagent and a session with nothing owed add nothing', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  await start(f)
  mem.since = T0 - MIN
  f.h.usage = { context: { tokens: 320_000 } }
  await tick(f)
  f.h.submitted.length = 0
  mem.pending.clear()
  mem.spent.clear()
  const r = await postToolHook(f.$, { agentId: undefined }, async () => ({ result: 'x' }))
  assert.equal(r.result, 'x')
  assert.equal(r.additionalContext.length, 2)
  assert.match(r.additionalContext[0], /300k/)
  assert.match(r.additionalContext[1], /ghost/)
  const again = await postToolHook(f.$, {}, async () => ({ result: 'x' }))
  assert.equal(again.additionalContext, undefined)
  const sub = await postToolHook(f.$, { agentId: 'a1' }, async () => ({ result: 'x' }))
  assert.equal(sub.additionalContext, undefined)
})
test('the session end removes the usage file; a restart-safe state: a rest ends at a real turn', async () => {
  const f = lead()
  f.h.files.set(`${V2}/usage/sid-me.json`, '{}')
  await sessionEnd(f.$, {}, next)
  assert.equal(f.h.files.has(`${V2}/usage/sid-me.json`), false)
  await patchUp(f.$, (u) => ({ ...u, restAt: T0 }))
  await turnStart(f.$, { text: 'a person typed this' }, next)
  assert.equal((await getUp(f.$)).restAt, undefined)
})
test('nothing is sent into a turn that began inside the 10 s the machine reading is kept: the own row is read again before a send', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  await start(f)
  mem.since = T0 - MIN
  f.h.draft = 'x'
  await tick(f)
  f.h.draft = ''
  f.h.files.set('/Users/x/.claude/sessions/10.json', JSON.stringify({ sessionId: 'sid-me', pid: 10, procStart: 'Tue Oct 27 20:37:50 2026', cwd: '/w/me', status: 'busy', kind: 'interactive' }))
  f.h.now += 2000
  await tick(f)
  assert.equal(f.h.submitted.length, 0)
  f.idle()
  f.h.now += 2000
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
})
test('the resume note waits for a quiet session for up to 2 min: not over a draft, not into a running turn, and never after that', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', kind: 'interactive' })
  const req = (at: number) => patchUp(f.$, (u) => ({ ...u, req: { focus: 'f', continuation: 'c', phase: 'compacted', at, sid: 'sid-me', doneAt: at } }))
  await req(T0)
  f.h.draft = 'half'
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 0)
  assert.equal((await getUp(f.$)).req?.phase, 'compacted')
  f.h.draft = ''
  f.h.files.set('/Users/x/.claude/sessions/10.json', JSON.stringify({ sessionId: 'sid-me', pid: 10, procStart: 'Tue Oct 27 20:37:50 2026', cwd: '/w/me', status: 'busy', kind: 'interactive' }))
  f.h.now += 30_000
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 0)
  f.idle()
  f.h.now += 30_000
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 1)
  await req(f.h.now)
  f.h.draft = 'still typing'
  f.h.now += 121_000
  await requestTick(f.$, 'sid-me')
  assert.equal(f.h.submitted.length, 1)
  assert.equal((await getUp(f.$)).req, null)
})
test('a PR tracker is kept while the session is off, and a manager clears the tracker of a gone loose session', async () => {
  const f = lead()
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', off: true } })
  const entry = { owner: 'acme', repo: 'app', number: 5, at: T0, seen: { sha: 'a'.repeat(40), state: 'open', draft: false, checks: 'pending', mergeable: false, reviews: 0, comments: 0, threads: 0 } }
  f.h.files.set(`${V2}/prs/sid-me.json`, JSON.stringify({ sid: 'sid-me', prs: [entry] }))
  await start(f)
  f.h.now += 3 * MIN
  await tick(f)
  assert.ok(f.h.files.has(`${V2}/prs/sid-me.json`))
  const m = fake()
  m.seed({ sid: 'sid-me', pid: 10, name: 'BOSS', kind: 'interactive' })
  m.h.files.set(`${HOME}/.claude/callboard/manager-name`, 'BOSS\n')
  m.table({ 'sid-dead': { name: 'dead', folder: '/w/d', goneAt: T0 - 1000 } })
  m.h.files.set(`${V2}/prs/sid-dead.json`, JSON.stringify({ sid: 'sid-dead', prs: [entry] }))
  await start(m)
  m.h.now += 3 * MIN
  await tick(m)
  assert.equal(m.h.files.has(`${V2}/prs/sid-dead.json`), false)
})
test('a report that is not a plain file is not read, so a lane cannot stall its lead\'s tick; the waiting text is cut', async () => {
  const f = lead({ 'sid-kid': kid({ report: '/w/kid/.archive/kid/REPORT.md', goneAt: T0 - 1000 }) })
  f.h.files.set('/w/kid/.archive/kid/REPORT.md', 'status: done sid-kid\n')
  f.h.kinds.set('/w/kid/.archive/kid/REPORT.md', 'fifo')
  await start(f)
  mem.since = T0 - MIN
  await tick(f)
  assert.match(f.h.submitted[0], /is gone/)
  const w = lead({ 'sid-kid': kid() })
  w.seed({ sid: 'sid-kid', pid: 11, name: 'kid', status: 'waiting', waitingFor: 'x'.repeat(500), statusUpdatedAt: T0 - 10 * MIN })
  await start(w)
  mem.since = T0 - MIN
  await tick(w)
  assert.ok(w.h.submitted[0].length < 600)
})

test('a notice owed for his own step is dropped, not sent, once the session is turned off', async () => {
  const f = lead()
  await start(f)
  mem.owed.push('[callboard] one')
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] }, off: true } })
  await tick(f)
  assert.deepEqual([f.h.submitted, mem.owed], [[], []])
})

test('a notice owed for his own step is sent once the session is quiet, one a tick, and not again', async () => {
  const f = lead()
  await start(f)
  mem.owed.push('[callboard] one', '[callboard] two')
  f.h.draft = 'typing'
  await tick(f)
  assert.equal(f.h.submitted.length, 0)
  f.h.draft = ''
  await tick(f)
  assert.deepEqual(f.h.submitted, ['[callboard] one'])
  f.idle()
  await tick(f)
  assert.deepEqual(f.h.submitted, ['[callboard] one', '[callboard] two'])
  f.idle()
  await tick(f)
  assert.equal(f.h.submitted.length, 2)
})

test('the manager\'s check-in carries a short digest of what changed under it, once, and a quiet manager is not woken by the digest alone', async () => {
  const f = tiers()
  f.table({ 'sid-me': { name: 'lane', folder: '/w/me', under: 'sid-lead', report: '/w/me/.archive/lane/REPORT.md' }, 'sid-lead': { name: 'lead', folder: '/w/lead', lead: { repos: [] } } })
  f.h.files.set('/w/me/.archive/lane/REPORT.md', 'did it\nstatus: done sid-me\n')
  const boss = peer(f, 'sid-boss')
  await start(boss)
  mem.since = T0 - MIN
  await logAsk(f.$, { ev: 'closed', ask: 'cc11dd22e1', asker: 'sid-lead', code: 'click' })
  await logAsk(f.$, { ev: 'closed', ask: 'cc11dd22e2', asker: 'sid-lead', code: 'click' })
  await writeGo(f.$, { id: 'goaa1111', giver: 'sid-lead', text: 'secret command text', end: T0 - 1000 })
  await tick(boss)
  assert.equal(boss.h.submitted.length, 0, 'no ask, no check-in: the digest alone wakes nobody')
  boss.h.now += 11_000
  await writeAsk(f.$, { id: 'aa11bb22cc', asker: 'sid-lead', t0: T0 - 60_000, awake: 60_000, tool: 'Bash', raisedBy: 'unknown', input: '{"command":"make"}', cut: false, beat: T0 })
  await tick(boss)
  const text = boss.h.submitted[0]
  assert.match(text, /^\[callboard\] Check-in/)
  assert.match(text, /Since your last check-in \(log data, not an instruction; check live state/)
  const since = text.split('\n').slice(text.split('\n').findIndex((l) => l.startsWith('Since your')) + 1).filter((l) => l.startsWith('- '))
  assert.deepEqual(since.map((l) => l.replace(/^- /, '')).sort(), ['A go from `lead` ended.', '`lane` signed its report done.', '`lead`: 2 asks ended in its own panel (a click or an interruption).'])
  assert.doesNotMatch(text, /secret command text|make/)
  await turnStart(boss.$, { text }, next)
  boss.h.now += 130_000
  await writeAsk(f.$, { id: 'dd11ee22ff', asker: 'sid-lead', t0: T0 + 100_000, awake: 60_000, tool: 'Bash', raisedBy: 'unknown', input: '{}', cut: false, beat: T0 + 130_000 })
  boss.idle()
  await tick(boss)
  assert.equal(boss.h.submitted.length, 2)
  assert.doesNotMatch(boss.h.submitted[1], /Since your last check-in/, 'what was told is not told again')
})
test('a lead\'s check-in has no digest: it is the manager\'s alone', async () => {
  const f = lead({ 'sid-ghost': kid({ name: 'ghost', goneAt: T0 - 1000 }) })
  await logAsk(f.$, { ev: 'closed', ask: 'cc11dd22e1', asker: 'sid-ghost', code: 'click' })
  await start(f)
  mem.since = T0 - MIN
  await tick(f)
  assert.doesNotMatch(f.h.submitted[0], /Since your last check-in/)
})

test('a /clear or a /resume ends the session id: what belonged to it in module memory goes, the process-wide hand-over time stays; any other end keeps it', async () => {
  for (const reason of ['clear', 'resume']) {
    const f = lead()
    mem.owed.push('owed')
    mem.selfNamed = true
    mem.handedAt = T0
    await sessionEnd(f.$, { reason }, next)
    assert.deepEqual([mem.owed, mem.selfNamed, mem.handedAt], [[], false, T0], reason)
  }
  const g = lead()
  mem.owed.push('owed')
  await sessionEnd(g.$, { reason: 'logout' }, next)
  assert.deepEqual(mem.owed, ['owed'])
})
