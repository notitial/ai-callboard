import { expect, test } from 'claude-code/testing'
import { h, T0, longTest, submitted, toasts } from './harness'
import { MIN, OTHER, OTHERLEAD, PIN, TURN, checkins, ckLane, ckLead, ckRow, ckText, cueSession, idleFor, lane, leadSelfReg, logged } from './fixtures'

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
  expect(logged(stdins)).toContain('lane-gone-toast:unsigned:1')
  await idleFor(20 * MIN)
  expect(toasts.filter((t) => t === GONE_TOAST).length).toBe(1)
  expect(dones()).toEqual([])
})

test('a lane whose session ends after it signed is told to the lead as done, with no toast', async ($, on) => {
  await ckLead($, on)
  await $.command.run(lane('checkin pause 4m'))
  sign(OTHER)
  await idleFor(4 * MIN)
  h.sessions = leadSelfReg()
  await idleFor(16 * MIN)
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

test('no toast for a lane this lead never saw live (a restart, an unpark whose panel never opened), nor for a parked one', async ($, on) => {
  await ckLead($, on, [], undefined, [ckLane(), { ...ckLane({ name: 'PARKED', folder: `${PIN}/parked`, brief: `${PIN}/parked/BRIEF.md` }), sid: OTHERLEAD, parked: 5 }])
  await idleFor(20 * MIN)
  expect(toasts.filter((t) => t.includes('session ended'))).toEqual([])
  expect(dones()).toEqual([])
})

test('a gone lane whose report cannot be read: after the tries, the toast says so and does not call it unsigned', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  sign(OTHER)
  h.headFails = true
  await idleFor(4 * MIN)
  h.sessions = leadSelfReg()
  await idleFor(32 * MIN)
  expect(toasts.filter((t) => t.includes('session ended'))).toEqual(['Lane API: session ended, report could not be read.'])
  expect(logged(stdins)).toContain('lane-gone-toast:unread:1')
  expect(dones()).toEqual([])
})

longTest('signed done has its own budget of 6 an hour: the seventh waits, and the shared cap is not spent', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  for (let n = 1; n <= 7; n++) {
    sign(OTHER, h.nowMs / 1000, 'x'.repeat(n))
    h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
    await idleFor(4 * MIN)
  }
  expect(dones().length).toBe(6)
  expect(logged(stdins)).toContain('notice-capped:lane-done')
  expect(logged(stdins)).not.toContain('notice-capped:attention')
  await idleFor(40 * MIN)
  expect(dones().length).toBe(7)
})

test('a report stat that fails for another reason than a missing file is a failed read: tried again, never "not signed"', async ($, on) => {
  await ckLead($, on)
  sign(OTHER)
  h.reportStatErr = `stat: ${h.reportAt}: Permission denied`
  await idleFor(4 * MIN)
  expect(dones()).toEqual([])
  h.reportStatErr = undefined
  await idleFor(4 * MIN)
  expect(dones()).toEqual([DONE])
  expect(toasts.filter((t) => t.includes('session ended'))).toEqual([])
})

// Two lanes: API signs its report; WEB has none and stays quiet, so a check-in is owed for it about 31 minutes after the lead's turn ended at T0.
const WEB = { ...ckLane({ name: 'WEB', folder: `${PIN}/svc`, brief: `${PIN}/svc/BRIEF.md` }), sid: OTHERLEAD }
const webRow = () => cueSession(OTHERLEAD, 'WEB', `${PIN}/svc`, { pid: 4600 })
const WEB_QUIET = ckText('`WEB` (quiet for 30 min, report not signed done)')

longTest("the idle hold: the done notice's own turn does not restart the 20 idle minutes a check-in waits for", async ($, on) => {
  await ckLead($, on, [], {}, [ckLane(), WEB])
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...webRow() }
  await idleFor(16 * MIN)
  sign(OTHER)
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }), ...webRow() }
  await idleFor(4 * MIN)
  expect(dones()).toEqual([DONE])
  // The notice's turn ends 20 minutes in: counted from there, the check-in would wait until minute 40.
  await $.turn.complete(TURN as any)
  await idleFor(14 * MIN)
  expect(checkins()).toEqual([WEB_QUIET])
})

for (const [what, hangs] of [
  ["a turn that ends after the notice's own ends the hold", false],
  ['a notice whose submit timed out holds nothing', true],
] as const) {
  longTest(`the idle hold: ${what}, and the check-in waits 20 minutes from that turn`, async ($, on) => {
    const stdins: string[] = []
    await ckLead($, on, stdins, {}, [ckLane(), WEB])
    h.sessions = { ...leadSelfReg(), ...ckRow(), ...webRow() }
    sign(OTHER)
    h.submitHangs = hangs
    await idleFor(4 * MIN)
    await h.clock!.advance(62_000)
    h.submitHangs = false
    expect(dones()).toEqual([DONE])
    expect(logged(stdins).filter((x) => x.startsWith('lane-done'))).toEqual([hangs ? 'lane-done-unconfirmed:done:1' : 'lane-done:done:1'])
    // The notice's own turn ends, when its submit went through; no check-in is owed yet, so no check-in gate runs.
    if (!hangs) await $.turn.complete(TURN as any)
    await idleFor(15 * MIN)
    // Another turn (the lanes-changed notice's, say) ends about 20 minutes in.
    await $.turn.complete(TURN as any)
    await idleFor(16 * MIN)
    expect(checkins()).toEqual([])
    await idleFor(8 * MIN)
    expect(checkins()).toEqual([WEB_QUIET])
  })
}
