import { expect, test } from 'claude-code/testing'
import { MANAGER_LEAD_NO, MANAGER_LEAD_YES, REASON_TEXT, leadWhy, managerLeadQuestion, orderLeadText } from '../hooks/core'
import { h, NO, PROMPTS_DIR, PS_TABLE, ROOT, SID, YES, LEADRECDIR, extraStat, leadFiles, longTest, submitted } from './harness'
import { ledgerRows } from './answer-fixtures'
import { CSESS, LEADPATH, LEADSID, MGR_SESS, MIN, OTHERLEAD, PIN, APP2, condOn, idleFor, leadFileText, leadReg, mgrAt, ownedBy, putLeadRecs, TURN } from './fixtures'

// ---- the lead tools (ADR 0007), the caller's side: lead_resume and lead_compact ----
// The conductor is this session (SID in COND, over ../app and ../app2); the lead LEAD is session LEADSID (pid 4242) in PIN, with its presence file. `owned` adds
// the lead's record naming this conductor and the lead's binding to it. The lead's own answer to a cue is h.autoAnswer.
const LEDGER = `${PROMPTS_DIR}/ledger-2023-11.jsonl`
const call = (tool: string, lead: unknown = 'LEAD', over: Record<string, unknown> = {}) => ({ tool: `mcp__callboard__${tool}`, lead, ...over }) as any
const cues = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${LEADSID}.cue`).length
const leadRows = () => ledgerRows().filter((r) => r.kind === 'lead-resume')
const deny = async ($: any, c: unknown) => String(((await $.tool.call(c)) as { deny?: string }).deny)
async function conductor($: any, on: any, argv: string[][], o: { owned?: boolean; sess?: Record<string, string>; repos?: string[] } = {}) {
  await condOn($, on, [], { clock: true, argv, repos: o.repos, sess: o.sess ?? { ...CSESS(), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  if (o.owned !== false) ownedBy(SID, { leadSid: LEADSID })
}
async function manager($: any, on: any, argv: string[][]) {
  await mgrAt($, on, [], { argv, clock: true, sess: { ...MGR_SESS({ name: 'MANAGER' }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
}

test('a conductor resumes a lead it owns with no dialog: one cue, and a lead-resume row written before it', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const asked = h.askCount
  expect((await $.tool.call(call('lead_resume'))).result).toBe('cue resume acted for lead LEAD.')
  expect(cues(argv)).toBe(1)
  expect(h.askCount).toBe(asked)
  expect(leadRows()).toEqual([expect.objectContaining({ kind: 'lead-resume', repo: PIN, lane: 'LEAD', by: SID, target: LEADSID, tier: 'conductor', dialog: 'none', hash: expect.stringMatching(/^[0-9a-f]{64}$/) })])
})

test('a conductor\'s lead tools refuse, before any cue: a bad name, no record, a lead it does not own, a record of another repo, a lead not bound to its record', async ($, on) => {
  const argv: string[][] = []
  // Over ../app only, so a record in APP2 is in another repo.
  await conductor($, on, argv, { owned: false, repos: ['../app'] })
  for (const bad of ['', 'a b', 7]) expect(await deny($, call('lead_resume', bad))).toContain('lead_resume refused: bad-lead')
  expect(await deny($, call('lead_resume'))).toBe(`lead_resume refused: unknown-lead: ${REASON_TEXT['unknown-lead']}`)
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: LEADSID }])
  expect(await deny($, call('lead_compact'))).toContain('lead_compact refused: not-owner')
  putLeadRecs([], PIN)
  ownedBy(SID, { leadSid: LEADSID, repo: APP2 })
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: other-repo')
  putLeadRecs([], APP2)
  ownedBy(SID, { leadSid: LEADSID })
  h.store.delete(`owner:${LEADSID}`)
  expect(await deny($, call('lead_resume'))).toBe(`lead_resume refused: ${leadWhy('record-changed')}`)
  expect(cues(argv)).toBe(0)
  expect(leadRows()).toEqual([])
})

test('the target checks refuse before any cue: no registry row of the lead, two rows, no presence file or one of another repo', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.sessions = CSESS()
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: no-live-session')
  h.sessions = { ...CSESS(), ...leadReg(), '4243.json': leadReg({ pid: 4243 })['4242.json'] }
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: session-duplicate')
  h.sessions = { ...CSESS(), ...leadReg() }
  leadFiles.delete(LEADPATH)
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: not-a-lead')
  leadFiles.set(LEADPATH, { text: leadFileText({ repo: APP2 }) })
  expect(await deny($, call('lead_compact'))).toContain('lead_compact refused: not-a-lead')
  expect(cues(argv)).toBe(0)
  expect(leadRows()).toEqual([])
})

test('a ledger that does not take the row sends no resume cue (ledger-write)', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a.includes(LEDGER)
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: ledger-write')
  expect(cues(argv)).toBe(0)
})

test('the lead\'s refusal comes back in a lead\'s words', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'refused not-eligible'
  expect(await deny($, call('lead_resume'))).toContain('that session did not take the cue from you: it is not that lead')
})

longTest('a conductor\'s lead_compact the lead takes as an order: the deny says so, and 15 minutes on with the stamp still there the conductor gets one fixed notice', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  // The conductor's own process in the ps table and a real turn of its own, as the lane twin of this test has (ckLead).
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  h.autoAnswer = 'held nudged'
  expect(await deny($, call('lead_compact'))).toContain('the lead was ordered to compact')
  h.store.set(`ord:${LEADSID}`, { at: h.nowMs })
  await idleFor(12 * MIN)
  const notices = () => submitted.filter((t) => t.includes('did not compact after your order'))
  expect(notices()).toEqual([])
  await idleFor(6 * MIN)
  expect(notices()).toEqual([orderLeadText(['LEAD'])])
  expect(h.store.has(`ord:${LEADSID}`)).toBe(false)
})

test('the conductor\'s lane_compact with the name of a lead it owns is lead_compact; one it does not own is refused; a lane name still reaches the lane', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { owned: false })
  expect(await deny($, { tool: 'mcp__callboard__lane_compact', lane: 'LEAD' })).toContain('lane_compact refused: unknown-lead')
  ownedBy(SID, { leadSid: LEADSID })
  expect((await $.tool.call({ tool: 'mcp__callboard__lane_compact', lane: 'LEAD' } as any)).result).toBe('cue compact acted for lead LEAD.')
  expect(cues(argv)).toBe(1)
  expect((await $.tool.call({ tool: 'mcp__callboard__lane_compact', lane: 'API' } as any)).result).toBe('cue compact acted for lane API.')
})

test('lane_compact on a lane goes to the lane whatever the lead records say: a record of the lane\'s name with no live lead, or a records folder that fails its checks', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { owned: false })
  putLeadRecs([{ name: 'API', conductorSid: SID, sid: OTHERLEAD }])
  expect((await $.tool.call({ tool: 'mcp__callboard__lane_compact', lane: 'API' } as any)).result).toBe('cue compact acted for lane API.')
  extraStat.set(LEADRECDIR, '501 755 2 Directory 11 64 1700000000\n')
  expect((await $.tool.call({ tool: 'mcp__callboard__lane_compact', lane: 'API' } as any)).result).toBe('cue compact acted for lane API.')
  expect(await deny($, call('lead_compact'))).toContain('lead_compact refused: unsafe-dir')
  extraStat.delete(LEADRECDIR)
  expect(cues(argv)).toBe(0)
})

test('the manager\'s lead tools ask the person every time: one dialog naming the lead, its repo and its session; Cancel sends nothing and writes no row', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv)
  ownedBy(OTHERLEAD, { leadSid: LEADSID })
  const asked = h.askCount
  h.askAnswer = NO
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: the person did not confirm.')
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastQuestion).toBe(managerLeadQuestion('lead_resume', 'LEAD', PIN, LEADSID))
  expect(h.lastHeader).toBe('Manager')
  expect(h.askedOptions.slice(-1)).toEqual([[MANAGER_LEAD_YES.lead_resume, MANAGER_LEAD_NO]])
  expect(cues(argv)).toBe(0)
  expect(leadRows()).toEqual([])
  h.askAnswer = YES
  expect((await $.tool.call(call('lead_resume'))).result).toBe('cue resume acted for lead LEAD.')
  expect(h.askCount).toBe(asked + 2)
  expect(leadRows()).toEqual([expect.objectContaining({ by: SID, target: LEADSID, tier: 'manager', dialog: 'yes' })])
  expect((await $.tool.call(call('lead_compact'))).result).toBe('cue compact acted for lead LEAD.')
  expect(h.lastQuestion).toBe(managerLeadQuestion('lead_compact', 'LEAD', PIN, LEADSID))
  expect(h.askCount).toBe(asked + 3)
  expect(cues(argv)).toBe(2)
})

test('the manager reaches a live lead with no record by its name, and its lane_compact on a lead\'s name asks too', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv)
  const asked = h.askCount
  expect((await $.tool.call(call('lead_resume'))).result).toBe('cue resume acted for lead LEAD.')
  expect((await $.tool.call({ tool: 'mcp__callboard__lane_compact', lane: 'LEAD' } as any)).result).toBe('cue compact acted for lead LEAD.')
  expect(h.askCount).toBe(asked + 2)
  expect(cues(argv)).toBe(2)
  expect(await deny($, call('lead_resume', 'NOBODY'))).toContain('lead_resume refused: unknown-lead')
})

test('a target that changes while the manager\'s dialog is open is checked again: nothing is sent', async ($, on) => {
  const argv: string[][] = []
  await manager($, on, argv)
  ownedBy(OTHERLEAD, { leadSid: LEADSID })
  h.askScript = async () => {
    leadFiles.delete(LEADPATH)
    return YES
  }
  expect(await deny($, call('lead_resume'))).toContain('lead_resume refused: not-a-lead')
  expect(cues(argv)).toBe(0)
  expect(leadRows()).toEqual([])
})

test('a lead and a subagent cannot call the lead tools', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await deny($, call('lead_resume', 'LEAD', { agentId: 'a1' }))).toBe('lead_resume refused: for the main agent only.')
  expect(cues(argv)).toBe(0)
})
