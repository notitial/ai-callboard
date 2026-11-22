import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN, T0, V2, fake } from '../../test/fake.ts'
import { liveness } from '../core/model.ts'
import { handoverTick } from './handover.ts'
import { getUp, mem } from './mem.ts'
import { getView, writeAsk } from './store.ts'
import { sessionEnd } from './tick.ts'
import { stopVerbCall } from './tools-child.ts'
import { requestHandoverCall, requestTick, turnComplete } from './upkeep.ts'
import { T } from '../texts.ts'

const next = async (e: unknown) => e
const NOTE = '/w/me/.archive/n.md'
const ASK = { file: NOTE, continuation: 'Next: tests.' }
const SEEN = { sha: 'a'.repeat(40), state: 'open', checks: 'none', draft: false, mergeable: false, reviews: 0, comments: 0, threads: 0 }
type F = ReturnType<typeof fake>
// A lead `LEAD` (sid-me) with a lane under it, the manager BOSS above, the lead's note on disk.
function machine(): F {
  const f = fake()
  f.h.panel = true
  f.seed({ sid: 'sid-me', pid: 10, name: 'LEAD', nameSource: 'user', cwd: '/w/me', kind: 'interactive' })
  f.seed({ sid: 'sid-lane', pid: 11, name: 'L1', cwd: '/w/me', kind: 'interactive' })
  f.seed({ sid: 'sid-boss', pid: 12, name: 'BOSS', cwd: '/w/boss', kind: 'interactive' })
  f.h.files.set('/Users/x/.claude/callboard/manager-name', 'BOSS\n')
  f.h.files.set(NOTE, 'where I am')
  f.h.real.set(NOTE, NOTE)
  f.table({ 'sid-me': { name: 'LEAD', folder: '/w/me', lead: { repos: [] } }, 'sid-lane': { name: 'L1', folder: '/w/me', under: 'sid-me' } })
  return f
}
const file = (f: F, n: string) => f.h.files.get(`${V2}/${n}`)
const rowOf = (f: F, pid: number) => JSON.parse(f.h.files.get(`/Users/x/.claude/sessions/${pid}.json`)!)
// The request made, the turn ended, the tick that begins the handover.
async function begin(f: F) {
  assert.equal((await requestHandoverCall(f.$, ASK, next)).result, T['handover.queued']({}))
  await turnComplete(f.$, { reason: 'answer' }, next)
  return requestTick(f.$, 'sid-me')
}
// The new session's ticks until the marker is gone (or the count runs out).
async function ticks(f: F, sid: string, n = 8) {
  for (let i = 0; i < n && file(f, 'handover/sid-me.json') !== undefined; i++) {
    f.h.now += 1_000
    await handoverTick(f.$, sid, f.h.now)
  }
}
const cleared = (f: F) => sessionEnd(f.$, { reason: 'clear' }, next)

test('request_handover: the main agent of an interactive session, with a plain note under its own .archive, once in thirty minutes, queues one request', async () => {
  const f = machine()
  assert.match((await requestHandoverCall(f.$, { ...ASK, agentId: 'a1' }, next)).deny, /a subagent may not call this/)
  f.h.files.set('/w/me/.archive/unresolved.md', 'x')
  for (const file of ['/w/me/.archive/unresolved.md', '/w/me/other.md', '/w/me/.archive/missing.md', '/w/other/.archive/n.md']) assert.ok((await requestHandoverCall(f.$, { ...ASK, file }, next)).deny, file)
  assert.equal((await getUp(f.$)).req, null)
  mem.handedAt = T0 - 10 * MIN
  assert.match((await requestHandoverCall(f.$, ASK, next)).deny, /30 minutes/)
  mem.handedAt = T0 - 31 * MIN
  assert.equal((await requestHandoverCall(f.$, ASK, next)).result, T['handover.queued']({}))
  assert.deepEqual({ ...(await getUp(f.$)).req }, { focus: NOTE, continuation: ASK.continuation, kind: 'handover', phase: 'called', at: T0, sid: 'sid-me' })
})

test('the handover begins once the turn has ended: the old session is renamed NAME~1, recorded, and cleared; its marker is the state between the two ids', async () => {
  const f = machine()
  assert.equal(await begin(f), true)
  assert.deepEqual(f.h.compactRuns, ['rename LEAD~1', 'clear '])
  assert.equal(f.h.sid, 'sid-new')
  assert.equal(rowOf(f, 10).name, 'LEAD~1')
  const m = JSON.parse(file(f, 'handover/sid-me.json')!)
  assert.deepEqual({ ...m, at: 0 }, { old: 'sid-me', pid: 10, procStart: m.procStart, name: 'LEAD', historic: 'LEAD~1', file: NOTE, continuation: ASK.continuation, phase: 'clearing', at: 0, failed: [] })
  assert.deepEqual(JSON.parse(file(f, 'handovers.json')!), { LEAD: { n: 1, old: [{ sid: 'sid-me', group: 'Lead', folder: '/w/me', at: T0 }] } })
  assert.equal(mem.handedAt, T0)
  assert.ok(f.h.toasts.includes(T['handover.start']({})))
  assert.equal((await getUp(f.$)).req, null)
})

test('between the two ids the old session is unknown to the view, not gone', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  const v = await getView(f.$, true)
  assert.equal(liveness(v, 'sid-me'), 'unknown')
  assert.equal(liveness(v, 'sid-new'), 'yes')
  f.h.now += 3 * MIN
  assert.equal(liveness(await getView(f.$, true), 'sid-me'), 'no')
})

test('the new session takes the table row, the children, the goes, the ask marks and the PR watches, takes its name back, and reports with its note', async () => {
  const f = machine()
  f.h.files.set(`${V2}/go/gogo1234.json`, JSON.stringify({ id: 'gogo1234', giver: 'sid-me', text: 'build it', end: T0 + 3_600_000 }))
  f.h.files.set(`${V2}/asks/zz11yy22xx.up.sid-me`, '{}')
  f.h.files.set(`${V2}/prs/sid-me.json`, JSON.stringify({ sid: 'sid-me', prs: [{ owner: 'o', repo: 'r', number: 1, at: T0, seen: SEEN }] }))
  await begin(f)
  await cleared(f)
  await ticks(f, 'sid-new')
  assert.equal(file(f, 'handover/sid-me.json'), undefined)
  assert.deepEqual(Object.keys(JSON.parse(file(f, 'sessions.json')!)).sort(), ['sid-lane', 'sid-new'])
  const t = JSON.parse(file(f, 'sessions.json')!)
  assert.deepEqual([t['sid-new'].name, t['sid-new'].lead, t['sid-lane'].under], ['LEAD', { repos: [] }, 'sid-new'])
  assert.equal(JSON.parse(file(f, 'go/gogo1234.json')!).giver, 'sid-new')
  assert.equal(file(f, 'asks/zz11yy22xx.up.sid-me'), undefined)
  assert.equal(file(f, 'asks/zz11yy22xx.up.sid-new'), '{}')
  assert.equal(file(f, 'prs/sid-me.json'), undefined)
  assert.equal(JSON.parse(file(f, 'prs/sid-new.json')!).sid, 'sid-new')
  assert.equal(rowOf(f, 10).name, 'LEAD')
  assert.deepEqual(mem.owed, [T['handover.note']({ name: 'LEAD', file: NOTE, continuation: ASK.continuation, failed: [] })])
})

test('a record that cannot be read stops the handover before anything changes', async () => {
  for (const [bad, why] of [[`${V2}/go/gogo1234.json`, 'a go file could not be read'], [`${V2}/prs/sid-me.json`, 'the PR watch list could not be read'], [`${V2}/handovers.json`, 'the handover record could not be read']] as const) {
    const f = machine()
    f.h.files.set(bad, 'not json')
    assert.equal(await begin(f), undefined, why)
    assert.deepEqual(f.h.compactRuns, [])
    assert.equal(f.h.sid, 'sid-me')
    assert.equal(file(f, 'handover/sid-me.json'), undefined)
    assert.ok(f.h.toasts.includes(T['handover.notRun']({ reason: why })), why)
    assert.deepEqual(mem.owed, [T['handover.notRun']({ reason: why })])
    assert.equal((await getUp(f.$)).req, null)
  }
  const f = machine()
  await writeAsk(f.$, { id: 'aa11bb22cc', asker: 'sid-me', t0: T0, awake: 0, tool: 'Bash', raisedBy: 'unknown', input: '{}', cut: false, beat: T0 })
  assert.equal(await begin(f), undefined)
  assert.deepEqual(f.h.compactRuns, [])
  assert.ok(f.h.toasts.includes(T['handover.notRun']({ reason: 'an ask of this session is still open' })))
})

test('a rename that does not land undoes the record and does not clear', async () => {
  const f = machine()
  f.h.dead.add('rename')
  f.h.sleepDone = true
  assert.equal(await begin(f), undefined)
  assert.ok(!f.h.compactRuns.some((c) => c.startsWith('clear')))
  assert.equal(file(f, 'handover/sid-me.json'), undefined)
  assert.deepEqual(JSON.parse(file(f, 'handovers.json')!).LEAD.old, [])
  assert.equal(rowOf(f, 10).name, 'LEAD')
  assert.ok(f.h.toasts.includes(T['handover.notRun']({ reason: 'the session could not be renamed' })))
})

test('a table that already holds the new id is not overwritten: the old conversation is resumed and gives its name back', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  f.table({ 'sid-me': { name: 'LEAD', folder: '/w/me', lead: { repos: [] } }, 'sid-new': { name: 'other', folder: '/w/o' }, 'sid-lane': { name: 'L1', folder: '/w/me', under: 'sid-me' } })
  await handoverTick(f.$, 'sid-new', f.h.now)
  assert.equal(JSON.parse(file(f, 'handover/sid-me.json')!).phase, 'undo')
  assert.ok(f.h.compactRuns.includes('resume sid-me'))
  assert.equal(f.h.sid, 'sid-me')
  await sessionEnd(f.$, { reason: 'resume' }, next)
  f.h.now += 1_000
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.equal(file(f, 'handover/sid-me.json'), undefined)
  assert.equal(rowOf(f, 10).name, 'LEAD')
  assert.deepEqual(JSON.parse(file(f, 'handovers.json')!).LEAD.old, [])
  assert.deepEqual(mem.owed, [T['handover.notRun']({ reason: 'the records could not be moved' })])
  assert.equal(JSON.parse(file(f, 'sessions.json')!)['sid-new'].name, 'other')
})

test('a /clear that never ran: the old session takes its name back after a minute and says so', async () => {
  const f = machine()
  f.h.dead.add('clear')
  await begin(f)
  f.h.now += 30_000
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.ok(file(f, 'handover/sid-me.json'))
  f.h.now += 31_000
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.equal(file(f, 'handover/sid-me.json'), undefined)
  assert.equal(rowOf(f, 10).name, 'LEAD')
  assert.deepEqual(mem.owed, [T['handover.notRun']({ reason: 'the session could not be cleared' })])
})

test('a marker whose process is gone, or that is ten minutes old, is removed by any session', async () => {
  const f = machine()
  const m = { old: 'sid-gone', pid: 99, procStart: 'Tue Oct 27 20:37:50 2026', name: 'X', historic: 'X~1', file: NOTE, continuation: 'c', phase: 'clearing', at: T0, failed: [] }
  f.h.files.set(`${V2}/handover/sid-gone.json`, JSON.stringify(m))
  f.h.files.set(`${V2}/handover/sid-old.json`, JSON.stringify({ ...m, old: 'sid-old', pid: 10, procStart: 'Tue Oct 27 20:37:50 2026' }))
  f.h.now += 10_000
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.ok(file(f, 'handover/sid-gone.json'))
  f.h.now += 21_000
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.equal(file(f, 'handover/sid-gone.json'), undefined)
  assert.ok(file(f, 'handover/sid-old.json'))
  f.h.now += 10 * MIN
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.equal(file(f, 'handover/sid-old.json'), undefined)
})

test('a marker is read only from a file named for its own old id, and only the process that wrote it takes it over', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  f.h.files.set(`${V2}/handover/sid-liar.json`, file(f, 'handover/sid-me.json')!)
  const before = file(f, 'sessions.json')
  f.h.files.set(`${V2}/handover/sid-me.json`, JSON.stringify({ ...JSON.parse(file(f, 'handover/sid-me.json')!), pid: 11 }))
  f.h.now += 1_000
  await handoverTick(f.$, 'sid-new', f.h.now)
  assert.equal(file(f, 'sessions.json'), before)
})

test('a lead cannot retire, park or stop a lane while it is handing over', async () => {
  const f = machine()
  f.seed({ sid: 'sid-lane2', pid: 21, name: 'L1~1', cwd: '/w/me', kind: 'interactive' })
  const row = JSON.parse(f.h.files.get('/Users/x/.claude/sessions/11.json')!)
  f.h.files.delete('/Users/x/.claude/sessions/11.json')
  f.h.files.set('/Users/x/.claude/sessions/21.json', JSON.stringify({ ...row, sessionId: 'sid-lane2', pid: 21, name: 'L1~1' }))
  f.h.files.set(`${V2}/handover/sid-lane.json`, JSON.stringify({ old: 'sid-lane', pid: 21, procStart: row.procStart, name: 'L1', historic: 'L1~1', file: NOTE, continuation: 'c', phase: 'clearing', at: T0, failed: [] }))
  const v = await getView(f.$, true)
  assert.equal(liveness(v, 'sid-lane'), 'unknown')
  for (const verb of ['retire', 'park', 'terminate'] as const) assert.match(String((await stopVerbCall(f.$, { lane: 'L1' }, next, verb) as any).deny), /could not read which sessions are live/, verb)
})

const clash = (f: F) => f.table({ 'sid-me': { name: 'LEAD', folder: '/w/me', lead: { repos: [] } }, 'sid-new': { name: 'other', folder: '/w/o' }, 'sid-lane': { name: 'L1', folder: '/w/me', under: 'sid-me' } })

test('a resume that does not land: the new session moves nothing else, says the table did not move, and the note is owed once', async () => {
  const f = machine()
  f.h.files.set(`${V2}/go/gogo1234.json`, JSON.stringify({ id: 'gogo1234', giver: 'sid-me', text: 'build it', end: T0 + 3_600_000 }))
  await begin(f)
  await cleared(f)
  clash(f)
  f.h.hang.add('resume')
  f.h.sleepDone = true
  await ticks(f, 'sid-new')
  assert.equal(file(f, 'handover/sid-me.json'), undefined)
  assert.equal(JSON.parse(file(f, 'go/gogo1234.json')!).giver, 'sid-me')
  assert.deepEqual(mem.owed, [T['handover.note']({ name: 'LEAD', file: NOTE, continuation: ASK.continuation, failed: ['table'] })])
})

test('a resume that lands late: the old session is live again with a bound marker and gives its name back', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  clash(f)
  f.h.hang.add('resume')
  f.h.sleepDone = true
  await handoverTick(f.$, 'sid-new', f.h.now)
  assert.equal(JSON.parse(file(f, 'handover/sid-me.json')!).phase, 'bound')
  f.h.hang.delete('resume')
  await f.$.command.run({ command: 'resume', args: 'sid-me' })
  await sessionEnd(f.$, { reason: 'resume' }, next)
  f.h.now += 1_000
  await handoverTick(f.$, 'sid-me', f.h.now)
  assert.equal(file(f, 'handover/sid-me.json'), undefined)
  assert.equal(rowOf(f, 10).name, 'LEAD')
  assert.deepEqual(mem.owed, [T['handover.notRun']({ reason: 'the records could not be moved' })])
})

test('a marker in undo is not taken over, and a bound marker only by the session that bound it', async () => {
  const f = machine()
  f.h.files.set(`${V2}/go/gogo1234.json`, JSON.stringify({ id: 'gogo1234', giver: 'sid-me', text: 'build it', end: T0 + 3_600_000 }))
  await begin(f)
  await cleared(f)
  const m = JSON.parse(file(f, 'handover/sid-me.json')!)
  for (const x of [{ ...m, phase: 'undo' }, { ...m, phase: 'bound', nw: 'sid-other' }, { ...m, phase: 'bound' }]) {
    f.h.files.set(`${V2}/handover/sid-me.json`, JSON.stringify(x))
    await handoverTick(f.$, 'sid-new', f.h.now)
  }
  assert.equal(JSON.parse(file(f, 'go/gogo1234.json')!).giver, 'sid-me')
  assert.deepEqual(mem.owed, [])
})

test('a second handover in the same process starts its takeover afresh', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  await ticks(f, 'sid-new')
  assert.equal(mem.hand?.old, 'sid-me')
  f.h.files.set(`${V2}/handover/sid-new.json`, JSON.stringify({ old: 'sid-new', pid: 10, procStart: 'Tue Oct 27 20:37:50 2026', name: 'LEAD', historic: 'LEAD~2', file: NOTE, continuation: 'c', phase: 'clearing', at: f.h.now, failed: [] }))
  mem.handedAt = f.h.now
  f.h.sid = 'sid-third'
  f.h.files.set('/Users/x/.claude/sessions/10.json', JSON.stringify({ ...rowOf(f, 10), sessionId: 'sid-third' }))
  await handoverTick(f.$, 'sid-third', f.h.now + 1_000)
  assert.equal(mem.hand?.old, 'sid-new')
  assert.equal(mem.hand?.moved, false)
})

test('a marker the process did not write itself (it only names the pid and start time) is not taken over', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  const m = JSON.parse(file(f, 'handover/sid-me.json')!)
  f.h.files.set(`${V2}/handover/sid-me.json`, JSON.stringify({ ...m, at: m.at + 1 }))
  f.h.now += 1_000
  const before = file(f, 'sessions.json')
  await handoverTick(f.$, 'sid-new', f.h.now)
  assert.equal(file(f, 'sessions.json'), before)
})

test('once the table moved, the new id is handing too, so no tick copies NAME~N into its row', async () => {
  const f = machine()
  await begin(f)
  await cleared(f)
  f.h.now += 1_000
  await handoverTick(f.$, 'sid-new', f.h.now)
  assert.equal(JSON.parse(file(f, 'handover/sid-me.json')!).nw, 'sid-new')
  assert.deepEqual([...(await getView(f.$, true)).handing].sort(), ['sid-me', 'sid-new'])
})
