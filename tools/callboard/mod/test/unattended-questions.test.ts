import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { h, SID, T0, longTest, pfs } from './harness'
import { APISID, MGR_SESS, lane, logged, mgrAt, ownedBy, putCond } from './fixtures'
import { APIQ, CNDT, LDIR, MGRT, QASK, QIN, QTEXT, TID, addCondT, addMgrT, answerCall, answerer, askCheck, at, byCond, byMgr, callOf, handDecision, ledgerRows, pcall, putQ, putWindow, readReq, refusal, reqFiles, runRequest, said, stop, win, winShort } from './answer-fixtures'

// ---- a lead's own question while an unattended window is held (ADR 0008): it rises to the manager alone, which answers it, answers it provisionally or
// leaves it for the person; what cannot rise is refused, since nobody is there. A window is seeded as the open step writes it (putWindow). ----
const rows = () => ledgerRows().filter((r) => !String(r.kind).startsWith('unattended-'))
const kinds = () => rows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
const of = (kind: string) => rows().filter((r) => r.kind === kind)
const later = () => (h.nowMs += 11_000)
const QCALL = callOf('AskUserQuestion', QIN)
const QUESTION_DENIED = { decision: { behavior: 'deny', message: prm.TIER_QUESTION_DENY } }
const ans = (o: Record<string, unknown> = {}) => ({ decision: 'answer', answer: { index: 1, label: '8080' }, why: 'settled by the brief', by: byMgr, ...o })
const answeredBy = (who: string) => ({ decision: { behavior: 'allow', updatedInput: { ...QIN, answers: { [QTEXT]: `8080 (answered by ${who})` } } } })
// The lead's side: this session is the lead, with a live conductor that owns it and, unless `mgr` is false, a live manager; the switch covers questions, and
// leadAsks is set only when asked for.
const leadInWindow = async ($: any, on: any, stdins: string[] = [], o: { mgr?: boolean; leadAsks?: boolean } = {}) => {
  await answerer($, on, stdins, { verdict: QASK, asksScope: 'all', asLead: true, leadAsks: o.leadAsks === true })
  addCondT('CONDX', ['/data/x/work'], { own: false })
  putCond(['/data/x/work'])
  ownedBy(CNDT, { repo: '/data/x/work', leadSid: SID })
  if (o.mgr !== false) addMgrT()
}

test('window: a lead\'s own question with leadAsks unset rises to the manager alone; a conductor\'s answer is dropped and the manager\'s lands with its name', async ($, on) => {
  await leadInWindow($, on)
  const u = winShort(putWindow())
  let req: any
  const r = await runRequest($, [
    at(4000, () => { req = readReq(); handDecision(req, ans({ by: byCond, u }), { by: CNDT, u }) }),
    at(8000, () => handDecision(readReq(), ans({ u }), { by: MGRT, u })),
  ], QCALL.over, QCALL.check)
  expect(req).toMatchObject({ level: 'lead', tool: 'AskUserQuestion', u })
  expect(r).toEqual(answeredBy('manager MANAGER'))
  expect(kinds()).toEqual(['requested', 'answered answer', 'dropped by-sid', 'answered answer', 'returned answer'])
  expect(of('requested')[0]).toMatchObject({ tier: 'manager', u })
  expect(of('returned')[0]).toMatchObject({ tier: 'manager', by: MGRT, u })
})

test('window: the manager\'s answer to a lead\'s question that names no window is dropped as the person\'s', async ($, on) => {
  await leadInWindow($, on)
  putWindow()
  // The OFF file then ends the wait; the window is still held, so the question is refused rather than left waiting for the person.
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), ans(), { by: MGRT })), stop(20_000)], QCALL.over, QCALL.check)
  expect(r).toEqual(QUESTION_DENIED)
  expect(kinds()).toEqual(['requested', 'answered answer', 'dropped relay', 'off'])
})

for (const [name, mode, want] of [
  ['lands with the provisional text when the lead\'s request records the default mode', 'default', 'returned answer'],
  ['is dropped when the lead\'s request records another mode', 'auto', 'dropped kind'],
] as const) {
  test(`window: the manager's provisional answer to a lead's question ${name}`, async ($, on) => {
    await leadInWindow($, on)
    const u = winShort(putWindow())
    const r = await runRequest($, [at(4000, () => handDecision(readReq(), ans({ u, provisional: true }), { by: MGRT, u, prov: 'yes' })), stop(20_000)], { ...QCALL.over, permission_mode: mode }, QCALL.check)
    expect(kinds()).toContain(want)
    if (mode === 'default') expect(r.decision.updatedInput.answers[QTEXT]).toBe(`8080 (answered by manager MANAGER${prm.PROVISIONAL_TAIL})`)
    else expect(r).toEqual(QUESTION_DENIED)
  })
}

test('window: the manager\'s park closes a lead\'s question with the park text and the question tail, and its returned row names the window', async ($, on) => {
  await leadInWindow($, on)
  const u = winShort(putWindow())
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'park', why: 'which port to open: a design choice', by: byMgr, u }, { by: MGRT, u }))], QCALL.over, QCALL.check)
  expect(r).toEqual({ decision: { behavior: 'deny', message: `Parked by the manager MANAGER for the person: which port to open: a design choice${prm.UNATTENDED_QUESTION_PARK_TAIL}` } })
  expect(kinds()).toEqual(['requested', 'answered park', 'returned park'])
  expect(of('returned')[0]).toMatchObject({ tool: 'AskUserQuestion', u })
})

test('window: a park given as the window ends, with leadAsks unset, ends the wait off and leaves the card with the person', async ($, on) => {
  await leadInWindow($, on)
  const u = winShort(putWindow())
  const r = await runRequest($, [at(4000, async () => { handDecision(readReq(), { decision: 'park', why: 'x', by: byMgr, u }, { by: MGRT, u }); await $.command.run(lane('unattended off')) })], QCALL.over, QCALL.check)
  expect(r).toEqual({})
  expect(kinds()).toEqual(['requested', 'answered park', 'off'])
})

test('window: with leadAsks set, a plain answer the manager made in a window that has since ended is dropped as the person\'s, and the question waits on', async ($, on) => {
  await leadInWindow($, on, [], { leadAsks: true })
  const u = winShort(putWindow())
  const r = await runRequest($, [at(4000, async () => { handDecision(readReq(), ans({ u }), { by: MGRT, u }); await $.command.run(lane('unattended off')) }), stop(40_000)], QCALL.over, QCALL.check)
  expect(r).toEqual({})
  expect(kinds()).toEqual(['requested', 'answered answer', 'dropped relay', 'off'])
})

longTest('window: a lead\'s question nobody decides is closed at 20 minutes with the hold text and an expired-denied held row', async ($, on) => {
  await leadInWindow($, on)
  const v = putWindow()
  const r = await runRequest($, [], QCALL.over, QCALL.check)
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_QUESTION_HOLD_MESSAGE } })
  expect(kinds()).toEqual(['requested', 'expired-denied held'])
  expect(of('expired-denied')[0].u).toBe(winShort(v))
})

longTest('window: a lead\'s question raised by day and still open when a window opens is the manager\'s, and is held at 20 minutes', async ($, on) => {
  await leadInWindow($, on, [], { leadAsks: true })
  let v: prm.Unattended | undefined
  const r = await runRequest($, [at(60_000, () => { v = putWindow(win({ from: h.nowMs, savedAt: h.nowMs, until: h.nowMs + 8 * 3_600_000 })) })], QCALL.over, QCALL.check)
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.UNATTENDED_QUESTION_HOLD_MESSAGE } })
  expect(of('requested')[0]).toMatchObject({ tier: 'conductor' })
  expect(of('requested')[0].u).toBeUndefined()
  expect(of('expired-denied')[0]).toMatchObject({ code: 'held', u: winShort(v!) })
})

longTest('window: a lane\'s question nobody answers is not held: it stays open in the lane\'s panel past 21 minutes', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  addMgrT()
  putWindow()
  expect(await runRequest($, [], QCALL.over, QCALL.check)).toEqual({})
  expect(kinds()).toEqual(['requested', 'abandoned expired'])
})

test('window: a lead\'s same question asked twice rises twice, each with its own entry, and each takes the manager\'s answer', async ($, on) => {
  await leadInWindow($, on)
  const u = winShort(putWindow())
  const act = () => at(4000, () => handDecision(readReq(), ans({ u }), { by: MGRT, u }))
  expect(await runRequest($, [act()], QCALL.over, QCALL.check)).toEqual(answeredBy('manager MANAGER'))
  for (const k of [...pfs.keys()].filter((k) => k.startsWith(LDIR(SID)))) pfs.delete(k)
  expect(await runRequest($, [act()], { ...QCALL.over, tool_use_id: 'tu2' }, { ...QCALL.check, tool_use_id: 'tu2' })).toEqual(answeredBy('manager MANAGER'))
  expect(of('returned').length).toBe(2)
})

// ---- what is refused at once ----
const PERSON_Q = { questions: [{ ...QIN.questions[0], header: 'Person' }] }
const MULTI_Q = { questions: [{ ...QIN.questions[0], multiSelect: true }] }
for (const [name, setup, want] of [
  ['with no manager live', async ($: any, on: any, s: string[]) => { await leadInWindow($, on, s, { mgr: false }); return QCALL }, ['abandoned no-tier']],
  ['headed Person', async ($: any, on: any, s: string[]) => { await leadInWindow($, on, s); return callOf('AskUserQuestion', PERSON_Q) }, ['not-judgeable question-person']],
  ['that is multi-select', async ($: any, on: any, s: string[]) => { await leadInWindow($, on, s); return callOf('AskUserQuestion', MULTI_Q) }, ['not-judgeable question-multi']],
] as const) {
  test(`window: a lead's question ${name} is refused at once with the tier question text, its row first, and no request`, async ($, on) => {
    const stdins: string[] = []
    const call = await setup($, on, stdins)
    putWindow()
    expect(await runRequest($, [], call.over, call.check)).toEqual(QUESTION_DENIED)
    expect(kinds()).toEqual(want)
    expect(reqFiles().length).toBe(0)
    expect(logged(stdins)).toContain('refused:unattended-question')
  })
}

test('window: a lead\'s question with no tool.check entry, or one a host approves, is refused at once; the same by day stays the person\'s', async ($, on) => {
  await leadInWindow($, on)
  putWindow()
  expect(await $.classic.PermissionRequest(QCALL.over as any)).toEqual(QUESTION_DENIED)
  expect(kinds()).toEqual(['not-judgeable no-check'])
  await askCheck($, { ...QCALL.check, tool_use_id: 'tu2', approver: 'host' })
  expect(await $.classic.PermissionRequest({ ...QCALL.over, tool_use_id: 'tu2' } as any)).toEqual(QUESTION_DENIED)
  expect(reqFiles().length).toBe(0)
  await $.command.run(lane('unattended off'))
  expect((await $.classic.PermissionRequest(QCALL.over as any)) ?? {}).toEqual({})
})

// ---- the manager's side ----
const asManager = async ($: any, on: any) => {
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
}
const LEADQ = (over: Record<string, unknown> = {}) => ({ ...APIQ, leadName: undefined, level: 'lead', tool: 'AskUserQuestion', input: QIN, mode: 'auto', ...over })
const list = async ($: any) => said(await $.tool.call(pcall('prompt_list')))
const call = async ($: any, over: Record<string, unknown>) => said(await $.tool.call(answerCall({ decision: 'answer', option: 2, why: 'settled by the brief', ...over })))
const dec = () => JSON.parse(pfs.get(`${LDIR(APISID)}/${TID}.decision.json`)!.text)

test('window: the manager lists a lead\'s own question with its own line, and may answer it; the file and the row name the window', async ($, on) => {
  await asManager($, on)
  putQ(LEADQ())
  // By day a lead's question is the person's: relay-only.
  expect(await call($, {})).toContain(refusal('relay-only'))
  const v = putWindow()
  later()
  const text = await list($)
  expect(text).toContain("Unattended mode: a lead's own question, and you are its only tier.")
  expect(text).toContain('Its lead is not recorded in the default permission mode, so it takes no provisional answer.')
  expect(await call($, { provisional: true })).toContain(refusal('provisional-mode'))
  expect(await call($, {})).toContain(`Recorded: answer 2 for ${TID}.`)
  expect(dec()).toMatchObject({ decision: 'answer', answer: { index: 1, label: '8080' }, u: winShort(v), by: { level: 'manager', sid: SID } })
  expect(ledgerRows().find((r) => r.kind === 'answered')).toMatchObject({ code: 'answer', u: winShort(v) })
})

test('window: the manager may park a lead\'s question, and give a provisional answer to one in default mode; a lane\'s question takes no park', async ($, on) => {
  await asManager($, on)
  const v = putWindow()
  putQ(LEADQ({ mode: 'default' }))
  expect(said(await $.tool.call(answerCall({ decision: 'park', why: 'which port: a design choice' })))).toContain(`Recorded: park for ${TID}. It closes the question`)
  expect(dec()).toMatchObject({ decision: 'park', u: winShort(v) })
  pfs.delete(`${LDIR(APISID)}/${TID}.decision.json`)
  expect(await call($, { provisional: true })).toContain(`Recorded: provisional answer 2 for ${TID}.`)
  pfs.delete(`${LDIR(APISID)}/${TID}.decision.json`)
  putQ({ ...LEADQ(), level: 'lane', lane: 'API' })
  expect(said(await $.tool.call(answerCall({ decision: 'park', why: 'x' })))).toContain(refusal('question-answer-only'))
})

test('window: the manager\'s decision on a lead\'s question is refused while the window cannot be read', async ($, on) => {
  await asManager($, on)
  putQ(LEADQ())
  putWindow()
  later()
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  expect(await call($, {})).toContain(refusal('unattended-unread'))
  h.pfsFails = undefined
})
