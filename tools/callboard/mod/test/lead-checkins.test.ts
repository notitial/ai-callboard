import { expect, test } from 'claude-code/testing'
import { LEADS_CHANGED_NOTE, LEADS_CHANGED_TEXT, SUBMITTED_NOTE_NEVER_RECORD } from '../hooks/core'
import { LEADRECDIR, PS_TABLE, SID, T0, extraStat, h, leadFiles, longTest, submitted, toasts } from './harness'
import { APISID, CSESS, LEADPATH, LEADSID, MIN, OTHERLEAD, PIN, TURN, bindOwner, ckLane, condOn, idleFor, lane, leadFileText, leadReg, listed, ownedBy, putLeadRecs, putStore, ticks, leadRecsJson, waitFor } from './fixtures'

// An owning conductor's check-ins on its leads and the leads-changed notice (the lead's own: checkins.test.ts, lead.test.ts).
const THEIRS = '7a1b2c3d-0000-4000-8000-123456789abc'
const leadCk = (parts: string) => `[callboard] Check-in: some of your leads may need you. ${parts}. Call lane_list and look at each. ${SUBMITTED_NOTE_NEVER_RECORD}`
const LEAD_QUIET = '`LEAD` (quiet for 30 min with no live lane, report not signed done)'
const leadCheckins = () => submitted.filter((t) => t.startsWith('[callboard] Check-in: some of your leads'))
const anyCheckins = () => submitted.filter((t) => t.startsWith('[callboard] Check-in:'))
const leadsChanged = () => submitted.filter((t) => t === LEADS_CHANGED_TEXT).length
// The registry: the conductor and its lane API (pid 4500), and the lead LEAD unless `lead` is null.
const sessions = (lead: Record<string, unknown> | null = {}, lanes = true) => {
  const s: Record<string, string> = { ...CSESS(), ...(lead ? leadReg(lead) : {}) }
  if (!lanes) delete s['4500.json']
  return s
}

// A conductor with the repo PIN in reach, after a turn of its own that ended at T0. owned: LEAD (session LEADSID) is this conductor's by record and binding; lead: its
// registry row (null: not live); lanes: the repo's lane records.
async function ckOwn($: any, on: any, o: { owned?: boolean; lead?: Record<string, unknown> | null; lanes?: unknown[] } = {}) {
  const lead = 'lead' in o ? o.lead : {}
  await condOn($, on, [], {
    clock: true,
    owns: [],
    sess: sessions(lead),
    seed: () => {
      if (o.lanes) putStore(o.lanes)
      if (o.owned !== false) ownedBy(SID, { leadSid: LEADSID })
    },
  })
  // The conductor's own process in the ps table, with no shell under it: no background work.
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
}

longTest('lead check-in: an owned lead quiet 30 min with no live lane gets one fixed notice from an idle conductor, not before, once', async ($, on) => {
  await ckOwn($, on)
  await idleFor(28 * MIN)
  expect(leadCheckins()).toEqual([])
  await idleFor(4 * MIN)
  expect(leadCheckins()).toEqual([leadCk(LEAD_QUIET)])
  await idleFor(32 * MIN)
  expect(leadCheckins().length).toBe(1)
  // The conductor hears nothing of a lane: the lane API (its session live, no lead named) is not a lead's and the conductor's own list is not about lanes.
  expect(anyCheckins().length).toBe(1)
})

longTest('lead check-in: a lead with a live lane of its own is waiting for it, so it is not told quiet; the lane ends and the notice follows a new 30 min', async ($, on) => {
  await ckOwn($, on, { lanes: [ckLane({ sid: APISID, leadName: 'LEAD' })] })
  await idleFor(36 * MIN)
  expect(leadCheckins()).toEqual([])
  h.sessions = sessions({}, false)
  await idleFor(28 * MIN)
  expect(leadCheckins()).toEqual([])
  await idleFor(8 * MIN)
  expect(leadCheckins()).toEqual([leadCk(LEAD_QUIET)])
})

test('lead check-in: an owned lead waiting on a prompt 5 min is told to an idle conductor at once, with no 20 min of idle, with one toast', async ($, on) => {
  await ckOwn($, on, { lead: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T0 } })
  await idleFor(4 * MIN)
  expect(leadCheckins()).toEqual([])
  await idleFor(4 * MIN)
  expect(leadCheckins()).toEqual([leadCk('`LEAD` (waiting on a prompt for over 5 min)')])
  expect(toasts.filter((t) => t.includes('waiting on a prompt'))).toEqual(['Lead LEAD: waiting on a prompt for over 5 min.'])
})

longTest('lead check-in: an owned lead whose session is gone is told', async ($, on) => {
  await ckOwn($, on)
  await idleFor(4 * MIN)
  h.sessions = sessions(null)
  await idleFor(24 * MIN)
  expect(leadCheckins()).toEqual([leadCk('`LEAD` (session gone, report not signed done)')])
})

longTest('lead check-in: a parked lead and a record with no session are never gone', async ($, on) => {
  await ckOwn($, on, { owned: false, lead: null })
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID, parked: T0 }, { name: 'NOSID', conductorSid: SID }])
  bindOwner(LEADSID, SID, 'LEAD')
  await idleFor(36 * MIN)
  expect(leadCheckins()).toEqual([])
})

longTest("lead check-in: never about a lead another conductor owns, a live lead with no record, or a record whose lead has no binding to it", async ($, on) => {
  await ckOwn($, on, { owned: false, lead: null })
  putLeadRecs([{ name: 'THEIRS', conductorSid: OTHERLEAD, sid: THEIRS }, { name: 'LEFT', conductorSid: SID, sid: LEADSID }])
  bindOwner(THEIRS, OTHERLEAD, 'THEIRS')
  await idleFor(36 * MIN)
  expect(anyCheckins()).toEqual([])
  // A live lead of the repo that no record names is nobody's to this conductor either.
  h.sessions = sessions({ sessionId: '8a1b2c3d-0000-4000-8000-123456789abc', name: 'NEWBIE' })
  await idleFor(36 * MIN)
  expect(anyCheckins()).toEqual([])
})

longTest('lead check-in: not with a draft in the box; owed until it clears', async ($, on) => {
  await ckOwn($, on)
  h.draftNow = 'half a sentence'
  await idleFor(36 * MIN)
  expect(leadCheckins()).toEqual([])
  h.draftNow = ''
  await idleFor(4 * MIN)
  expect(leadCheckins()).toEqual([leadCk(LEAD_QUIET)])
})

longTest('lead check-in: /callboard checkin pauses a conductor, its status shows the row, and config checkin off stops the notices', async ($, on) => {
  await ckOwn($, on)
  expect((await $.command.run(lane('status'))).text).toMatch(/\| Check-ins \| ON \|/)
  expect((await $.command.run(lane('checkin pause 1h'))).text).toBe('Check-ins paused in this session for 60 min.')
  expect((await $.command.run(lane('status'))).text).toMatch(/\| Check-ins \| PAUSED for/)
  await idleFor(40 * MIN)
  expect(leadCheckins()).toEqual([])
  expect((await $.command.run(lane('checkin on'))).text).toBe('Check-ins are on again in this session.')
  await $.command.run(lane('config checkin off'))
  expect((await $.command.run(lane('status'))).text).toMatch(/\| Check-ins \| OFF \|/)
  await idleFor(8 * MIN)
  expect(leadCheckins()).toEqual([])
  await $.command.run(lane('config checkin on'))
  await idleFor(8 * MIN)
  expect(leadCheckins()).toEqual([leadCk(LEAD_QUIET)])
})

longTest('lead check-in: off ends the memory; nothing is told after it', async ($, on) => {
  await ckOwn($, on)
  await idleFor(8 * MIN)
  await $.command.run(lane('off'))
  await idleFor(36 * MIN)
  expect(anyCheckins()).toEqual([])
})

longTest('leads-changed: a join, a rename and a leave are one notice each in an idle conductor; a park mark, another conductor\'s lead and a passing read error are none', async ($, on) => {
  await ckOwn($, on, { owned: false })
  // The first look is the baseline; the records are looked at about every 10 s.
  await ticks(7)
  expect(leadsChanged()).toBe(0)
  const step = () => ticks(7)
  ownedBy(SID, { leadSid: LEADSID })
  await step()
  expect(leadsChanged()).toBe(1)
  await step()
  expect(leadsChanged()).toBe(1)
  // A rename: the record's name changes, its session and binding do not.
  putLeadRecs([{ name: 'RENAMED', conductorSid: SID, sid: LEADSID }])
  await step()
  expect(leadsChanged()).toBe(2)
  // The conductor's own park, another conductor's lead and a folder that cannot be read for a while are not news.
  putLeadRecs([{ name: 'RENAMED', conductorSid: SID, sid: LEADSID, parked: T0 }])
  await step()
  putLeadRecs([{ name: 'RENAMED', conductorSid: SID, sid: LEADSID, parked: T0 }, { name: 'THEIRS', conductorSid: OTHERLEAD, sid: THEIRS }])
  await step()
  extraStat.set(LEADRECDIR, '501 755 2 Directory 11 64 1700000000\n')
  await step()
  extraStat.delete(LEADRECDIR)
  await step()
  expect(leadsChanged()).toBe(2)
  putLeadRecs([{ name: 'THEIRS', conductorSid: OTHERLEAD, sid: THEIRS }])
  await step()
  expect(leadsChanged()).toBe(3)
})

longTest('leads-changed: a lane_list call right after a change carries the note and no turn follows', async ($, on) => {
  await ckOwn($, on, { owned: false })
  await ticks(7)
  ownedBy(SID, { leadSid: LEADSID })
  expect(await listed($)).toContain(LEADS_CHANGED_NOTE)
  expect(await listed($)).not.toContain(LEADS_CHANGED_NOTE)
  await ticks(7)
  expect(leadsChanged()).toBe(0)
})

longTest('leads-changed: nothing for a conductor with no owned lead', async ($, on) => {
  await ckOwn($, on, { owned: false })
  await h.clock!.advance(60_000)
  expect(leadsChanged()).toBe(0)
  expect(anyCheckins()).toEqual([])
})

longTest('leads-changed: a record that names the conductor but has no binding, or no session, is not news; its lead binding to it is', async ($, on) => {
  await ckOwn($, on, { owned: false })
  await ticks(7)
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID }, { name: 'NOSID', conductorSid: SID }])
  await ticks(7)
  expect(leadsChanged()).toBe(0)
  bindOwner(LEADSID, SID, 'LEAD')
  await ticks(7)
  expect(leadsChanged()).toBe(1)
})

longTest('lead check-in: a lead whose report is signed done is not told quiet or gone (one with no report is: above)', async ($, on) => {
  await ckOwn($, on)
  h.reportAt = `${PIN}/.archive/LEAD/REPORT.md`
  h.reportFile = { text: `# report\nstatus: done ${LEADSID}\n`, mtimeSec: T0 / 1000 }
  await idleFor(36 * MIN)
  expect(leadCheckins()).toEqual([])
  h.sessions = sessions(null)
  await idleFor(24 * MIN)
  expect(leadCheckins()).toEqual([])
})

longTest("leads-changed: the conductor's own lead_retire of a record no session carries is not news to it", async ($, on) => {
  await ckOwn($, on, { lead: null })
  h.store.set(`lead:${LEADSID}`, { pin: PIN, savedAt: T0 })
  await ticks(7)
  const r = (await $.tool.call({ tool: 'mcp__callboard__lead_retire', lead: 'LEAD' })) as { result?: string; deny?: string }
  expect(r.result).toContain('LEAD')
  expect(leadRecsJson().leads).toEqual([])
  await ticks(14)
  expect(leadsChanged()).toBe(0)
})

longTest('lead check-in: a binding that cannot be read for a moment is no look at all: the lead\'s quiet clock and its told marks stand', async ($, on) => {
  await ckOwn($, on)
  await idleFor(20 * MIN)
  h.storeThrowSync = 'get'
  await ticks(35)
  h.storeThrowSync = undefined
  await idleFor(11 * MIN)
  expect(leadCheckins()).toEqual([leadCk(LEAD_QUIET)])
})

longTest("lead check-in: a lead tool names the record in any letter case, and what the check-in saw of that lead starts over", async ($, on) => {
  await ckOwn($, on)
  leadFiles.set(LEADPATH, { text: leadFileText() })
  await idleFor(24 * MIN)
  expect(((await $.tool.call({ tool: 'mcp__callboard__lead_resume', lead: 'lead' } as any)) as { result?: string }).result).toContain('LEAD')
  await idleFor(10 * MIN)
  expect(leadCheckins()).toEqual([])
  await idleFor(28 * MIN)
  expect(leadCheckins()).toEqual([leadCk(LEAD_QUIET)])
})

longTest("leads-changed: a look that began before the conductor's own lead_retire and ends after it does not make the retire news", async ($, on) => {
  await ckOwn($, on, { lead: null })
  h.store.set(`lead:${LEADSID}`, { pin: PIN, savedAt: T0 })
  await ticks(7)
  let release!: () => void
  h.ownerGetHang = new Promise<void>((r) => (release = r))
  const ticking = ticks(6)
  await waitFor(() => h.ownerGetHit > 0)
  const r = (await $.tool.call({ tool: 'mcp__callboard__lead_retire', lead: 'LEAD' })) as { result?: string }
  expect(r.result).toContain('LEAD')
  expect(leadRecsJson().leads).toEqual([])
  release()
  await ticking
  await ticks(14)
  expect(leadsChanged()).toBe(0)
})
