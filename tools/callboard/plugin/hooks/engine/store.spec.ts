import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, fake } from '../../test/fake.ts'
import { createExcl, locked, personDialog, readText, windowNow, writeFile } from './io.ts'
import { getView, listGoes, readRegistry, updateTable } from './store.ts'
import { usageFlush, usageRead } from './usage.ts'
import { mem, staleView } from './mem.ts'
import { goDialog } from '../ui.ts'

test('the registry: rows whose process is alive with the same start; anything in doubt is unknown, never an empty list', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', kind: 'interactive' })
  f.seed({ sid: 'sid-a', pid: 11, name: 'a' })
  f.seed({ sid: 'sid-dead', pid: 12, alive: false })
  f.seed({ sid: 'sid-reused', pid: 13, procStart: 'Mon Jan  1 00:00:00 2024' })
  const reg = await readRegistry(f.$, 'sid-me')
  assert.ok(reg !== 'unknown')
  assert.deepEqual(reg.map((r) => r.sid).sort(), ['sid-a', 'sid-me'])
  assert.equal(reg.find((r) => r.sid === 'sid-me')?.kind, 'interactive')
  // No row of its own: a live session always has one, so the read is in doubt.
  assert.equal(await readRegistry(f.$, 'sid-nobody'), 'unknown')
  f.h.psFails = true
  assert.equal(await readRegistry(f.$, 'sid-me'), 'unknown')
  f.h.psFails = false
  f.h.files.set(`${HOME}/.claude/sessions/14.json`, '{"sessionId":')
  assert.equal(await readRegistry(f.$, 'sid-me'), 'unknown')
})
test('the registry: more files than the cap is unknown; a file name that is not a pid is ignored', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10 })
  f.h.files.set(`${HOME}/.claude/sessions/notes.json`, 'not a row')
  assert.ok((await readRegistry(f.$, 'sid-me')) !== 'unknown')
  for (let i = 100; i < 320; i++) f.h.files.set(`${HOME}/.claude/sessions/${i}.json`, '{}')
  assert.equal(await readRegistry(f.$, 'sid-me'), 'unknown')
})
test('the table is written under a lock by read-modify-write, in a private folder; an unreadable one is never overwritten', async () => {
  const f = fake()
  f.table({ a: { name: 'A', folder: '/w/a' } })
  assert.equal(await updateTable(f.$, (t) => ({ ...t, b: { name: 'B', folder: '/w/b' } })), true)
  assert.deepEqual(Object.keys(JSON.parse(f.file('sessions.json')!)).sort(), ['a', 'b'])
  assert.equal(f.h.modes.get(V2), '700')
  f.h.files.set(`${V2}/sessions.json`, '{"a": ')
  assert.equal(await updateTable(f.$, (t) => ({ ...t, c: { name: 'C', folder: '/w/c' } })), false)
  assert.equal(f.file('sessions.json'), '{"a": ')
  assert.equal(f.h.dirs.has(`${V2}/sessions.lock`), false)
})
test('the table parse keeps a row by its fields and drops a key that is not a session key', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10 })
  f.table({ 'sid-a': { name: 'A', folder: '/w/a', lead: { repos: ['/r', 5] }, off: true, evil: 1 }, __proto__: { name: 'X', folder: '/' }, 'bad key': { name: 'Y', folder: '/' }, 'sid-b': { name: 3 } })
  const v = await getView(f.$, true)
  assert.deepEqual(v.table, { 'sid-a': { name: 'A', folder: '/w/a', lead: { repos: ['/r'] }, off: true } })
})
test('a lock held is waited for and one older than 10 s is taken over', async () => {
  const f = fake()
  f.h.dirs.add(`${V2}/x.lock`)
  f.h.mtimes.set(`${V2}/x.lock`, T0 - 11_000)
  assert.equal(await locked(f.$, 'x', async () => 'got'), 'got')
})
test('personDialog opens only while the window reads off, one at a time, and an answer is only a label it offered', async () => {
  const f = fake()
  const spec = goDialog('me', 'work', 'later')
  const yes = spec.options[0].label
  f.h.askAnswer = async () => yes
  assert.deepEqual(await personDialog(f.$, spec), { label: yes })
  f.h.askAnswer = async () => 'not a button'
  assert.deepEqual(await personDialog(f.$, spec), { no: 'error' })
  // A window on: no dialog opens, and nothing was asked.
  f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0 - MIN, end: T0 + 60 * MIN, readAt: T0 }))
  mem.win = undefined
  const asked = f.h.asked.length
  assert.deepEqual(await personDialog(f.$, spec), { no: 'unattended' })
  assert.equal(f.h.asked.length, asked)
  assert.equal((await windowNow(f.$)).state, 'on')
})
test('personDialog: a second dialog while one is open is busy; one that outlives its time stays recorded and ends as a timeout', async () => {
  const f = fake()
  const spec = goDialog('me', 'work', 'later')
  let click: (s: string) => void = () => undefined
  f.h.askAnswer = () => new Promise((r) => (click = r as (s: string) => void))
  f.h.sleepDone = true
  assert.deepEqual(await personDialog(f.$, spec, 10), { no: 'timeout' })
  assert.equal(mem.dialogs.size, 1)
  assert.deepEqual(await personDialog(f.$, spec), { no: 'busy' })
  click(spec.options[0].label)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(mem.dialogs.size, 0)
})
test('usage: written at most every 30 s, read back for a session, none past a day or from the future', async () => {
  const f = fake()
  f.h.usage = { context: { tokens: 123_456 }, cost: { usd: 2 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30 }, { kind: 'bogus', percentUsed: 5 }] }
  mem.usageOwed = true
  await usageFlush(f.$, 'sid-me')
  const r = await usageRead(f.$, 'sid-me', T0 + 1000)
  assert.deepEqual(r, { at: T0, tokens: 123_456, cost: 2, fiveHour: 30, sevenDay: undefined })
  f.h.files.delete(`${V2}/usage/sid-me.json`)
  mem.usageOwed = true
  f.h.now = T0 + 10_000
  await usageFlush(f.$, 'sid-me')
  assert.equal(f.h.files.has(`${V2}/usage/sid-me.json`), false)
  f.h.now = T0 + 31_000
  await usageFlush(f.$, 'sid-me')
  assert.ok(f.h.files.has(`${V2}/usage/sid-me.json`))
  assert.equal(await usageRead(f.$, 'sid-me', T0), undefined)
  assert.equal(await usageRead(f.$, 'sid-me', T0 + 31_000 + 25 * 60 * MIN), undefined)
  assert.equal(await usageRead(f.$, '../evil', T0), undefined)
})

test('the fake: a file written is read back, a plain mkdir fails twice, a registry row needs its process', async () => {
  const f = fake()
  await f.$.fs.write('/a/b', 'x')
  assert.equal(await f.$.fs.read('/a/b'), 'x')
  assert.equal((await f.$.process.run(['/bin/mkdir', '/d'])).exitCode, 0)
  assert.equal((await f.$.process.run(['/bin/mkdir', '/d'])).exitCode, 1)
  f.seed({ sid: 'sid-me', pid: 7 })
  assert.match(f.h.ps, /7 /)
})
test('a registry file that is there and cannot be read makes the reading unknown; one that vanished is skipped', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10 })
  f.seed({ sid: 'sid-a', pid: 11 })
  f.h.unreadable.add(`${HOME}/.claude/sessions/11.json`)
  assert.equal(await readRegistry(f.$, 'sid-me'), 'unknown')
  f.h.unreadable.clear()
  const gone = fake()
  gone.seed({ sid: 'sid-me', pid: 10 })
  gone.$.fs.list = async () => [{ name: '10.json' }, { name: '11.json' }]
  const reg = await readRegistry(gone.$, 'sid-me')
  assert.ok(reg !== 'unknown')
  assert.equal(reg.length, 1)
})
test('a table that cannot be read keeps the last good one, also after a write marked the reading stale; with none the reading is unknown', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'me', kind: 'interactive' })
  f.h.files.set(`${V2}/sessions.json`, '{"broken": ')
  assert.equal((await getView(f.$, true)).rows, 'unknown')
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] } } })
  assert.ok((await getView(f.$, true)).table['sid-me']?.lead)
  f.h.files.set(`${V2}/sessions.json`, '{"broken": ')
  staleView()
  const v = await getView(f.$)
  assert.ok(v.table['sid-me']?.lead)
  assert.ok(v.rows !== 'unknown')
})
test('the lock: two writers at once both land, a holder whose lock was taken over does not remove its successor\'s, and a stale lock has one breaker', async () => {
  const f = fake()
  f.table({})
  await Promise.all([updateTable(f.$, (t) => ({ ...t, a: { name: 'A', folder: '/a' } })), updateTable(f.$, (t) => ({ ...t, b: { name: 'B', folder: '/b' } }))])
  assert.deepEqual(Object.keys(JSON.parse(f.file('sessions.json')!)).sort(), ['a', 'b'])
  await locked(f.$, 'y', async () => {
    f.h.files.set(`${V2}/y.lock/owner`, 'someone-else')
  })
  assert.ok(f.h.dirs.has(`${V2}/y.lock`))
  f.h.mtimes.set(`${V2}/y.lock`, T0 - 11_000)
  assert.equal(await locked(f.$, 'y', async () => 'got'), 'got')
  assert.equal(f.h.dirs.has(`${V2}/y.lock`), false)
  assert.equal([...f.h.dirs].filter((d) => d.endsWith('.stale')).length, 0)
})
test('a go that ended an hour ago is removed when the goes are listed; a live one and a recent end stay', async () => {
  const f = fake()
  const go = (id: string, end: number) => f.h.files.set(`${V2}/go/${id}.json`, JSON.stringify({ id, giver: 'sid-me', text: 'work', end }))
  go('old1', T0 - 2 * 60 * MIN)
  go('new1', T0 - 10 * MIN)
  go('live', T0 + 60 * MIN)
  f.h.dirs.add(`${V2}/go`)
  assert.deepEqual((await listGoes(f.$)).map((g) => g.id).sort(), ['live', 'new1'])
  assert.equal(f.h.files.has(`${V2}/go/old1.json`), false)
})
test('two registry rows of one session id are a doubtful reading; a registry entry that is not a plain file is not read', async () => {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10 })
  f.seed({ sid: 'sid-me', pid: 11 })
  assert.equal(await readRegistry(f.$, 'sid-me'), 'unknown')
  const g = fake()
  g.seed({ sid: 'sid-me', pid: 10 })
  g.seed({ sid: 'sid-a', pid: 11 })
  g.h.kinds.set(`${HOME}/.claude/sessions/11.json`, 'fifo')
  const reg = await readRegistry(g.$, 'sid-me')
  assert.ok(reg !== 'unknown')
  assert.deepEqual(reg.map((r) => r.sid), ['sid-me'])
})
test('a file that is not a plain one is neither read nor written over', async () => {
  const f = fake()
  f.h.files.set(`${V2}/config.json`, '{}')
  f.h.kinds.set(`${V2}/config.json`, 'fifo')
  assert.equal(await readText(f.$, `${V2}/config.json`), undefined)
  assert.equal(await writeFile(f.$, `${V2}/config.json`, '{"a":1}'), false)
  f.h.dirs.add(`${V2}/unattended.json`)
  f.h.kinds.set(`${V2}/unattended.json`, 'dir')
  assert.equal(await writeFile(f.$, `${V2}/unattended.json`, '{}'), false)
  const ok = fake()
  assert.equal(await writeFile(ok.$, `${V2}/x.json`, '{}'), true)
  assert.ok(ok.h.runs.some((r) => r.argv[0] === '/bin/chmod' && r.argv[1] === '600'))
})
test('personDialog reads the window anew: a window turned on within the 10 s a reading is kept still refuses', async () => {
  const f = fake()
  const spec = goDialog('me', 'work', 'later')
  assert.equal((await windowNow(f.$)).state, 'off')
  f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0, end: T0 + 60 * MIN, readAt: T0 }))
  assert.deepEqual(await personDialog(f.$, spec), { no: 'unattended' })
  assert.equal(f.h.asked.length, 0)
})

test('the state folder is private and a new file lands by a temporary name and a rename', async () => {
  const f = fake()
  const p = `${V2}/new/file.json`
  assert.equal(await writeFile(f.$, p, '{"a":1}'), true)
  assert.equal(f.h.modes.get(V2), '700')
  assert.equal(f.h.files.get(p), '{"a":1}')
  const mv = f.h.runs.find((r) => r.argv[0] === '/bin/mv' && r.argv.at(-1) === p)
  assert.match(mv?.argv.at(-2) ?? '', new RegExp(`^${p.replace(/[.\\/]/g, '\\$&')}\\.[a-z0-9]{10}\\.tmp$`))
  assert.deepEqual([...f.h.files.keys()].filter((k) => k.endsWith('.tmp')), [])
})
test('createExcl: the first writer wins, the second finds it there, and no temporary file is left', async () => {
  const f = fake()
  const p = `${V2}/asks/a1b2c3d4.answer`
  assert.equal(await createExcl(f.$, p, 'first'), 'ok')
  assert.equal(await createExcl(f.$, p, 'second'), 'exists')
  assert.equal(f.h.files.get(p), 'first')
  assert.deepEqual([...f.h.files.keys()].filter((k) => k.endsWith('.tmp')), [])
})
test('a read that never returns (a pipe put where a file was) is given up after 3 s as a failed read', async () => {
  const f = fake()
  const p = `${V2}/asks/a1b2c3d4.json`
  f.h.files.set(p, '{}')
  f.h.hung.add(p)
  f.h.sleepDone = true
  assert.equal(await readText(f.$, p, 100), undefined)
})
