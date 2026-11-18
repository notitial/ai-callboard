import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import * as g from '../hooks/go'
import { HOUR_MS, REASON_TEXT, UNATTENDED_LIVE_LANES } from '../hooks/core'
import { UNATTENDED_KEY } from '../hooks/engine/answer-hook'
import { h, GO_DIR, ROOT, SID, T0, leadFiles, longTest, pfs, submitted } from './harness'
import { APISID, LEADPATH, LEADSID, MGR_SESS, NEWSID, PIN, ckLane, ckRow, cueSession, drive, lane, leadAt, leadCall, leadSelfReg, logged, mgrAt, putStore, started, tickTwice, waitFor } from './fixtures'
import { APIQ, LDIR, MGRT, OFF_FILE, PDIR, PRQ, QIN, TID, TID2, addMgrT, answerCall, answerer, asConductor, at, beneathHooks, byMgr, handDecision, ledgerRows, pcall, putFileAt, putLedger, putQ, putRelay, putWindow, readReq, refusal, relayQ, reqFiles, runRequest, said, stop, tier, win, winShort, wireGuard } from './answer-fixtures'

// ---- what an unattended window does (ADR 0008): nothing is put to the person, no tier waits on its own question or prompt, the manager's park, the window's
// mark on the rows, what the lane is told, the lane ceiling, go_request, and the list ----
// Nothing here opens a window through a command: a test seeds one as the open step writes it (putWindow), once the session is set up. The mod under test keeps
// its own memory, new for each test; a test that changes the window after a read lets the reader's 10 s pass (later).
const when = (ms: number) => g.goWhen(ms, -new Date(ms).getTimezoneOffset())
const open = (v?: prm.Unattended) => putWindow(v)
const later = () => (h.nowMs += 11_000)
// The rows of requests: every row but the window's own.
const rows = () => ledgerRows().filter((r) => !String(r.kind).startsWith('unattended-'))
const kinds = () => rows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
const of = (kind: string) => rows().filter((r) => r.kind === kind)
const TID3 = '1a1b2c3d-7777-4000-8000-123456789abc'
const APIREQ = { ...APIQ, leadName: undefined }
const asManager = async ($: any, on: any, opts: { clock?: boolean } = {}) => {
  await mgrAt($, on, [], { clock: opts.clock, sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
}
const escalate = async ($: any, id = TID) => said(await $.tool.call(pcall('prompt_escalate', { id, why: 'a push to main' })))
const list = async ($: any) => said(await $.tool.call(pcall('prompt_list')))
const apiDec = (id = TID) => JSON.parse(pfs.get(`${LDIR(APISID)}/${id}.decision.json`)!.text)

// ---- the relay is refused at every tier ----
test('window: a lead that is the top tier is refused the relay: no relay file, a relay-refused row that names the window, and the request is still its to answer', async ($, on) => {
  await tier($, on)
  putQ()
  const v = open()
  const text = await list($)
  expect(text).toContain('Unattended mode: you are the top tier for this prompt and the person is not asked.')
  expect(text.endsWith(`${prm.RUBRIC}\n\n${prm.UNATTENDED_TIER_LINE}`)).toBe(true)
  expect(await escalate($)).toBe(`prompt_escalate refused: ${refusal('unattended-no-manager')}`)
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(false)
  expect(of('relay-refused')).toEqual([expect.objectContaining({ id: TID, code: 'refused', tier: 'lead', by: SID, u: winShort(v), lane: 'svc-api' })])
  expect(of('relayed')).toEqual([])
  // The request stays open to the tier, and a lead's answer in the window carries its mark, as every tier's does.
  expect(await list($)).toContain(`### ${TID}`)
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  expect(JSON.parse(pfs.get(`${LDIR()}/${TID}.decision.json`)!.text).u).toBe(winShort(v))
  expect(of('answered')[0].u).toBe(winShort(v))
})

test('window: a conductor that is the top tier is refused the relay the same way, and may still answer', async ($, on) => {
  await asConductor($, on)
  putQ(APIREQ)
  const v = open()
  expect(await list($)).toContain('Unattended mode: you are the top tier for this prompt and the person is not asked.')
  expect(await escalate($)).toContain(refusal('unattended-no-manager'))
  expect(pfs.has(`${LDIR(APISID)}/${TID}.relay.json`)).toBe(false)
  expect(of('relay-refused')).toEqual([expect.objectContaining({ id: TID, code: 'refused', tier: 'conductor', by: SID, u: winShort(v) })])
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  expect(apiDec().by.level).toBe('conductor')
})

test('window: the manager is refused the relay and reads its rules after the rubric; its park and its allow carry the window in the file and on the row', async ($, on) => {
  await asManager($, on)
  putQ(APIREQ)
  putQ({ ...APIREQ, id: TID2 })
  const v = open()
  const text = await list($)
  expect(text).toContain('Unattended mode: allow, deny or park it by the rubric and the unattended rules below. Nothing is put to the person.')
  expect(text.endsWith(prm.unattendedBlock(g.GO_NEVER_TEXT, when(v.until)))).toBe(true)
  expect(text).not.toContain('put it to the person with prompt_escalate')
  expect(await escalate($)).toBe(`prompt_escalate refused: ${refusal('unattended')}`)
  expect(pfs.has(`${LDIR(APISID)}/${TID}.relay.json`)).toBe(false)
  expect(of('relay-refused')).toEqual([expect.objectContaining({ id: TID, code: 'refused', tier: 'manager', by: SID, u: winShort(v) })])
  const park = said(await $.tool.call(answerCall({ decision: 'park', why: 'a merge waits for you' })))
  expect(park).toContain(`Recorded: park for ${TID}.`)
  expect(apiDec()).toMatchObject({ decision: 'park', why: 'a merge waits for you', u: winShort(v), by: { level: 'manager', sid: SID, name: 'MANAGER' } })
  expect(prm.parseDecision(pfs.get(`${LDIR(APISID)}/${TID}.decision.json`)!.text)?.decision).toBe('park')
  expect(said(await $.tool.call(answerCall({ id: TID2 })))).toContain('Recorded: allow')
  expect(apiDec(TID2)).toMatchObject({ decision: 'allow', u: winShort(v) })
  expect(of('answered')).toEqual([expect.objectContaining({ id: TID, code: 'park', by: SID, u: winShort(v) }), expect.objectContaining({ id: TID2, code: 'allow', by: SID, u: winShort(v) })])
})

test('window: a lead the person said they are with passes up to the manager as by day: here counts for nothing while the window is held', async ($, on) => {
  await tier($, on)
  addMgrT()
  h.sessions = { ...h.sessions, ...h.extraRows }
  h.store.set(prm.HERE_KEY, { v: 1, sid: SID, at: T0, until: T0 + HOUR_MS })
  putQ()
  expect(await list($)).toContain('The person said they are here: put it to them with prompt_escalate')
  open()
  later()
  expect(await list($)).toContain('The manager MANAGER is above you. Answer it by the rubric, or pass it up with prompt_escalate.')
  expect(await escalate($)).toContain('Passed up')
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(false)
  expect(pfs.has(`${LDIR()}/${TID}.escalate-lead.json`)).toBe(true)
  expect(of('relay-refused')).toEqual([])
})

test('window: a relay written just before the window is seen is taken back by the tier: the file goes, a relay-refused row says so, and no relayed row is written', async ($, on) => {
  await tier($, on)
  putQ()
  // This read finds no window and is kept; the window opens right after it.
  expect(await list($)).toContain('You are the top tier for this prompt')
  const v = putWindow()
  expect(await escalate($)).toContain(refusal('unattended-no-manager'))
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(false)
  expect(of('relay-refused')).toEqual([expect.objectContaining({ id: TID, code: 'taken-back', tier: 'lead', by: SID, u: winShort(v) })])
  expect(of('relayed')).toEqual([])
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
})

test('window: a relay seen by the lane\'s hook is taken back (relay-lost unattended, the file gone) and the request is the tiers\' again', async ($, on) => {
  await answerer($, on, [])
  const v = open()
  const r = await runRequest($, [at(4000, () => putRelay(readReq())), at(4000, () => putFileAt(`${readReq().id}.asked`)), at(12_000, () => { expect(pfs.has(`${PDIR}/${readReq().id}.relay.json`)).toBe(false); handDecision(readReq()) })])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(kinds()).toEqual(['requested', 'relay-lost unattended', 'answered allow', 'returned allow'])
  // Every row the hook wrote for a request raised in the window names it.
  for (const k of ['requested', 'relay-lost', 'returned']) expect(of(k)[0].u).toBe(winShort(v))
  expect(of('relay-lost')[0]).toMatchObject({ tier: 'lead', by: LEADSID })
})

// ---- a tier's own question and its own permission prompt ----
const PLAIN = { header: 'Plan', question: 'Which way?', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }
const ask = ($: any, qs: unknown[], over: Record<string, unknown> = {}) => $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: qs }, ...over } as any)
const QUESTION_DENIED = { decision: { behavior: 'deny', message: prm.TIER_QUESTION_DENY } }
for (const [level, setup] of [
  ['a lead', async ($: any, on: any) => { await tier($, on); putQ() }],
  ['a conductor', async ($: any, on: any) => { await asConductor($, on); putQ(APIREQ) }],
  ['the manager', async ($: any, on: any) => { await asManager($, on); putQ(APIREQ) }],
] as const) {
  test(`window: ${level}'s own AskUserQuestion is denied at once, a relay question included, with nothing marked or held; a subagent's passes beneath, and it is asked as before once the window is off`, async ($, on) => {
    beneathHooks(on)
    await setup($, on)
    const dir = level === 'a lead' ? LDIR() : LDIR(APISID)
    const by = { level: level === 'a lead' ? 'lead' : level === 'a conductor' ? 'conductor' : 'manager', sid: SID, name: 'X' }
    pfs.set(`${dir}/${TID}.relay.json`, { text: JSON.stringify({ id: TID, short: TID.slice(0, 8), by, at: T0, nonce: 'n-1' }), mtimeSec: T0 / 1000 })
    open()
    expect(await ask($, [PLAIN])).toEqual(QUESTION_DENIED)
    // A Relay-headed question with the right options: denied before the options check, the asked mark and the hold.
    expect(await ask($, [relayQ(TID)])).toEqual(QUESTION_DENIED)
    expect([...pfs.keys()].filter((k) => k.endsWith('.asked') || k.includes('/asking/'))).toEqual([])
    // A subagent's question is not the tier's own: it goes to the chain beneath, as always.
    expect((await ask($, [PLAIN], { agent_id: 'a1' })) ?? {}).toEqual({})
    // No ledger row is written for the refusal.
    expect(rows()).toEqual([])
    await $.command.run(lane('unattended off'))
    expect((await ask($, [PLAIN])) ?? {}).toEqual({})
  })
}

test('window: a read of the window that fails still denies a tier\'s question in a process that read the window on', async ($, on) => {
  beneathHooks(on)
  await tier($, on)
  open()
  expect(await ask($, [PLAIN])).toEqual(QUESTION_DENIED)
  h.storeThrowSync = 'get'
  later()
  expect(await ask($, [PLAIN])).toEqual(QUESTION_DENIED)
  h.storeThrowSync = undefined
})

test('window: a read of the window that fails passes a tier\'s question on in a process that never read one on', async ($, on) => {
  beneathHooks(on)
  await tier($, on)
  open()
  h.storeThrowSync = 'get'
  expect((await ask($, [PLAIN])) ?? {}).toEqual({})
  h.storeThrowSync = undefined
})

test('window: a stored value the process cannot judge (the ledger does not answer) holds: a tier\'s question is denied, and no park is taken', async ($, on) => {
  beneathHooks(on)
  await asManager($, on)
  putQ(APIREQ)
  open()
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  expect(await ask($, [PLAIN])).toEqual(QUESTION_DENIED)
  expect(said(await $.tool.call(answerCall({ decision: 'park', why: 'x' })))).toContain(refusal('unattended-unread'))
  expect(await escalate($)).toContain(refusal('unattended'))
  h.pfsFails = undefined
})

// ---- the mod's own dialog in a window ----
// The mod's own dialog ($.ui.ask), should the engine show it through the permission hook, is passed on as it stands while it is open: the window's refusal of a
// tier's own question never closes it. Only the header and question of a dialog open now in this session pass; anything else is the tier's own question.
const holdDialog = () => {
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  return (a: string) => {
    release(a)
    h.askHang = undefined
  }
}
const GO_WORK = 'Build the API: the schema change in api/db.'
// The question the mocked engine was last shown, as the permission hook would see it.
const shownQ = () => ({ ...PLAIN, header: h.lastHeader, question: h.lastQuestion })
// A hook beneath that refuses every question, as a settings hook might: the mod's own dialog never reaches it.
const BENEATH_DENY = { decision: { behavior: 'deny', message: 'a settings hook said no' } }
const goLead = async ($: any, on: any, stdins: string[]) => {
  for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionDenied'] as const) on(ev, () => ({}))
  on('classic.PermissionRequest', () => BENEATH_DENY)
  await leadAt($, on, stdins, { clock: true, sess: { ...leadSelfReg(), ...ckRow() }, seed: () => putStore([ckLane()]) })
  await waitFor(() => h.liveHeadAsked !== undefined)
  wireGuard()
}
// Runs the typed command and waits (real time) until its dialog is up.
const typedGo = async ($: any) => {
  ;(h as any).lastHeader = undefined
  const p = $.command.run(lane(`go ${GO_WORK}`))
  await waitFor(() => h.lastHeader === g.GO_HEADER)
  return { done: p }
}

test('window: a lead\'s go dialog, open, passes the permission hook as it stands with a passed own-dialog line and no row; another header, a second question or a relay question is denied, and so is the same once it closes', async ($, on) => {
  const stdins: string[] = []
  await goLead($, on, stdins)
  open()
  const release = holdDialog()
  const typed = (await typedGo($)).done
  // A subagent's question with the same text is not the dialog: it goes beneath as any subagent's does, with no pass.
  expect(await ask($, [shownQ()], { agent_id: 'a1' })).toEqual(BENEATH_DENY)
  expect(logged(stdins)).not.toContain('passed:own-dialog')
  // The dialog gets no decision here or beneath: only the person answers it.
  expect(await ask($, [shownQ()])).toEqual({})
  expect(logged(stdins)).toContain('passed:own-dialog')
  expect(await ask($, [{ ...shownQ(), header: 'Plan' }])).toEqual(QUESTION_DENIED)
  expect(await ask($, [{ ...shownQ(), question: `${h.lastQuestion} ` }])).toEqual(QUESTION_DENIED)
  expect(await ask($, [shownQ(), PLAIN])).toEqual(QUESTION_DENIED)
  expect(await ask($, [relayQ(TID)])).toEqual(QUESTION_DENIED)
  expect(rows()).toEqual([])
  release(g.GO_NO)
  expect(String((await typed).text)).toContain('No go was given: cancelled')
  expect(await ask($, [shownQ()])).toEqual(QUESTION_DENIED)
})

test('window: the manager\'s own dialog, open when the window is seen, passes the permission hook; once it closes the same question is denied', async ($, on) => {
  const stdins: string[] = []
  beneathHooks(on)
  await mgrAt($, on, stdins, { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }), seed: () => putStore([ckLane({ sid: APISID, leadName: 'LEAD' })]) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
  const release = holdDialog()
  const n = h.askCount
  const typed = $.command.run(lane('unattended on for 3 h'))
  await waitFor(() => h.askCount !== n)
  expect(h.lastHeader).toBe(prm.UNATTENDED_HEADER)
  // Another session's window opens while the dialog is up.
  open()
  later()
  expect(await ask($, [PLAIN])).toEqual(QUESTION_DENIED)
  expect((await ask($, [shownQ()])) ?? {}).toEqual({})
  expect(logged(stdins)).toContain('passed:own-dialog')
  release(prm.UNATTENDED_NO)
  await typed
  expect(await ask($, [shownQ()])).toEqual(QUESTION_DENIED)
})

longTest('window: a dialog still on screen after its time limit still passes; one whose engine call fails passes no more', async ($, on) => {
  await goLead($, on, [])
  open()
  const release = holdDialog()
  const typed = (await typedGo($)).done
  await new Promise((r) => setTimeout(r, 10))
  await h.clock!.advance(g.GO_DIALOG_MS + 1000)
  expect(String((await typed).text)).toContain('No go was given: timed-out')
  expect((await ask($, [shownQ()])) ?? {}).toEqual({})
  release(g.GO_YES)
  await new Promise((r) => setTimeout(r, 10))
  expect(await ask($, [shownQ()])).toEqual(QUESTION_DENIED)
  expect(goFiles()).toEqual([])
  // The engine call throws: the dialog's record goes with it.
  h.askHang = { then: (_: unknown, no: (e: Error) => void) => no(new Error('engine')) } as any
  const failed = await $.command.run(lane(`go ${GO_WORK}`))
  h.askHang = undefined
  expect(String(failed.text)).toContain('No go was given')
  expect(await ask($, [shownQ()])).toEqual(QUESTION_DENIED)
})

const PROMPT_DENIED = { decision: { behavior: 'deny', message: prm.TIER_PROMPT_DENY } }
for (const [level, setup] of [
  ['the manager', asManager],
  ['a conductor', async ($: any, on: any) => asConductor($, on)],
] as const) {
  test(`window: ${level}'s own permission prompt is denied at once, a hook beneath that answers still wins, and it waits for the person as before once the window is off`, async ($, on) => {
    let beneath: unknown = {}
    for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionDenied'] as const) on(ev, () => ({}))
    on('classic.PermissionRequest', () => beneath)
    await setup($, on)
    open()
    const prompt = () => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: PRQ } as any)
    expect(await prompt()).toEqual(PROMPT_DENIED)
    beneath = { decision: { behavior: 'allow' } }
    expect(await prompt()).toEqual({ decision: { behavior: 'allow' } })
    beneath = { decision: { behavior: 'deny', message: 'a settings hook said no' } }
    expect(await prompt()).toEqual({ decision: { behavior: 'deny', message: 'a settings hook said no' } })
    beneath = {}
    // A subagent's ask in the tier's session passes beneath, as always.
    expect((await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: PRQ, agent_id: 'a1' } as any)) ?? {}).toEqual({})
    expect(rows()).toEqual([])
    await $.command.run(lane('unattended off'))
    expect((await prompt()) ?? {}).toEqual({})
  })
}

test('window: the manager\'s own prompt waits for the person once the OFF file is there, before any tick has ended the window', async ($, on) => {
  for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionDenied'] as const) on(ev, () => ({}))
  on('classic.PermissionRequest', () => ({}))
  await asManager($, on)
  open()
  const prompt = () => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: PRQ } as any)
  expect(await prompt()).toEqual(PROMPT_DENIED)
  pfs.set(OFF_FILE, { text: '', mtimeSec: h.nowMs / 1000 })
  expect((await prompt()) ?? {}).toEqual({})
})

test('window: a lead\'s own prompt with no tier above it is denied at once; a lane\'s with no tier in reach stays in its panel', async ($, on) => {
  const stdins: string[] = []
  await answerer($, on, stdins, { asLead: true })
  const v = open()
  expect(await runRequest($, [])).toEqual(PROMPT_DENIED)
  expect(kinds()).toEqual(['abandoned no-tier'])
  expect(rows()[0].u).toBe(winShort(v))
  expect(reqFiles().length).toBe(0)
  expect(logged(stdins)).toContain('refused:unattended-own-prompt')
})

longTest('window: a lane\'s prompt with no tier in reach is not denied: it holds 30 minutes for a tier, then stays in the lane\'s panel, its rows marked', async ($, on) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  const v = open()
  expect(await runRequest($, [])).toEqual({})
  expect(kinds()).toEqual(['no-tier', 'abandoned no-tier'])
  expect(rows().map((r) => r.u)).toEqual([winShort(v), winShort(v)])
})

// ---- park ----
test('window: park is refused from a lead; from the manager it is refused outside a window, while the window cannot be read, on a question and before 30 s', async ($, on) => {
  await asManager($, on)
  putQ(APIREQ)
  const park = async (over: Record<string, unknown> = {}) => said(await $.tool.call(answerCall({ decision: 'park', why: 'a merge waits for you', ...over })))
  expect(await park()).toContain(refusal('park-not-allowed'))
  const v = putWindow()
  // The ledger does not answer: the window is unknown, which permits no park.
  later()
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  expect(await park()).toContain(refusal('unattended-unread'))
  h.pfsFails = undefined
  later()
  putQ({ ...APIREQ, id: TID2, tool: 'AskUserQuestion', input: QIN })
  expect(await park({ id: TID2 })).toContain(refusal('question-answer-only'))
  putQ({ ...APIREQ, id: TID3, at: h.nowMs })
  expect(await park({ id: TID3 })).toContain(refusal('window'))
  expect([...pfs.keys()].filter((k) => k.endsWith('.decision.json'))).toEqual([])
  expect(await park()).toContain('Recorded: park')
  expect(apiDec().u).toBe(winShort(v))
})

test('window: a lead may not park', async ($, on) => {
  await tier($, on)
  putQ()
  open()
  expect(said(await $.tool.call(answerCall({ decision: 'park', why: 'x' })))).toContain(refusal('park-not-allowed'))
  expect(said(await $.tool.call(answerCall({ decision: 'hold', why: 'x' })))).toContain(refusal('bad-input'))
  expect(pfs.has(`${LDIR()}/${TID}.decision.json`)).toBe(false)
})

// The lane's side: this session is the lane, the manager (MGRT) its only tier, and a decision file is made by hand.
const laneUnderManager = async ($: any, on: any) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  addMgrT()
}
const WHY = 'w'.repeat(prm.WHY_MAX)
test('window: the manager\'s park lands as a deny with the park text, whole after a 200-character why, and a returned row with code park and the window', async ($, on) => {
  await laneUnderManager($, on)
  const v = open()
  const u = winShort(v)
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'park', why: WHY, by: byMgr, u }, { by: MGRT, u }))])
  expect(r).toEqual({ decision: { behavior: 'deny', message: `${prm.capBytes(`Parked by the manager MANAGER for the person: ${WHY}`, 300).text}${prm.UNATTENDED_PARK_TAIL}` } })
  expect(r.decision.message.startsWith('Parked by the manager MANAGER for the person: www')).toBe(true)
  expect(kinds()).toEqual(['requested', 'answered park', 'returned park'])
  expect(of('returned')[0]).toMatchObject({ code: 'park', tier: 'manager', by: MGRT, u })
  expect(of('requested')[0].u).toBe(u)
})

test('window: a deny the manager made in the window ends with the unattended text; the cleaner-command deny keeps its own, and a deny with no window mark has none', async ($, on) => {
  await laneUnderManager($, on)
  const u = winShort(open())
  const deny = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why: WHY, by: byMgr, u }, { by: MGRT, u }))])
  expect(deny.decision.message).toBe(`${prm.capBytes(`Denied by the manager MANAGER: ${WHY}`, 300).text}${prm.UNATTENDED_DENY_TAIL}`)
  expect(of('returned')[0]).toMatchObject({ code: 'deny', u })
  const unclear = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why: `${prm.UNCLEAR_PREFIX}a script built at run time`, by: byMgr, u }, { by: MGRT, u }))], { tool_use_id: 'tu2' }, { tool_use_id: 'tu2' })
  expect(unclear.decision.message).toBe(`Denied by the manager MANAGER: ${prm.UNCLEAR_PREFIX}a script built at run time${prm.UNCLEAR_SUFFIX}`)
  const plain = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why: 'no', by: byMgr }, { by: MGRT }))], { tool_use_id: 'tu3' }, { tool_use_id: 'tu3' })
  expect(plain.decision.message).toBe('Denied by the manager MANAGER: no')
})

test('window: a lead\'s deny in the window carries the mark and ends with the unattended text', async ($, on) => {
  await answerer($, on, [])
  const u = winShort(open())
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why: 'no', u }, { u }))])
  expect(r).toEqual({ decision: { behavior: 'deny', message: `Denied by the lead LEAD: no${prm.UNATTENDED_DENY_TAIL}` } })
  expect(of('returned')[0]).toMatchObject({ code: 'deny', u })
})

for (const [name, decide, drop] of [
  ['by a tier that is not the manager', (req: any, u: string) => handDecision(req, { decision: 'park', why: 'x', u }, { u }), 'dropped kind'],
  ['that names another window', (req: any) => handDecision(req, { decision: 'park', why: 'x', by: byMgr, u: 'bbbbbbbb' }, { by: MGRT, u: 'bbbbbbbb' }), 'dropped unattended-closed'],
  ['whose row does not carry its window', (req: any, u: string) => handDecision(req, { decision: 'park', why: 'x', by: byMgr, u }, { by: MGRT }), 'dropped no-answered-row'],
  ['with no window named', (req: any) => handDecision(req, { decision: 'park', why: 'x', by: byMgr }, { by: MGRT }), 'dropped kind'],
] as const) {
  test(`window: a park file ${name} is dropped by the hook, and the prompt stays open`, async ($, on) => {
    await answerer($, on, [])
    addMgrT()
    const u = winShort(open())
    const r = await runRequest($, [at(4000, () => decide(readReq(), u)), stop(60_000)])
    expect(r).toEqual({})
    expect(kinds()).toEqual(['requested', 'answered park', drop, 'off'])
  })
}

test('window: a decision of a kind the hook does not know is dropped as a bad shape', async ($, on) => {
  await laneUnderManager($, on)
  const u = winShort(open())
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'provisional', why: 'x', by: byMgr, u }, { by: MGRT, u })), stop(40_000)])
  expect(r).toEqual({})
  expect(kinds()).toEqual(['requested', 'answered provisional', 'dropped shape', 'off'])
})

test('window: a park whose window cannot be read at apply is held, not dropped, and lands once the window reads on again', async ($, on) => {
  await laneUnderManager($, on)
  const v = open()
  const u = winShort(v)
  const decision = () => `${PDIR}/${readReq().id}.decision.json`
  const r = await runRequest($, [
    // Another value with no row yet: the read gives no answer for its first minute.
    at(4000, () => { handDecision(readReq(), { decision: 'park', why: 'a merge waits', by: byMgr, u }, { by: MGRT, u }); h.store.set(UNATTENDED_KEY, win({ savedAt: h.nowMs, until: v.until + 1000 })) }),
    at(44_000, () => { expect(pfs.has(decision())).toBe(true); expect(kinds().some((k) => k.startsWith('dropped'))).toBe(false); h.store.set(UNATTENDED_KEY, v) }),
  ])
  expect(r.decision.message).toBe(`Parked by the manager MANAGER for the person: a merge waits${prm.UNATTENDED_PARK_TAIL}`)
  expect(kinds()).toEqual(['requested', 'answered park', 'returned park'])
})

test('window: a park is dropped once its window has ended, and the prompt is the person\'s again', async ($, on) => {
  await laneUnderManager($, on)
  const u = winShort(open())
  const r = await runRequest($, [at(4000, async () => { handDecision(readReq(), { decision: 'park', why: 'x', by: byMgr, u }, { by: MGRT, u }); await $.command.run(lane('unattended off')) }), stop(60_000)])
  expect(r).toEqual({})
  expect(kinds()).toEqual(['requested', 'answered park', 'dropped unattended-closed', 'off'])
})

// ---- the 20-minute hold ----
longTest('window: a prompt nobody answers is held for the person at 20 minutes: the hold text, and an expired-denied row with code held and the window', async ($, on) => {
  await answerer($, on, [])
  const v = open()
  const r = await runRequest($, [])
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_HOLD_MESSAGE } })
  expect(kinds()).toEqual(['requested', 'expired-denied held'])
  expect(of('expired-denied')[0].u).toBe(winShort(v))
})

longTest('window: a relay the person had on screen before the window opened is taken back, and the prompt is still held at 20 minutes', async ($, on) => {
  await answerer($, on, [])
  let v: prm.Unattended | undefined
  const r = await runRequest($, [
    at(4000, () => putRelay(readReq())),
    at(4000, () => putFileAt(`${readReq().id}.asked`)),
    at(12_000, () => { v = putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 8 * HOUR_MS })) }),
  ])
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_HOLD_MESSAGE } })
  expect(kinds()).toEqual(['requested', 'relay-lost unattended', 'expired-denied held'])
  expect(of('expired-denied')[0].u).toBe(winShort(v!))
})

longTest('window: a relay 25 minutes old taken back for a window ends in the hold, not in the 21-minute expiry', async ($, on) => {
  await answerer($, on, [])
  let v: prm.Unattended | undefined
  const r = await runRequest($, [
    at(4000, () => putRelay(readReq())),
    at(4000, () => putFileAt(`${readReq().id}.asked`)),
    at(25 * 60_000, () => { v = putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 8 * HOUR_MS })) }),
  ])
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_HOLD_MESSAGE } })
  expect(kinds()).toEqual(['requested', 'relay-lost unattended', 'expired-denied held'])
  expect(of('expired-denied')[0].u).toBe(winShort(v!))
})

longTest('window: a relay the person saw that was lost, then a second relay taken back for a window, still ends in the hold', async ($, on) => {
  await answerer($, on, [])
  let v: prm.Unattended | undefined
  const r = await runRequest($, [
    at(4000, () => putRelay(readReq())),
    at(4000, () => putFileAt(`${readReq().id}.asked`)),
    at(20_000, () => putFileAt(`${readReq().id}.relay.json`, 'not a relay')),
    at(40_000, () => putRelay(readReq())),
    at(60_000, () => { v = putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 8 * HOUR_MS })) }),
  ])
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_HOLD_MESSAGE } })
  expect(kinds()).toEqual(['requested', 'relay-lost bad-file', 'relay-lost unattended', 'expired-denied held'])
  expect(of('expired-denied')[0].u).toBe(winShort(v!))
})

longTest('window: a relay taken back, then the window ends and a new relay the person saw is lost: the wait ends at the 21-minute expiry', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [
    at(4000, () => putRelay(readReq())),
    at(20_000, () => { putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 8 * HOUR_MS })) }),
    at(40_000, async () => { await $.command.run(lane('unattended off')) }),
    at(60_000, () => putRelay(readReq())),
    at(60_000, () => putFileAt(`${readReq().id}.asked`)),
    at(80_000, () => putFileAt(`${readReq().id}.relay.json`, 'not a relay')),
  ])
  expect(r).toEqual({})
  expect(kinds()).toEqual(['requested', 'relay-lost unattended', 'relay-lost bad-file', 'abandoned expired'])
})

longTest('window: a prompt raised before the window and still unanswered at 20 minutes inside it is held too; one whose window ended meanwhile gets the usual text', async ($, on) => {
  await answerer($, on, [])
  let v: prm.Unattended | undefined
  const r = await runRequest($, [at(60_000, () => { v = putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 8 * HOUR_MS })) })])
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_HOLD_MESSAGE } })
  expect(of('requested')[0].u).toBeUndefined()
  expect(of('expired-denied')[0]).toMatchObject({ code: 'held', u: winShort(v!) })
  const off = await runRequest($, [at(22 * 60_000, async () => { await $.command.run(lane('unattended off')) })], { tool_use_id: 'tu2' }, { tool_use_id: 'tu2' })
  expect(off).toEqual({ decision: { behavior: 'deny', message: prm.DENY_TIMEOUT_MESSAGE } })
  expect(kinds().at(-1)).toBe('expired-denied timeout')
})

// ---- the told marks ----
const notices = () => submitted.filter((t) => t === prm.PROMPT_NOTICE_TEXT).length
test('window: a tier that was refused the relay is told of the request again once the window has ended, and can then put it to the person', async ($, on) => {
  await tier($, on, [], { clock: true })
  putQ()
  open()
  await h.clock!.advance(2000)
  expect(notices()).toBe(1)
  expect(await escalate($)).toContain(refusal('unattended-no-manager'))
  await tickTwice()
  expect(notices()).toBe(1)
  await $.command.run(lane('unattended off', { kind: 'peer' }))
  await tickTwice()
  expect(notices()).toBe(2)
  expect(await escalate($)).toContain(`header exactly "Relay ${TID.slice(0, 8)}"`)
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(true)
})

// ---- go_request and the lane ceiling ----
const goCall = ($: any) => $.tool.call({ tool: 'mcp__callboard__go_request', text: 'Build the API: the schema change in api/db.' } as any)
const goFiles = () => [...pfs.keys()].filter((k) => k.startsWith(`${GO_DIR}/`) && k.endsWith('.json'))
test('window: go_request is refused with no dialog, and works again once the window is off', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...ckRow() }, seed: () => putStore([ckLane()]) })
  await waitFor(() => h.liveHeadAsked !== undefined)
  wireGuard()
  h.askAnswer = g.GO_YES as any
  open()
  const asked = h.askCount
  expect(String((await goCall($)).deny)).toBe(`go_request refused: unattended: ${g.GO_REFUSE.unattended}`)
  expect(h.askCount).toBe(asked)
  expect(goFiles()).toEqual([])
  await $.command.run(lane('unattended off'))
  expect(String((await goCall($)).result)).toContain('go')
  expect(h.askCount).toBe(asked + 1)
  expect(goFiles().length).toBe(1)
})

test('window: /callboard go typed by the person, at the prompt or from the phone, opens the dialog and a click gives the go; from a plugin it is refused with no dialog', async ($, on) => {
  await goLead($, on, [])
  h.askAnswer = g.GO_YES as any
  open()
  expect(String((await goCall($)).deny)).toContain('The person can type /callboard go in this session themselves, without ending the mode.')
  for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }]) {
    const asked = h.askCount
    expect(String((await $.command.run(lane(`go ${GO_WORK}`, origin))).text)).not.toContain('No go was given')
    expect(h.askCount).toBe(asked + 1)
    expect(h.lastHeader).toBe(g.GO_HEADER)
  }
  expect(goFiles().length).toBe(2)
  expect(ledgerRows().filter((r) => r.kind === 'go-grant').length).toBe(2)
  expect(String((await $.tool.call({ tool: 'mcp__callboard__go_status' } as any)).result)).toContain(`\n${GO_WORK}\n>>>`)
  const asked = h.askCount
  expect(String((await $.command.run(lane(`go ${GO_WORK}`, { kind: 'plugin', name: 'x' }))).text)).toBe(g.GO_NOT_PERSON)
  expect(h.askCount).toBe(asked)
  expect(goFiles().length).toBe(2)
})

const LIVE = ['L1', 'L2', 'L3', 'L4']
const liveSid = (n: number) => `${n}c1b2c3d-0000-4000-8000-123456789abc`
const liveRows = (names: string[]) => Object.assign({}, ...names.map((name, n) => cueSession(liveSid(n + 1), name, `${PIN}/api`, { pid: 4601 + n })))
const ceilingLead = async ($: any, on: any, names = LIVE) => {
  const lanes = [...LIVE.map((name, n) => ckLane({ name, sid: liveSid(n + 1) })), ckLane({ name: 'L5', sid: undefined }), ckLane({ name: 'L6', sid: liveSid(6), parked: T0 - 60_000 })]
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...liveRows(names) }, seed: () => putStore(lanes) })
}
// The window answers once the open request has been written.
const opening = async ($: any) => {
  h.openResultPath = `${ROOT}/open/L5.result`
  const p = $.tool.call(leadCall('open', { lane: 'L5' }))
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  return JSON.stringify(await drive(p))
}
longTest('window: with four lanes live a lead\'s fifth is refused, by lane_open and by lane_unpark, and opens once the window is off', async ($, on) => {
  await ceilingLead($, on)
  open()
  expect(UNATTENDED_LIVE_LANES).toBe(4)
  const full = `refused: unattended-lanes: ${REASON_TEXT['unattended-lanes']}`
  expect(JSON.stringify(await drive($.tool.call(leadCall('open', { lane: 'L5' }))))).toContain(`lane_open ${full}`)
  expect(JSON.stringify(await drive($.tool.call(leadCall('unpark', { lane: 'L6' }))))).toContain(`lane_unpark ${full}`)
  await $.command.run(lane('unattended off'))
  expect(await opening($)).toContain(`session ${NEWSID}`)
})

longTest('window: with three lanes live the fourth still opens', async ($, on) => {
  await ceilingLead($, on, LIVE.slice(0, 3))
  open()
  expect(await opening($)).toContain(`session ${NEWSID}`)
})

longTest('window: with three lanes live, a session opened and not yet renamed counts, so a second open in a row is refused', async ($, on) => {
  await ceilingLead($, on, LIVE.slice(0, 3))
  open()
  expect(await opening($)).toContain(`session ${NEWSID}`)
  // The opened panel is live with no lane's name yet.
  Object.assign(h.sessions, cueSession(NEWSID, undefined, `${PIN}/api`, { pid: 4700 }))
  expect(JSON.stringify(await drive($.tool.call(leadCall('open', { lane: 'L4' }))))).toContain(`lane_open refused: unattended-lanes: ${REASON_TEXT['unattended-lanes']}`)
})

longTest('window: with three lanes live, a panel just opened counts before its session is in the registry, so a second open is refused', async ($, on) => {
  await ceilingLead($, on, LIVE.slice(0, 3))
  open()
  expect(await opening($)).toContain(`session ${NEWSID}`)
  expect(JSON.stringify(await drive($.tool.call(leadCall('open', { lane: 'L4' }))))).toContain(`lane_open refused: unattended-lanes: ${REASON_TEXT['unattended-lanes']}`)
})

longTest('window: with three lanes live, an open still under way counts, so an open beside it is refused', async ($, on) => {
  await ceilingLead($, on, LIVE.slice(0, 3))
  open()
  h.openResultPath = `${ROOT}/open/L5.result`
  const first = $.tool.call(leadCall('open', { lane: 'L5' }))
  await h.clock!.advance(500)
  expect(JSON.stringify(await drive($.tool.call(leadCall('open', { lane: 'L4' }))))).toContain(`lane_open refused: unattended-lanes: ${REASON_TEXT['unattended-lanes']}`)
  h.openResult = `ok ${NEWSID}\n`
  expect(JSON.stringify(await drive(first))).toContain(`session ${NEWSID}`)
})

longTest('window: with four lanes live, lane_rename that would bind a fifth is refused; it is not refused with three', async ($, on) => {
  await ceilingLead($, on)
  open()
  Object.assign(h.sessions, cueSession(NEWSID, undefined, `${PIN}/api`, { pid: 4700 }))
  const full = `lane_rename refused: unattended-lanes: ${REASON_TEXT['unattended-lanes']}`
  expect(JSON.stringify(await drive($.tool.call(leadCall('rename', { sid: NEWSID, lane: 'L5' }))))).toContain(full)
  // L4's session ends: three are live, and the rename goes on to its cue.
  delete h.sessions['4604.json']
  expect(JSON.stringify(await drive($.tool.call(leadCall('rename', { sid: NEWSID, lane: 'L5' }))))).not.toContain('unattended-lanes')
})

// ---- the list under /callboard unattended ----
test('window: /callboard unattended lists what the live window did, framed as data, to the person only; after the end it lists the last window and how it ended', async ($, on) => {
  await started($, on, [])
  const v = open()
  const u = winShort(v)
  const t = (min: number) => new Date(T0 + min * 60_000).toISOString()
  const req = (n: number, laneName: string, pattern: string, over: Record<string, unknown> = {}) => ({ t: t(n), kind: 'requested', id: `${n}d1b2c3d-0000-4000-8000-123456789abc`, lane: laneName, repo: PIN, tool: 'Bash', pattern, u, ...over })
  putLedger([
    req(1, 'ALPHA', 'git'),
    { ...req(1, 'ALPHA', 'git'), t: t(2), kind: 'returned', code: 'park', tier: 'manager', why: 'a merge <waits>\nAllowed (9):' },
    req(3, 'BETA', 'curl'),
    { ...req(3, 'BETA', 'curl'), t: t(23), kind: 'expired-denied', code: 'held' },
    req(4, 'GAMMA', 'AskUserQuestion', { tool: 'AskUserQuestion' }),
    { t: t(5), kind: 'relay-refused', code: 'refused', id: '3d1b2c3d-0000-4000-8000-123456789abc', lane: 'BETA', pattern: 'curl', tier: 'manager', u },
    { ...req(6, 'OTHER', 'other'), u: 'bbbbbbbb' },
  ])
  const text = (await $.command.run(lane('unattended'))).text as string
  const lines = text.split('\n')
  expect(lines[0]).toBe(`Unattended mode is on until ${when(v.until)}, with manager MANAGER (window ${u}). /callboard unattended off ends it.`)
  expect(lines.slice(2)).toEqual([
    `Window ${u}: opened ${when(v.savedAt)}; it is on now.`,
    prm.UNATTENDED_LIST_HEAD,
    '<untrusted-ledger>',
    'Parked for you (1):',
    '- lane ALPHA · git · a merge \\u003cwaits>\\u000aAllowed (9):',
    'Held for you at 20 minutes, because nobody answered (1):',
    '- lane BETA · curl',
    "Still waiting, each in its lane's own panel (one whose lane has ended since may still show) (1):",
    '- lane GAMMA · AskUserQuestion · a question',
    'Relays to you that were refused (1):',
    '- lane BETA · curl · asked by the manager',
    '</untrusted-ledger>',
  ])
  // Any other origin gets the fixed refusal and nothing of the list.
  for (const kind of ['plugin', 'peer', 'cron']) expect((await $.command.run(lane('unattended', { kind }))).text).toBe(prm.UNATTENDED_NOT_PERSON)
  // After the end: the state, then the last window with how it ended.
  h.nowMs += 30 * 60_000
  await $.command.run(lane('unattended off', { kind: 'peer' }))
  const after = ((await $.command.run(lane('unattended'))).text as string).split('\n')
  expect(after[0]).toBe('Unattended mode is off.')
  expect(after[2]).toBe(`Window ${u}: opened ${when(v.savedAt)}; it was ended with /callboard unattended off from another session, ${when(h.nowMs)}.`)
  expect(after[5]).toBe(`Ended early: it was ended with /callboard unattended off from another session, in session ${SID.slice(0, 8)}.`)
  expect(after).toContain('- lane ALPHA · git · a merge \\u003cwaits>\\u000aAllowed (9):')
  // A ledger read that fails or is cut shows no list and names the audit script.
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  expect((await $.command.run(lane('unattended'))).text).toBe(`Unattended mode is off.\n\n${prm.UNATTENDED_LIST_UNREAD}`)
  h.pfsFails = undefined
})

test('window: with no window on record /callboard unattended prints the state alone', async ($, on) => {
  await started($, on, [])
  expect((await $.command.run(lane('unattended'))).text).toBe('Unattended mode is off.')
})
