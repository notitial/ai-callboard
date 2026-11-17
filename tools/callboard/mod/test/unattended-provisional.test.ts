import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { h, SID, T0, leadFiles, longTest, pfs, toasts } from './harness'
import { APISID, LEADPATH, MGR_SESS, PIN, SVC, lane, mgrAt } from './fixtures'
import { UNATTENDED_KEY } from '../hooks/engine/answer-hook'
import { APIQ, LDIR, MGRT, PDIR, QASK, QIN, QTEXT, TID, TID2, addMgrT, answerCall, answerer, at, byMgr, callOf, handDecision, ledgerRows, pcall, putLedger, putQ, putWindow, readReq, refusal, runRequest, said, stop, tier, win, winShort } from './answer-fixtures'

// ---- provisional answers and repeats inside an unattended window (ADR 0008) ----
// A window is seeded as the open step writes it (putWindow). The mod under test keeps its own memory, new for each test.
const later = () => (h.nowMs += 11_000)
const rows = () => ledgerRows().filter((r) => !String(r.kind).startsWith('unattended-'))
const kinds = () => rows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
const of = (kind: string) => rows().filter((r) => r.kind === kind)
const QCALL = callOf('AskUserQuestion', QIN)
const APIREQ = { ...APIQ, leadName: undefined }
const QREQ = (over: Record<string, unknown> = {}) => ({ ...APIREQ, tool: 'AskUserQuestion', input: QIN, mode: 'default', ...over })
const asManager = async ($: any, on: any) => {
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
}
const provCall = (over: Record<string, unknown> = {}) => answerCall({ decision: 'answer', option: 2, why: 'the cautious option', provisional: true, ...over })
const list = async ($: any) => said(await $.tool.call(pcall('prompt_list')))
const apiDec = (id = TID) => JSON.parse(pfs.get(`${LDIR(APISID)}/${id}.decision.json`)!.text)
const decisions = () => [...pfs.keys()].filter((k) => k.endsWith('.decision.json'))
// The lane's side: this session is the lane, the manager (MGRT) its only tier, questions in scope, and a decision file made by hand.
const laneUnderManager = async ($: any, on: any) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  leadFiles.delete(LEADPATH)
  addMgrT()
}
const provisional = (u: string, over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) => handDecision(readReq(), { decision: 'answer', answer: { index: 1, label: '8080' }, why: 'the cautious option', by: byMgr, u, provisional: true, ...over }, { by: MGRT, u, prov: 'yes', ...row })
const PROV_TEXT = `8080 (answered by manager MANAGER${prm.PROVISIONAL_TAIL})`

// ---- the mode on the request ----
for (const [name, mode, want] of [
  ['the default mode', 'default', 'default'],
  ['another mode', 'acceptEdits', 'acceptEdits'],
  ['no mode', undefined, undefined],
  ['a mode that is not one plain word', 'default; x', undefined],
] as const) {
  test(`provisional: the lane's hook records ${name} from the permission event on the request`, async ($, on) => {
    await laneUnderManager($, on)
    putWindow()
    let req: any
    await runRequest($, [at(4000, () => { req = readReq() }), stop(8000)], { ...QCALL.over, ...(mode !== undefined ? { permission_mode: mode } : {}) }, QCALL.check)
    expect(req.mode).toBe(want)
    expect('mode' in req).toBe(want !== undefined)
  })
}

// ---- the tool ----
test('provisional: the manager gives a provisional answer to a lane\'s question in default mode inside a window; the file and its row carry the mark and the window', async ($, on) => {
  await asManager($, on)
  putQ(QREQ())
  const v = putWindow()
  const text = await list($)
  expect(text).toContain('Its lane is in the default permission mode, so one the rubric leaves to the person may take a provisional answer.')
  expect(text).toContain('with `provisional: true`')
  expect(said(await $.tool.call(provCall()))).toContain(`Recorded: provisional answer 2 for ${TID}.`)
  expect(apiDec()).toMatchObject({ decision: 'answer', answer: { index: 1, label: '8080' }, provisional: true, u: winShort(v), by: { level: 'manager', sid: SID, name: 'MANAGER' } })
  expect(of('answered')).toEqual([expect.objectContaining({ id: TID, code: 'answer', opt: '1', prov: 'yes', u: winShort(v) })])
})

test('provisional: refused for each mode but default and for an absent mode, with the list saying so; the same answer with no mark still lands', async ($, on) => {
  await asManager($, on)
  putWindow()
  const modes = ['acceptEdits', 'auto', 'bypassPermissions', 'plan', undefined]
  const idOf = (n: number) => `${n}c1b2c3d-0000-4000-8000-123456789abc`
  modes.forEach((mode, n) => putQ(QREQ({ id: idOf(n), mode })))
  const text = await list($)
  expect(text.split('Its lane is not recorded in the default permission mode, so it takes no provisional answer.').length - 1).toBe(modes.length)
  expect(text).not.toContain('Its lane is in the default permission mode')
  for (let n = 0; n < modes.length; n++) expect(said(await $.tool.call(provCall({ id: idOf(n) })))).toBe(`prompt_answer refused: ${refusal('provisional-mode')}`)
  expect(decisions()).toEqual([])
  expect(said(await $.tool.call(provCall({ id: idOf(0), provisional: false })))).toContain('Recorded: answer 2')
  expect(apiDec(idOf(0)).provisional).toBeUndefined()
  expect(of('answered')[0].prov).toBeUndefined()
})

test('provisional: refused outside a window, while the window cannot be read, from a lead, on a prompt that is not a question, and for a mark that is not a boolean', async ($, on) => {
  await asManager($, on)
  putQ(QREQ())
  expect(said(await $.tool.call(provCall()))).toContain(refusal('provisional-not-allowed'))
  putWindow()
  later()
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/grep'
  expect(said(await $.tool.call(provCall()))).toContain(refusal('unattended-unread'))
  h.pfsFails = undefined
  later()
  putQ({ ...APIREQ, id: TID2, mode: 'default' })
  expect(said(await $.tool.call(provCall({ id: TID2, decision: 'allow', option: undefined })))).toContain(refusal('bad-input'))
  expect(said(await $.tool.call(provCall({ provisional: 'yes' })))).toContain(refusal('bad-input'))
  expect(decisions()).toEqual([])
  expect(said(await $.tool.call(provCall()))).toContain('Recorded: provisional answer')
})

test('provisional: a lead may not give one', async ($, on) => {
  await tier($, on, [], { asksScope: 'all' })
  putQ({ tool: 'AskUserQuestion', input: QIN, mode: 'default' })
  putWindow()
  expect(said(await $.tool.call(provCall()))).toContain(refusal('provisional-not-allowed'))
  expect(pfs.has(`${LDIR()}/${TID}.decision.json`)).toBe(false)
})

// ---- the lane's side ----
longTest('provisional: the answer lands as the label with the provisional text, and its returned row carries the mark and the window', async ($, on) => {
  await laneUnderManager($, on)
  const u = winShort(putWindow())
  const r = await runRequest($, [at(4000, () => provisional(u))], { ...QCALL.over, permission_mode: 'default' }, QCALL.check)
  expect(r).toEqual({ decision: { behavior: 'allow', updatedInput: { ...QIN, answers: { [QTEXT]: PROV_TEXT } } } })
  expect(kinds()).toEqual(['requested', 'answered answer', 'returned answer'])
  expect(of('returned')[0]).toMatchObject({ code: 'answer', opt: '1', tier: 'manager', by: MGRT, prov: 'yes', u })
  // The person's list sets it apart from what was allowed.
  const listed = (await $.command.run(lane('unattended'))).text as string
  expect(listed).toContain('Questions answered provisionally, for you to review (the lane was told to take only reversible steps on them) (1):\n- lane svc-api · AskUserQuestion · by the manager · the cautious option')
  expect(listed).not.toContain('Allowed (')
})

longTest('provisional: a plain answer by the manager in the window reads as by day', async ($, on) => {
  await laneUnderManager($, on)
  const u = winShort(putWindow())
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'answer', answer: { index: 1, label: '8080' }, by: byMgr, u }, { by: MGRT, u }))], { ...QCALL.over, permission_mode: 'default' }, QCALL.check)
  expect(r.decision.updatedInput.answers[QTEXT]).toBe('8080 (answered by manager MANAGER)')
  expect(of('returned')[0].prov).toBeUndefined()
})

for (const [name, mode, decide, drop] of [
  ['given after its window ended', 'default', async ($: any, u: string) => { provisional(u); await $.command.run(lane('unattended off')) }, 'dropped unattended-closed'],
  ['made in another window', 'default', async () => provisional('bbbbbbbb'), 'dropped unattended-closed'],
  ['to a lane whose request records another mode', 'acceptEdits', async (_: any, u: string) => provisional(u), 'dropped kind'],
  ['to a lane whose request records no mode', undefined, async (_: any, u: string) => provisional(u), 'dropped kind'],
  ['whose row does not carry the mark', 'default', async (_: any, u: string) => provisional(u, {}, { prov: undefined }), 'dropped no-answered-row'],
  ['whose mark was taken off the file after its row', 'default', async (_: any, u: string) => provisional(u, { provisional: undefined }), 'dropped no-answered-row'],
] as const) {
  longTest(`provisional: an answer ${name} is dropped by the hook, and the question stays open`, async ($, on) => {
    await laneUnderManager($, on)
    const u = winShort(putWindow())
    const r = await runRequest($, [at(4000, () => decide($, u)), stop(60_000)], { ...QCALL.over, ...(mode !== undefined ? { permission_mode: mode } : {}) }, QCALL.check)
    expect(r).toEqual({})
    expect(kinds()).toEqual(['requested', 'answered answer', drop, 'off'])
  })
}

longTest('provisional: an answer whose window cannot be read at apply is held, not dropped, and lands once the window reads on again', async ($, on) => {
  await laneUnderManager($, on)
  const v = putWindow()
  const u = winShort(v)
  const r = await runRequest($, [
    // Another value with no row yet: the read gives no answer for its first minute.
    at(4000, () => { provisional(u); h.store.set(UNATTENDED_KEY, win({ savedAt: h.nowMs, until: v.until + 1000 })) }),
    at(44_000, () => { expect(decisions().length).toBe(1); expect(kinds().some((k) => k.startsWith('dropped'))).toBe(false); h.store.set(UNATTENDED_KEY, v) }),
  ], { ...QCALL.over, permission_mode: 'default' }, QCALL.check)
  expect(r.decision.updatedInput.answers[QTEXT]).toBe(PROV_TEXT)
  expect(kinds()).toEqual(['requested', 'answered answer', 'returned answer'])
})

// ---- repeats ----
test('repeat: the manager\'s list marks a request whose lane had a call of the same pattern denied, parked or held in this window, and no other', async ($, on) => {
  await asManager($, on)
  const v = putWindow()
  const u = winShort(v)
  putQ(APIREQ)
  putQ({ ...APIREQ, id: TID2, input: { command: 'git status' } })
  const OLD = '0b1b2c3d-0000-4000-8000-123456789abc'
  putLedger([{ t: 'x', kind: 'returned', code: 'park', id: OLD, lane: 'API', repo: `${PIN}/api`, tool: 'Bash', pattern: 'ssh', u }])
  const text = await list($)
  const part = (id: string) => text.split('### ').find((s) => s.startsWith(id))!
  expect(part(TID)).toContain(prm.REPEAT_LINE)
  expect(part(TID2)).not.toContain('REPEAT:')
  expect(text).toContain('6. A request marked REPEAT that reaches the same effect as the call denied, parked or held before: park it.')
})

test('repeat: the person\'s list shows a request asked again after a park in the window, with what came of it, and counts it', async ($, on) => {
  await asManager($, on)
  const u = winShort(putWindow())
  const t = (ms: number) => new Date(T0 + ms).toISOString()
  const row = (id: string, ms: number, o: Record<string, unknown>) => ({ t: t(ms), id, lane: 'API', repo: `${PIN}/api`, tool: 'Bash', pattern: 'ssh', u, ...o })
  const A = '0b1b2c3d-0000-4000-8000-123456789abc'
  const B = '0c1b2c3d-0000-4000-8000-123456789abc'
  putLedger([row(A, 1000, { kind: 'requested' }), row(A, 2000, { kind: 'returned', code: 'park', tier: 'manager', why: 'a deploy' }), row(B, 3000, { kind: 'requested' }), row(B, 4000, { kind: 'returned', code: 'deny', tier: 'manager', why: 'parked before' })])
  const listed = (await $.command.run(lane('unattended'))).text as string
  expect(listed).toContain('Asked again after a call of the same lane, tool and pattern was denied, parked or held in this window (each also in its own section above) (1):\n- lane API · ssh · denied')
  await $.command.run(lane('unattended off', { kind: 'peer' }))
  expect(toasts.filter((x) => x.startsWith('Unattended mode ended'))).toEqual(['Unattended mode ended: 1 parked, 1 denied, 1 asked again. /callboard unattended lists it.'])
})

test('repeat: a deny of another window, or by day, marks nothing', async ($, on) => {
  await asManager($, on)
  putWindow()
  putQ(APIREQ)
  const OLD = '0b1b2c3d-0000-4000-8000-123456789abc'
  putLedger([{ t: 'x', kind: 'returned', code: 'deny', id: OLD, lane: 'API', repo: `${PIN}/api`, tool: 'Bash', pattern: 'ssh', u: 'bbbbbbbb' }, { t: 'x', kind: 'returned', code: 'deny', id: OLD, lane: 'API', repo: `${PIN}/api`, tool: 'Bash', pattern: 'ssh' }])
  expect(await list($)).not.toContain('REPEAT:')
})

test('repeat: a lead\'s list in a window shows no repeat line', async ($, on) => {
  await tier($, on)
  putQ()
  const u = winShort(putWindow())
  putLedger([{ t: 'x', kind: 'returned', code: 'deny', id: '0b1b2c3d-0000-4000-8000-123456789abc', lane: 'svc-api', repo: SVC, tool: 'Bash', pattern: 'ssh', u }])
  expect(await list($)).not.toContain('REPEAT:')
})
