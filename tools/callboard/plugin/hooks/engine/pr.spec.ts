import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN, T0, V2, fake } from '../../test/fake.ts'
import { mem } from './mem.ts'
import { prClaim, prTick, prWatchCall } from './pr.ts'
import { getView } from './store.ts'

type F = ReturnType<typeof fake>
const BIN = '/opt/homebrew/bin/gh'
const SHA = 'a'.repeat(40)
const node = (o: Record<string, unknown> = {}) => ({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, headRefOid: SHA, reviews: { totalCount: 0 }, comments: { totalCount: 0 }, reviewThreads: { totalCount: 0 }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] }, ...o })
const answer = (nodes: Record<number, object>) => ({ exitCode: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(nodes).map(([n, o]) => [`p${n}`, o])) } }) })
const REF = { owner: 'acme', repo: 'app', number: 5 }
const GHRUNS = (f: F) => f.h.runs.filter((r) => r.argv[0] === BIN)
const tracker = (f: F, sid = 'sid-me') => JSON.parse(f.h.files.get(`${V2}/prs/${sid}.json`) ?? 'null')
function session(): F {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })
  f.h.ghBin = BIN
  f.h.ghOut = answer({ 5: node() })
  return f
}
const watch = (f: F, e: object = REF) => prWatchCall(f.$, e, async (x: unknown) => x)

test('pr_watch: the first look records the start in this session\'s own tracker, with a fixed argv and an emptied environment; a renewal runs nothing', async () => {
  const f = session()
  const r = await watch(f)
  assert.match(r.result, /Watching .acme\/app#5./)
  assert.equal(tracker(f).prs.length, 1)
  assert.equal(tracker(f).sid, 'sid-me')
  const [call] = GHRUNS(f)
  assert.deepEqual(call.argv.slice(0, 8), [BIN, 'api', 'graphql', '--hostname', 'github.com', '-f', 'owner=acme', '-f'])
  assert.equal(call.argv.length, 11)
  assert.match(call.argv[10], /^query=query\(\$owner:String!,\$name:String!\)\{repository\(owner:\$owner,name:\$name\)\{p5:pullRequest\(number:5\)\{/)
  assert.equal(call.env?.HOME, '/Users/x')
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'HTTPS_PROXY']) assert.equal(call.env?.[k], '', k)
  f.h.now += 5 * MIN
  await watch(f, { ...REF, owner: 'ACME' })
  assert.equal(GHRUNS(f).length, 1)
  assert.equal(tracker(f).prs.length, 1)
  assert.equal(tracker(f).prs[0].at, T0 + 5 * MIN)
})
test('pr_watch refuses a subagent, a name outside the grammar, an off session, a missing CLI and an answer it cannot trust; nothing is tracked', async () => {
  const f = session()
  for (const e of [{ ...REF, agentId: 'a1' }, { ...REF, owner: 'a/b' }, { ...REF, repo: '..' }, { ...REF, number: 0 }, { ...REF, number: '5; rm' }]) assert.match((await watch(f, e)).deny, /refused/)
  assert.equal(GHRUNS(f).length, 0)
  const off = session()
  off.table({ 'sid-me': { name: 'me', folder: '/w/me', off: true } })
  assert.match((await watch(off)).deny, /refused/)
  const nocli = session()
  nocli.h.ghBin = undefined
  assert.match((await watch(nocli)).deny, /refused/)
  for (const out of [{ exitCode: 1, stdout: '' }, { exitCode: 0, stdout: 'not json' }, { exitCode: 0, stdout: '{}', isStdoutTruncated: true }, { exitCode: 0, stdout: ' '.repeat(300_000) }]) {
    const x = session()
    x.h.ghOut = out
    assert.match((await watch(x)).deny, /refused/)
    assert.equal(tracker(x), null)
  }
})
test('pr_watch: a PR already merged is answered with the end and not tracked; at most 8 PRs; at most 30 first looks an hour', async () => {
  const f = session()
  f.h.ghOut = answer({ 5: node({ state: 'MERGED' }) })
  assert.match((await watch(f)).result, /merged\. Tracking ended/)
  assert.equal(tracker(f), null)
  const g = session()
  for (let n = 1; n <= 8; n++) {
    g.h.ghOut = answer({ [n]: node() })
    assert.match((await watch(g, { ...REF, number: n })).result, /Watching/)
  }
  g.h.ghOut = answer({ 9: node() })
  assert.match((await watch(g, { ...REF, number: 9 })).deny, /refused/)
  assert.equal(tracker(g).prs.length, 8)
  const h = session()
  mem.prLooks = Array(30).fill(T0)
  assert.match((await watch(h)).deny, /refused/)
  assert.equal(GHRUNS(h).length, 0)
})
test('the poll: every 2 min, a finished green check is one note, then nothing; the note is one PR turn, claimed once and put back if it was not sent', async () => {
  const f = session()
  await watch(f)
  const v = await getView(f.$, true)
  await prTick(f.$, 'sid-me', v)
  assert.equal(GHRUNS(f).length, 1)
  f.h.now += 2 * MIN
  f.h.ghOut = answer({ 5: node({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }) })
  await prTick(f.$, 'sid-me', v)
  assert.equal(GHRUNS(f).length, 2)
  const c = prClaim()!
  assert.match(c.text, /^\[callboard\] PR notice\./)
  assert.match(c.text, /all checks finished green on aaaaaaa/)
  assert.equal(prClaim(), undefined)
  c.undo()
  assert.ok(prClaim())
  f.h.now += 2 * MIN
  await prTick(f.$, 'sid-me', v)
  assert.equal(prClaim(), undefined)
})
test('the poll: a merge ends the tracking and the file; 20 min after the last call it ends with a note; five rounds with no answer end it as lost', async () => {
  const f = session()
  await watch(f)
  const v = await getView(f.$, true)
  f.h.now += 2 * MIN
  f.h.ghOut = answer({ 5: node({ state: 'MERGED' }) })
  await prTick(f.$, 'sid-me', v)
  assert.match(prClaim()!.text, /merged\. Tracking ended/)
  assert.equal(f.h.files.has(`${V2}/prs/sid-me.json`), false)
  const e = session()
  await watch(e)
  const ve = await getView(e.$, true)
  e.h.now += 21 * MIN
  await prTick(e.$, 'sid-me', ve)
  assert.match(prClaim()!.text, /tracking ended after 20 minutes/)
  assert.equal(e.h.files.has(`${V2}/prs/sid-me.json`), false)
  const l = session()
  await watch(l)
  const vl = await getView(l.$, true)
  l.h.ghOut = { exitCode: 1, stdout: '' }
  for (let i = 0; i < 4; i++) {
    l.h.now += 2 * MIN
    await prTick(l.$, 'sid-me', vl)
    assert.equal(prClaim(), undefined)
  }
  await watch(l, { ...REF, number: 5 })
  l.h.now += 2 * MIN
  await prTick(l.$, 'sid-me', vl)
  assert.match(prClaim()?.text ?? '', /stopped answering/)
  assert.equal(l.h.files.has(`${V2}/prs/sid-me.json`), false)
})
test('a lead polls the tracker of a child no live session carries, and tells which lane; the tracker of a live child is its own, and a gone row routes nothing', async () => {
  const f = session()
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] } }, 'sid-dead': { name: 'dead', folder: '/w/d', under: 'sid-me' }, 'sid-live': { name: 'live', folder: '/w/l', under: 'sid-me' }, 'sid-gone': { name: 'gone', folder: '/w/g', under: 'sid-me', goneAt: T0 - 1000 } })
  f.seed({ sid: 'sid-live', pid: 11, name: 'live' })
  const entry = { owner: 'acme', repo: 'app', number: 5, at: T0, seen: { sha: SHA, state: 'open', draft: false, checks: 'pending', mergeable: false, reviews: 0, comments: 0, threads: 0 } }
  for (const sid of ['sid-dead', 'sid-live', 'sid-gone']) f.h.files.set(`${V2}/prs/${sid}.json`, JSON.stringify({ sid, prs: [entry] }))
  f.h.ghOut = answer({ 5: node({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }) })
  f.h.now += 2 * MIN
  await prTick(f.$, 'sid-me', await getView(f.$, true))
  assert.equal(GHRUNS(f).length, 1)
  assert.match(prClaim()!.text, /\(registered by .dead.\)/)
  assert.equal(tracker(f, 'sid-live').prs[0].seen.checks, 'pending')
  assert.equal(f.h.files.has(`${V2}/prs/sid-gone.json`), false)
})
test('an unknown registry holds the notes: nothing is polled or written', async () => {
  const f = session()
  await watch(f)
  const before = f.h.files.get(`${V2}/prs/sid-me.json`)
  f.h.psFails = true
  f.h.now += 2 * MIN
  await prTick(f.$, 'sid-me', await getView(f.$, true))
  assert.equal(GHRUNS(f).length, 1)
  assert.equal(f.h.files.get(`${V2}/prs/sid-me.json`), before)
})
