import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { UNATTENDED_UNREAD_KEY } from '../hooks/engine/answer-hook'
import { h, SID, T0, longTest, toasts } from './harness'
import { MGR_SESS, lane, logged, mgrAt, started, statusText } from './fixtures'
import { ledgerRows, putLedger, putQ, putWindow, tier, win, winShort, pcall, said } from './answer-fixtures'

// ---- what the person sees when an unattended window ends (ADR 0008): the toast of the process that ended it, the unread mark in the store, its line in the status
// and in the manager's prompt_list, the list of every window since it was last read, and the row of a notice cap inside a window ----
const t = (ms: number) => new Date(T0 + ms).toISOString()
const parkRow = (u: string, id = '1d1b2c3d-0000-4000-8000-123456789abc') => ({ t: t(60_000), kind: 'returned', id, lane: 'ALPHA', repo: '/Users/x/api', tool: 'Bash', pattern: 'git', u, code: 'park', tier: 'manager', why: 'a merge waits' })
const ended = () => toasts.filter((x) => x.startsWith('Unattended mode ended'))
const unread = () => h.store.get(UNATTENDED_UNREAD_KEY)
const list = async ($: any) => (await $.command.run(lane('unattended'))).text as string
const off = async ($: any) => $.command.run(lane('unattended off', { kind: 'peer' }))

test('window end: the process that ends a window toasts what it did once and marks it unread; a second off does neither', async ($, on) => {
  await started($, on, [])
  const u = winShort(putWindow())
  putLedger([parkRow(u)])
  await off($)
  expect(ended()).toEqual(['Unattended mode ended: 1 parked. /callboard unattended lists it.'])
  expect(unread()).toEqual({ v: 1, us: [u] })
  await off($)
  expect(ended()).toHaveLength(1)
  expect(unread()).toEqual({ v: 1, us: [u] })
})

test('window end: a window with nothing in it says so, and a ledger that cannot be read is told as such', async ($, on) => {
  await started($, on, [])
  putWindow()
  await off($)
  expect(ended()).toEqual(['Unattended mode ended: nothing was raised. /callboard unattended lists it.'])
  putWindow(win({ from: T0 + 1000, savedAt: T0 + 1000 }))
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  await off($)
  h.pfsFails = undefined
  expect(ended()[1]).toBe('Unattended mode ended: what it did could not be counted. /callboard unattended lists it.')
})

test('window end: the status shows the unread windows until the person reads the list, and a list that could not be read leaves them marked', async ($, on) => {
  await started($, on, [])
  const u = winShort(putWindow())
  putLedger([parkRow(u)])
  expect(await statusText($)).not.toContain('Unattended list')
  await off($)
  expect(await statusText($)).toContain('| Unattended list | 1 window not read yet: run /callboard unattended |')
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  expect(await list($)).toContain(prm.UNATTENDED_LIST_UNREAD)
  h.pfsFails = undefined
  expect(unread()).toEqual({ v: 1, us: [u] })
  expect(await list($)).toContain('Parked for you (1):')
  expect(unread()).toBeUndefined()
  expect(await statusText($)).not.toContain('Unattended list')
  // A command of another origin lists nothing and clears nothing.
  h.store.set(UNATTENDED_UNREAD_KEY, { v: 1, us: [u] })
  expect((await $.command.run(lane('unattended', { kind: 'plugin' }))).text).toBe(prm.UNATTENDED_NOT_PERSON)
  expect(unread()).toEqual({ v: 1, us: [u] })
})

test('window end: every window since the list was last read is listed, oldest first, and one read clears them all', async ($, on) => {
  await started($, on, [])
  const v1 = putWindow()
  const v2 = win({ from: T0 + 1000, savedAt: T0 + 1000 })
  putLedger([parkRow(winShort(v1))])
  await off($)
  putWindow(v2)
  putLedger([parkRow(winShort(v2), '2d1b2c3d-0000-4000-8000-123456789abc')])
  await off($)
  expect(unread()).toEqual({ v: 1, us: [winShort(v1), winShort(v2)] })
  expect(ended()).toHaveLength(2)
  const text = await list($)
  expect(text).toContain(prm.unattendedListsHead(2))
  expect(text.indexOf(`Window ${winShort(v1)}:`)).toBeGreaterThan(-1)
  expect(text.indexOf(`Window ${winShort(v2)}:`)).toBeGreaterThan(text.indexOf(`Window ${winShort(v1)}:`))
  expect(unread()).toBeUndefined()
  // Read once, the next list is the last window alone.
  const again = await list($)
  expect(again).not.toContain(prm.unattendedListsHead(2))
  expect(again).toContain(`Window ${winShort(v2)}:`)
})

test('window end: a window on now is listed with the unread ones and stays unmarked', async ($, on) => {
  await started($, on, [])
  const v1 = putWindow()
  await off($)
  const v2 = putWindow(win({ from: T0 + 1000, savedAt: T0 + 1000 }))
  const text = await list($)
  expect(text).toContain(prm.unattendedListsHead(2))
  expect(text).toContain(`Window ${winShort(v2)}: opened`)
  expect(text).toContain('it is on now')
  expect(unread()).toBeUndefined()
  expect(v1).toBeTruthy()
})

test('window end: the manager\'s prompt_list carries one line about the unread windows, until they are read; a lead gets none', async ($, on) => {
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain('Unattended mode ended')
  h.store.set(UNATTENDED_UNREAD_KEY, { v: 1, us: ['abcdef01', 'abcdef02'] })
  const text = said(await $.tool.call(pcall('prompt_list')))
  expect(text.endsWith(prm.unattendedUnreadLine(2))).toBe(true)
  expect(text.startsWith('No prompt is waiting in your reach.')).toBe(true)
})

test('window end: the manager\'s unattended_off toasts and marks like the command, and a window put back after its end is not marked or toasted again', async ($, on) => {
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
  const v = putWindow()
  const u = winShort(v)
  expect(said(await $.tool.call(pcall('unattended_off')))).toContain(`Window ${u}: nothing was raised.`)
  expect(ended()).toEqual(['Unattended mode ended: nothing was raised. /callboard unattended lists it.'])
  expect(unread()).toEqual({ v: 1, us: [u] })
  await list($)
  expect(unread()).toBeUndefined()
  // The same value stored again after its end is ended once more as `ended`: the person has read it, so nothing is shown again.
  h.store.set('unattended', v)
  h.nowMs += 11_000
  await $.command.run(lane('status'))
  expect(unread()).toBeUndefined()
  expect(ended()).toHaveLength(1)
})

test('window end: a value put back while the ledger still refuses its off row is ended again without a new mark or toast', async ($, on) => {
  await started($, on, [])
  const v = putWindow()
  const u = winShort(v)
  const ledgerRefuses = (a: string[]) => a[0] === '/usr/bin/tee' && a.includes('-a')
  h.pfsFails = ledgerRefuses
  await off($)
  expect(unread()).toEqual({ v: 1, us: [u] })
  expect(ended()).toHaveLength(1)
  h.pfsFails = undefined
  await list($)
  expect(unread()).toBeUndefined()
  h.pfsFails = ledgerRefuses
  h.store.set('unattended', v)
  h.nowMs += 11_000
  await $.command.run(lane('status'))
  expect(unread()).toBeUndefined()
  expect(ended()).toHaveLength(1)
  h.pfsFails = undefined
})

test('window end: the manager\'s prompt_list says so also while escalation is off', async ($, on) => {
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { off: true, savedAt: T0 })
  h.store.set(UNATTENDED_UNREAD_KEY, { v: 1, us: ['abcdef01'] })
  const text = said(await $.tool.call(pcall('prompt_list')))
  expect(text.startsWith('Escalation is off on this Mac.')).toBe(true)
  expect(text.endsWith(prm.unattendedUnreadLine(1))).toBe(true)
})

test('window end: a lead\'s prompt_list never carries the line', async ($, on) => {
  await tier($, on)
  h.store.set(UNATTENDED_UNREAD_KEY, { v: 1, us: ['abcdef01'] })
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain('Unattended mode ended')
})

test('window end: a stored unread mark that is not a list of window marks reads as none', async ($, on) => {
  await started($, on, [])
  h.store.set(UNATTENDED_UNREAD_KEY, { v: 1, us: ['nope', 7, 'abcdef01', 'abcdef01'] })
  expect(await statusText($)).toContain('| Unattended list | 1 window not read yet: run /callboard unattended |')
  h.store.set(UNATTENDED_UNREAD_KEY, 'junk')
  expect(await statusText($)).not.toContain('Unattended list')
})

// ---- the notice cap inside a window ----
const capLoop = async ($: any, on: any, window: boolean) => {
  const stdins: string[] = []
  await tier($, on, stdins, { clock: true })
  const u = window ? winShort(putWindow()) : undefined
  for (let i = 1; i <= 31; i++) {
    putQ({ id: `${i.toString(16).padStart(8, '0')}-aaaa-4000-8000-123456789abc` })
    await h.clock!.advance(2000)
  }
  expect(logged(stdins).filter((e) => e === 'notice-capped:prompts').length).toBe(1)
  return { u, rows: ledgerRows().filter((r) => r.kind === 'notice-capped') }
}

longTest('window end: a tier held back by its notice cap inside a window leaves one notice-capped row with the window mark, once per capped stretch', async ($, on) => {
  const { u, rows } = await capLoop($, on, true)
  expect(rows).toHaveLength(1)
  expect([rows[0].kind, rows[0].code, rows[0].tier, rows[0].by, rows[0].u]).toEqual(['notice-capped', 'prompts', 'lead', SID, u])
  expect(prm.unattendedListText({ u: u!, live: true, rows: [...rows, { t: t(0), kind: 'unattended-on', u: u! }] as prm.LedgerRow[], unknown: [], when: (ms) => `<${ms - Date.parse(t(0))}>` })).toContain('A tier was not told of waiting prompts for a while (its hourly notice cap was reached) (1):\n- the lead, at <')
})

longTest('window end: the same cap outside a window leaves no row', async ($, on) => {
  const { rows } = await capLoop($, on, false)
  expect(rows).toEqual([])
})

longTest('window end: a capped stretch that began before the window leaves its row once the window is held, and one row for each window', async ($, on) => {
  const stdins: string[] = []
  await tier($, on, stdins, { clock: true })
  for (let i = 1; i <= 31; i++) {
    putQ({ id: `${i.toString(16).padStart(8, '0')}-aaaa-4000-8000-123456789abc` })
    await h.clock!.advance(2000)
  }
  expect(ledgerRows().filter((r) => r.kind === 'notice-capped')).toEqual([])
  const v1 = putWindow()
  await h.clock!.advance(30_000)
  await h.clock!.advance(30_000)
  expect(ledgerRows().filter((r) => r.kind === 'notice-capped').map((r) => r.u)).toEqual([winShort(v1)])
  await $.command.run(lane('unattended off', { kind: 'peer' }))
  const v2 = putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 4 * 3_600_000 }))
  await h.clock!.advance(30_000)
  await h.clock!.advance(30_000)
  expect(ledgerRows().filter((r) => r.kind === 'notice-capped').map((r) => r.u)).toEqual([winShort(v1), winShort(v2)])
})
