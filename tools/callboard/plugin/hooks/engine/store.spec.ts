import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, fake } from '../../test/fake.ts'
import { locked, personDialog, windowNow } from './io.ts'
import { getView, readRegistry, updateTable } from './store.ts'
import { usageFlush, usageRead } from './usage.ts'
import { mem } from './mem.ts'
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
