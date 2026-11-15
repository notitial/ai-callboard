import { expect, test } from 'claude-code/testing'
import { HEADER, keptKey, leadRecordText, PARK_YES, REMOVE_YES, REOPEN_YES, REASON_TEXT, RETIRE_YES, TERMINATE_YES, afterSignalFailedLeadText, parkLeadQuestion, parkedLeadText, removedLeadNoSessionText, removeLeadQuestion, retireLeadQuestion, reopenedLeadText, stoppedLeadText, terminateLeadQuestion } from '../hooks/core'
import { h, NO, PS_TABLE, ROOT, SID, T0, fakeSha, leadFiles, longTest, teeTexts, toasts } from './harness'
import { ledgerRows } from './answer-fixtures'
import { APISID, CSESS, HOME, LEADPATH, LEADSID, MGR_SESS, OTHERLEAD, PIN, condOn, drive, killed, lane, leadAt, leadFileText, leadRecsJson, leadReg, mgrAt, ownedBy, putLeadRecs, putStore } from './fixtures'

// ---- the lead stop tools (ADR 0007), the caller's side: lead_park, lead_unpark, lead_retire, lead_terminate ----
// The conductor is this session (SID); the lead LEAD is session LEADSID (pid 4242) in PIN, with its presence file and (owned) its record naming the conductor and
// its binding to it. The lead's own answer to a cue is h.autoAnswer. Its saved lead grant is `lead:<LEADSID>`.
const call = (tool: string, lead: unknown = 'LEAD') => ({ tool: `mcp__callboard__${tool}`, lead }) as any
const cues = (argv: string[][], verb?: string) => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${LEADSID}.cue` && (verb === undefined || teeTexts.get(a[a.length - 2])?.startsWith(`${verb}\n`))).length
const stopRows = () => ledgerRows().filter((r) => r.kind === 'lead-stop')
// A call that waits (the idle wait, the window's answer to a reopen) is driven by the clock; the others are plain calls.
const deny = async ($: any, c: unknown) => String(((await $.tool.call(c)) as { deny?: string }).deny)
const result = async ($: any, c: unknown) => (await $.tool.call(c)) as { deny?: string; result?: string }
const driven = async ($: any, c: unknown) => (await drive($.tool.call(c), 200)) as { deny?: string; result?: string }
const LEADKEY = `lead:${LEADSID}`
const OWNKEY = `owner:${LEADSID}`
const LEADREPORT = `${PIN}/.archive/LEAD/REPORT.md`
const REOPENPATH = `${ROOT}/open/LEAD.reopen`
const reopenWrites = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === REOPENPATH)
const recOf = () => leadRecsJson(PIN).leads.find((l) => l.name === 'LEAD')
// A lane record of the conductor's repo that names the lead.
const namingLane = (extra: Record<string, unknown> = {}) => ({ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1, leadName: 'LEAD', ...extra })
// The lead's process in the ps table (no shell under it), its saved grant, and a signed report newer than its start.
function leadUp(): void {
  h.psTable = `${PS_TABLE} 4242     1 /x/native-binary/claude\n`
  h.store.set(LEADKEY, { pin: PIN, savedAt: T0 })
  h.reportAt = LEADREPORT
  h.reportFile = { text: `# report\nstatus: done ${LEADSID}\n`, mtimeSec: T0 / 1000 }
}
async function conductor($: any, on: any, argv: string[][], o: { owned?: boolean; sess?: Record<string, string> } = {}) {
  await condOn($, on, [], { clock: true, argv, sess: o.sess ?? { ...CSESS(), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  if (o.owned !== false) ownedBy(SID, { leadSid: LEADSID })
  leadUp()
}
async function manager($: any, on: any, argv: string[][], o: { sess?: Record<string, string> } = {}) {
  await mgrAt($, on, [], { argv, clock: true, sess: o.sess ?? { ...MGR_SESS({ name: 'MANAGER' }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  leadUp()
}

// ---- lead_terminate ----

test('lead_terminate by the conductor asks the person every time; Cancel sends nothing; Force stop signals once, then the record and the saved grant go', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const asked = h.askCount
  h.askAnswer = NO
  expect(await deny($, call('lead_terminate'))).toBe('lead_terminate refused: the person did not confirm.')
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastQuestion).toBe(terminateLeadQuestion('LEAD', PIN, LEADSID, 4242, 0))
  expect(h.lastHeader).toBe(HEADER.stopLead)
  expect(killed(argv)).toEqual([])
  expect(stopRows()).toEqual([])
  h.askAnswer = TERMINATE_YES
  expect((await result($, call('lead_terminate'))).result).toBe(stoppedLeadText('terminate', 'LEAD', 4242, 'removed'))
  expect(h.askCount).toBe(asked + 2)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(stopRows()).toEqual([expect.objectContaining({ kind: 'lead-stop', code: 'terminate', lane: 'LEAD', repo: PIN, by: SID, target: LEADSID, tier: 'conductor', dialog: 'yes' })])
  expect(recOf()).toBeUndefined()
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(h.store.has(OWNKEY)).toBe(false)
  expect(cues(argv)).toBe(0)
})

test('lead_terminate of a lead that lanes still name keeps its record with no session; the dialog counts its live lanes', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  putStore([namingLane({ sid: APISID })])
  h.askAnswer = TERMINATE_YES
  expect((await result($, call('lead_terminate'))).result).toBe(stoppedLeadText('terminate', 'LEAD', 4242, 'kept'))
  expect(h.lastQuestion).toBe(terminateLeadQuestion('LEAD', PIN, LEADSID, 4242, 1))
  const rec = recOf()
  expect(rec).toBeDefined()
  expect(rec!.sid).toBeUndefined()
  expect(rec!.conductorSid).toBe(SID)
  expect(h.store.has(LEADKEY)).toBe(false)
  // The owner the lead was bound to stays as the proof that lets the sessionless record keep its lanes; lead_retire removes record and proof.
  const proofKey = keptKey(fakeSha(leadRecordText(PIN, rec!)), 'LEAD')
  expect(h.store.get(proofKey)).toMatchObject({ repo: PIN, conductorSid: SID, name: 'LEAD' })
  putStore([])
  h.sessions = CSESS()
  expect((await result($, call('lead_retire'))).result).toContain('LEAD')
  expect(recOf()).toBeUndefined()
  expect(h.store.has(proofKey)).toBe(false)
})

test('lead_terminate whose proof cannot be saved keeps the record unproven and says its lanes reach no conductor', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  putStore([namingLane({ sid: APISID })])
  h.askAnswer = TERMINATE_YES
  h.storeSetHook = (k: string) => {
    if (k.startsWith('owner-kept:')) throw new Error('store full')
  }
  expect((await result($, call('lead_terminate'))).result).toBe(stoppedLeadText('terminate', 'LEAD', 4242, 'kept-unproven'))
  expect(recOf()?.sid).toBeUndefined()
  expect([...h.store.keys()].some((k) => k.startsWith('owner-kept:'))).toBe(false)
})

longTest('lead_terminate: a process that does not end leaves the record and keys and says so; a failed ledger write sends no signal', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.askAnswer = TERMINATE_YES
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a.some((x) => x.includes('/ledger-'))
  expect(await deny($, call('lead_terminate'))).toContain('lead_terminate refused: ledger-write')
  expect(killed(argv)).toEqual([])
  expect(toasts).toContain('Force stop not sent: ledger-write')
  h.pfsFails = undefined
  h.survivesKill = true
  expect((await driven($, call('lead_terminate'))).result).toBe(stoppedLeadText('terminate', 'LEAD', 4242, 'alive'))
  expect(recOf()?.sid).toBe(LEADSID)
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('lead_terminate by the manager on a live lead with no record: the dialog, the signal, nothing to remove but its keys', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv)
  const asked = h.askCount
  h.askAnswer = TERMINATE_YES
  expect((await result($, call('lead_terminate'))).result).toBe(stoppedLeadText('terminate', 'LEAD', 4242, 'stopped'))
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastQuestion).toBe(terminateLeadQuestion('LEAD', PIN, LEADSID, 4242, 0))
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'terminate', tier: 'manager', dialog: 'yes', target: LEADSID })])
})

test('a lead stop tool refuses a lead the conductor does not own, before any dialog', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { owned: false })
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: LEADSID }])
  const asked = h.askCount
  for (const tool of ['lead_park', 'lead_unpark', 'lead_retire', 'lead_terminate']) expect(await deny($, call(tool))).toContain(`${tool} refused: not-owner`)
  expect(h.askCount).toBe(asked)
  expect(killed(argv)).toEqual([])
  expect(cues(argv)).toBe(0)
})

// ---- lead_retire ----

test('lead_retire by the conductor asks nothing: the retire cue, the signal on the lead\'s ok, then the record and both keys go', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const asked = h.askCount
  expect((await result($, call('lead_retire'))).result).toBe(stoppedLeadText('retire', 'LEAD', 4242, 'removed'))
  expect(h.askCount).toBe(asked)
  expect(cues(argv, 'retire')).toBe(1)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'retire', tier: 'conductor', dialog: 'none', target: LEADSID })])
  expect(recOf()).toBeUndefined()
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(h.store.has(OWNKEY)).toBe(false)
})

test('lead_retire: the lead\'s refusal sends no signal; an unsigned report refuses before the cue; a lane naming the lead refuses lead-has-lanes', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'refused report-not-done'
  expect(await deny($, call('lead_retire'))).toContain('lead_retire refused')
  expect(killed(argv)).toEqual([])
  h.autoAnswer = 'ok -'
  h.reportFile = { text: '# report\n', mtimeSec: T0 / 1000 }
  const sent = cues(argv)
  expect(await deny($, call('lead_retire'))).toContain('lead_retire refused: report-not-done')
  expect(cues(argv)).toBe(sent)
  putStore([namingLane()])
  expect(await deny($, call('lead_retire'))).toContain(`lead_retire refused: lead-has-lanes: ${REASON_TEXT['lead-has-lanes']}`)
  expect(killed(argv)).toEqual([])
  expect(recOf()?.sid).toBe(LEADSID)
})

test('lead_retire by the manager asks once, naming the lead, its repo and session; Cancel sends no cue and writes no row', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv)
  ownedBy(OTHERLEAD, { leadSid: LEADSID })
  const asked = h.askCount
  h.askAnswer = NO
  expect(await deny($, call('lead_retire'))).toContain('lead_retire refused: the person did not confirm.')
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastQuestion).toBe(retireLeadQuestion('LEAD', PIN, LEADSID))
  expect(h.lastHeader).toBe(HEADER.stopLead)
  expect(cues(argv)).toBe(0)
  expect(stopRows()).toEqual([])
  h.askAnswer = RETIRE_YES
  expect((await result($, call('lead_retire'))).result).toBe(stoppedLeadText('retire', 'LEAD', 4242, 'removed'))
  expect(h.askCount).toBe(asked + 2)
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'retire', tier: 'manager', dialog: 'yes' })])
  expect(recOf()).toBeUndefined()
})

test('lead_retire of a record no session carries: the conductor removes an orphan directly, and asks first for a parked one', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { sess: CSESS() })
  const asked = h.askCount
  expect((await result($, call('lead_retire'))).result).toContain('LEAD')
  expect(h.askCount).toBe(asked)
  expect(recOf()).toBeUndefined()
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'remove', dialog: 'none' })])
  ownedBy(SID, { leadSid: LEADSID })
  const recs = leadRecsJson(PIN)
  putLeadRecs(recs.leads.map((l) => ({ ...l, parked: T0 })))
  h.askAnswer = NO
  expect(await deny($, call('lead_retire'))).toBe('lead_retire refused: the person did not confirm.')
  expect(h.lastQuestion).toBe(removeLeadQuestion('LEAD', PIN, true, HOME))
  expect(h.lastQuestion).toContain('~/code/app')
  expect(recOf()).toBeDefined()
  expect(killed(argv)).toEqual([])
})

test('a record whose session is gone for good and whose binding went with it: the owner\'s lead_retire removes it and its stale grant; an unpark still needs the binding', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { sess: CSESS() })
  h.store.delete(OWNKEY)
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID, parked: T0 }])
  h.openResultPath = `${ROOT}/open/LEAD.result`
  expect(await deny($, call('lead_unpark'))).toContain('lead_unpark refused: record-changed')
  expect(reopenWrites(argv).length).toBe(0)
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID }])
  const asked = h.askCount
  expect((await result($, call('lead_retire'))).result).toBe(removedLeadNoSessionText('LEAD'))
  expect(h.askCount).toBe(asked)
  expect(recOf()).toBeUndefined()
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'remove', dialog: 'none' })])
  expect(killed(argv)).toEqual([])
  // Another conductor's record is still out of reach, binding or not.
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: LEADSID }])
  expect(await deny($, call('lead_retire'))).toContain('lead_retire refused: not-owner')
  expect(recOf()).toBeDefined()
})

test('removing a record whose session another record\'s binding names leaves that session\'s keys alone', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { sess: CSESS() })
  const other = { repo: '/Users/x/code/other', rec: 'b'.repeat(64), conductorSid: OTHERLEAD, at: T0 }
  h.store.set(OWNKEY, other)
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID }])
  // The keys stay, and the answer says so rather than calling them gone.
  expect((await result($, call('lead_retire'))).result).toBe(removedLeadNoSessionText('LEAD', 'left'))
  expect(recOf()).toBeUndefined()
  expect(h.store.get(OWNKEY)).toEqual(other)
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('the manager\'s lead_retire removes a record whose session is gone, only after the person\'s click', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv, { sess: MGR_SESS({ name: 'MANAGER' }) })
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: LEADSID }])
  h.askAnswer = NO
  expect(await deny($, call('lead_retire'))).toBe('lead_retire refused: the person did not confirm.')
  expect(h.lastQuestion).toBe(removeLeadQuestion('LEAD', PIN, false, HOME))
  expect(recOf()).toBeDefined()
  h.askAnswer = REMOVE_YES
  expect((await result($, call('lead_retire'))).result).toContain('LEAD')
  expect(recOf()).toBeUndefined()
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'remove', dialog: 'yes' })])
  expect(killed(argv)).toEqual([])
})

// ---- lead_park and lead_unpark ----

test('lead_park by the conductor: the park cue, the signal on the lead\'s ok, the record marked parked and the saved grant kept', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const asked = h.askCount
  expect((await result($, call('lead_park'))).result).toBe(parkedLeadText('LEAD', 4242))
  expect(h.askCount).toBe(asked)
  expect(cues(argv, 'park')).toBe(1)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(recOf()?.parked).toBeGreaterThan(0)
  expect(recOf()?.sid).toBe(LEADSID)
  expect(h.store.has(LEADKEY)).toBe(true)
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'park', dialog: 'none' })])
})

test('lead_park that fails after its signal answers that the lead was signalled, never failed closed', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  // The log line written after the parked mark fails as a spawn failure would.
  h.runThrows = (a, stdin) => a[0] === '/usr/bin/tee' && (stdin ?? '').includes('"event":"parked"')
  expect((await result($, call('lead_park'))).result).toBe(afterSignalFailedLeadText('park', 'LEAD', 4242))
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
})

test('lead_park refuses a lead with a live lane before any cue', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  putStore([namingLane({ sid: APISID })])
  expect(await deny($, call('lead_park'))).toContain('lead_park refused: lead-has-live-lanes')
  expect(cues(argv)).toBe(0)
  expect(killed(argv)).toEqual([])
})

test('the manager\'s lead_park of a lead with no record refuses lead-no-record before any dialog; of an owned lead it asks once', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv)
  const asked = h.askCount
  expect(await deny($, call('lead_park'))).toContain('lead_park refused: lead-no-record')
  expect(h.askCount).toBe(asked)
  ownedBy(OTHERLEAD, { leadSid: LEADSID })
  h.askAnswer = NO
  expect(await deny($, call('lead_park'))).toContain('the person did not confirm')
  expect(h.lastQuestion).toBe(parkLeadQuestion('LEAD', PIN, LEADSID))
  expect(h.askCount).toBe(asked + 1)
  expect(cues(argv)).toBe(0)
  h.askAnswer = PARK_YES
  expect((await result($, call('lead_park'))).result).toBe(parkedLeadText('LEAD', 4242))
  expect(h.askCount).toBe(asked + 2)
})

async function parkedLead($: any, on: any, argv: string[][], parked = T0) {
  await conductor($, on, argv, { sess: CSESS() })
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID, parked }])
  h.openResultPath = `${ROOT}/open/LEAD.result`
}

longTest('lead_unpark writes LEAD.reopen with the record\'s session, waits for the window, and clears the parked mark', async ($, on) => {
  const argv: string[][] = []
  await parkedLead($, on, argv)
  h.mvHook = (to) => {
    if (to === REOPENPATH) h.openResult = `ok ${LEADSID}\n`
  }
  expect(await driven($, call('lead_unpark'))).toEqual({ result: reopenedLeadText('LEAD', LEADSID) })
  const w = reopenWrites(argv)
  expect(w.length).toBe(1)
  expect(teeTexts.get(w[0][3])).toBe(`${LEADSID}\n`)
  expect(recOf()?.parked).toBeUndefined()
  expect(recOf()?.sid).toBe(LEADSID)
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'unpark', dialog: 'none' })])
})

test('lead_unpark refuses a lead that is not parked and one parked more than 28 days ago; an older extension\'s unknown-lane names the version', async ($, on) => {
  const argv: string[][] = []
  await parkedLead($, on, argv, h.nowMs - 28 * 24 * 3_600_000 - 60_000)
  expect(await deny($, call('lead_unpark'))).toContain(`lead_unpark refused: park-expired: ${REASON_TEXT['park-expired']}`)
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID }])
  expect(await deny($, call('lead_unpark'))).toContain('lead_unpark refused: not-parked')
  const at = h.nowMs
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID, parked: at }])
  h.mvHook = (to) => {
    if (to === REOPENPATH) h.openResult = 'error unknown-lane\n'
  }
  expect(String((await driven($, call('lead_unpark'))).deny)).toContain(`lead_unpark refused: lead-reopen-unknown-lane: ${REASON_TEXT['lead-reopen-unknown-lane']}`)
  expect(recOf()?.parked).toBe(at)
  expect(killed(argv)).toEqual([])
})

test('the manager\'s lead_unpark asks once with Reopen; Cancel writes no reopen request', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv, { sess: MGR_SESS({ name: 'MANAGER' }) })
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: LEADSID, parked: T0 }])
  h.openResultPath = `${ROOT}/open/LEAD.result`
  const asked = h.askCount
  h.askAnswer = NO
  expect(await deny($, call('lead_unpark'))).toBe('lead_unpark refused: the person did not confirm.')
  expect(h.askCount).toBe(asked + 1)
  expect(h.askedOptions.at(-1)?.[0]).toBe(REOPEN_YES)
  expect(reopenWrites(argv).length).toBe(0)
  expect(stopRows()).toEqual([])
  h.askAnswer = REOPEN_YES
  h.mvHook = (to) => {
    if (to === REOPENPATH) h.openResult = `ok ${LEADSID}\n`
  }
  expect(await driven($, call('lead_unpark'))).toEqual({ result: reopenedLeadText('LEAD', LEADSID) })
  expect(h.askCount).toBe(asked + 2)
  expect(stopRows()).toEqual([expect.objectContaining({ code: 'unpark', tier: 'manager', dialog: 'yes' })])
})

// ---- across the tools ----

// The Force stop dialog held open while `change` runs, then clicked.
async function terminateDuring($: any, change: () => void | Promise<void>) {
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const p = $.tool.call(call('lead_terminate'))
  await new Promise((r) => setTimeout(r, 20))
  await change()
  release(TERMINATE_YES)
  const out = JSON.stringify(await p)
  h.askHang = undefined
  return out
}

test('lead_terminate: /callboard off during the dialog wins, and a record moved to another session during it is not stopped', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await terminateDuring($, () => putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: OTHERLEAD }]))).toContain('lead_terminate refused')
  expect(killed(argv)).toEqual([])
  expect(stopRows()).toEqual([])
  ownedBy(SID, { leadSid: LEADSID })
  expect(await terminateDuring($, async () => {
    await $.command.run(lane('off'))
  })).toContain('refused')
  expect(killed(argv)).toEqual([])
  expect(stopRows()).toEqual([])
})

test('a ledger row that cannot be written stops each tool before its action: no cue, no signal, no reopen request, no record change', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a.some((x) => x.includes('/ledger-'))
  for (const tool of ['lead_park', 'lead_retire']) expect(await deny($, call(tool))).toContain(`${tool} refused: ledger-write`)
  expect(cues(argv)).toBe(0)
  expect(killed(argv)).toEqual([])
  expect(recOf()?.parked).toBeUndefined()
  h.sessions = CSESS()
  putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID, parked: T0 }])
  expect(await deny($, call('lead_unpark'))).toContain('lead_unpark refused: ledger-write')
  expect(await deny($, call('lead_retire'))).toContain('ledger-write')
  expect(reopenWrites(argv).length).toBe(0)
  expect(recOf()?.parked).toBe(T0)
})

test('the conductor\'s lane_terminate on a lead\'s name still refuses', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__callboard__lane_terminate', lane: 'LEAD' } as any))).toContain('lane_terminate refused')
  expect(killed(argv)).toEqual([])
})

test('a lead\'s own call of a lead stop tool refuses, before any dialog', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { clock: true, argv })
  const asked = h.askCount
  for (const tool of ['lead_park', 'lead_unpark', 'lead_retire', 'lead_terminate']) expect(await deny($, call(tool))).toContain(`${tool} refused`)
  expect(h.askCount).toBe(asked)
  expect(killed(argv)).toEqual([])
})
