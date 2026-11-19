import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPIRE_MS, HEAD_START_MS, MANAGER_AT_MS, NO_MANAGER_HOLD_MS, awakeAdd, classify, decide, inputText, questionShape, questionView, stage, sweep } from './asks.ts'
import type { Open, StageIn } from './asks.ts'
import { PERSON, ancestors, liveView } from './model.ts'
import type { Answer, Ask, Sid, Table, UpMark, View } from './model.ts'
import { MANAGER, NOW, WINDOWS, forAll, pick, reg } from './gen.spec.ts'

const M = 'sid-manager'
const A = 'sid-lead-a'
const L1 = 'sid-lane-1'
const LOOSE = 'sid-loose'
const ON = WINDOWS[2]
const OFF = WINDOWS[0]
const ask = (x: Partial<Ask> = {}): Ask => ({ id: 'ask-1', asker: L1, t0: NOW, awake: 0, window: null, personOnly: false, tool: 'Bash', raisedBy: 'mode', input: '{}', cut: false, beat: NOW, ...x })
const lanes: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: A } }
const all = liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1'), reg(LOOSE, 'loose')], lanes, MANAGER)
const at = (x: Partial<StageIn>): StageIn => ({ ask: ask(), now: NOW + HEAD_START_MS, win: OFF, ups: [], v: all, held: 0, ...x })
const open = (x: Partial<StageIn>): Open => {
  const s = stage(at(x))
  assert.ok(s.open, `closed with ${s.open ? '' : s.msg}`)
  return s
}
const up = (by: Sid, kind: UpMark['kind'] = 'escalated'): UpMark => ({ kind, by, at: NOW })

test('every ask has an owner or a close: eligible is a subset of the asker\'s ancestors now, nothing is open past 15 minutes awake, and unattended nothing the person owns stays open', () => {
  forAll(600, (r, w) => {
    const asker = pick(r, w.sids)
    const ups = Array.from({ length: Math.floor(r() * 3) }, () => up(pick(r, w.sids), r() < 0.5 ? 'escalated' : 'told'))
    const x: StageIn = { ask: ask({ asker, awake: Math.floor(r() * 20 * 60_000), personOnly: r() < 0.2 }), now: NOW + Math.floor(r() * 2 * HEAD_START_MS), win: pick(r, WINDOWS), ups, v: w.v, held: Math.floor(r() * 2 * NO_MANAGER_HOLD_MS) }
    const s = stage(x)
    if (x.ask.awake >= EXPIRE_MS) return assert.ok(!s.open && s.msg === 'ask.expired')
    if (!s.open) return assert.ok(s.msg === 'ask.leftForPerson' && x.win.state === 'on' && s.p.parent !== undefined)
    const above = ancestors(w.v, asker)
    for (const e of s.eligible) assert.ok(above.includes(e), `${e} is eligible but not above ${asker}`)
    if (x.ask.personOnly) assert.deepEqual(s.eligible, [])
    // Open while unattended with the person as next owner: only on an unknown reading, or while "no manager" has not yet held.
    if (x.win.state === 'on' && s.toPerson) assert.ok(s.top === 'unknown' || (s.noManager && x.held < NO_MANAGER_HOLD_MS))
  })
})

test('unknown never closes early and never moves an owner: with the registry or the window unread, only the 15 minute close comes, and only the stored lead is eligible', () => {
  forAll(400, (r, w) => {
    const asker = pick(r, w.sids)
    if (w.table[asker]?.off) return // never staged: the hook returns before it
    const blind = liveView('unknown', w.table, MANAGER)
    const x: StageIn = { ask: ask({ asker, awake: Math.floor(r() * (EXPIRE_MS - 1)), personOnly: r() < 0.3 }), now: NOW + HEAD_START_MS, win: pick(r, WINDOWS), ups: [up(pick(r, w.sids))], v: blind, held: NO_MANAGER_HOLD_MS * 2 }
    const s = stage(x)
    assert.ok(s.open, 'an unknown registry closed an ask early')
    for (const e of s.eligible) assert.equal(e, w.table[asker]?.under)
    assert.ok(stage({ ...x, v: w.v, win: { state: 'unknown' } }).open, 'an unknown window closed an ask early')
  })
})

test('the timeline: hidden 30 s by day, the parent at once in a window, the manager at 5 min awake, each escalation one step at once', () => {
  assert.deepEqual(open({ now: NOW }).eligible, [])
  assert.deepEqual(open({ now: NOW + HEAD_START_MS }).eligible, [A])
  assert.deepEqual(open({ now: NOW, win: ON }).eligible, [A])
  assert.deepEqual(open({ ask: ask({ awake: MANAGER_AT_MS }) }).eligible, [A, M])
  assert.deepEqual(open({ ups: [up(A)] }).eligible, [A, M])
  // An escalation by the manager, or by a session no longer above the asker, counts from where that session stands.
  assert.deepEqual(open({ ups: [up(LOOSE)] }).eligible, [A])
  const past = open({ ups: [up(A), up(M)] })
  assert.ok(past.toPerson && past.relay)
  assert.equal(stage(at({ ups: [up(A), up(M)], win: ON })).open, false)
})

test('a loose session\'s ask while unattended (the 8 h wait): the manager owns it at once and it closes at 15 minutes awake; with no manager it closes for the person after the hold', () => {
  const x = at({ ask: ask({ asker: LOOSE }), now: NOW, win: ON })
  assert.deepEqual(open(x).eligible, [M])
  const s = stage({ ...x, ask: ask({ asker: LOOSE, awake: EXPIRE_MS }) })
  assert.ok(!s.open && s.msg === 'ask.expired' && s.p.parent === MANAGER)
  const alone = liveView([reg(LOOSE, 'loose')], {}, MANAGER)
  assert.ok(open({ ...x, v: alone, held: NO_MANAGER_HOLD_MS - 1 }).noManager)
  const shut = stage({ ...x, v: alone, held: NO_MANAGER_HOLD_MS })
  assert.ok(!shut.open && shut.msg === 'ask.leftForPerson' && shut.p.parent === PERSON)
  // By day the same ask with no manager is the person's dialog, closed only at 15 minutes.
  assert.ok(stage({ ...x, v: alone, win: OFF, held: NO_MANAGER_HOLD_MS * 10, ask: ask({ asker: LOOSE, awake: EXPIRE_MS - 1 }) }).open)
})

test('a manager restart while unattended: the person\'s asks are not closed during the hold, and a failed registry read closes nothing', () => {
  const noManager = liveView([reg(A, 'A'), reg(L1, 'L1')], lanes, MANAGER)
  const x = at({ v: noManager, win: ON, ups: [up(A)] })
  assert.ok(open({ ...x, held: NO_MANAGER_HOLD_MS - 2000 }).toPerson)
  assert.equal(stage({ ...x, held: NO_MANAGER_HOLD_MS }).open, false)
  assert.ok(open({ ...x, v: liveView('unknown', lanes, MANAGER), held: NO_MANAGER_HOLD_MS * 5 }))
})

test('a lead that restarts does not take an ask back from the manager; a busy parent keeps its ask, and the lead is never taken for the top', () => {
  const leadGone = liveView([reg(M, MANAGER), reg(L1, 'L1')], lanes, MANAGER)
  assert.deepEqual(open({ v: leadGone }).eligible, [M])
  assert.deepEqual(open({ ups: [up(M, 'told')] }).eligible.sort(), [A, M].sort())
  const busy = liveView([reg(M, MANAGER, { status: 'waiting', waitingFor: 'question' }), reg(A, 'A', { status: 'compacting' }), reg(L1, 'L1')], lanes, MANAGER)
  const s = open({ v: busy, ups: [up(A)] })
  assert.deepEqual(s.eligible, [A, M])
  assert.equal(s.toPerson, false, 'the lead was treated as the top while the manager sat in a question')
})

test('the person\'s own: a personOnly ask has no deciders and no words path; the manager\'s own ask is not relayed and closes at once while unattended', () => {
  const only = open({ ask: ask({ personOnly: true }), ups: [up(A, 'told')] })
  assert.deepEqual(only.eligible, [])
  assert.ok(only.toPerson && only.relay)
  assert.equal(decide({ ask: 'ask-1', by: M, decision: 'allow', at: NOW }, ask({ personOnly: true }), only, all, {}).act, 'ignore')
  assert.equal(decide({ ask: 'ask-1', by: PERSON, decision: 'allow', at: NOW }, ask({ personOnly: true }), only, all, {}).act, 'allow')
  const own = open({ ask: ask({ asker: M }) })
  assert.ok(own.toPerson && !own.relay)
  assert.equal(stage(at({ ask: ask({ asker: M }), win: ON, now: NOW })).open, false)
})

test('decide: the answer must name this ask and come from the person or an eligible session; it must fit the ask; the label is read from the live input', () => {
  const s = open({})
  const a = (x: Partial<Answer>): Answer => ({ ask: 'ask-1', by: A, decision: 'allow', at: NOW, ...x })
  assert.equal(decide(a({}), ask(), s, all, {}).act, 'allow')
  assert.equal(decide(a({ ask: 'other' }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({ by: M }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({ by: L1 }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({}), ask({ cut: true }), s, all, {}).msg, 'refuse.input-cut')
  assert.equal(decide(a({ by: PERSON }), ask({ cut: true }), s, all, {}).act, 'allow')
  assert.deepEqual(decide(a({ decision: 'deny', note: 'no' }), ask(), s, all, {}), { act: 'deny', msg: 'ask.denyText', p: { by: 'A', note: 'no' } })
  const live = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: ' Yes ' }, { label: 'No' }] }] }
  const q = ask({ tool: 'AskUserQuestion' })
  assert.deepEqual(decide(a({ decision: 'answer', option: 1 }), q, s, all, live), { act: 'answer', msg: 'ask.answerText', p: { label: 'Yes', by: 'A' }, question: 'Which?' })
  assert.equal(decide(a({ decision: 'answer', option: 3 }), q, s, all, live).act, 'ignore')
  assert.equal(decide(a({}), q, s, all, live).act, 'ignore')
  assert.equal(decide(a({ decision: 'answer', option: 1 }), ask(), s, all, live).act, 'ignore')
  // Eligible sessions only, in every world: an answer by anyone else is ignored.
  forAll(200, (r, w) => {
    const x: StageIn = { ask: ask({ asker: pick(r, w.sids) }), now: NOW + HEAD_START_MS, win: pick(r, WINDOWS), ups: [], v: w.v, held: 0 }
    const st = stage(x)
    const by = pick(r, w.sids)
    if (st.open && !st.eligible.includes(by)) assert.equal(decide(a({ by }), x.ask, st, w.v, {}).act, 'ignore')
  })
})

test('the sweep: a dead asker\'s ask ends; a live one is only marked stale, and only once the sweeper has been awake 90 s since its wake', () => {
  const v: View = liveView([reg(M, MANAGER), reg(L1, 'L1')], {}, MANAGER)
  const old = ask({ beat: NOW - 10 * 60_000 })
  assert.equal(sweep(ask({ asker: 'sid-dead' }), v, NOW, 0), 'sweep')
  assert.equal(sweep(old, v, NOW, 60_000), 'keep')
  assert.equal(sweep(old, v, NOW, 120_000), 'stale')
  assert.equal(sweep(ask(), v, NOW, 120_000), 'keep')
  assert.equal(sweep(old, liveView('unknown', {}, MANAGER), NOW, 120_000), 'keep')
})

test('classify: no tool.check entry is raised by unknown; a dialog that is not an ask, a question with no answer form or headed Person, is the person\'s only', () => {
  assert.deepEqual(classify('Bash', {}, undefined), { raisedBy: 'unknown', personOnly: false })
  assert.deepEqual(classify('ExitPlanMode', {}, { decision: 'other' }), { raisedBy: 'mode', personOnly: true })
  assert.deepEqual(classify('Bash', {}, { decision: 'ask', rule: 'Bash(rm:*)', setting: 'x' }), { raisedBy: 'setting', personOnly: false })
  assert.equal(classify('mcp__github__update_pull_request', {}, { decision: 'ask', hook: 'PreToolUse', reason: 'github-mcp-guard: no' }).raisedBy, 'guard')
  const q = (header: string, n = 2) => ({ questions: [{ question: 'Q', header, options: Array.from({ length: n }, (_, i) => ({ label: `o${i}` })) }] })
  assert.equal(classify('AskUserQuestion', q('Pick'), { decision: 'ask' }).personOnly, false)
  assert.equal(classify('AskUserQuestion', q('Person'), { decision: 'ask' }).personOnly, true)
  assert.equal(classify('AskUserQuestion', q('Pick', 5), { decision: 'ask' }).personOnly, true)
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', options: [{ label: 'a' }, { label: 'a ' }] }] }), { ok: false, code: 'question-options' })
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', options: [{ label: 'a\u202e' }, { label: 'b' }] }] }), { ok: false, code: 'question-options' })
  assert.equal(questionView({ questions: [{ question: 'token=abc123', header: 'H', options: [{ label: 'a' }, { label: 'b' }] }] })?.question, 'token=[REDACTED]')
})

test('what a parent sees of the input: secrets redacted, a removed secret that could run leaves the input cut, a huge or odd input is capped and never throws', () => {
  const t = inputText({ command: 'curl -H "Authorization: Bearer abcdef" https://u:pw@host/x', env: { API_TOKEN: 'plain' }, password: 'a;b' })
  assert.ok(!t.text.includes('abcdef') && !t.text.includes('pw@') && !t.text.includes('plain'))
  assert.equal(t.cut, true)
  assert.equal(inputText({ password: 'plain' }).cut, false)
  assert.equal(inputText({ s: 'x'.repeat(40_000) }).cut, true)
  const cyc: Record<string, unknown> = {}
  cyc.self = cyc
  assert.equal(inputText(cyc).cut, true)
  assert.equal(inputText({ n: 10n }).cut, true)
  assert.ok(Buffer.byteLength(inputText(Array.from({ length: 150 }, () => 'é'.repeat(5000))).text) <= 32 * 1024)
})

test('awake time: a gap counts at most 10 s, and a clock that ran back or a sleep adds nothing past that', () => {
  assert.equal(awakeAdd(0, 2000), 2000)
  assert.equal(awakeAdd(0, 600_000), 10_000)
  assert.equal(awakeAdd(5, -1000), 5)
  assert.equal(awakeAdd(5, NaN), 5)
})
