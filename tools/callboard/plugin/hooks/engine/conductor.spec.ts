import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, fake } from '../../test/fake.ts'
import { parent } from '../core/model.ts'
import { T } from '../texts.ts'
import { commandRun, promptCompose } from './commands.ts'
import { mem } from './mem.ts'
import { conductorRepos, getView, saveConductorRepos } from './store.ts'
import { laneCreateCall, laneListCall, laneOpenCall, stopVerbCall } from './tools-child.ts'

type F = ReturnType<typeof fake>
const next = async (e: unknown) => e
const table = (f: F) => JSON.parse(f.file('sessions.json') ?? '{}')
const text = (r: any): string => r.result ?? r.deny ?? ''
const run = (f: F, args: string, kind?: string) => commandRun(f.$, { args, origin: kind === undefined ? undefined : { kind } })
const rows = (f: F) => JSON.parse(f.file('sessions.json')!)['sid-me']

// A session in /w/me with real repo folders /w/repo and /w/repo2.
function world(): F {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })
  for (const d of ['/w/repo', '/w/repo/new', '/w/repo2', '/w/other']) f.h.dirs.add(d)
  return f
}
const window = (f: F, reply: (req: any) => object | undefined) => {
  const orig = f.$.process.run
  f.$.process.run = async (argv: string[], o?: unknown) => {
    if (argv[0] === '/bin/sleep') for (const [p, t] of [...f.h.files]) if (p.startsWith(`${V2}/open/`) && p.endsWith('.req')) ((r) => r && f.h.files.set(p.replace(/\.req$/, '.result'), JSON.stringify(r)))(reply(JSON.parse(t)))
    return orig(argv, o)
  }
}

test('/callboard conductor: typed paths become the row\'s repos and the list saved for the folder; with no paths the saved list is reused; typed paths replace it', async () => {
  const f = world()
  const r = await run(f, 'conductor /w/repo /w/repo2', 'composer')
  assert.equal(r.text, T['cmd.conductor']({ repos: ['/w/repo', '/w/repo2'] }))
  assert.deepEqual(rows(f), { name: 'me', folder: '/w/me', lead: { repos: ['/w/repo', '/w/repo2'], conductor: true } })
  assert.deepEqual(JSON.parse(f.file('conductors.json')!), { '/w/me': ['/w/repo', '/w/repo2'] })
  assert.equal(f.h.modes.get(V2), '700')
  assert.equal(f.h.tools.filter((n) => n.startsWith('lane_')).length, 8 + 3)
  // `lead off` drops the grant; the saved list stays, so a bare `conductor` restores it.
  await run(f, 'lead off', 'composer')
  assert.equal(rows(f).lead, undefined)
  await run(f, 'conductor', 'composer')
  assert.deepEqual(rows(f).lead, { repos: ['/w/repo', '/w/repo2'], conductor: true })
  await run(f, 'conductor /w/other', 'composer')
  assert.deepEqual(rows(f).lead, { repos: ['/w/other'], conductor: true })
  assert.deepEqual(await conductorRepos(f.$, '/w/me'), ['/w/other'])
  // Another folder has its own list.
  assert.deepEqual(await conductorRepos(f.$, '/w/elsewhere'), [])
  // The plain `lead` form is not a conductor: it keeps the repos and drops the flag.
  await run(f, 'lead', 'composer')
  assert.deepEqual(rows(f).lead, { repos: ['/w/other'] })
})

// The window's answer to a pick: `reply` is read at each request, and `seen` collects the requests.
const picking = (f: F, reply: () => object | undefined, seen: any[] = []) => window(f, (req) => (req.op === 'pick' ? (seen.push(req), reply()) : undefined))
const spooled = (f: F) => [...f.h.files.keys()].filter((p) => p.startsWith(`${V2}/open/`))

test('/callboard conductor with nothing saved asks the window for its tick list: what he ticks is resolved, saved and given like typed paths', async () => {
  const f = world()
  f.h.real.set('/w/link', '/w/repo2')
  const seen: any[] = []
  let answer: object = { ok: true, folders: ['/w/repo', '/w/link', '/w/me', '/w/repo'] }
  picking(f, () => answer, seen)
  const r = await run(f, 'conductor', 'composer')
  assert.deepEqual(seen, [{ op: 'pick', folder: '/w/me', ticked: [] }])
  assert.equal(r.text, T['cmd.conductor']({ repos: ['/w/repo', '/w/repo2'] }))
  assert.deepEqual(rows(f).lead, { repos: ['/w/repo', '/w/repo2'], conductor: true })
  assert.deepEqual(JSON.parse(f.file('conductors.json')!), { '/w/me': ['/w/repo', '/w/repo2'] })
  assert.equal(mem.owed.length, 1)
  assert.deepEqual(spooled(f), [], 'the request and its answer are taken away')
  // With a list saved the bare command asks nothing; `pick` shows the list again with the saved repos ticked, and its answer replaces them.
  seen.length = 0
  await run(f, 'conductor', 'composer')
  assert.deepEqual(seen, [])
  answer = { ok: true, folders: ['/w/other'] }
  await run(f, 'conductor pick', 'composer')
  assert.deepEqual(seen.at(-1), { op: 'pick', folder: '/w/me', ticked: ['/w/repo', '/w/repo2'] })
  assert.deepEqual(rows(f).lead, { repos: ['/w/other'], conductor: true })
  assert.deepEqual(await conductorRepos(f.$, '/w/me'), ['/w/other'])
})

test('a tick list that picks nothing changes nothing, and says why: cancelled, timed out, nothing to offer, too many, a list already up, no window, a bad answer', async () => {
  const cases: [object | undefined, RegExp][] = [
    [{ ok: false, code: 'cancelled' }, /nothing was ticked, so nothing changed/],
    [{ ok: false, code: 'timeout' }, /the list closed itself after 80 seconds/],
    [{ ok: false, code: 'no-folders' }, /no git repo sits beside this one/],
    [{ ok: false, code: 'too-many' }, /at most 32 repos/],
    [{ ok: false, code: 'busy' }, /already shows a list/],
    [{ ok: false, code: 'stale' }, /could not show the list of repos/],
    [undefined, /no window took the request for the list of repos in 30 seconds.*\/callboard conductor PATH…/],
    // An answer that is not a list of at most 32 plain absolute paths is a bad answer, said at once.
    [{ ok: true, folders: ['relative'] }, /its answer could not be used/],
    [{ ok: true, folders: ['/w/repo\u0007'] }, /its answer could not be used/],
    [{ ok: true, folders: Array.from({ length: 33 }, () => '/w/repo') }, /its answer could not be used/],
    [{ ok: true, folders: '/w/repo' }, /its answer could not be used/],
    [{ ok: true, folders: ['/w/repo'], sid: 'sid-x' }, /its answer could not be used/],
    [{ nonsense: 1 }, /its answer could not be used/],
    // An answer with nothing usable in it: no folders, only the conductor's own, or one that does not exist.
    [{ ok: true }, /could not show the list of repos/],
    [{ ok: true, folders: [] }, /could not show the list of repos/],
    [{ ok: true, folders: ['/w/me'] }, /could not show the list of repos/],
    [{ ok: true, folders: ['/no/such/dir'] }, /input is not valid/],
  ]
  for (const [reply, want] of cases) {
    const f = world()
    picking(f, () => reply)
    assert.match((await run(f, 'conductor', 'composer')).text, want, JSON.stringify(reply))
    assert.equal(f.file('sessions.json'), undefined)
    assert.equal(f.file('conductors.json'), undefined)
    assert.deepEqual(spooled(f), [])
    // On a saved list a `pick` that picks nothing keeps the list and the row as they were.
    const g = world()
    await run(g, 'conductor /w/repo', 'composer')
    picking(g, () => reply)
    assert.match((await run(g, 'conductor pick', 'composer')).text, want, JSON.stringify(reply))
    assert.deepEqual(await conductorRepos(g.$, '/w/me'), ['/w/repo'])
    assert.deepEqual(rows(g).lead, { repos: ['/w/repo'], conductor: true })
  }
})

// A window that takes the request (its file goes) at the `claimAt`-th second and answers at the `answerAt`-th; `n` counts the seconds waited.
function slowWindow(f: F, claimAt: number | undefined, answerAt: number | undefined) {
  const w = { n: 0 }
  let req: string | undefined
  const orig = f.$.process.run
  f.$.process.run = async (argv: string[], o?: unknown) => {
    if (argv[0] === '/bin/sleep') {
      w.n++
      req ??= spooled(f).find((p) => p.endsWith('.req'))
      if (w.n === claimAt && req !== undefined) f.h.files.delete(req)
      if (w.n === answerAt && req !== undefined) f.h.files.set(req.replace(/\.req$/, '.result'), JSON.stringify({ ok: true, folders: ['/w/repo'] }))
    }
    return orig(argv, o)
  }
  return w
}

test('the wait for the tick list: 30 s for a window to take the request, then 90 s from when one took it; a bad answer ends it at once', async () => {
  // No window takes it.
  const none = world()
  const a = slowWindow(none, undefined, undefined)
  assert.match((await run(none, 'conductor', 'composer')).text, /no window took the request/)
  assert.equal(a.n, 30)
  // Taken at 20 s, answered 85 s later: inside the 90 s that run from the taking.
  const late = world()
  const b = slowWindow(late, 20, 105)
  await run(late, 'conductor', 'composer')
  assert.deepEqual([await conductorRepos(late.$, '/w/me'), b.n], [['/w/repo'], 105])
  // Taken and never answered: 90 s after the taking.
  const mute = world()
  const c = slowWindow(mute, 20, undefined)
  assert.match((await run(mute, 'conductor', 'composer')).text, /or it never answered/)
  assert.deepEqual([c.n, mute.file('conductors.json')], [20 + 90, undefined])
  // An answer after the wait ended is not read: its file is taken away with the request.
  assert.deepEqual(spooled(mute), [])
  // A bad answer is not waited on.
  const bad = world()
  let n = 0
  picking(bad, () => (n++, { ok: true, folders: ['relative'] }))
  await run(bad, 'conductor', 'composer')
  assert.equal(n, 1)
})

test('the tick list is asked for only from his typed turn, and takes up to 32 repos where typed paths take 16', async () => {
  for (const kind of ['plugin', 'sdk', 'peer', undefined]) {
    const f = world()
    const seen: any[] = []
    picking(f, () => ({ ok: true, folders: ['/w/repo'] }), seen)
    for (const args of ['conductor', 'conductor pick']) assert.match((await run(f, args, kind)).text, /only when the person types it themselves/)
    assert.deepEqual([seen, f.file('conductors.json')], [[], undefined])
  }
  const f = world()
  const many = Array.from({ length: 32 }, (_, i) => `/w/r${i}`)
  for (const d of many) f.h.dirs.add(d)
  picking(f, () => ({ ok: true, folders: many }))
  await run(f, 'conductor', 'composer')
  assert.deepEqual(await conductorRepos(f.$, '/w/me'), many)
  await run(f, `conductor ${many.join(' ')}`, 'composer')
  assert.deepEqual(await conductorRepos(f.$, '/w/me'), many.slice(0, 16))
})

test('/callboard conductor with a path that does not exist, or only its own folder, changes nothing', async () => {
  const f = world()
  assert.match((await run(f, 'conductor /no/such/dir', 'composer')).text, /input is not valid/)
  assert.match((await run(f, 'conductor /w/me', 'composer')).text, /only path typed is this session's own folder/)
  assert.equal(f.file('sessions.json'), undefined)
  assert.equal(f.file('conductors.json'), undefined)
})

test('/callboard conductor runs only from his typed turn: another origin, or none, changes neither the row nor the saved list', async () => {
  for (const kind of ['plugin', 'sdk', 'peer', 'task-notification', undefined]) {
    const f = world()
    assert.match((await run(f, 'conductor /w/repo', kind)).text, /only when the person types it themselves/, String(kind))
    assert.equal(f.file('sessions.json'), undefined)
    assert.equal(f.file('conductors.json'), undefined)
  }
  // A typed change owes the session its notice turn, like a lead.
  const g = world()
  await run(g, 'conductor /w/repo', 'composer')
  assert.equal(mem.owed.length, 1)
})

test('the saved list: one file for every folder, written under its own lock, a bad file read as empty, at most 32 repos, only absolute paths', async () => {
  const f = world()
  assert.equal(await saveConductorRepos(f.$, '/w/me', ['/w/repo']), true)
  assert.equal(await saveConductorRepos(f.$, '/w/c2', ['/w/repo2']), true)
  assert.deepEqual(JSON.parse(f.file('conductors.json')!), { '/w/me': ['/w/repo'], '/w/c2': ['/w/repo2'] })
  assert.equal(f.h.dirs.has(`${V2}/conductors.lock`), false)
  f.h.files.set(`${V2}/conductors.json`, JSON.stringify({ '/w/me': ['/ok', 'relative', 5, ...Array.from({ length: 40 }, (_, i) => `/r${i}`)] }))
  assert.equal((await conductorRepos(f.$, '/w/me')).length, 32)
  assert.ok((await conductorRepos(f.$, '/w/me')).every((p) => p.startsWith('/')))
  f.h.files.set(`${V2}/conductors.json`, '{"broken": ')
  assert.deepEqual(await conductorRepos(f.$, '/w/me'), [])
  // A file that is there and cannot be read whole is never overwritten: the other folders' lists are not lost.
  assert.equal(await saveConductorRepos(f.$, '/w/me', ['/w/repo']), false)
  assert.equal(f.file('conductors.json'), '{"broken": ')
  assert.equal(f.h.dirs.has(`${V2}/conductors.lock`), false)
  f.h.files.set(`${V2}/conductors.json`, '[1,2]')
  assert.deepEqual(await conductorRepos(f.$, '/w/me'), [])
})

test('the table parse keeps a conductor flag or a minted flag, never both, and drops any other flag; a write round trip keeps them', async () => {
  const f = world()
  f.table({
    'sid-c': { name: 'C', folder: '/w/c', lead: { repos: ['/w/repo'], conductor: true } },
    'sid-m': { name: 'M', folder: '/w/m', under: 'sid-c', lead: { repos: [], minted: true } },
    'sid-both': { name: 'B', folder: '/w/b', lead: { repos: ['/w/repo'], conductor: true, minted: true } },
    'sid-odd': { name: 'O', folder: '/w/o', lead: { repos: [], conductor: 'yes', minted: 1, evil: true } },
  })
  const v = await getView(f.$, true)
  assert.deepEqual(v.table['sid-c']!.lead, { repos: ['/w/repo'], conductor: true })
  assert.deepEqual(v.table['sid-m']!.lead, { repos: [], minted: true })
  assert.deepEqual(v.table['sid-both']!.lead, { repos: ['/w/repo'], minted: true })
  assert.deepEqual(v.table['sid-odd']!.lead, { repos: [] })
  const { updateTable } = await import('./store.ts')
  assert.equal(await updateTable(f.$, (t) => ({ ...t, 'sid-x': { name: 'X', folder: '/w/x' } })), true)
  assert.deepEqual(table(f)['sid-c'].lead, { repos: ['/w/repo'], conductor: true })
  assert.deepEqual(table(f)['sid-m'].lead, { repos: [], minted: true })
})

// A conductor `me` with the repo /w/repo.
const conductor = (): F => {
  const f = world()
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: ['/w/repo'], conductor: true } } })
  return f
}

test('lane_create role lead: a conductor writes a minted lead row under itself, in a folder inside its saved repos; the reply says lead', async () => {
  const f = conductor()
  const r = await laneCreateCall(f.$, { name: 'NL', folder: '/w/repo/new', brief: 'own the repo', role: 'lead' }, next)
  assert.match(r.result, /`NL` is now a lead of `me`, in `\/w\/repo\/new`/)
  assert.deepEqual(table(f)['new:NL'], { name: 'NL', folder: '/w/repo/new', report: '/w/repo/new/.archive/NL/REPORT.md', under: 'sid-me', brief: '/w/repo/new/.archive/NL/BRIEF.md', model: 'sonnet', lead: { repos: [], minted: true } })
  assert.match(f.h.files.get('/w/repo/new/.archive/NL/BRIEF.md')!, /own the repo/)
  // Its own folder is no repo to open a lead in; a folder outside the repos, a bad role and a taken name are refused and leave no row.
  assert.match(text(await laneCreateCall(f.$, { name: 'ME', folder: '/w/me', brief: 'b', role: 'lead' }, next)), /not inside your allowlist/)
  assert.match(text(await laneCreateCall(f.$, { name: 'OUT', folder: '/w/other', brief: 'b', role: 'lead' }, next)), /not inside your allowlist/)
  assert.match(text(await laneCreateCall(f.$, { name: 'BAD', folder: '/w/repo/new', brief: 'b', role: 'boss' }, next)), /role must be lane or lead/)
  assert.match(text(await laneCreateCall(f.$, { name: 'NL', folder: '/w/repo/new', brief: 'b', role: 'lead' }, next)), /already has that name/)
  assert.deepEqual(Object.keys(table(f)).filter((k) => k.startsWith('new:')), ['new:NL'])
  // A plain lane of a conductor has no lead flag.
  await laneCreateCall(f.$, { name: 'LN', folder: '/w/repo/new', brief: 'b' }, next)
  assert.equal(table(f)['new:LN'].lead, undefined)
})

test('lane_create role lead is refused to a plain lead and to a minted lead; a brief that cannot be written leaves no minted row', async () => {
  const f = world()
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: ['/w/repo'] } } })
  assert.match(text(await laneCreateCall(f.$, { name: 'NL', folder: '/w/repo/new', brief: 'b', role: 'lead' }, next)), /only a conductor may make a lead\. The person makes a conductor by typing \/callboard conductor\./)
  f.seed({ sid: 'sid-c', pid: 11, name: 'cond', cwd: '/w/c', kind: 'interactive' })
  f.table({ 'sid-c': { name: 'cond', folder: '/w/c', lead: { repos: ['/w/repo'], conductor: true } }, 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-c', lead: { repos: ['/w/repo'], minted: true } } })
  assert.match(text(await laneCreateCall(f.$, { name: 'NL', folder: '/w/repo/new', brief: 'b', role: 'lead' }, next)), /only a conductor may make a lead/)
  const g = conductor()
  g.h.files.set('/w/repo/new/.archive/OLD/BRIEF.md', 'older work')
  assert.match(text(await laneCreateCall(g.$, { name: 'OLD', folder: '/w/repo/new', brief: 'b', role: 'lead' }, next)), /exists already/)
  assert.equal(table(g)['new:OLD'], undefined)
})

test('a minted lead is opened and bound like a lane: its row follows the session id under the conductor, the conductor lists it and its lanes, and a retire removes the row once it is gone', async () => {
  const f = conductor()
  await laneCreateCall(f.$, { name: 'NL', folder: '/w/repo/new', brief: 'b', role: 'lead' }, next)
  window(f, (req) => (req.op === 'open' && req.folder === '/w/repo/new' ? { ok: true, sid: 'sid-nl' } : undefined))
  assert.match(text(await laneOpenCall(f.$, { lane: 'NL' }, next)), /`NL` opened as session `sid-nl`/)
  assert.deepEqual(table(f)['sid-nl'].lead, { repos: [], minted: true })
  assert.equal(table(f)['sid-nl'].under, 'sid-me')
  f.seed({ sid: 'sid-nl', pid: 40, name: 'NL', cwd: '/w/repo/new', kind: 'interactive', status: 'idle', statusUpdatedAt: T0 - 2 * MIN })
  f.seed({ sid: 'sid-ll', pid: 41, name: 'LL', cwd: '/w/repo/new', kind: 'interactive' })
  f.table({ ...table(f), 'sid-ll': { name: 'LL', folder: '/w/repo/new', under: 'sid-nl' } })
  mem.view = undefined
  assert.equal(parent(await getView(f.$, true), 'sid-nl'), 'sid-me')
  const list = text(await laneListCall(f.$, {}, next))
  assert.match(list, /\| NL \|/)
  assert.match(list, /LL \|/)
  // The minted lead's session ends: the conductor retires it and its row is removed; a typed lead's row would stay.
  for (const [p, t] of [...f.h.files]) if (p.endsWith('/sessions/40.json') || p.endsWith('/sessions/41.json')) f.h.files.delete(p)
  f.h.ps = f.h.ps.split('\n').filter((l) => !/^\s*(40|41) /.test(l)).join('\n')
  mem.view = undefined
  assert.match(text(await stopVerbCall(f.$, { lane: 'NL' }, next, 'retire')), /`NL` is retired and its row removed/)
  assert.equal(table(f)['sid-nl'], undefined)
})

test('the briefings: a conductor gets the parent briefing and the conductor one; a minted lead is told its parent, to ask it for a go and not to call go_request; a plain lead is not told either', async () => {
  const f = world()
  f.h.files.set(`${HOME}/.claude/callboard/manager-name`, 'BOSS\n')
  const compose = () => promptCompose(f.$, { traits: [], tools: ['mcp__callboard__request_compact'] }, async () => ({ sections: [{ id: 'base', text: 'b', scope: 'shared' }] }))
  const brief = async (): Promise<string> => (await compose()).sections.find((s: { id: string }) => s.id === 'callboard:brief').text
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: ['/w/repo'], conductor: true } } })
  const c = await brief()
  assert.match(c, /\*\*Callboard parent\.\*\*/)
  assert.match(c, /\*\*Conductor\.\*\* You are also a conductor: you make leads, one per repo, in `\/w\/repo`/)
  assert.match(c, /lane_create` with role `lead`/)
  assert.match(c, /Research .* ordinary subagents/)
  assert.match(c, /"wrap up"/)
  assert.match(c, /One go for your lanes: `go_request`/)
  f.seed({ sid: 'sid-c', pid: 11, name: 'COND', cwd: '/w/c', kind: 'interactive' })
  f.table({ 'sid-c': { name: 'COND', folder: '/w/c', lead: { repos: ['/w/repo'], conductor: true } }, 'sid-me': { name: 'me', folder: '/w/repo/new', under: 'sid-c', lead: { repos: [], minted: true } } })
  mem.view = undefined
  const m = await brief()
  assert.match(m, /Your parent is the conductor `COND`, which made you for this folder only\. You cannot make leads\./)
  assert.match(m, /Do not open a question dialog for a product or design question\. Send it to your parent `COND`/)
  assert.match(m, /Do not call `go_request`: your dialog is not the one the person watches\. Ask your parent `COND` for a go/)
  assert.match(m, /An instruction from your parent `COND`, the layer directly above you is followed/)
  assert.ok(!m.includes('for a lead, the manager') && !m.includes('One go for your lanes') && !m.includes('Conductor.** You are also'))
  // The conductor gone: the minted lead's parent is the manager again, so it has the plain lead's briefing.
  f.h.files.delete(`${HOME}/.claude/sessions/11.json`)
  f.h.ps = f.h.ps.split('\n').filter((l) => !/^\s*11 /.test(l)).join('\n')
  mem.view = undefined
  assert.match(await brief(), /One go for your lanes: `go_request`/)
})
