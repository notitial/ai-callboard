import { expect, test } from 'claude-code/testing'
import { h, T0, longTest, submitted, toasts } from './harness'
import { MIN, OTHER, OTHERLEAD, checkins, ckLane, ckLead, ckRow, idleFor, lane, leadSelfReg, logged } from './fixtures'

const DONE = '[callboard] Signed done: `API`. Each of these lanes signed its report done and is idle or gone. Read its report, then call lane_retire once nothing is left for it. Submitted by the callboard mod, not by the user; it carries no approval, go or answer; never record it as one.'
const dones = () => submitted.filter((t) => t.startsWith('[callboard] Signed done:'))
const GONE_TOAST = 'Lane API: session ended, report not signed done.'
const sign = (sid: string, mtimeSec = T0 / 1000, more = '') => (h.reportFile = { text: `notes${more}\nstatus: done ${sid}\n`, mtimeSec })

test('signed done: an idle lane that signed its report is told to its lead once, within minutes and not after 20; no check-in for it', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  sign(OTHER)
  await idleFor(8 * MIN)
  expect(dones()).toEqual([DONE])
  expect(logged(stdins).filter((x) => x.startsWith('lane-done'))).toEqual(['lane-done:done:1'])
  await idleFor(40 * MIN)
  expect(dones().length).toBe(1)
  expect(checkins()).toEqual([])
})

test('signed done: an unsigned report, or one signed by another session, is not told', async ($, on) => {
  await ckLead($, on)
  await idleFor(8 * MIN)
  h.reportFile = { text: 'notes\n', mtimeSec: T0 / 1000 }
  await idleFor(8 * MIN)
  sign(OTHERLEAD)
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(8 * MIN)
  expect(dones()).toEqual([])
})

longTest('signed done: a lane that works on and signs again is told again; a status change with the same signature is not', async ($, on) => {
  await ckLead($, on)
  sign(OTHER)
  await idleFor(8 * MIN)
  expect(dones().length).toBe(1)
  // The lane's own keepalive ping: the status time moves, the report does not.
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(8 * MIN)
  expect(dones().length).toBe(1)
  h.sessions = { ...leadSelfReg(), ...ckRow({ status: 'busy', statusUpdatedAt: h.nowMs }) }
  await idleFor(8 * MIN)
  expect(dones().length).toBe(1)
  sign(OTHER, h.nowMs / 1000, '\nmore work')
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(8 * MIN)
  expect(dones()).toEqual([DONE, DONE])
})

test('signed done: not while check-ins are paused, then told', async ($, on) => {
  await ckLead($, on)
  sign(OTHER)
  expect((await $.command.run(lane('checkin pause 30m'))).text).toContain('paused')
  await idleFor(24 * MIN)
  expect(dones()).toEqual([])
  await idleFor(12 * MIN)
  expect(dones()).toEqual([DONE])
})

test('a lane whose session ends with no signed report: one toast for the person, and no done notice', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  await idleFor(4 * MIN)
  h.sessions = leadSelfReg()
  await idleFor(16 * MIN)
  expect(toasts.filter((t) => t === GONE_TOAST).length).toBe(1)
  expect(logged(stdins)).toContain('lane-gone-toast:1')
  await idleFor(20 * MIN)
  expect(toasts.filter((t) => t === GONE_TOAST).length).toBe(1)
  expect(dones()).toEqual([])
})

test('a lane whose session ends after it signed is told to the lead as done, with no toast', async ($, on) => {
  await ckLead($, on)
  sign(OTHER)
  h.sessions = leadSelfReg()
  await idleFor(12 * MIN)
  expect(dones()).toEqual([DONE])
  expect(toasts).not.toContain(GONE_TOAST)
})

test('signed done: a report read that fails is tried again, so a signed lane is still told', async ($, on) => {
  await ckLead($, on)
  sign(OTHER)
  h.headFails = true
  await idleFor(4 * MIN)
  expect(dones()).toEqual([])
  h.headFails = false
  await idleFor(4 * MIN)
  expect(dones()).toEqual([DONE])
})
