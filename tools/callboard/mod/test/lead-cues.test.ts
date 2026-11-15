import { expect, test } from 'claude-code/testing'
import { CONFIG_DEFAULTS, leadResumeText, nudgeText } from '../hooks/core'
import { h, GOOD, PS_TABLE, SID, T0, extraStat, longTest, seen, submitted } from './harness'
import type { Trace } from './harness'
import { COND, OTHER, OTHERLEAD, PIN, TURN, condPresenceOf, cue, cueSession, dirStat, putStore, leadAt, leadSelfReg, logged, mgrFile, mgrRow, nudges, ownedBy, putCond, putLeadRecs, regAs, ticks } from './fixtures'

// ---- the cues a lead takes (ADR 0007): resume and compact from its owner and from a trusted manager ----
// A lead LEAD (this session, SID) in PIN. The conductor CONDX (session OTHERLEAD, pid 4243) in COND is trusted for PIN: its presence file, its saved grant
// and its list file all hold the repo. `owned` adds the lead's record naming CONDX and the lead's binding to it.
const trustSeed = () => {
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN])
}
const CTSESS = (over: Record<string, unknown> = {}) => ({ ...leadSelfReg(over), ...regAs(OTHERLEAD, 4243, 'CONDX') })
async function lead($: any, on: any, stdins: string[] = [], o: { owned?: boolean; trace?: Trace } = {}) {
  await leadAt($, on, stdins, { clock: true, sess: CTSESS(), seed: trustSeed, trace: o.trace })
  if (o.owned !== false) ownedBy(OTHERLEAD)
  h.psTable = LEAD_PS
}
// The process table with the lead's own pid (4400) and its usual children, none a shell.
const LEAD_PS = PS_TABLE.replaceAll('4300', '4400')
// The lead with a trusted manager (session OTHERLEAD, pid 4243) and no conductor.
async function underManager($: any, on: any, stdins: string[] = []) {
  await leadAt($, on, stdins, { clock: true, sess: { ...leadSelfReg(), ...mgrRow() } })
  mgrFile()
  h.psTable = LEAD_PS
}
const arm = async ($: any) => {
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
}
const resumes = () => submitted.filter((t) => t === leadResumeText('LEAD'))

test('the owner\'s resume gives the lead one fixed turn that names it; a start stays refused', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  expect(await cue(10, 'resume\n')).toBe('resume ok - 10\n')
  expect(resumes().length).toBe(1)
  expect(logged(stdins)).toContain('resumed:')
  expect(await cue(13, 'start\n')).toBe('start refused not-eligible 13\n')
  expect(resumes().length).toBe(1)
})

test('a resume waits while the lead is busy or has a draft in its prompt box', async ($, on) => {
  await lead($, on)
  h.sessions = CTSESS({ status: 'busy' })
  expect(await cue(20, 'resume\n')).toBe('resume held not-idle 20\n')
  h.sessions = CTSESS()
  h.draftNow = 'half a thought'
  expect(await cue(21, 'resume\n')).toBe('resume held draft-in-box 21\n')
  expect(resumes()).toEqual([])
  h.draftNow = ''
  expect(await cue(22, 'resume\n')).toBe('resume ok - 22\n')
})

longTest('the 13th resume in an hour is refused rate-limit', async ($, on) => {
  await lead($, on)
  for (let i = 0; i < 12; i++) expect(await cue(30 + i, 'resume\n')).toBe(`resume ok - ${30 + i}\n`)
  expect(await cue(50, 'resume\n')).toBe('resume refused rate-limit 50\n')
  expect(resumes().length).toBe(12)
})

test('a trusted conductor that does not own the lead may not resume it; a record edited to another conductor says record-changed', async ($, on) => {
  await lead($, on, [], { owned: false })
  expect(await cue(60, 'resume\n')).toBe('resume refused not-eligible 60\n')
  ownedBy(OTHERLEAD)
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHER, sid: SID }])
  expect(await cue(61, 'resume\n')).toBe('resume refused record-changed 61\n')
  expect(resumes()).toEqual([])
})

test('a trusted manager\'s resume is taken; with the manager gone it is refused', async ($, on) => {
  await underManager($, on)
  expect(await cue(70, 'resume\n')).toBe('resume ok - 70\n')
  expect(resumes().length).toBe(1)
  h.sessions = leadSelfReg()
  expect(await cue(71, 'resume\n')).toBe('resume refused not-eligible 71\n')
})

test('with an armed on-cue request the lead compacts on its owner\'s cue', async ($, on) => {
  await lead($, on)
  await arm($)
  expect(await cue(80, 'compact\n')).toBe('compact ok - 80\n')
  expect(seen.compacted).toBe(true)
})

test('with an armed on-cue request the lead compacts on a trusted manager\'s cue; with no request it is no-request, as the manager owns nothing', async ($, on) => {
  await underManager($, on)
  expect(await cue(81, 'compact\n')).toBe('compact refused no-request 81\n')
  expect(nudges()).toEqual([])
  await arm($)
  expect(await cue(82, 'compact\n')).toBe('compact ok - 82\n')
  expect(seen.compacted).toBe(true)
})

test('the owner\'s compact with no request is an order: the conductor-worded nudge, the stamp, and an on-cue request below the floor that survives the ticks and compacts at the turn end', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  h.tokensNow = 50_000
  expect(await cue(90, 'compact\n')).toBe('compact held nudged 90\n')
  expect(nudges()).toEqual([nudgeText('lead', CONFIG_DEFAULTS, 'lead')])
  expect(nudges()[0]).toContain('Your conductor asked you to compact.')
  expect(h.store.get(`ord:${SID}`)).toEqual({ at: expect.any(Number) })
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('queued')
  await ticks(3)
  expect(seen.compacted).toBe(false)
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(seen.compacted).toBe(true)
  expect(h.store.has(`ord:${SID}`)).toBe(false)
  expect(logged(stdins)).toContain('requested:on-cue-ordered')
})

test('a compact with no request and no owner is no-request, though a trusted conductor is live', async ($, on) => {
  await lead($, on, [], { owned: false })
  expect(await cue(100, 'compact\n')).toBe('compact refused no-request 100\n')
  expect(nudges()).toEqual([])
  expect(h.store.has(`ord:${SID}`)).toBe(false)
})

// ---- park and retire: the lead's own checks before it answers ok (ADR 0007). Its caller signals only on that ok ----
const LEADREPORT = `${PIN}/.archive/LEAD/REPORT.md`
const leadLane = (over: Record<string, unknown> = {}) => ({ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, repo: PIN, createdAt: 1, leadSid: SID, ...over })
const apiLive = () => cueSession(OTHER, 'API', `${PIN}/api`, { pid: 4500 })
// The lead takes a turn, then signs its own report after it.
async function signed($: any) {
  h.reportAt = LEADREPORT
  await $.prompt.submit({ text: 'work on it' } as any)
  await h.clock!.advance(2000)
  h.reportFile = { text: `# r\nstatus: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(2000)
}

test('a park from the owner is confirmed when idle with no report at all, and the saved lead grant is written again first', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  await h.clock!.advance(5 * 60_000)
  const before = (h.store.get(`lead:${SID}`) as { savedAt: number }).savedAt
  expect(h.reportFile).toBeUndefined()
  expect(await cue(200, 'park\n', { mtimeSec: h.nowMs / 1000 })).toBe('park ok - 200\n')
  const after = h.store.get(`lead:${SID}`) as { pin: string; savedAt: number }
  expect(after.pin).toBe(PIN)
  expect(after.savedAt).toBeGreaterThan(before)
  expect(logged(stdins)).toContain('park-confirmed:LEAD')
})

test('a park is held on a draft or a busy lead, and refused while background work runs', async ($, on) => {
  await lead($, on)
  h.draftNow = 'half'
  expect(await cue(201, 'park\n')).toBe('park held draft-in-box 201\n')
  h.draftNow = ''
  h.sessions = CTSESS({ status: 'busy' })
  expect(await cue(202, 'park\n')).toBe('park held not-idle 202\n')
  h.sessions = CTSESS()
  h.agentsNow = [{ status: 'running' }]
  expect(await cue(203, 'park\n')).toBe('park refused background-work 203\n')
})

test('a park is refused lead-has-live-lanes while a lane naming the lead has a live session; a parked lane does not block it', async ($, on) => {
  await lead($, on)
  putStore([leadLane()])
  h.sessions = { ...CTSESS(), ...apiLive() }
  expect(await cue(210, 'park\n')).toBe('park refused lead-has-live-lanes 210\n')
  // Named by the lead's name only (a lane made before leadSid), live under its record's session id.
  putStore([leadLane({ leadSid: undefined, leadName: 'lead', sid: OTHER })])
  h.sessions = { ...CTSESS(), ...cueSession(OTHER, 'renamed', `${PIN}/api`, { pid: 4500 }) }
  expect(await cue(211, 'park\n')).toBe('park refused lead-has-live-lanes 211\n')
  h.sessions = CTSESS()
  expect(await cue(212, 'park\n')).toBe('park ok - 212\n')
})

test('a park whose saved lead grant cannot be written again is refused grant-unsaved', async ($, on) => {
  await lead($, on)
  await h.clock!.advance(5 * 60_000)
  h.storeSetHook = (k) => {
    if (k.startsWith('lead:')) throw new Error('disk full')
  }
  expect(await cue(220, 'park\n', { mtimeSec: h.nowMs / 1000 })).toBe('park refused grant-unsaved 220\n')
  h.storeSetHook = undefined
  expect(await cue(221, 'park\n', { mtimeSec: h.nowMs / 1000 })).toBe('park ok - 221\n')
})

test('a trusted manager\'s park and retire are taken: each manager call is behind the person\'s dialog', async ($, on) => {
  await underManager($, on)
  expect(await cue(230, 'park\n')).toBe('park ok - 230\n')
  await signed($)
  expect(await cue(231, 'retire\n')).toBe('retire ok - 231\n')
})

test('a park or retire from a trusted conductor that does not own the lead is not-eligible', async ($, on) => {
  await lead($, on, [], { owned: false })
  await signed($)
  expect(await cue(240, 'park\n')).toBe('park refused not-eligible 240\n')
  expect(await cue(241, 'retire\n')).toBe('retire refused not-eligible 241\n')
})

test('a retire from the owner needs the lead\'s own report signed since its last turn', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  h.reportAt = LEADREPORT
  await $.prompt.submit({ text: 'work on it' } as any)
  await h.clock!.advance(2000)
  expect(await cue(250, 'retire\n')).toBe('retire refused report-missing 250\n')
  h.reportFile = { text: '# r\nwork done\n', mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(2000)
  expect(await cue(251, 'retire\n')).toBe('retire refused report-not-done 251\n')
  h.reportFile = { text: `# r\nstatus: done ${OTHER}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(2000)
  expect(await cue(252, 'retire\n')).toBe('retire refused report-not-done 252\n')
  h.reportFile = { text: `# r\nstatus: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(2000)
  expect(await cue(253, 'retire\n')).toBe('retire ok - 253\n')
  expect(logged(stdins)).toContain('retire-confirmed:LEAD')
  await $.prompt.submit({ text: 'one more thing' } as any)
  expect(await cue(254, 'retire\n')).toBe('retire refused report-stale 254\n')
})

test('a retire is refused lead-has-lanes while any lane record names the lead, live or not', async ($, on) => {
  await lead($, on)
  await signed($)
  putStore([leadLane({ parked: T0, sid: OTHER })])
  expect(await cue(260, 'retire\n')).toBe('retire refused lead-has-lanes 260\n')
  putStore([leadLane({ leadSid: OTHERLEAD, name: 'WEB' })])
  expect(await cue(261, 'retire\n')).toBe('retire ok - 261\n')
})
