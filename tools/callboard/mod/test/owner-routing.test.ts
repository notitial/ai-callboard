import { expect, test } from 'claude-code/testing'
import { toolNames } from '../hooks/tool-text'
import { h, LEADRECDIR, ROOT, SID, T0, extraStat, leadFiles, longTest, pfs, toolDefs, toolDesc } from './harness'
import { APISID, COND, LEADPATH, LEADSID, OTHERLEAD, PIN, condOn, condPresenceOf, killed, lead, leadCall, leadRecsJson, listCall, mgrCall, ownedBy, putCond, putLeadRecs, regAs } from './fixtures'
import { APIQ, CNDT, LDIR, LEAD2, PDIR, QIN, TID, TID2, addCondT, answerCall, answerer, asConductor, at, byCond, decideBy, pcall, putQ, readReq, refusal, rowKinds, runRequest, said, stop } from './answer-fixtures'

// ---- ADR 0007: who is told of a lead's prompts, and what a conductor reaches, follows the lead's record ----
// A conductor of PIN that is trusted (presence file, saved grant, list file) and listed in the registry, as the conductors above lead LEAD are.
const addOtherCond = (sid: string, pid: number, name: string) => {
  h.store.set(`conductor:${sid}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(sid, pid, name, [PIN])
  h.extraRows = { ...h.extraRows, ...regAs(sid, pid, name) }
}
const others = ['1c', '2c', '3c', '4c'].map((p, i) => ({ sid: `${p}1b2c3d-0000-4000-8000-123456789abc`, pid: 4251 + i, name: `CND${i}` }))
const ids = (n: number) => Array.from({ length: n }, (_, i) => `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-123456789abc`)

longTest('five conductors list one repo and the lead is owned by the one whose session id sorts last: it is the only conductor tier, and a decision of another is dropped', async ($, on) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  addCondT()
  for (const o of others) addOtherCond(o.sid, o.pid, o.name)
  const r = await runRequest($, [
    at(4000, () => decideBy({ level: 'conductor', sid: others[0].sid, name: others[0].name })),
    at(8000, () => {
      pfs.delete(`${PDIR}/${readReq().id}.decision.json`)
      decideBy(byCond)
    }),
  ])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'dropped by-sid', 'answered allow', 'returned allow'])
})

test('a conductor that lists the repo but does not own the lead does not see its request, and cannot answer it', async ($, on) => {
  await asConductor($, on, { owns: [] })
  putQ({ ...APIQ })
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain('No prompt is waiting in your reach.')
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
  expect(pfs.has(`${LDIR(APISID)}/${TID}.decision.json`)).toBe(false)
})

test('a conductor never answers a lead\'s own question: prompt_list says to put it to the person, prompt_answer refuses it relay-only, and the relay is open to it', async ($, on) => {
  await asConductor($, on, { lead: true })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', leadAsks: true, savedAt: T0 })
  putQ({ sid: LEADSID, pid: 4242, level: 'lead', lane: 'LEAD', leadName: undefined, repo: PIN, tool: 'AskUserQuestion', input: QIN })
  const list = said(await $.tool.call(pcall('prompt_list')))
  expect(list).toContain(`### ${TID}`)
  expect(list).toContain("A lead's own question: never answer it. Put it to the person with prompt_escalate")
  expect(said(await $.tool.call(answerCall({ decision: 'answer', option: 1 })))).toContain(refusal('relay-only'))
  expect(pfs.has(`${LDIR(LEADSID)}/${TID}.decision.json`)).toBe(false)
  const relayed = said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'a lead\'s own question' })))
  expect(relayed).toContain('Lead LEAD asks:')
  expect(pfs.has(`${LDIR(LEADSID)}/${TID}.relay.json`)).toBe(true)
})

test('the owner sees the request of a lane working in a subfolder of the repo, and answers it', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ })
  expect(APIQ.repo).toBe(`${PIN}/api`)
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain(`### ${TID}`)
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
})

test('two leads of one repo: a conductor sees the requests of the lanes of the lead it owns, and not those of the other lead', async ($, on) => {
  await asConductor($, on)
  ownedBy(OTHERLEAD, { name: 'LEAD2', leadSid: LEAD2 })
  putQ({ ...APIQ, leadName: 'LEAD' })
  putQ({ ...APIQ, id: TID2, leadName: 'LEAD2' })
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain(`### ${TID}`)
  expect(t).not.toContain(`### ${TID2}`)
  expect(said(await $.tool.call(answerCall({ id: TID2 })))).toContain(refusal('unknown-request'))
})

for (const [what, setup] of [
  ['a lead nobody owns', () => addCondT('CONDX', [PIN], { own: false })],
  ['an owner that is gone', () => (addCondT(), leadFiles.delete(`${ROOT}/leads/${CNDT}.json`))],
  ['an owner whose list file dropped the repo', () => (addCondT(), putCond(['../app2']))],
  ['a record whose lead left (no binding)', () => (addCondT(), h.store.delete(`owner:${LEADSID}`))],
  ['a record that names another conductor than the one bound', () => (addCondT(), h.store.set(`owner:${LEADSID}`, { ...(h.store.get(`owner:${LEADSID}`) as object), conductorSid: OTHERLEAD }))],
] as const) {
  test(`${what} is no conductor tier: nobody can be asked, and the dialog stays the person's`, async ($, on) => {
    await answerer($, on, [])
    leadFiles.delete(LEADPATH)
    setup()
    expect(await runRequest($, [stop(5000)])).toEqual({})
    expect(rowKinds()).toEqual(['no-tier', 'abandoned no-tier'])
  })
}

test('a lead\'s own prompt goes to its owner, found by the lead\'s session id', async ($, on) => {
  await answerer($, on, [], { asLead: true })
  addCondT('CONDX', ['/data/x/work'], { own: false })
  putCond(['/data/x/work'])
  ownedBy(CNDT, { repo: '/data/x/work', leadSid: SID })
  const r = await runRequest($, [at(4000, () => decideBy(byCond))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
})

test('a lane whose lead is known but unnamed has no owner, even when the repo has one record of another lead; a lane that names no lead follows the only record', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ, leadName: undefined, leadSid: LEAD2 })
  putQ({ ...APIQ, id: TID2, leadName: undefined })
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).not.toContain(`### ${TID}`)
  expect(t).toContain(`### ${TID2}`)
})

test('a lane that names no lead has no owner when the repo holds two records', async ($, on) => {
  await asConductor($, on)
  ownedBy(SID, { name: 'LEAD2', leadSid: LEAD2 })
  putQ({ ...APIQ, leadName: undefined })
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain('No prompt is waiting in your reach.')
})

test('a lead-records folder that cannot be read gives no conductor tier, and the conductor\'s own tools say so rather than list nothing', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ })
  extraStat.set(LEADRECDIR, '501 755 2 Directory 11 64 1700000000\n')
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain(`### ${TID}`)
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain('the lead records cannot be read safely')
  extraStat.delete(LEADRECDIR)
})

test('prompt_list reads the lead records once, whatever the number of requests', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ })
  h.leadRecLists = 0
  await $.tool.call(pcall('prompt_list'))
  const one = h.leadRecLists
  expect(one).toBeGreaterThan(0)
  for (const id of ids(20)) putQ({ ...APIQ, id })
  h.leadRecLists = 0
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain(`### ${ids(20)[0]}`)
  expect(h.leadRecLists).toBe(one)
})

test('reach: a conductor lists only the leads it owns and their lanes, and refuses a lane or a lead it does not own (not-owner)', async ($, on) => {
  await condOn($, on, [], { owns: [] })
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: LEADSID }])
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('not-owner')
  expect(JSON.stringify(await $.tool.call(mgrCall('compact', 'API')))).toContain('not-owner')
  expect(((await $.tool.call(listCall())).result as string)).not.toContain('API')
})

test('the records of a repo are the conductor\'s own only: the file of a repo it lists, owned by another conductor, adds nothing to its reach', async ($, on) => {
  await condOn($, on, [], { owns: [{ name: 'LEAD' }] })
  expect(leadRecsJson().leads.map((l) => l.name)).toEqual(['LEAD'])
  expect(((await $.tool.call(listCall())).result as string)).toContain('API')
  ownedBy(OTHERLEAD, { name: 'LEAD', leadSid: LEADSID })
  expect(((await $.tool.call(listCall())).result as string)).not.toContain('API')
})

test('the conductor\'s tools are declared with the conductor\'s descriptions, which say it reaches the leads it owns', async ($, on) => {
  await condOn($, on)
  const d = toolDefs.join('\n')
  for (const name of toolNames('conductor')) expect(d).toContain(toolDesc(name, 'conductor'))
})

test('lane_terminate in a lead whose conductor owns it and is live is refused before any dialog, naming the conductor; with the conductor gone the dialog opens in the lead as before', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  addCondT('CONDX', [PIN], { own: false })
  putCond([PIN])
  ownedBy(CNDT, { repo: PIN, leadSid: SID })
  const before = h.sessions
  h.sessions = { ...h.sessions, ...h.extraRows }
  h.lastQuestion = undefined
  h.askAnswer = 'Force stop'
  const out = said(await $.tool.call(leadCall('terminate')))
  expect(out).toContain('lane_terminate refused: conductor-owns:')
  expect(out).toContain('ask your conductor `CONDX` by message to force stop lane `LABLANE`')
  expect(h.lastQuestion).toBeUndefined()
  expect(killed(argv).length).toBe(0)
  // The conductor's registry row is gone: it is not live, so the lead's own dialog asks the person.
  h.sessions = before
  h.askAnswer = 'Cancel'
  expect(said(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  expect(h.lastQuestion).toContain('Force stop lane LABLANE')
  expect(killed(argv).length).toBe(0)
})
