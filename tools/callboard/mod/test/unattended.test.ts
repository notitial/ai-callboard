import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { HOUR_MS, usageLine } from '../hooks/core'
import { goWhen } from '../hooks/go'
import { mem } from '../hooks/mem'
import { UNATTENDED_KEY, unattendedClose, unattendedHeld, unattendedNow, unattendedOn, unattendedOpen, unattendedTick } from '../hooks/engine/answer-hook'
import { h, SETTINGS_FILE, SID, T0, fakeSha, longTest, pfs } from './harness'
import { OFF_FILE, ledgerRows, putLedger, wireGuard } from './answer-fixtures'
import { MIN, advanceQuiet, lane, leadAt, logged, started, statusText, waitFor } from './fixtures'

// ---- the unattended window (ADR 0008): its stored value and rows, the readers, the sure offs, the tick's look, the off command and the status row ----
// Nothing here opens a window through a command: a test seeds one as the open step writes it (the stored value, and the `unattended-on` row with its hash), or
// calls the open step itself.
const iso = (ms: number) => new Date(ms).toISOString()
const when = (ms: number) => goWhen(ms, -new Date(ms).getTimezoneOffset())
const win = (over: Partial<prm.Unattended> = {}): prm.Unattended => ({ v: 1, from: T0, until: T0 + 8 * HOUR_MS, by: 'prompt', manager: 'MANAGER', savedAt: T0, ...over })
const hashOf = (v: prm.Unattended) => fakeSha(prm.canonical(v))
const shortOf = (v: prm.Unattended) => hashOf(v).slice(0, 8)
const onRow = (v: prm.Unattended) => ({ t: iso(v.savedAt), kind: 'unattended-on', hash: hashOf(v), u: shortOf(v), end: iso(v.until), origin: v.by, lane: v.manager })
function putWindow(v: prm.Unattended = win(), row = true): prm.Unattended {
  h.store.set(UNATTENDED_KEY, v)
  if (row) putLedger([onRow(v)])
  return v
}
const uRows = () => ledgerRows().filter((r) => String(r.kind).startsWith('unattended-'))
const uKinds = () => uRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
const ESC_ON = { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 }
const ON_ROW = (v: prm.Unattended) => `| Unattended | ON until ${when(v.until)} |`

// The direct calls: a handle over the harness's own mocks, as a call from the mod's hooks makes them, with knobs on the store and on the engine call limit.
// The engine files a test imports are one module for the whole file, so each such test starts from the memory of a new process.
type Knob = { get?: 'throw' | 'hang'; set?: 'throw'; del?: 'throw' | 'lands'; timesOut: boolean; rowsAtSet: string[][]; afterGrep?: () => Promise<unknown> }
async function proc($: any, on0: any) {
  const handlers = new Map<string, any>()
  const on = (name: string, handler: any) => {
    handlers.set(name, handler)
    return on0(name, handler)
  }
  const call = async (name: string, e: unknown) => (await handlers.get(name)(undefined, e, undefined))?.value
  const knob: Knob = { timesOut: false, rowsAtSet: [] }
  const $$ = {
    process: {
      run: async (argv: string[], init: unknown) => {
        const r = await call('process.run', { argv, init })
        if (argv[0] !== '/usr/bin/grep' || !knob.afterGrep) return r
        const after = knob.afterGrep
        knob.afterGrep = undefined
        await after()
        return r
      },
    },
    store: {
      get: async (key: string) => {
        if (knob.get === 'throw') throw new Error('store')
        if (knob.get === 'hang') return new Promise(() => undefined)
        return call('store.get', { key })
      },
      set: async (key: string, value: unknown) => {
        knob.rowsAtSet.push(uKinds())
        if (knob.set === 'throw') throw new Error('store')
        return call('store.set', { key, value })
      },
      delete: async (key: string) => {
        if (knob.del === 'throw') throw new Error('store')
        const r = await call('store.delete', { key })
        if (knob.del === 'lands') throw new Error('store')
        return r
      },
    },
    session: { id: async () => SID },
    // The engine call limit is a long sleep: it ends at once when a test says the call times out, and never otherwise.
    clock: { now: async () => h.nowMs, sleep: () => (knob.timesOut ? Promise.resolve() : new Promise(() => undefined)) },
    ui: { toast: async () => undefined },
  }
  await started($, on, [])
  newProcess()
  return { $$, knob }
}
const newProcess = () => Object.assign(mem, { unattended: undefined, unattendedSure: undefined, unattendedUnknown: false, unattendedBound: undefined, unattendedHash: undefined, unattendedLookedAt: undefined })
// Past the reader's 10 s and the tick's 30 s.
const later = (ms = 31_000) => (h.nowMs += ms)

test('unattended: opening writes the row first, then the stored value, and the window reads on with its short id', async ($, on) => {
  const { $$, knob } = await proc($, on)
  const v = win()
  expect(await unattendedOpen($$, v)).toEqual({ ok: true, u: shortOf(v) })
  expect(knob.rowsAtSet).toEqual([['unattended-on']])
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  const { t: _t, ...row } = uRows()[0]
  expect(row).toEqual({ kind: 'unattended-on', hash: hashOf(v), u: shortOf(v), end: iso(v.until), origin: 'prompt', lane: 'MANAGER', by: SID })
  expect(await unattendedNow($$)).toEqual({ state: 'on', value: v, u: shortOf(v) })
  expect(await unattendedHeld($$)).toBe(true)
  expect(await unattendedOn($$)).toBe(true)
})

test('unattended: a stored value that cannot be written leaves a void row and nothing on, and a write that landed after all is ended by that row', async ($, on) => {
  const { $$, knob } = await proc($, on)
  const v = win()
  knob.set = 'throw'
  expect(await unattendedOpen($$, v)).toEqual({ ok: false, why: 'store' })
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off void'])
  expect(uRows()[1]).toMatchObject({ hash: hashOf(v), u: shortOf(v), by: SID })
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  // The same value in the store after all: its void row ends it, in a process that never saw it.
  h.store.set(UNATTENDED_KEY, v)
  newProcess()
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off void', 'unattended-off ended'])
})

test('unattended: nothing is opened without its row, for a value that does not parse or whose time does not fit, or over a store that times out', async ($, on) => {
  const { $$, knob } = await proc($, on)
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/tee'
  expect(await unattendedOpen($$, win())).toEqual({ ok: false, why: 'ledger' })
  h.pfsFails = undefined
  for (const bad of [{ ...win(), by: 'plugin' }, { ...win(), manager: '' }, win({ until: T0 + 60_000 }), win({ until: T0 + 15 * HOUR_MS }), win({ from: T0 - 9 * HOUR_MS, until: T0 - HOUR_MS }), win({ from: T0 + HOUR_MS, until: T0 + 2 * HOUR_MS }), undefined]) {
    expect(await unattendedOpen($$, bad)).toEqual({ ok: false, why: 'value' })
  }
  expect(knob.rowsAtSet).toEqual([])
  expect(uKinds()).toEqual([])
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
})

test('unattended: a look between the row and the stored value deletes nothing, and the value then reads on', async ($, on) => {
  const { $$ } = await proc($, on)
  const v = win()
  putLedger([onRow(v)])
  await unattendedTick($$)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(uKinds()).toEqual(['unattended-on'])
  h.store.set(UNATTENDED_KEY, v)
  later()
  await unattendedTick($$)
  expect((await unattendedNow($$)).state).toBe('on')
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  expect(uKinds()).toEqual(['unattended-on'])
})

test('unattended: a stored value with no row opens nothing, is left alone for 60 s, and goes after that', async ($, on) => {
  const { $$ } = await proc($, on)
  const v = putWindow(win(), false)
  expect(await unattendedNow($$)).toEqual({ state: 'unknown', cause: 'unbound', key: true })
  expect(await unattendedOn($$)).toBe(false)
  expect(await unattendedHeld($$)).toBe(false)
  later(50_000)
  expect((await unattendedNow($$)).state).toBe('unknown')
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  expect(uKinds()).toEqual(['unattended-unknown unbound'])
  later(11_000)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-unknown unbound', 'unattended-off unbound'])
})

test('unattended: ending removes the stored value before the off row, which carries the origin and the session; nothing stored writes no row', async ($, on) => {
  const { $$, knob } = await proc($, on)
  const v = putWindow()
  expect((await unattendedNow($$)).state).toBe('on')
  const keyAtRow: boolean[] = []
  h.pfsFails = (a: string[]) => {
    if (a[0] === '/usr/bin/tee') keyAtRow.push(h.store.has(UNATTENDED_KEY))
    return false
  }
  knob.del = 'throw'
  expect(await unattendedClose($$, { code: 'command', origin: 'session' })).toBe('store-failed')
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  expect(uKinds()).toEqual(['unattended-on'])
  knob.del = undefined
  expect(await unattendedClose($$, { code: 'command', origin: 'session' })).toBe('closed')
  expect(keyAtRow).toEqual([false])
  const { t: _t, ...row } = uRows()[1]
  expect(row).toEqual({ kind: 'unattended-off', code: 'command', hash: hashOf(v), u: shortOf(v), origin: 'session', by: SID })
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(await unattendedClose($$, { code: 'command', origin: 'prompt' })).toBe('none')
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off command'])
})

test('unattended: a reader ends only the value it judged: another value stored meanwhile is left alone', async ($, on) => {
  const { $$ } = await proc($, on)
  const next = putWindow(win({ from: T0 + 1000, until: T0 + HOUR_MS, savedAt: T0 + 1000 }))
  expect(await unattendedClose($$, { code: 'expired', only: prm.canonical(win({ until: T0 + 30 * MIN })) })).toBe('none')
  expect(h.store.get(UNATTENDED_KEY)).toEqual(next)
  expect(uKinds()).toEqual(['unattended-on'])
})

// A read that fails never ends a window and never opens or permits anything. After an `on` read the window stays held; in a process that never read it, nothing is held.
for (const [name, fault, cause] of [
  ['a store that throws', (k: Knob) => { k.get = 'throw' }, 'store'],
  ['a store that times out', (k: Knob) => { k.get = 'hang'; k.timesOut = true }, 'store'],
] as const) {
  test(`unattended: ${name} ends nothing: the window is unknown, held after an on read, and never on`, async ($, on) => {
    const { $$, knob } = await proc($, on)
    const v = putWindow()
    expect((await unattendedNow($$)).state).toBe('on')
    fault(knob)
    later()
    await unattendedTick($$)
    expect(await unattendedNow($$)).toEqual({ state: 'unknown', cause, key: false })
    expect(await unattendedHeld($$)).toBe(true)
    expect(await unattendedOn($$)).toBe(false)
    expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
    expect(uKinds()).toEqual(['unattended-on', `unattended-unknown ${cause}`])
    // A process that never read the window on holds nothing and writes no row.
    newProcess()
    expect(await unattendedHeld($$)).toBe(false)
    expect(await unattendedOn($$)).toBe(false)
    expect(uKinds()).toEqual(['unattended-on', `unattended-unknown ${cause}`])
    knob.get = undefined
    knob.timesOut = false
    later()
    expect((await unattendedNow($$)).state).toBe('on')
  })
}

test('unattended: a ledger that does not answer ends nothing: a process that found the row keeps the window, one that did not reads unknown', async ($, on) => {
  const { $$ } = await proc($, on)
  const v = putWindow()
  expect((await unattendedNow($$)).state).toBe('on')
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep' || a[0] === '/usr/bin/tee'
  later()
  await unattendedTick($$)
  expect((await unattendedNow($$)).state).toBe('on')
  newProcess()
  expect(await unattendedNow($$)).toEqual({ state: 'unknown', cause: 'ledger', key: true })
  expect(await unattendedOn($$)).toBe(false)
  expect(await unattendedHeld($$)).toBe(false)
  later()
  await unattendedTick($$)
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  h.pfsFails = undefined
  later()
  expect((await unattendedNow($$)).state).toBe('on')
  expect(uKinds()).toEqual(['unattended-on'])
})

test('unattended: a value that does not parse is unknown and stays stored; the off command is what removes it', async ($, on) => {
  const { $$ } = await proc($, on)
  h.store.set(UNATTENDED_KEY, { ...win(), by: 'plugin' })
  expect(await unattendedNow($$)).toEqual({ state: 'unknown', cause: 'value', key: true })
  later()
  await unattendedTick($$)
  expect(h.store.has(UNATTENDED_KEY)).toBe(true)
  expect(await unattendedClose($$, { code: 'command', origin: 'prompt' })).toBe('closed')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  const { t: _t, ...row } = uRows().at(-1)
  expect(row).toEqual({ kind: 'unattended-off', code: 'command', origin: 'prompt', by: SID })
})

test('unattended: a clock 6 minutes before the start reads unknown and deletes nothing; 5 minutes before reads on', async ($, on) => {
  const { $$ } = await proc($, on)
  const v = putWindow(win({ from: T0 + 6 * MIN, until: T0 + 6 * MIN + HOUR_MS }))
  expect(await unattendedNow($$)).toEqual({ state: 'unknown', cause: 'clock', key: true })
  later()
  await unattendedTick($$)
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-unknown clock'])
  h.nowMs = T0 + MIN
  newProcess()
  expect((await unattendedNow($$)).state).toBe('on')
})

test('unattended: a span outside the bounds is ended as invalid at the first read', async ($, on) => {
  const { $$ } = await proc($, on)
  putWindow(win({ until: T0 + 15 * HOUR_MS }))
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off invalid'])
})

test('unattended: one unknown row per run of failed reads, and a new one only after a sure read between', async ($, on) => {
  const { $$, knob } = await proc($, on)
  putWindow()
  expect((await unattendedNow($$)).state).toBe('on')
  const unknowns = () => uKinds().filter((k) => k.startsWith('unattended-unknown')).length
  knob.get = 'throw'
  for (let i = 0; i < 4; i++) {
    later()
    expect((await unattendedNow($$)).state).toBe('unknown')
  }
  expect(unknowns()).toBe(1)
  expect(uRows().at(-1)).toMatchObject({ kind: 'unattended-unknown', code: 'store', by: SID })
  knob.get = undefined
  later()
  expect((await unattendedNow($$)).state).toBe('on')
  knob.get = 'throw'
  later()
  await unattendedNow($$)
  later()
  await unattendedNow($$)
  expect(unknowns()).toBe(2)
})

test('unattended: the read is kept 10 s, so a value stored meanwhile is seen at the next read after that', async ($, on) => {
  const { $$ } = await proc($, on)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  putWindow()
  later(9000)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  later(2000)
  expect((await unattendedNow($$)).state).toBe('on')
})

test('unattended: an off row written by another process ends a window this one had read on, at its next read', async ($, on) => {
  const { $$ } = await proc($, on)
  const v = putWindow()
  expect((await unattendedNow($$)).state).toBe('on')
  putLedger([{ t: iso(T0 + 1000), kind: 'unattended-off', code: 'void', hash: hashOf(v), u: shortOf(v) }])
  later(11_000)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off void', 'unattended-off ended'])
})

test('unattended: a read under way while the window is ended in the same process does not bring it back', async ($, on) => {
  const { $$, knob } = await proc($, on)
  putWindow()
  // The read has its ledger rows, with no off row yet, when the off command ends the window.
  knob.afterGrep = async () => expect(await unattendedClose($$, { code: 'command', origin: 'prompt' })).toBe('closed')
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(await unattendedOn($$)).toBe(false)
  expect(await unattendedHeld($$)).toBe(false)
  knob.get = 'throw'
  later()
  expect(await unattendedHeld($$)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off command'])
})

test('unattended: a removal that failed to answer but landed still gets its off row', async ($, on) => {
  const { $$, knob } = await proc($, on)
  const v = putWindow()
  knob.del = 'lands'
  expect(await unattendedClose($$, { code: 'command', origin: 'prompt' })).toBe('closed')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uRows()[1]).toMatchObject({ kind: 'unattended-off', code: 'command', hash: hashOf(v), origin: 'prompt', by: SID })
})

test('unattended: a kept on read is not served past the window\'s end', async ($, on) => {
  const { $$ } = await proc($, on)
  const v = putWindow(win({ until: T0 + 31 * MIN }))
  h.nowMs = v.until - 5000
  expect((await unattendedNow($$)).state).toBe('on')
  h.nowMs = v.until
  expect(await unattendedOn($$)).toBe(false)
  expect(await unattendedNow($$)).toEqual({ state: 'off' })
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off expired'])
})

// ---- through the engine: a tier's tick, the commands and the status row ----
// The markers are seeded once the session start has read where the mod loads from.
const guardOn = async () => {
  await waitFor(() => h.liveHeadAsked !== undefined)
  wireGuard()
}
const look = () => h.clock!.advance(32_000)

for (const [name, act, undo, code] of [
  ['a stored off', () => { h.store.set('answering', { off: true, savedAt: T0 }) }, () => { h.store.set('answering', ESC_ON) }, 'escalation-off:stored'],
  ['an OFF file a stat shows', () => { pfs.set(OFF_FILE, { text: '', mtimeSec: T0 / 1000 }) }, () => { pfs.delete(OFF_FILE) }, 'escalation-off:file'],
] as const) {
  test(`unattended: ${name} ends the window at a tier's next look, and it does not come back`, async ($, on) => {
    await leadAt($, on, [], { clock: true })
    h.store.set('answering', ESC_ON)
    const v = putWindow()
    await look()
    expect(await statusText($)).toContain(ON_ROW(v))
    act()
    await look()
    expect(h.store.has(UNATTENDED_KEY)).toBe(false)
    expect(uKinds()).toEqual(['unattended-on', `unattended-off ${code}`])
    expect(uRows()[1]).toMatchObject({ hash: hashOf(v), u: shortOf(v), by: SID })
    expect(uRows()[1].origin).toBeUndefined()
    // Escalation on again, and the same value back in the store: its off row keeps it ended.
    undo()
    h.store.set(UNATTENDED_KEY, v)
    await look()
    expect(h.store.has(UNATTENDED_KEY)).toBe(false)
    expect(uKinds()).toEqual(['unattended-on', `unattended-off ${code}`, 'unattended-off ended'])
    expect(await statusText($)).toContain('| Unattended | OFF |')
  })
}

test('unattended: /callboard escalation off from any origin ends the window, with the origin and the session in the row', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.store.set('answering', ESC_ON)
  const v = putWindow()
  const r = await $.command.run(lane('escalation off', { kind: 'plugin' }))
  expect(r.text).toBe(`Escalation is off on this Mac. ${prm.UNATTENDED_ENDED}`)
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  const { t: _t, ...row } = uRows()[1]
  expect(row).toEqual({ kind: 'unattended-off', code: 'escalation-off', hash: hashOf(v), u: shortOf(v), origin: 'plugin', by: SID })
  h.store.set(UNATTENDED_KEY, v)
  await look()
  expect(await statusText($)).toContain('| Unattended | OFF |')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  // With no window, the answer is the one it always was.
  expect((await $.command.run(lane('escalation off', { kind: 'plugin' }))).text).toBe('Escalation is off on this Mac.')
})

// Escalation reads off for each of these, and none is the person's own off: the window stays stored.
for (const [name, fault, escalation] of [
  ['a settings file that cannot be read', () => { pfs.delete(SETTINGS_FILE) }, 'OFF (default blocked'],
  ['a settings file that does not parse', () => { pfs.set(SETTINGS_FILE, { text: '{ not json', mtimeSec: T0 / 1000 }) }, 'OFF (default blocked'],
  ['a marker whose stat fails', () => { h.pfsFails = (a: string[]) => a[0] === '/usr/bin/stat' && String(a.at(-1)).endsWith('/.protected-checkout') }, 'OFF (default blocked'],
  ['an OFF file whose stat fails', () => { h.pfsFails = (a: string[]) => a[0] === '/usr/bin/stat' && a.at(-1) === OFF_FILE }, 'OFF (the OFF file exists)'],
] as const) {
  test(`unattended: ${name} does not end the window, though escalation reads off`, async ($, on) => {
    await leadAt($, on, [], { clock: true })
    await guardOn()
    const v = putWindow()
    await look()
    expect(await statusText($)).toContain('| Escalation | ON (default) |')
    fault()
    await h.clock!.advance(2 * MIN + 4000)
    const status = await statusText($)
    expect(status).toContain(`| Escalation | ${escalation}`)
    expect(status).toContain(ON_ROW(v))
    expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
    expect(uKinds()).toEqual(['unattended-on'])
  })
}

test('unattended: a store that throws under a tier ends nothing: status says unknown, the value stays, one row marks it', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.store.set('answering', ESC_ON)
  const v = putWindow()
  await look()
  expect(await statusText($)).toContain(ON_ROW(v))
  h.storeThrowSync = 'get'
  await h.clock!.advance(2 * MIN)
  expect(await statusText($)).toContain('| Unattended | UNKNOWN (the store did not answer) |')
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-unknown store'])
  h.storeThrowSync = undefined
  await look()
  expect(await statusText($)).toContain(ON_ROW(v))
})

longTest('unattended: a window whose end passed while the Mac slept ends at a tier\'s first look after the wake', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.store.set('answering', ESC_ON)
  const v = putWindow(win({ until: T0 + 30 * MIN }))
  await look()
  expect(await statusText($)).toContain(ON_ROW(v))
  await advanceQuiet(31 * MIN)
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off expired'])
  expect(uRows()[1]).toMatchObject({ hash: hashOf(v), u: shortOf(v), by: SID })
  expect(await statusText($)).toContain('| Unattended | OFF |')
})

test('unattended: a session that is no tier does not look from its tick; its own read of the state ends a window that is over', async ($, on) => {
  await started($, on, [], { clock: true })
  putWindow(win({ from: T0 - HOUR_MS, until: T0 - 1, savedAt: T0 - HOUR_MS }))
  await h.clock!.advance(2 * MIN)
  expect(h.store.has(UNATTENDED_KEY)).toBe(true)
  expect((await $.command.run(lane('unattended'))).text).toBe('Unattended mode is off.')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off expired'])
})

test('unattended: /callboard unattended prints the state to the person only', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  expect((await $.command.run(lane('unattended'))).text).toBe('Unattended mode is off.')
  for (const kind of ['plugin', 'peer', 'cron']) expect((await $.command.run(lane('unattended', { kind }))).text).toBe(prm.UNATTENDED_NOT_PERSON)
  expect(logged(stdins)).toContain('refused:unattended-not-person:plugin')
  expect(logged(stdins)).toContain('refused:unattended-not-person:session')
  const v = putWindow()
  h.nowMs += 11_000
  expect((await $.command.run(lane('unattended', { kind: 'bridge' }))).text).toBe(`Unattended mode is on until ${when(v.until)}, with manager MANAGER (window ${shortOf(v)}). /callboard unattended off ends it.`)
  expect(await statusText($)).toContain(ON_ROW(v))
})

test('unattended: no form of the command opens a window: on, with or without a time, is the usage line, with no dialog, value or row', async ($, on) => {
  await started($, on, [])
  for (const bad of ['unattended on', 'unattended on for 3 h', 'unattended on until 09:00', 'unattended on for 8h', 'unattended start', 'unattended off now']) {
    expect((await $.command.run(lane(bad))).text).toBe(usageLine('unattended'))
  }
  expect(usageLine('unattended')).toBe('Use /callboard unattended or unattended off.')
  expect(h.askCount).toBe(0)
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual([])
})

test('unattended: /callboard unattended off from any origin ends the window with no dialog: the value goes first, then the row with the origin and the session', async ($, on) => {
  await started($, on, [])
  const v = putWindow()
  const keyAtRow: boolean[] = []
  h.pfsFails = (a: string[]) => {
    if (a[0] === '/usr/bin/tee') keyAtRow.push(h.store.has(UNATTENDED_KEY))
    return false
  }
  expect((await $.command.run(lane('unattended off', { kind: 'peer' }))).text).toBe(prm.UNATTENDED_ENDED)
  expect(h.askCount).toBe(0)
  expect(keyAtRow).toEqual([false])
  const { t: _t, ...row } = uRows()[1]
  expect(row).toEqual({ kind: 'unattended-off', code: 'command', hash: hashOf(v), u: shortOf(v), origin: 'session', by: SID })
  expect((await $.command.run(lane('unattended off'))).text).toBe(prm.UNATTENDED_NOT_ON)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off command'])
  // The same value put back does not come back.
  h.store.set(UNATTENDED_KEY, v)
  h.nowMs += 11_000
  expect((await $.command.run(lane('unattended'))).text).toBe('Unattended mode is off.')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
})

test('unattended: an off the store will not take says so and leaves the window as it was', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  const v = putWindow()
  h.storeDeleteFails = true
  expect((await $.command.run(lane('unattended off'))).text).toBe(prm.UNATTENDED_OFF_FAILED)
  expect(h.store.get(UNATTENDED_KEY)).toEqual(v)
  expect(uKinds()).toEqual(['unattended-on'])
  expect(logged(stdins)).toContain('error:unattended-store')
  h.storeDeleteFails = false
  expect((await $.command.run(lane('unattended off'))).text).toBe(prm.UNATTENDED_ENDED)
})
