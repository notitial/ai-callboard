import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import * as g from '../hooks/go'
import { CONFIG_DEFAULTS, HOUR_MS } from '../hooks/core'
import { UNATTENDED_KEY, UNATTENDED_OFF_AT_KEY } from '../hooks/engine/answer-hook'
import { h, PROMPTS_DIR, SID, T0, longTest, pdirs, pfs, toasts } from './harness'
import { APISID, MGR_SESS, OTHER, ckLane, lane, leadAt, logged, mgrAt, putStore, statusText, waitFor } from './fixtures'
import { LDIR, LEDGER_FILE, OFF_FILE, TID, ledgerRows, putLedger, putWindow, win, winShort } from './answer-fixtures'

// ---- turning unattended mode on (ADR 0008): /callboard unattended on, its preconditions, its dialog and the recheck after the click; the manager's
// unattended_off ----
// This session is the manager MANAGER, with escalation stored on for everything, check-ins on, and the lane API of lead LEAD live.
const when = (ms: number) => g.goWhen(ms, -new Date(ms).getTimezoneOffset())
const uKinds = () => ledgerRows().filter((r) => String(r.kind).startsWith('unattended-')).map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
const ESC_ON = { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 }
const onCmd = ($: any, args = 'unattended on for 3 h', origin?: unknown) => $.command.run(origin === undefined ? lane(args) : lane(args, origin)).then((r: any) => String(r.text))
const offTool = ($: any, input: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__callboard__unattended_off', ...input } as any)
async function manager($: any, on: any, stdins: string[] = [], opts: { clock?: boolean } = {}) {
  await mgrAt($, on, stdins, { clock: opts.clock, sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }), seed: () => putStore([ckLane({ sid: APISID, leadName: 'LEAD' })]) })
  h.store.set('answering', ESC_ON)
  h.askAnswer = prm.UNATTENDED_YES as any
}
const nothingOn = () => {
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds().filter((k) => k === 'unattended-on')).toEqual([])
}
// Holds the dialog open until the test answers it.
const holdDialog = () => {
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  return (a: string) => {
    release(a)
    h.askHang = undefined
  }
}

test('unattended on: typed by the person, its dialog names the end, the manager and the live lanes; Turn on writes the row, then the value', async ($, on) => {
  const stdins: string[] = []
  await manager($, on, stdins)
  const asked = h.askCount
  const text = await onCmd($)
  const until = T0 + 3 * HOUR_MS
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastHeader).toBe(prm.UNATTENDED_HEADER)
  expect(h.askedOptions.at(-1)).toEqual([prm.UNATTENDED_NO, prm.UNATTENDED_YES])
  expect(h.lastQuestion).toBe(prm.unattendedQuestion(when(until), 'MANAGER', [{ lead: 'LEAD', n: 1 }]))
  const v = h.store.get(UNATTENDED_KEY) as prm.Unattended
  expect(v).toEqual({ v: 1, from: T0, until, by: 'prompt', manager: 'MANAGER', savedAt: T0 })
  expect(text).toBe(prm.unattendedOnText(when(until), 'MANAGER', winShort(v)))
  expect(uKinds()).toEqual(['unattended-on'])
  expect(logged(stdins)).toContain('command:unattended-on:prompt')
})

test('unattended on: the status row shows the window, and a second on while one is open is refused with its state', async ($, on) => {
  await manager($, on)
  const v = putWindow()
  h.nowMs += 11_000
  expect(await statusText($)).toContain(`| Unattended | ON until ${when(v.until)} |`)
  const asked = h.askCount
  expect(await onCmd($)).toBe(prm.unattendedNoText('on', prm.unattendedState({ state: 'on', value: v, u: winShort(v) }, when)))
  expect(h.askCount).toBe(asked)
})

test('unattended on: from the phone the value names the phone; with no time it lasts 8 hours, and until HH:MM ends at the next such time', async ($, on) => {
  await manager($, on)
  await onCmd($, 'unattended on', { kind: 'bridge' })
  expect(h.store.get(UNATTENDED_KEY)).toMatchObject({ by: 'phone', from: T0, until: T0 + 8 * HOUR_MS })
  await $.command.run(lane('unattended off'))
  h.nowMs += 11_000
  const end = new Date(T0)
  end.setHours(end.getHours() + 2, 0, 0, 0)
  const hhmm = `${String(end.getHours()).padStart(2, '0')}:00`
  await onCmd($, `unattended on until ${hhmm}`)
  expect((h.store.get(UNATTENDED_KEY) as prm.Unattended).until).toBe(end.getTime())
})

test('unattended on: from another plugin, another session or a script it is refused, with no dialog, value or row', async ($, on) => {
  const stdins: string[] = []
  await manager($, on, stdins)
  const asked = h.askCount
  for (const kind of ['plugin', 'peer', 'cron']) for (const args of ['unattended on', 'unattended on for 3 h', 'unattended on until 09:00']) expect(await onCmd($, args, { kind })).toBe(prm.UNATTENDED_ON_NOT_PERSON)
  expect(h.askCount).toBe(asked)
  expect(logged(stdins)).toContain('refused:unattended-not-person:plugin')
  expect(logged(stdins)).toContain('refused:unattended-not-person:session')
  expect(logged(stdins)).toContain('refused:unattended-not-person:other')
  nothingOn()
})

test('unattended on: an end under half an hour or past 14 hours is refused with the nearest end it takes, with no dialog', async ($, on) => {
  await manager($, on)
  const asked = h.askCount
  const early = prm.unattendedSpanText({ kind: 'for', hours: 0.25 }, T0, when)
  const late = prm.unattendedSpanText({ kind: 'for', hours: 15 }, T0, when)
  expect(early).toContain(`the earliest end it takes now is ${when(Math.ceil((T0 + 30 * 60_000) / 60_000) * 60_000)}`)
  for (const args of ['unattended on for 0.25 h', 'unattended 0.25h', 'unattended 29m', 'unattended 0m', 'unattended on for 20m']) expect(await onCmd($, args)).toBe(early)
  for (const args of ['unattended on for 15 h', 'unattended 15h', 'unattended 841m']) expect(await onCmd($, args)).toBe(late)
  expect(h.askCount).toBe(asked)
  nothingOn()
})

test('unattended: a span or a time alone turns it on like on for and on until: 1h, 45m, 90m, 17:30', async ($, on) => {
  await manager($, on)
  for (const [args, ms] of [['unattended 1h', HOUR_MS], ['unattended 45m', 45 * 60_000], ['unattended 90m', 90 * 60_000]] as const) {
    const text = await onCmd($, args)
    const v = h.store.get(UNATTENDED_KEY) as prm.Unattended
    expect(v, `${args}: ${text}`).toMatchObject({ by: 'prompt', from: h.nowMs, until: h.nowMs + ms })
    expect(h.lastQuestion, args).toBe(prm.unattendedQuestion(when(v.until), 'MANAGER', [{ lead: 'LEAD', n: 1 }]))
    expect(text, args).toBe(prm.unattendedOnText(when(v.until), 'MANAGER', winShort(v)))
    await $.command.run(lane('unattended off'))
    h.nowMs += 2_000
  }
  const end = new Date(h.nowMs)
  end.setHours(end.getHours() + 2, 0, 0, 0)
  await onCmd($, `unattended ${String(end.getHours()).padStart(2, '0')}:00`)
  expect((h.store.get(UNATTENDED_KEY) as prm.Unattended).until).toBe(end.getTime())
  // The long forms still work.
  await $.command.run(lane('unattended off'))
  h.nowMs += 2_000
  await onCmd($, 'unattended on for 1 h')
  expect((h.store.get(UNATTENDED_KEY) as prm.Unattended).until).toBe(h.nowMs + HOUR_MS)
})

test('/unattended is /callboard unattended: the same dialog and window from the person, the same refusal from any other origin, and a bare one lists', async ($, on) => {
  await manager($, on)
  const slash = (args: unknown, origin: unknown = { kind: 'composer' }) => $.command.run({ command: 'unattended', args, origin } as any).then((r: any) => String(r.text))
  const asked = h.askCount
  for (const kind of ['plugin', 'peer', 'cron']) for (const args of ['1h', 'on', '17:30', '45m']) expect(await slash(args, { kind })).toBe(prm.UNATTENDED_ON_NOT_PERSON)
  // An origin with no kind is no person's; args that are not a string read as none (the state, for the person only).
  expect(await slash('1h', {})).toBe(prm.UNATTENDED_ON_NOT_PERSON)
  expect(await slash(7, { kind: 'plugin' })).toBe(prm.UNATTENDED_NOT_PERSON)
  expect(await slash({ x: 1 })).toContain('Unattended mode is off')
  expect(h.askCount).toBe(asked)
  nothingOn()
  const text = await slash('1h')
  const v = h.store.get(UNATTENDED_KEY) as prm.Unattended
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastHeader).toBe(prm.UNATTENDED_HEADER)
  expect(v).toMatchObject({ by: 'prompt', until: T0 + HOUR_MS })
  expect(text).toBe(prm.unattendedOnText(when(v.until), 'MANAGER', winShort(v)))
  expect(await slash('')).toContain('Unattended mode is on until')
  expect(await slash('off', { kind: 'plugin' })).toBe(prm.UNATTENDED_ENDED)
  h.nowMs += 11_000
  expect(await slash('bogus')).toContain('Use /callboard unattended')
  expect(await slash('10m')).toContain('lasts at least half an hour')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
})

test('unattended on: each missing precondition is refused with its own text, before any dialog, and stores nothing', async ($, on) => {
  const stdins: string[] = []
  await manager($, on, stdins)
  const asked = h.askCount
  // Escalation surely off, or on for less than everything: the state is printed.
  h.store.set('answering', { off: true, savedAt: T0 })
  expect(await onCmd($)).toBe(prm.unattendedNoText('escalation', 'Escalation: off.'))
  h.store.set('answering', { ...ESC_ON, asksScope: undefined })
  expect(await onCmd($)).toBe(prm.unattendedNoText('escalation', 'Escalation: on for all lanes and leads; questions: yours.'))
  h.store.set('answering', ESC_ON)
  // The OFF file.
  pfs.set(OFF_FILE, { text: '', mtimeSec: T0 / 1000 })
  expect(await onCmd($)).toBe(prm.unattendedNoText('off-file'))
  pfs.delete(OFF_FILE)
  // Check-ins off.
  h.store.set('config', { ...CONFIG_DEFAULTS, checkin: false })
  expect(await onCmd($)).toBe(prm.unattendedNoText('checkin'))
  h.store.delete('config')
  // A relay open, then a tier asking the person.
  pdirs.add(PROMPTS_DIR)
  pdirs.add(LDIR(APISID))
  pfs.set(`${LDIR(APISID)}/${TID}.relay.json`, { text: '{}', mtimeSec: T0 / 1000 })
  expect(await onCmd($)).toBe(prm.unattendedNoText('relay'))
  pfs.delete(`${LDIR(APISID)}/${TID}.relay.json`)
  pdirs.add(`${PROMPTS_DIR}/asking`)
  pfs.set(`${PROMPTS_DIR}/asking/${OTHER}`, { text: '{}', mtimeSec: T0 / 1000 })
  expect(await onCmd($)).toBe(prm.unattendedNoText('asking'))
  pfs.delete(`${PROMPTS_DIR}/asking/${OTHER}`)
  // A settings read that fails: the check-in value is not taken from the cache or the defaults.
  h.storeGetFails = (k: string) => k === 'config'
  expect(await onCmd($)).toBe(prm.unattendedNoText('config'))
  h.storeGetFails = undefined
  // More prompt folders than are read: a relay in one past the cap could be missed.
  const many = Array.from({ length: 513 }, (_, i) => `${PROMPTS_DIR}/${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`)
  for (const d of many) pdirs.add(d)
  expect(await onCmd($)).toBe(prm.unattendedNoText('prompts'))
  for (const d of many) pdirs.delete(d)
  expect(h.askCount).toBe(asked)
  expect(logged(stdins)).toEqual(expect.arrayContaining(['refused:unattended-on:escalation', 'refused:unattended-on:off-file', 'refused:unattended-on:checkin', 'refused:unattended-on:relay', 'refused:unattended-on:asking', 'refused:unattended-on:config', 'refused:unattended-on:prompts']))
  nothingOn()
  // With everything back, it turns on.
  expect(await onCmd($)).toContain('Unattended mode is on until')
})

test('unattended on: with no live manager it is refused, with no dialog', async ($, on) => {
  await leadAt($, on, [])
  h.store.set('answering', ESC_ON)
  const asked = h.askCount
  expect(await onCmd($)).toBe(prm.unattendedNoText('manager'))
  expect(h.askCount).toBe(asked)
  nothingOn()
})

test('unattended on: Cancel stores nothing; a precondition that changed while the dialog was open is refused after the click', async ($, on) => {
  await manager($, on)
  h.askAnswer = prm.UNATTENDED_NO as any
  expect(await onCmd($)).toBe(prm.unattendedNoText('cancelled'))
  nothingOn()
  h.askAnswer = prm.UNATTENDED_YES as any
  const answer = holdDialog()
  const n = h.askCount
  const p = onCmd($)
  await waitFor(() => h.askCount !== n)
  h.store.set('config', { ...CONFIG_DEFAULTS, checkin: false })
  answer(prm.UNATTENDED_YES)
  expect(await p).toBe(prm.unattendedNoText('checkin'))
  nothingOn()
})

test('unattended on: an off typed in any session while the dialog is open wins over the click', async ($, on) => {
  const stdins: string[] = []
  await manager($, on, stdins)
  const answer = holdDialog()
  const n = h.askCount
  const p = onCmd($)
  await waitFor(() => h.askCount !== n)
  // Another session's off finds nothing on and leaves its mark in the store.
  expect(await onCmd($, 'unattended off', { kind: 'peer' })).toBe(prm.UNATTENDED_NOT_ON)
  answer(prm.UNATTENDED_YES)
  expect(await p).toBe(prm.unattendedNoText('off-typed'))
  expect(logged(stdins)).toContain('refused:unattended-on:off-typed')
  nothingOn()
})

test('unattended on: for half an hour opens after the dialog was open a while: its span is measured from when the person asked', async ($, on) => {
  await manager($, on)
  const answer = holdDialog()
  const n = h.askCount
  const p = onCmd($, 'unattended on for 0.5 h')
  await waitFor(() => h.askCount !== n)
  h.nowMs += 20_000
  answer(prm.UNATTENDED_YES)
  const text = await p
  const v = h.store.get(UNATTENDED_KEY) as prm.Unattended
  expect(v).toEqual({ v: 1, from: T0, until: T0 + 30 * 60_000, by: 'prompt', manager: 'MANAGER', savedAt: T0 + 20_000 })
  expect(text).toBe(prm.unattendedOnText(when(v.until), 'MANAGER', winShort(v)))
  expect(uKinds()).toEqual(['unattended-on'])
})

test('unattended on: an off whose mark lands while the window is being written still wins, and the window is ended with a void row', async ($, on) => {
  const stdins: string[] = []
  await manager($, on, stdins)
  // Another session's off finds nothing yet and leaves its mark while the window's row is written.
  h.pfsFails = (a: string[]) => {
    if (a[0] === '/usr/bin/tee' && a.at(-1) === LEDGER_FILE && !h.store.has(UNATTENDED_OFF_AT_KEY)) h.store.set(UNATTENDED_OFF_AT_KEY, h.nowMs)
    return false
  }
  expect(await onCmd($)).toBe(prm.unattendedNoText('off-typed'))
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off off-during-open'])
  expect(logged(stdins)).toContain('refused:unattended-on:off-typed')
  h.nowMs += 11_000
  expect(await onCmd($, 'unattended')).toContain('an unattended off came while it was being opened, and the off won')
})

test('unattended on: a late off whose removal of the value fails still ends the window, by its void row', async ($, on) => {
  await manager($, on)
  h.storeSetHook = (k: string) => {
    if (k === UNATTENDED_KEY) h.store.set(UNATTENDED_OFF_AT_KEY, h.nowMs)
  }
  h.storeDeleteFails = true
  expect(await onCmd($)).toBe(prm.unattendedNoText('off-typed'))
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off off-during-open'])
  h.storeDeleteFails = false
  h.nowMs += 11_000
  expect(await statusText($)).not.toContain('| Unattended | ON')
})

test('unattended off: an off whose mark the store does not take says so, typed and from unattended_off', async ($, on) => {
  await manager($, on)
  h.storeSetHook = (k: string) => {
    if (k === UNATTENDED_OFF_AT_KEY) throw new Error('disk')
  }
  expect(await onCmd($, 'unattended off')).toBe(`${prm.UNATTENDED_NOT_ON} ${prm.UNATTENDED_OFF_MARK_FAILED}`)
  expect((await offTool($)).result).toBe(`${prm.UNATTENDED_NOT_ON} ${prm.UNATTENDED_OFF_MARK_FAILED}`)
})

longTest('unattended on: a dialog nobody answers times out after 10 minutes and stores nothing; a click on it afterwards turns nothing on and says so', async ($, on) => {
  await manager($, on, [], { clock: true })
  const answer = holdDialog()
  const n = h.askCount
  const p = onCmd($)
  await waitFor(() => h.askCount !== n)
  await new Promise((r) => setTimeout(r, 10))
  await h.clock!.advance(prm.UNATTENDED_DIALOG_MS + 1000)
  expect(await p).toBe(prm.unattendedNoText('timed-out'))
  expect(toasts).toContain(prm.UNATTENDED_TIMED_OUT_TOAST)
  answer(prm.UNATTENDED_YES)
  await waitFor(() => toasts.includes(prm.UNATTENDED_LATE_TOAST))
  nothingOn()
})

test('unattended_off: the manager\'s main agent ends the window and gets its counts; it opens none and says so when none is on', async ($, on) => {
  const stdins: string[] = []
  await manager($, on, stdins)
  const v = putWindow()
  const u = winShort(v)
  putLedger([{ t: new Date(T0).toISOString(), kind: 'returned', id: TID, code: 'park', u, lane: 'API', pattern: 'git push origin main', why: 'a merge waits for you' }])
  h.nowMs += 11_000
  const r = await offTool($)
  expect(r.result).toBe(`${prm.UNATTENDED_ENDED} Window ${u}: 1 parked. The person reads the list with /callboard unattended.`)
  expect(String(r.result)).not.toContain('git push')
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off manager'])
  expect(ledgerRows().find((r) => r.kind === 'unattended-off')).toMatchObject({ code: 'manager', u, by: SID })
  expect(logged(stdins)).toContain('command:unattended-off:manager')
  h.nowMs += 11_000
  expect((await offTool($)).result).toBe(prm.UNATTENDED_NOT_ON)
  expect(h.store.has(UNATTENDED_KEY)).toBe(false)
  expect(uKinds()).toEqual(['unattended-on', 'unattended-off manager'])
  // The list names how it ended.
  expect(await onCmd($, 'unattended')).toContain('Ended early: the manager ended it with unattended_off')
})

test('unattended_off: a subagent of the manager is refused, and the window stays', async ($, on) => {
  await manager($, on)
  putWindow()
  h.nowMs += 11_000
  expect((await offTool($, { agentId: 'a1' })).deny).toBe(prm.UNATTENDED_OFF_SUBAGENT)
  expect(h.store.has(UNATTENDED_KEY)).toBe(true)
})

test('unattended_off: a lead is refused, and the window stays', async ($, on) => {
  await leadAt($, on, [])
  putWindow(win())
  h.nowMs += 11_000
  expect((await offTool($)).deny).toBe(prm.UNATTENDED_OFF_NOT_MANAGER)
  expect(h.store.has(UNATTENDED_KEY)).toBe(true)
})
