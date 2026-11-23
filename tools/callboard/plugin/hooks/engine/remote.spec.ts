import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, START, V2, fake } from '../../test/fake.ts'
import { REMOTE_GAP_MS, REMOTE_TRIES } from '../core/remote.ts'
import type { Row } from '../core/model.ts'
import { mem } from './mem.ts'
import { setRemote } from './remote.ts'
import { getView } from './store.ts'
import { sessionStart } from './tick.ts'
import { turnStart } from './upkeep.ts'
import { commandRun } from './commands.ts'

type F = ReturnType<typeof fake>
const started = new WeakSet<F>()
const tick = async (f: F) => {
  if (!started.has(f)) await sessionStart(f.$, {}, async (e: unknown) => e)
  started.add(f)
  await f.h.every!()
  // The ask runs beside the tick: wait until it has an answer.
  for (let i = 0; i < 200 && mem.remoteBusy; i++) await new Promise((r) => setImmediate(r))
}
const table = (f: F) => JSON.parse(f.file('sessions.json') ?? '{}')
const logged = (f: F): string[] => [...f.h.files].filter(([p]) => p.startsWith(`${V2}/log/`)).flatMap(([, t]) => t.split('\n').filter((l) => l.includes('"remote"')))
const SEED = { sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' }
// The process the session under test runs in, as a row's `met` names it.
const ME = `10@${START}`
const LEAD = { 'sid-lead': { name: 'lead', folder: '/w/lead', lead: { repos: [] } } }

// A lane `sid-me` (the session under test) of the lead `sid-lead`, its panel with Remote Control on or off, and a window that answers each request with `reply`.
function lane(o: { bridge?: boolean; remote?: Row['remote']; reply?: (req: any) => object | undefined; row?: object } = {}) {
  const f = fake()
  f.seed({ ...SEED, bridge: o.bridge ?? true })
  f.seed({ sid: 'sid-lead', pid: 11, name: 'lead', cwd: '/w/lead', kind: 'interactive' })
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-lead', ...(o.remote ? { remote: o.remote } : {}), ...o.row }, ...LEAD })
  const seen: any[] = []
  const once = new Set<string>()
  const reply = o.reply ?? (() => ({ ok: true }))
  f.h.onSleep = () => {
    for (const [p, t] of [...f.h.files])
      if (p.startsWith(`${V2}/open/`) && p.endsWith('.req')) {
        const req = JSON.parse(t)
        if (!once.has(p)) seen.push(req)
        once.add(p)
        const a = reply(req)
        if (a !== undefined) f.h.files.set(p.replace(/\.req$/, '.result'), JSON.stringify(a))
      }
  }
  return { f, seen }
}
const later = (f: F, ms = REMOTE_GAP_MS) => void (f.h.now += ms)
// The person switches the panel by hand: the registry row gains or loses its bridge session id.
const chip = (f: F, on: boolean) => {
  f.seed({ ...SEED, bridge: on })
  mem.view = undefined
}

test('a lane whose panel has Remote Control on and no wish asks the window to turn it off, naming its own session and folder, and marks the wish met', async () => {
  const { f, seen } = lane()
  await tick(f)
  assert.deepEqual(seen, [{ op: 'remote', sid: 'sid-me', on: false, folder: '/w/me' }])
  assert.deepEqual(table(f)['sid-me'].remote, { on: false, met: ME })
  assert.equal(mem.remote, undefined)
})
test('a wish for on asks for on when the panel has it off, and marks it met', async () => {
  const { f, seen } = lane({ bridge: false, remote: { on: true } })
  await tick(f)
  assert.deepEqual(seen, [{ op: 'remote', sid: 'sid-me', on: true, folder: '/w/me' }])
  assert.deepEqual(table(f)['sid-me'].remote, { on: true, met: ME })
})
test('a panel that already matches its wish is not asked, and is marked met only once it has matched for a pause; a registry reading ten seconds old is confirmed on the row itself', async () => {
  const none = lane({ bridge: false })
  await tick(none.f)
  assert.deepEqual(none.seen, [])
  assert.equal(table(none.f)['sid-me'].remote, undefined, 'not yet')
  later(none.f)
  await tick(none.f)
  assert.deepEqual(none.seen, [])
  assert.deepEqual(table(none.f)['sid-me'].remote, { on: false, met: ME })
  const { f, seen } = lane({ bridge: true })
  await getView(f.$, true)
  f.seed({ ...SEED, bridge: false })
  await tick(f)
  assert.deepEqual(seen, [], 'the cached view says on, the row says off')
})
test('a wish that was met is not enforced: a switch by hand afterwards stays, in either direction, over any number of ticks', async () => {
  const on = lane({ bridge: false, remote: { on: true } })
  await tick(on.f)
  assert.equal(on.seen.length, 1)
  chip(on.f, true)
  chip(on.f, false)
  for (let i = 0; i < 4; i++) {
    later(on.f)
    mem.view = undefined
    await tick(on.f)
  }
  assert.equal(on.seen.length, 1, 'turned off by hand: not turned back on')
  assert.deepEqual(table(on.f)['sid-me'].remote, { on: true, met: ME })
  const off = lane({ bridge: true })
  await tick(off.f)
  chip(off.f, false)
  chip(off.f, true)
  for (let i = 0; i < 4; i++) {
    later(off.f)
    mem.view = undefined
    await tick(off.f)
  }
  assert.equal(off.seen.length, 1, 'turned on by hand: not turned back off')
})
test('a wish met by this process is not applied again, and one met by another process (a restart), or by an older callboard, is applied once more and marked for this one', async () => {
  const met = lane({ bridge: false, remote: { on: true, met: ME } })
  await tick(met.f)
  assert.deepEqual(met.seen, [])
  const restarted = lane({ bridge: false, remote: { on: true, met: `9@${START}` } })
  await tick(restarted.f)
  assert.equal(restarted.seen.length, 1)
  assert.deepEqual(table(restarted.f)['sid-me'].remote, { on: true, met: ME })
  const older = lane({ bridge: false, remote: { on: true, met: true as unknown as string } })
  await tick(older.f)
  assert.equal(older.seen.length, 1, 'a row that reads met: true is not met in any process')
  const unmet = lane({ bridge: false, remote: { on: true } })
  await tick(unmet.f)
  assert.equal(unmet.seen.length, 1)
})
test('the wish set again, even to the same value, is applied again', async () => {
  const { f, seen } = lane()
  await tick(f)
  chip(f, false)
  chip(f, true)
  later(f)
  assert.equal(await setRemote(f.$, 'sid-me', false), true)
  assert.deepEqual(table(f)['sid-me'].remote, { on: false, at: f.h.now })
  later(f)
  await tick(f)
  assert.deepEqual(seen.map((r) => r.on), [false, false])
  assert.deepEqual(table(f)['sid-me'].remote, { on: false, at: f.h.now - REMOTE_GAP_MS, met: ME })
})
test('a window without the patch ends the asking at once: one log line, a status row, and no more asks until the wish changes', async () => {
  const { f, seen } = lane({ reply: () => ({ ok: false, code: 'patch-missing' }) })
  await tick(f)
  for (let i = 0; i < 3; i++) {
    later(f)
    await tick(f)
  }
  assert.equal(seen.length, 1)
  assert.equal(logged(f).filter((l) => l.includes('gave up off: patch-missing')).length, 1)
  const status = (await commandRun(f.$, { args: 'status', origin: { kind: 'composer' } })).text
  assert.match(status, /\| Remote Control \| wanted OFF, not applied: the Claude Code extension has no callboard patch/)
  // The same wish set again starts the counts again.
  later(f)
  assert.equal(await setRemote(f.$, 'sid-me', false), true)
  later(f)
  mem.view = undefined
  await tick(f)
  assert.equal(seen.length, 2)
  // The wish changes: the counts start again.
  later(f)
  assert.equal(await setRemote(f.$, 'sid-me', true), true)
  later(f)
  mem.view = undefined
  chip(f, false)
  await tick(f)
  assert.deepEqual(seen.map((r) => r.on), [false, false, true])
  assert.doesNotMatch((await commandRun(f.$, { args: 'status', origin: { kind: 'composer' } })).text, /wanted OFF/)
})
test('any other failure is asked REMOTE_TRIES times, a pause apart, and then given up', async () => {
  for (const [code, reply] of [['busy', () => ({ ok: false, code: 'busy' })], ['no-answer', () => undefined]] as const) {
    const { f, seen } = lane({ reply })
    for (let i = 0; i < REMOTE_TRIES + 3; i++) {
      await tick(f)
      later(f)
    }
    assert.equal(seen.length, REMOTE_TRIES)
    assert.equal(mem.remote?.stopped, code)
    assert.equal(logged(f).filter((l) => l.includes('gave up')).length, 1)
    assert.equal(table(f)['sid-me'].remote, undefined, 'a wish not met is not marked')
  }
})
test('a lane that found no panel session asks again at its next turn; one the window cannot serve does not', async () => {
  const { f, seen } = lane({ reply: () => ({ ok: false, code: 'no-channel' }) })
  for (let i = 0; i < REMOTE_TRIES + 1; i++) {
    await tick(f)
    later(f)
  }
  assert.equal(seen.length, REMOTE_TRIES)
  await turnStart(f.$, { text: 'hello' }, async (e: unknown) => e)
  assert.equal(mem.remote, undefined)
  await tick(f)
  assert.equal(seen.length, REMOTE_TRIES + 1)
  const gone = lane({ reply: () => ({ ok: false, code: 'patch-missing' }) })
  await tick(gone.f)
  await turnStart(gone.f.$, { text: 'hello' }, async (e: unknown) => e)
  assert.equal(mem.remote?.stopped, 'patch-missing')
})
test('only a lane asks: not a lead, the manager, a session that is off, one with no row, or a row nothing is above', async () => {
  for (const [label, row] of [['lead', { lead: { repos: [] } }], ['off', { off: true }], ['no parent', { under: undefined }]] as const) {
    const { f, seen } = lane({ row })
    await tick(f)
    assert.deepEqual(seen, [], label)
  }
  const loose = lane()
  loose.f.table({})
  await tick(loose.f)
  assert.deepEqual(loose.seen, [], 'no row')
  const boss = lane()
  boss.f.h.files.set(`${HOME}/.claude/callboard/manager-name`, 'me\n')
  await tick(boss.f)
  assert.deepEqual(boss.seen, [], 'the manager')
})
test('a read in doubt asks nothing and forgets nothing: a lane that gave up stays given up', async () => {
  const { f, seen } = lane({ reply: () => ({ ok: false, code: 'patch-missing' }) })
  await tick(f)
  assert.equal(mem.remote?.stopped, 'patch-missing')
  f.h.psFails = true
  mem.view = undefined
  await tick(f)
  assert.equal(mem.remote?.stopped, 'patch-missing')
  f.h.psFails = false
  mem.view = undefined
  later(f)
  await tick(f)
  assert.equal(seen.length, 1)
})
test('the wish is read again before an ask: a wish changed under a ten-second-old view is not acted on with the old one', async () => {
  const { f, seen } = lane({ bridge: true })
  await getView(f.$, true)
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-lead', remote: { on: true } }, ...LEAD })
  await tick(f)
  assert.deepEqual(seen, [], 'the panel is on and the row now wants it on')
})
test('/callboard remote NAME on|off, typed, sets the wish of that lane, not yet met; it is refused from anywhere else and for what is no lane', async () => {
  const { f } = lane({ bridge: false, remote: { on: false, met: ME } })
  const run = (args: string, origin = 'composer') => commandRun(f.$, { args, origin: { kind: origin } })
  assert.match((await run('remote me on')).text, /wanted ON for the lane `me`/)
  assert.deepEqual(table(f)['sid-me'].remote, { on: true, at: f.h.now })
  assert.match((await run('remote me off')).text, /wanted OFF/)
  assert.deepEqual(table(f)['sid-me'].remote, { on: false, at: f.h.now })
  assert.match((await run('remote me on', 'agent')).text, /refused/)
  assert.deepEqual(table(f)['sid-me'].remote, { on: false, at: f.h.now })
  assert.match((await run('remote lead on')).text, /is a lead/)
  assert.match((await run('remote nobody on')).text, /no lane of yours has that name/)
  assert.match((await run('remote me maybe')).text, /Use \/callboard/)
})
test('a wish marked met by another write under a ten-second-old view is not asked again', async () => {
  const { f, seen } = lane({ bridge: false, remote: { on: true } })
  await getView(f.$, true)
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-lead', remote: { on: true, met: ME } }, ...LEAD })
  await tick(f)
  assert.deepEqual(seen, [])
})
test('the mark is not written for a wish that was set again while its ask was out', async () => {
  const { f } = lane({ bridge: false, remote: { on: true, at: 5 }, reply: () => undefined })
  f.h.onSleep = () => {
    for (const [p] of [...f.h.files]) if (p.startsWith(`${V2}/open/`) && p.endsWith('.req')) f.h.files.set(p.replace(/\.req$/, '.result'), JSON.stringify({ ok: true }))
    f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-lead', remote: { on: true, at: 9 } }, ...LEAD })
    f.h.onSleep = undefined
  }
  await tick(f)
  assert.deepEqual(table(f)['sid-me'].remote, { on: true, at: 9 }, 'the newer wish is still to apply')
})
