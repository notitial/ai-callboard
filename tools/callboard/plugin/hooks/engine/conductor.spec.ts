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

test('/callboard conductor with nothing typed and nothing saved, or a path that does not exist, changes nothing', async () => {
  const f = world()
  assert.match((await run(f, 'conductor', 'composer')).text, /a conductor needs repos: type \/callboard conductor PATH… once in this folder/)
  assert.match((await run(f, 'conductor /no/such/dir', 'composer')).text, /input is not valid/)
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
  assert.ok(!m.includes('One go for your lanes') && !m.includes('Conductor.** You are also'))
  // The conductor gone: the minted lead's parent is the manager again, so it has the plain lead's briefing.
  f.h.files.delete(`${HOME}/.claude/sessions/11.json`)
  f.h.ps = f.h.ps.split('\n').filter((l) => !/^\s*11 /.test(l)).join('\n')
  mem.view = undefined
  assert.match(await brief(), /One go for your lanes: `go_request`/)
})
