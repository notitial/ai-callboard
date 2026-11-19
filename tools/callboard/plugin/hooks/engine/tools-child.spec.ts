import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN, T0, V2, fake } from '../../test/fake.ts'
import { parent, PERSON } from '../core/model.ts'
import { notices } from '../core/notices.ts'
import { cueTick } from './cue.ts'
import { mem } from './mem.ts'
import { prClaim, prTick, prWatchCall } from './pr.ts'
import { getView } from './store.ts'
import { sessionStart } from './tick.ts'
import { turnComplete } from './upkeep.ts'
import { cueVerbCall, laneAdoptCall, laneCreateCall, laneListCall, laneOpenCall, laneUnparkCall, stopVerbCall } from './tools-child.ts'

type F = ReturnType<typeof fake>
const next = async (e: unknown) => e
const KID_REPORT = '/w/repo/kid/.archive/kid/REPORT.md'
const table = (f: F) => JSON.parse(f.file('sessions.json') ?? '{}')
const tick = async (f: F) => void (await f.h.every!())
const text = (r: any): string => r.result ?? r.deny ?? ''

// A lead `lead` (sid-me) with one idle lane `kid` (sid-kid) under it; folders are real paths.
function world(kidStatus = 'idle'): F {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'lead', cwd: '/w/me', kind: 'interactive' })
  f.seed({ sid: 'sid-kid', pid: 20, name: 'kid', cwd: '/w/repo/kid', kind: 'interactive', status: kidStatus, statusUpdatedAt: T0 - 2 * MIN })
  f.table({
    'sid-me': { name: 'lead', folder: '/w/me', lead: { repos: ['/w/repo'] } },
    'sid-kid': { name: 'kid', folder: '/w/repo/kid', under: 'sid-me', report: KID_REPORT, brief: '/w/repo/kid/.archive/kid/BRIEF.md' },
  })
  for (const d of ['/w/repo', '/w/repo/kid', '/w/repo/new', '/w/other']) f.h.dirs.add(d)
  return f
}
// What happens when the caller waits (each wait is one `/bin/sleep` run): a window answering the spool, another session's tick, a process ending.
const sleepers = new WeakMap<F, () => Promise<void> | void>()
function onSleep(f: F, handler: () => Promise<void> | void): void {
  if (!sleepers.has(f)) {
    const orig = f.$.process.run
    f.$.process.run = async (argv: string[], o?: unknown) => {
      if (argv[0] === '/bin/sleep') await sleepers.get(f)!()
      return orig(argv, o)
    }
  }
  sleepers.set(f, handler)
}
const window = (f: F, reply: (req: any) => object | undefined) =>
  onSleep(f, () => {
    for (const [p, t] of [...f.h.files]) if (p.startsWith(`${V2}/open/`) && p.endsWith('.req')) ((r) => r && f.h.files.set(p.replace(/\.req$/, '.result'), JSON.stringify(r)))(reply(JSON.parse(t)))
  })
// The child's own tick, run as that session while the parent waits.
const asChild = (f: F, sid: string) =>
  onSleep(f, async () => {
    const me = f.h.sid
    f.h.sid = sid
    mem.view = undefined
    try {
      await cueTick(f.$, sid, await getView(f.$, true), f.h.now)
    } finally {
      f.h.sid = me
      mem.view = undefined
    }
  })
// `kill` ends the process: its `ps` line goes. Returns the kills seen.
function killer(f: F, ends = true): string[][] {
  const kills: string[][] = []
  const orig = f.$.process.run
  f.$.process.run = async (argv: string[], o?: unknown) => {
    if (argv[0] !== '/bin/kill') return orig(argv, o)
    kills.push(argv)
    if (ends) f.h.ps = f.h.ps.split('\n').filter((l) => l.trim().split(' ')[0] !== argv[2]).join('\n')
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return kills
}
const reqs = (f: F) => [...f.h.files].filter(([p]) => p.startsWith(`${V2}/open/`) && p.endsWith('.req')).map(([, t]) => JSON.parse(t))

test('every body re-checks at call time: a session with no capability, a subagent, a lead that turned lead off, an unreadable registry', async () => {
  const f = world()
  assert.match(text(await laneListCall(f.$, {}, next)), /\| kid \|/)
  assert.match(text(await laneListCall(f.$, { agentId: 'a1' }, next)), /input is not valid/)
  f.table({ 'sid-me': { name: 'lead', folder: '/w/me' } })
  for (const r of [await laneListCall(f.$, {}, next), await laneCreateCall(f.$, { name: 'x', folder: '/w/repo/new', brief: 'b' }, next), await laneAdoptCall(f.$, { name: 'kid' }, next), await laneOpenCall(f.$, { lane: 'kid' }, next), await cueVerbCall(f.$, { lane: 'kid' }, next, 'resume')]) assert.match(text(r), /only a lead or the manager/)
  f.table({ 'sid-me': { name: 'lead', folder: '/w/me', lead: { repos: [] } } })
  f.h.psFails = true
  assert.match(text(await laneListCall(f.$, {}, next)), /could not read which sessions are live/)
})

test('a lane is named by `lane`: no such name, a name two sessions carry and a session that is not under the caller are each refused, never guessed', async () => {
  const f = world()
  const call = (lane: string) => stopVerbCall(f.$, { lane }, next, 'park')
  assert.match(text(await call('nobody')), /no lane of yours has that name/)
  f.seed({ sid: 'sid-twin', pid: 30, name: 'kid', cwd: '/w/repo/twin' })
  assert.match(text(await call('kid')), /more than one live session has that name/)
  f.seed({ sid: 'sid-stranger', pid: 31, name: 'stranger', cwd: '/w/x' })
  assert.match(text(await call('stranger')), /not under you now/)
})

test('lane_create writes the brief with the lead named and the row `new:NAME`; the reply names the lead; a folder outside the allowlist and a taken name are refused', async () => {
  const f = world()
  const r = await laneCreateCall(f.$, { name: 'NEW', folder: '/w/repo/new', brief: 'do the thing' }, next)
  assert.match(r.result, /`NEW` is now a lane of `lead`/)
  const brief = f.h.files.get('/w/repo/new/.archive/NEW/BRIEF.md')!
  assert.match(brief, /Written by its lead lead\./)
  assert.match(brief, /do the thing/)
  assert.deepEqual(table(f)['new:NEW'], { name: 'NEW', folder: '/w/repo/new', report: '/w/repo/new/.archive/NEW/REPORT.md', under: 'sid-me', brief: '/w/repo/new/.archive/NEW/BRIEF.md', model: 'sonnet' })
  assert.match(text(await laneCreateCall(f.$, { name: 'NEW', folder: '/w/repo/new', brief: 'again' }, next)), /already has that name/)
  assert.match(text(await laneCreateCall(f.$, { name: 'OUT', folder: '/w/other', brief: 'b' }, next)), /not inside your allowlist/)
  assert.match(text(await laneCreateCall(f.$, { name: '../x', folder: '/w/repo/new', brief: 'b' }, next)), /a name is 1 to 40/)
  assert.match(text(await laneCreateCall(f.$, { name: 'Y', folder: 'repo/new', brief: 'b' }, next)), /input is not valid/)
  assert.equal(f.h.files.has('/w/other/.archive/OUT/BRIEF.md'), false)
})

test('lane_open names the folder in a spool request written as a dot-file then renamed, binds the row to the panel the window answers with, and takes the request back when nothing answers', async () => {
  const f = world()
  await laneCreateCall(f.$, { name: 'NEW', folder: '/w/repo/new', brief: 'b' }, next)
  const silent = await laneOpenCall(f.$, { lane: 'NEW' }, next)
  assert.match(silent.deny, /window did not answer in 30 seconds/)
  assert.deepEqual(reqs(f), [])
  assert.ok(table(f)['new:NEW'])
  window(f, (req) => (req.op === 'open' && req.folder === '/w/repo/new' ? { ok: true, sid: 'sid-new' } : undefined))
  const r = await laneOpenCall(f.$, { lane: 'NEW' }, next)
  assert.match(r.result, /`NEW` opened as session `sid-new`/)
  const mv = f.h.runs.map((x) => x.argv).filter((a) => a[0] === '/bin/mv' && a.at(-1)!.endsWith('.req')).at(-1)!
  assert.match(mv.at(-2)!, /\/open\/\.[a-z0-9]{8,40}\.tmp$/)
  assert.match(mv.at(-1)!, /\/open\/[a-z0-9]{8,40}\.req$/)
  assert.equal(table(f)['new:NEW'], undefined)
  assert.equal(table(f)['sid-new'].name, 'NEW')
  assert.equal(table(f)['sid-new'].under, 'sid-me')
  assert.match(text(await laneOpenCall(f.$, { lane: 'kid' }, next)), /a live session carries that lane already/)
})

test('a window that answers with an error, or with another session id for a reopen, leaves the row as it was', async () => {
  const f = world()
  f.table({ ...table(f), 'sid-old': { name: 'old', folder: '/w/repo/old', under: 'sid-me', parked: T0 - MIN } })
  window(f, () => ({ ok: false, code: 'not-workspace' }))
  assert.match(text(await laneUnparkCall(f.$, { lane: 'old' }, next)), /the window refused \(not-workspace\)/)
  assert.equal(table(f)['sid-old'].parked, T0 - MIN)
  window(f, () => ({ ok: true, sid: 'sid-other' }))
  assert.match(text(await laneUnparkCall(f.$, { lane: 'old' }, next)), /did not answer/)
  window(f, (req) => (req.op === 'reopen' && req.sid === 'sid-old' ? { ok: true, sid: 'sid-old' } : undefined))
  assert.match(text(await laneUnparkCall(f.$, { lane: 'old' }, next)), /reopened as session `sid-old`/)
  assert.equal(table(f)['sid-old'].parked, undefined)
})

test('lane_adopt: one loose live session by name becomes a lane and the reply names the lead; two of that name, a lane under another live lead and a folder outside are refused', async () => {
  const f = world()
  f.seed({ sid: 'sid-loose', pid: 30, name: 'loose', cwd: '/w/repo/loose' })
  assert.match(text(await laneAdoptCall(f.$, { name: 'loose' }, next)), /`loose` is now a lane of `lead`/)
  assert.deepEqual(table(f)['sid-loose'], { name: 'loose', folder: '/w/repo/loose', report: '/w/repo/loose/.archive/loose/REPORT.md', under: 'sid-me' })
  f.seed({ sid: 'sid-t1', pid: 31, name: 'twin', cwd: '/w/repo/t1' })
  f.seed({ sid: 'sid-t2', pid: 32, name: 'twin', cwd: '/w/repo/t2' })
  assert.match(text(await laneAdoptCall(f.$, { name: 'twin' }, next)), /more than one live session has that name/)
  f.seed({ sid: 'sid-b', pid: 33, name: 'other-lead', cwd: '/w/b' })
  f.seed({ sid: 'sid-held', pid: 34, name: 'held', cwd: '/w/repo/held' })
  f.table({ ...table(f), 'sid-b': { name: 'other-lead', folder: '/w/b', lead: { repos: [] } }, 'sid-held': { name: 'held', folder: '/w/repo/held', under: 'sid-b' } })
  assert.match(text(await laneAdoptCall(f.$, { name: 'held' }, next)), /already has a lead above it/)
  f.seed({ sid: 'sid-away', pid: 35, name: 'away', cwd: '/w/other' })
  assert.match(text(await laneAdoptCall(f.$, { name: 'away' }, next)), /not inside your allowlist/)
})

test('only the cap of live children refuses many lanes, and it says so (create and adopt)', async () => {
  const f = world()
  for (let i = 2; i <= 8; i++) {
    f.seed({ sid: `sid-k${i}`, pid: 100 + i, name: `k${i}`, cwd: `/w/repo/k${i}` })
    f.table({ ...table(f), [`sid-k${i}`]: { name: `k${i}`, folder: `/w/repo/k${i}`, under: 'sid-me' } })
  }
  assert.match(text(await laneCreateCall(f.$, { name: 'NINE', folder: '/w/repo/new', brief: 'b' }, next)), /already have 8 live lanes/)
  f.seed({ sid: 'sid-nine', pid: 200, name: 'nine', cwd: '/w/repo/nine' })
  assert.match(text(await laneAdoptCall(f.$, { name: 'nine' }, next)), /already have 8 live lanes/)
  assert.equal(table(f)['new:NINE'], undefined)
})

test('a cue: the child, in its own tick, renames or starts itself; a busy child leaves it and the parent is told the lane is in a turn; a cue from a session that is not above it is refused', async () => {
  const f = world()
  asChild(f, 'sid-kid')
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid', name: 'kid2' }, next, 'rename')), /accepted rename/)
  assert.deepEqual(f.h.compactRuns, ['rename kid2'])
  assert.deepEqual([...f.h.files.keys()].filter((p) => p.startsWith(`${V2}/cue/`)), [])
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid', name: 'lead' }, next, 'rename')), /already has that name|reserved/)
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid' }, next, 'start')), /accepted start/)
  assert.match(f.h.submitted.at(-1)!, /^\[callboard\] You are lane `kid` of `lead`\./)
  assert.match(f.h.submitted.at(-1)!, /Read your brief at `\/w\/repo\/kid\/\.archive\/kid\/BRIEF\.md`/)
  const busy = world('busy')
  asChild(busy, 'sid-kid')
  assert.match(text(await cueVerbCall(busy.$, { lane: 'kid' }, next, 'resume')), /in a turn/)
  assert.deepEqual([...busy.h.files.keys()].filter((p) => p.startsWith(`${V2}/cue/`)), [])
  const forged = world()
  forged.h.files.set(`${V2}/cue/sid-kid.json`, JSON.stringify({ id: 'abcdefgh1234', verb: 'start', from: 'sid-stranger', at: T0, name: 'kid' }))
  forged.h.sid = 'sid-kid'
  await cueTick(forged.$, 'sid-kid', await getView(forged.$, true), T0)
  assert.equal(forged.h.submitted.length, 0)
  assert.deepEqual(JSON.parse(forged.h.files.get(`${V2}/result/abcdefgh1234.json`)!), { id: 'abcdefgh1234', outcome: 'refused', code: 'not-a-parent' })
  assert.equal(forged.h.files.has(`${V2}/cue/sid-kid.json`), false)
})

test('a start cue reads the brief from the child\'s own row, never from the cue, and a cue with a path-like id does nothing', async () => {
  const f = world()
  f.table({ ...table(f), 'sid-kid': { name: 'kid', folder: '/w/repo/kid', under: 'sid-me' } })
  asChild(f, 'sid-kid')
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid' }, next, 'start')), /not valid/)
  f.h.files.set(`${V2}/cue/sid-kid.json`, JSON.stringify({ id: '../../etc', verb: 'resume', from: 'sid-me', at: T0 }))
  f.h.sid = 'sid-kid'
  await cueTick(f.$, 'sid-kid', await getView(f.$, true), T0)
  assert.equal(f.h.submitted.length, 0)
  assert.equal(f.h.files.has(`${V2}/cue/sid-kid.json`), false)
})

test('park, resume and retire by a parent open no dialog; a stop needs the lane idle, a retire its signed report; the stop sends TERM to the confirmed pid and the panel is asked to close', async () => {
  const f = world()
  const kills = killer(f)
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'retire')), /not signed done by its own session/)
  assert.deepEqual(kills, [])
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'park')), /`kid` is parked/)
  assert.deepEqual(kills, [['/bin/kill', '-TERM', '20']])
  assert.equal(table(f)['sid-kid'].parked, T0)
  assert.deepEqual(reqs(f), [{ op: 'close', sid: 'sid-kid', pid: 20, name: 'kid', folder: '/w/repo/kid' }])
  assert.deepEqual(f.h.asked, [])
  const g = world()
  const k2 = killer(g)
  g.h.files.set(KID_REPORT, 'notes\nstatus: done sid-kid\n')
  assert.match(text(await stopVerbCall(g.$, { lane: 'kid' }, next, 'retire')), /retired and its row removed/)
  assert.equal(table(g)['sid-kid'], undefined)
  assert.equal(k2.length, 1)
  assert.deepEqual(g.h.asked, [])
  const busy = world('busy')
  assert.match(text(await stopVerbCall(busy.$, { lane: 'kid' }, next, 'park')), /not idle yet/)
})

test('a park is recorded before the signal: kept when the process outlives the wait, cleared when the signal fails; a session with no row cannot be parked', async () => {
  const f = world()
  killer(f, false)
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'park')), /still running\. It is marked parked/)
  assert.equal(table(f)['sid-kid'].parked, T0)
  const g = world()
  g.$.process.run = async (argv: string[]) => (argv[0] === '/bin/kill' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: g.h.ps, stderr: '' })
  assert.match(text(await stopVerbCall(g.$, { lane: 'kid' }, next, 'park')), /signal to the session did not go/)
  assert.equal(table(g)['sid-kid'].parked, undefined)
})

test('a force stop always opens the person\'s dialog and needs his Yes; it is refused while a window is on and then opens none', async () => {
  const f = world()
  const kills = killer(f)
  f.h.askAnswer = async () => 'No'
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'terminate')), /did not confirm the force stop/)
  assert.equal(f.h.asked.length, 1)
  assert.match(f.h.asked[0]!.question, /kid/)
  assert.deepEqual(kills, [])
  f.h.askAnswer = async () => 'Yes'
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'terminate')), /force stopped and its row removed/)
  assert.equal(f.h.asked.length, 2)
  assert.equal(kills.length, 1)
  const w = world()
  w.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0 - 1000, end: T0 + 3_600_000, readAt: T0 }))
  assert.match(text(await stopVerbCall(w.$, { lane: 'kid' }, next, 'terminate')), /person is away/)
  assert.deepEqual(w.h.asked, [])
})

test('a lane of a gone lead is loose; another lead adopts it; the old lead, back with the same session id, is told nothing and lists nothing of it; the signed report goes to the new lead only', async () => {
  const f = fake({ sid: 'sid-b' })
  f.seed({ sid: 'sid-b', pid: 11, name: 'B', cwd: '/w/b', kind: 'interactive' })
  f.seed({ sid: 'sid-l1', pid: 21, name: 'L1', cwd: '/w/repo/l1', kind: 'interactive' })
  f.table({
    'sid-a': { name: 'A', folder: '/w/a', lead: { repos: ['/w/repo'] } },
    'sid-b': { name: 'B', folder: '/w/b', lead: { repos: ['/w/repo'] } },
    'sid-l1': { name: 'L1', folder: '/w/repo/l1', under: 'sid-a', report: '/w/repo/l1/.archive/L1/REPORT.md' },
  })
  assert.match(text(await laneAdoptCall(f.$, { name: 'L1' }, next)), /`L1` is now a lane of `B`/)
  f.seed({ sid: 'sid-a', pid: 12, name: 'A', cwd: '/w/a', kind: 'interactive' })
  const signed = new Set(['sid-l1'])
  const owed = async (sid: string) => {
    f.h.sid = sid
    mem.view = undefined
    const v = await getView(f.$, true)
    return notices({ me: sid, v, now: T0, since: 0, asks: [], log: [], reports: [], signed, asking: new Set() }).map((n) => `${n.kind}:${n.about}`)
  }
  assert.deepEqual(await owed('sid-b'), ['done:sid-l1'])
  assert.deepEqual(await owed('sid-a'), [])
  f.h.sid = 'sid-a'
  mem.view = undefined
  assert.doesNotMatch(text(await laneListCall(f.$, {}, next)), /L1/)
  f.h.sid = 'sid-b'
  mem.view = undefined
  assert.match(text(await laneListCall(f.$, {}, next)), /\| L1 \|[^\n]*\| B \|/)
  f.h.ps = f.h.ps.replace(/ {2}21 .*\n/, '')
  mem.view = undefined
  const dead = await getView(f.$, true)
  assert.equal(parent(dead, 'sid-l1'), 'sid-b')
  assert.notEqual(parent(dead, 'sid-l1'), PERSON)
})

test('a renamed lane keeps its lead: the lead still lists it, now by the new name, and is told when it signs its report at the path its row holds, and can retire it', async () => {
  const f = world()
  f.h.files.set('/w/repo/kid/.archive/kid/REPORT.md', 'status: done sid-kid\n')
  asChild(f, 'sid-kid')
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid', name: 'kid2' }, next, 'rename')), /accepted rename/)
  f.seed({ sid: 'sid-kid', pid: 20, name: 'kid2', cwd: '/w/repo/kid', kind: 'interactive', statusUpdatedAt: T0 - 2 * MIN })
  await sessionStart(f.$, {}, next)
  mem.since = T0 - MIN
  f.h.now += 31_000
  await tick(f)
  assert.equal(table(f)['sid-kid'].name, 'kid2')
  assert.equal(table(f)['sid-kid'].report, KID_REPORT)
  assert.match(text(await laneListCall(f.$, {}, next)), /\| kid2 \|/)
  assert.match(f.h.submitted.at(-1)!, /Signed done: `kid2` signed its report/)
  killer(f)
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid2' }, next, 'retire')), /retired and its row removed/)
})

test('a lead row gone three days keeps its capability and allowlist, a plain lane row gone a day is removed', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })
  f.table({ 'sid-a': { name: 'A', folder: '/w/a', lead: { repos: ['/w/repo'] } }, 'sid-l': { name: 'L', folder: '/w/l', under: 'sid-a' } })
  await sessionStart(f.$, {}, next)
  for (const step of [31_000, 31_000, 25 * 60 * MIN, 48 * 60 * MIN]) {
    f.h.now += step
    mem.view = undefined
    await tick(f)
  }
  assert.deepEqual(Object.keys(table(f)).sort(), ['sid-a'])
  f.seed({ sid: 'sid-a', pid: 12, name: 'A', cwd: '/w/a', kind: 'interactive' })
  f.h.sid = 'sid-a'
  mem.view = undefined
  assert.deepEqual(table(f)['sid-a'].lead, { repos: ['/w/repo'] })
  assert.match(text(await laneListCall(f.$, {}, next)), /No sessions are under you/)
})

test('lane_create refuses a link on the way to the brief, an existing brief and a full house of lanes and rows to open, and leaves no row behind', async () => {
  const f = world()
  f.h.real.set('/w/repo/new/.archive', '/w/elsewhere/.archive')
  assert.match(text(await laneCreateCall(f.$, { name: 'LINK', folder: '/w/repo/new', brief: 'b' }, next)), /input is not valid/)
  assert.equal(table(f)['new:LINK'], undefined)
  assert.equal(f.h.files.has('/w/repo/new/.archive/LINK/BRIEF.md'), false)
  f.h.real.delete('/w/repo/new/.archive')
  f.h.files.set('/w/repo/new/.archive/OLD/BRIEF.md', 'older work')
  assert.match(text(await laneCreateCall(f.$, { name: 'OLD', folder: '/w/repo/new', brief: 'b' }, next)), /input is not valid/)
  assert.equal(f.h.files.get('/w/repo/new/.archive/OLD/BRIEF.md'), 'older work')
  assert.equal(table(f)['new:OLD'], undefined)
  const g = world()
  for (let i = 1; i <= 7; i++) assert.match((await laneCreateCall(g.$, { name: `P${i}`, folder: '/w/repo/new', brief: 'b' }, next)).result, /is now a lane of/)
  assert.match(text(await laneCreateCall(g.$, { name: 'P8', folder: '/w/repo/new', brief: 'b' }, next)), /already have 8 live lanes/)
})

test('a window that names a session which already has a row does not overwrite it; a cue nobody answers is a refusal, not "in a turn"; the child itself refuses a start with no brief of its own', async () => {
  const f = world()
  await laneCreateCall(f.$, { name: 'NEW', folder: '/w/repo/new', brief: 'b' }, next)
  window(f, () => ({ ok: true, sid: 'sid-kid' }))
  assert.match(text(await laneOpenCall(f.$, { lane: 'NEW' }, next)), /window opened session `?sid-kid`? but the lane table could not take it\. Do not call lane_open again/)
  assert.equal(table(f)['sid-kid'].name, 'kid')
  assert.ok(table(f)['new:NEW'])
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid' }, next, 'resume')), /did not answer in 20 seconds\. It may still act on the cue: do not repeat/)
  const g = world()
  g.table({ ...table(g), 'sid-kid': { name: 'kid', folder: '/w/repo/kid', under: 'sid-me' } })
  g.h.files.set(`${V2}/cue/sid-kid.json`, JSON.stringify({ id: 'abcdefgh1234', verb: 'start', from: 'sid-me', at: T0, name: 'kid', brief: '/etc/passwd' }))
  g.h.sid = 'sid-kid'
  await cueTick(g.$, 'sid-kid', await getView(g.$, true), T0)
  assert.deepEqual(JSON.parse(g.h.files.get(`${V2}/result/abcdefgh1234.json`)!), { id: 'abcdefgh1234', outcome: 'refused', code: 'no-brief' })
  assert.equal(g.h.submitted.length, 0)
})

test('one tick submits one text: a start cue taken in a tick leaves a due compaction nudge for the next', async () => {
  const f = world()
  f.h.usage = { context: { tokens: 320_000 } }
  f.$.prompt.submit = async ({ text }: { text: string }) => void f.h.submitted.push(text)
  f.h.sid = 'sid-kid'
  mem.view = undefined
  await sessionStart(f.$, {}, next)
  await turnComplete(f.$, { reason: 'answer' }, next)
  f.h.files.set(`${V2}/cue/sid-kid.json`, JSON.stringify({ id: 'abcdefgh1234', verb: 'start', from: 'sid-me', at: T0, name: 'kid' }))
  f.h.now += 31_000
  await tick(f)
  assert.equal(f.h.submitted.length, 1)
  assert.match(f.h.submitted[0]!, /You are lane `kid`/)
  f.seed({ sid: 'sid-kid', pid: 20, name: 'kid', cwd: '/w/repo/kid', kind: 'interactive', status: 'idle', statusUpdatedAt: f.h.now - 2 * MIN })
  mem.view = undefined
  f.h.now += 31_000
  await tick(f)
  assert.equal(f.h.submitted.length, 2)
  assert.match(f.h.submitted[1]!, /300k/)
})

test('adopting a lane of a gone lead keeps its report path and brief; a force stop of a row with no live session still asks the person', async () => {
  const f = world()
  f.seed({ sid: 'sid-l2', pid: 21, name: 'L2', cwd: '/w/repo/l2', kind: 'interactive' })
  f.table({ ...table(f), 'sid-a': { name: 'A', folder: '/w/a', lead: { repos: ['/w/repo'] } }, 'sid-l2': { name: 'L1', folder: '/w/repo/l2', under: 'sid-a', report: '/w/repo/l2/.archive/L1/REPORT.md', brief: '/w/repo/l2/.archive/L1/BRIEF.md' } })
  assert.match(text(await laneAdoptCall(f.$, { name: 'L2' }, next)), /`L2` is now a lane of `lead`/)
  assert.deepEqual(table(f)['sid-l2'], { name: 'L2', folder: '/w/repo/l2', report: '/w/repo/l2/.archive/L1/REPORT.md', brief: '/w/repo/l2/.archive/L1/BRIEF.md', under: 'sid-me' })
  const g = world()
  g.table({ ...table(g), 'sid-gone': { name: 'gone', folder: '/w/repo/gone', under: 'sid-me' } })
  g.h.askAnswer = async () => 'No'
  assert.match(text(await stopVerbCall(g.$, { lane: 'gone' }, next, 'terminate')), /did not confirm/)
  assert.equal(g.h.asked.length, 1)
  assert.ok(table(g)['sid-gone'])
})

test('a loose session\'s pr_watch works; a lead polling a lane whose row is gone routes nothing and the tracker is removed', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'lead', cwd: '/w/me', kind: 'interactive' })
  f.seed({ sid: 'sid-loose', pid: 11, name: 'loose', cwd: '/w/x', kind: 'interactive' })
  f.table({ 'sid-me': { name: 'lead', folder: '/w/me', lead: { repos: [] } }, 'sid-gone': { name: 'gone', folder: '/w/g', under: 'sid-me', goneAt: T0 - 1000 } })
  f.h.ghBin = '/opt/homebrew/bin/gh'
  const sha = 'a'.repeat(40)
  const node = (state: string) => ({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, headRefOid: sha, reviews: { totalCount: 0 }, comments: { totalCount: 0 }, reviewThreads: { totalCount: 0 }, commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } })
  const out = (state: string) => ({ exitCode: 0, stdout: JSON.stringify({ data: { repository: { p5: node(state) } } }) })
  f.h.ghOut = out('PENDING')
  f.h.sid = 'sid-loose'
  mem.view = undefined
  assert.match((await prWatchCall(f.$, { owner: 'acme', repo: 'app', number: 5 }, next)).result, /Watching/)
  const seen = { sha, state: 'open', draft: false, checks: 'pending', mergeable: false, reviews: 0, comments: 0, threads: 0 }
  f.h.files.set(`${V2}/prs/sid-gone.json`, JSON.stringify({ sid: 'sid-gone', prs: [{ owner: 'acme', repo: 'app', number: 5, at: T0, seen }] }))
  f.h.sid = 'sid-me'
  mem.view = undefined
  f.h.ghOut = out('FAILURE')
  f.h.now += 2 * MIN
  await prTick(f.$, 'sid-me', await getView(f.$, true))
  assert.equal(prClaim(), undefined)
  assert.equal(f.h.files.has(`${V2}/prs/sid-gone.json`), false)
})

// The kid's registry row, changed in place.
const kidReg = (f: F, x: object) => {
  for (const [p, t] of [...f.h.files]) if (p.endsWith('/sessions/20.json')) f.h.files.set(p, JSON.stringify({ ...JSON.parse(t), ...x }))
}

test('a new lane is known by its own name: its panel, named by Claude, renames itself to the lane at its first quiet tick, and lane_start finds it by the lane name', async () => {
  const f = world()
  await laneCreateCall(f.$, { name: 'NEW', folder: '/w/repo/new', brief: 'b' }, next)
  f.seed({ sid: 'sid-new', pid: 30, name: 'ai-manager-ef', nameSource: 'auto', cwd: '/w/repo/new', kind: 'interactive', statusUpdatedAt: T0 - MIN })
  window(f, (req) => (req.op === 'open' ? { ok: true, sid: 'sid-new' } : undefined))
  assert.match(text(await laneOpenCall(f.$, { lane: 'NEW' }, next)), /`NEW` opened as session `sid-new`/)
  f.h.sid = 'sid-new'
  mem.view = undefined
  await cueTick(f.$, 'sid-new', await getView(f.$, true), T0)
  assert.deepEqual(f.h.compactRuns, ['rename NEW'])
  await cueTick(f.$, 'sid-new', await getView(f.$, true), T0)
  assert.deepEqual(f.h.compactRuns, ['rename NEW'])
  f.h.sid = 'sid-me'
  mem.view = undefined
  asChild(f, 'sid-new')
  assert.match(text(await cueVerbCall(f.$, { lane: 'NEW' }, next, 'start')), /`NEW` accepted start/)
  assert.match(f.h.submitted.at(-1)!, /^\[callboard\] You are lane `NEW` of `lead`\./)
  assert.match(text(await laneListCall(f.$, {}, next)), /\| NEW \|/)
})

test('lane_create takes a model, sonnet by default, and the lane switches to it at its start; any other model is refused by name; a model that cannot be set refuses the start', async () => {
  const f = world()
  assert.match(text(await laneCreateCall(f.$, { name: 'OP', folder: '/w/repo/new', brief: 'b', model: 'gpt' }, next)), /model must be one of opus, sonnet, haiku, fable\./)
  assert.equal(table(f)['new:OP'], undefined)
  await laneCreateCall(f.$, { name: 'OP', folder: '/w/repo/new', brief: 'b', model: 'opus' }, next)
  assert.equal(table(f)['new:OP'].model, 'opus')
  f.table({ ...table(f), 'sid-kid': { ...table(f)['sid-kid'], model: 'haiku' } })
  asChild(f, 'sid-kid')
  assert.match(text(await cueVerbCall(f.$, { lane: 'kid' }, next, 'start')), /accepted start/)
  assert.deepEqual(f.h.compactRuns, ['model haiku'])
  const g = world()
  g.table({ ...table(g), 'sid-kid': { ...table(g)['sid-kid'], model: 'opus' } })
  g.$.command.run = async (c: { command: string }) => {
    if (c.command === 'model') throw new Error('no such command')
  }
  asChild(g, 'sid-kid')
  assert.match(text(await cueVerbCall(g.$, { lane: 'kid' }, next, 'start')), /the lane refused \(model-failed\)/)
  assert.equal(g.h.submitted.length, 0)
})

test('lane_create names why it refuses: an existing brief, a link on the way, a folder that is not absolute, an empty brief', async () => {
  const f = world()
  f.h.files.set('/w/repo/new/.archive/OLD/BRIEF.md', 'older work')
  assert.match(text(await laneCreateCall(f.$, { name: 'OLD', folder: '/w/repo/new', brief: 'b' }, next)), /\.archive\/OLD\/BRIEF\.md exists already in that folder\. Pick another name\./)
  f.h.real.set('/w/repo/new/.archive', '/w/elsewhere/.archive')
  assert.match(text(await laneCreateCall(f.$, { name: 'LINK', folder: '/w/repo/new', brief: 'b' }, next)), /is a link, which callboard does not follow/)
  assert.match(text(await laneCreateCall(f.$, { name: 'Y', folder: 'repo/new', brief: 'b' }, next)), /folder must be an absolute path that exists/)
  assert.match(text(await laneCreateCall(f.$, { name: 'Y', folder: '/w/repo/new', brief: '' }, next)), /brief must be 1 to 16384 characters/)
})

test('a lane that signed done retires right after its turn ends; a park at that moment says to wait 30 seconds', async () => {
  const f = world()
  kidReg(f, { statusUpdatedAt: T0 })
  killer(f)
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'park')), /not idle yet\. Retry once its turn has ended and it has been quiet for 30 seconds\./)
  f.h.files.set(KID_REPORT, 'notes\nstatus: done sid-kid\n')
  assert.match(text(await stopVerbCall(f.$, { lane: 'kid' }, next, 'retire')), /retired and its row removed/)
})
