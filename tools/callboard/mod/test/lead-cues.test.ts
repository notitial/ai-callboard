import { expect, test } from 'claude-code/testing'
import { CONFIG_DEFAULTS, leadResumeText, nudgeText } from '../hooks/core'
import { h, GOOD, SID, T0, extraStat, longTest, seen, submitted } from './harness'
import type { Trace } from './harness'
import { COND, OTHER, OTHERLEAD, PIN, TURN, condPresenceOf, cue, dirStat, leadAt, leadSelfReg, logged, mgrFile, mgrRow, nudges, ownedBy, putCond, putLeadRecs, regAs, ticks } from './fixtures'

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
}
// The lead with a trusted manager (session OTHERLEAD, pid 4243) and no conductor.
async function underManager($: any, on: any, stdins: string[] = []) {
  await leadAt($, on, stdins, { clock: true, sess: { ...leadSelfReg(), ...mgrRow() } })
  mgrFile()
}
const arm = async ($: any) => {
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
}
const resumes = () => submitted.filter((t) => t === leadResumeText('LEAD'))

test('the owner\'s resume gives the lead one fixed turn that names it; other verbs stay refused', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  expect(await cue(10, 'resume\n')).toBe('resume ok - 10\n')
  expect(resumes().length).toBe(1)
  expect(logged(stdins)).toContain('resumed:')
  for (const [ino, verb] of [[11, 'retire'], [12, 'park'], [13, 'start']] as const) expect(await cue(ino, `${verb}\n`)).toBe(`${verb} refused not-eligible ${ino}\n`)
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

test('a trusted conductor that does not own the lead may not compact it, with or without a request of the lead\'s own', async ($, on) => {
  await lead($, on, [], { owned: false })
  expect(await cue(100, 'compact\n')).toBe('compact refused not-eligible 100\n')
  expect(nudges()).toEqual([])
  expect(h.store.has(`ord:${SID}`)).toBe(false)
  await arm($)
  expect(await cue(101, 'compact\n')).toBe('compact refused not-eligible 101\n')
  expect(seen.compacted).toBe(false)
})
