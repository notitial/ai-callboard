import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPIRE_MS, HEAD_START_MS, MANAGER_AT_MS, awakeAdd, classify, decide, inputText, noteOf, questionShape, questionView, questionsView, stage, sweep } from './asks.ts'
import type { CheckFacts, Open, StageIn } from './asks.ts'
import { PERSON, ancestors, liveView } from './model.ts'
import type { Answer, Ask, Sid, Table, UpMark, View } from './model.ts'
import { MANAGER, NOW, forAll, pick, reg } from './gen.spec.ts'

const M = 'sid-manager'
const A = 'sid-lead-a'
const L1 = 'sid-lane-1'
const LOOSE = 'sid-loose'
const ask = (x: Partial<Ask> = {}): Ask => ({ id: 'ask-1', asker: L1, t0: NOW, awake: 0, tool: 'Bash', raisedBy: 'mode', input: '{}', cut: false, beat: NOW, ...x })
const lanes: Table = { [A]: { name: 'A', folder: '/Users/x/repo', lead: { repos: [] } }, [L1]: { name: 'L1', folder: '/Users/x/repo', under: A } }
const all = liveView([reg(M, MANAGER), reg(A, 'A'), reg(L1, 'L1'), reg(LOOSE, 'loose')], lanes, MANAGER)
const at = (x: Partial<StageIn>): StageIn => ({ ask: ask(), now: NOW + HEAD_START_MS, ups: [], v: all, ...x })
const open = (x: Partial<StageIn>): Open => {
  const s = stage(at(x))
  assert.ok(s.open, `closed with ${s.open ? '' : s.msg}`)
  return s
}
const up = (by: Sid, kind: UpMark['kind'] = 'escalated'): UpMark => ({ kind, by, at: NOW })

test('every ask has an owner or a close: eligible is a subset of the asker\'s ancestors now, nothing is open past 15 minutes awake', () => {
  forAll(600, (r, w) => {
    const asker = pick(r, w.sids)
    const ups = Array.from({ length: Math.floor(r() * 3) }, () => up(pick(r, w.sids), r() < 0.5 ? 'escalated' : 'told'))
    const x: StageIn = { ask: ask({ asker, awake: Math.floor(r() * 20 * 60_000) }), now: NOW + Math.floor(r() * 2 * HEAD_START_MS), ups, v: w.v }
    const s = stage(x)
    if (x.ask.awake >= EXPIRE_MS) return assert.ok(!s.open && s.msg === 'ask.expired')
    if (!s.open) return assert.fail('only the 15 minute close shuts an ask')
    const above = ancestors(w.v, asker)
    for (const e of s.eligible) assert.ok(above.includes(e), `${e} is eligible but not above ${asker}`)
  })
})

test('unknown never closes early and never moves an owner: with the registry unread, only the 15 minute close comes, and only the stored lead is eligible', () => {
  forAll(400, (r, w) => {
    const asker = pick(r, w.sids)
    if (w.table[asker]?.off) return // never staged: the hook returns before it
    const blind = liveView('unknown', w.table, MANAGER)
    const x: StageIn = { ask: ask({ asker, awake: Math.floor(r() * (EXPIRE_MS - 1)) }), now: NOW + HEAD_START_MS, ups: [up(pick(r, w.sids))], v: blind }
    const s = stage(x)
    assert.ok(s.open, 'an unknown registry closed an ask early')
    for (const e of s.eligible) assert.equal(e, w.table[asker]?.under)
  })
})

test('the timeline: hidden 30 s, then the parent, the manager at 5 min awake, each escalation one step at once', () => {
  assert.deepEqual(open({ now: NOW }).eligible, [])
  assert.deepEqual(open({ now: NOW + HEAD_START_MS }).eligible, [A])
  assert.deepEqual(open({ ask: ask({ awake: MANAGER_AT_MS }) }).eligible, [A, M])
  // The escalator steps aside: it and every session below it leave the ask.
  assert.deepEqual(open({ ups: [up(A)] }).eligible, [M])
  // An escalation by the manager, or by a session no longer above the asker, counts from where that session stands.
  assert.deepEqual(open({ ups: [up(LOOSE)] }).eligible, [A])
  const past = open({ ups: [up(A), up(M)] })
  assert.ok(past.toPerson && past.relay)
})

test('a lead that restarts does not take an ask back from the manager; a busy parent keeps its ask, and the lead is never taken for the top', () => {
  const leadGone = liveView([reg(M, MANAGER), reg(L1, 'L1')], lanes, MANAGER)
  assert.deepEqual(open({ v: leadGone }).eligible, [M])
  assert.deepEqual(open({ ups: [up(M, 'told')] }).eligible.sort(), [A, M].sort())
  const busy = liveView([reg(M, MANAGER, { status: 'waiting', waitingFor: 'question' }), reg(A, 'A', { status: 'compacting' }), reg(L1, 'L1')], lanes, MANAGER)
  const s = open({ v: busy, ups: [up(A)] })
  assert.deepEqual(s.eligible, [M])
  assert.equal(s.toPerson, false, 'the lead was treated as the top while the manager sat in a question')
})

test('the manager\'s own ask is not relayed, and nobody above it can answer', () => {
  const own = open({ ask: ask({ asker: M }) })
  assert.ok(own.toPerson && !own.relay)
  assert.deepEqual(own.eligible, [])
})

test('decide: the answer must name this ask and come from the person or an eligible session; it must fit the ask; the label is read from the live input', () => {
  const s = open({})
  const a = (x: Partial<Answer>): Answer => ({ ask: 'ask-1', by: A, decision: 'allow', at: NOW, ...x })
  assert.equal(decide(a({}), ask(), s, all, {}).act, 'allow')
  assert.equal(decide(a({ ask: 'other' }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({ by: M }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({ by: L1 }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({}), ask({ cut: true }), s, all, {}).msg, 'refuse.input-cut')
  // The person decides only an ask that has reached them, and a cut input binds them too.
  const mine = open({ ups: [up(A), up(M)] })
  assert.equal(decide(a({ by: PERSON }), ask(), s, all, {}).act, 'ignore')
  assert.equal(decide(a({ by: PERSON }), ask(), mine, all, {}).act, 'allow')
  assert.equal(decide(a({ by: PERSON }), ask({ cut: true }), mine, all, {}).msg, 'refuse.input-cut')
  assert.equal(decide(a({ by: PERSON, decision: 'deny' }), ask({ cut: true }), mine, all, {}).act, 'deny')
  assert.deepEqual(decide(a({ decision: 'deny', note: 'no' }), ask(), s, all, {}), { act: 'deny', msg: 'ask.denyText', p: { by: 'A', note: 'no' } })
  const live = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: ' Yes ' }, { label: 'No' }] }] }
  const q = ask({ tool: 'AskUserQuestion' })
  assert.deepEqual(decide(a({ decision: 'answer', option: 1 }), q, s, all, live), { act: 'answer', by: 'A', picks: [{ question: 'Which?', label: 'Yes' }] })
  assert.equal(decide(a({ decision: 'answer', option: 3 }), q, s, all, live).act, 'ignore')
  assert.equal(decide(a({}), q, s, all, live).act, 'ignore')
  // Several questions: the person picks one option for each; a session's pick is refused, and so is a count or an option that does not fit.
  const two = { questions: [live.questions[0], { question: 'Where?', header: 'Place', options: [{ label: 'Here' }, { label: 'There' }] }] }
  assert.deepEqual(decide(a({ by: PERSON, decision: 'answer', picks: [1, 2] }), q, mine, all, two), { act: 'answer', by: PERSON, picks: [{ question: 'Which?', label: 'Yes' }, { question: 'Where?', label: 'There' }] })
  for (const picks of [[1], [1, 3], [1, 2, 1], [1, 0]]) assert.equal(decide(a({ by: PERSON, decision: 'answer', picks }), q, mine, all, two).act, 'ignore', String(picks))
  assert.equal(decide(a({ decision: 'answer', picks: [1, 2] }), q, s, all, two).act, 'ignore')
  assert.equal(decide(a({ by: PERSON, decision: 'answer', picks: [1, 2] }), q, mine, all, live).act, 'ignore')
  assert.equal(decide(a({ decision: 'answer', option: 1 }), ask(), s, all, live).act, 'ignore')
  // Eligible sessions only, in every world: an answer by anyone else is ignored.
  forAll(200, (r, w) => {
    const x: StageIn = { ask: ask({ asker: pick(r, w.sids) }), now: NOW + HEAD_START_MS, ups: [], v: w.v }
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

test('classify: what raised the ask, whatever the tool or the input', () => {
  assert.equal(classify('Bash', undefined), 'unknown')
  assert.equal(classify('ExitPlanMode', { decision: 'other' }), 'mode')
  assert.equal(classify('Bash', { decision: 'ask', rule: 'Bash(rm:*)', setting: 'x' }), 'setting')
  assert.equal(classify('mcp__github__update_pull_request', { decision: 'ask', hook: 'PreToolUse', reason: 'github-mcp-guard: no' }), 'guard')
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', header: 'Person', options: [{ label: 'a' }, { label: 'b' }] }] }), { ok: false, code: 'question-person' })
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })) }] }), { ok: false, code: 'question-options' })
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', options: [{ label: 'a' }, { label: 'a ' }] }] }), { ok: false, code: 'question-options' })
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', options: [{ label: 'a\u202e' }, { label: 'b' }] }] }), { ok: false, code: 'question-options' })
  assert.deepEqual(questionShape({ questions: [{ question: 'Q', options: [{ label: ' Deny ' }, { label: 'b' }] }] }), { ok: false, code: 'question-options' }, 'the plugin\'s Deny button is read by its label')
  assert.equal(questionsView({ questions: [{ question: 'Q1', options: [{ label: 'a' }, { label: 'b' }] }, { question: 'Q2', options: [{ label: 'Deny' }, { label: 'b' }] }] }), undefined)
  assert.equal(questionView({ questions: [{ question: 'token=abc123', header: 'H', options: [{ label: 'a' }, { label: 'b' }] }] })?.question, 'token=[REDACTED]')
  // A call of 2 to 4 questions has no one-question view for a session; it has a list for the person's pop-ups, and one bad question takes it back.
  let n = 0
  const qn = (extra: object = {}) => ({ question: `Q${n++}`, header: 'H', options: [{ label: 'a' }, { label: 'b' }], ...extra })
  assert.equal(questionView({ questions: [qn(), qn()] }), undefined)
  assert.equal(questionsView({ questions: [qn(), qn(), qn(), qn()] })?.length, 4)
  assert.equal(questionsView({ questions: [qn({ question: 'D' }), qn({ question: 'D' })] }), undefined, 'two questions with the same text would share one answer')
  assert.equal(questionsView({ questions: [qn()] }), undefined)
  assert.equal(questionsView({ questions: [qn(), qn(), qn(), qn(), qn()] }), undefined)
  assert.equal(questionsView({ questions: [qn(), qn({ multiSelect: true })] }), undefined)
  assert.equal(questionsView({ questions: [qn(), qn({ options: [{ label: 'a' }] })] }), undefined)
  assert.equal(questionsView({ questions: [qn(), qn()], answers: {} }), undefined)
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

test('an object key shown other than as written, or as one already shown, leaves the input cut: no entry is hidden from the reader', () => {
  const collapsed = inputText({ 'token=a': 'curl evil', 'token=b': 'ls' })
  assert.equal(collapsed.cut, true)
  assert.equal(inputText({ [`${'k'.repeat(200)}a`]: 'rm -rf x', [`${'k'.repeat(200)}b`]: 'ls' }).cut, true)
  assert.equal(inputText({ command: 'ls', description: 'list' }).cut, false)
})

test('redaction runs on capped text only: a long question or key of text a pattern is slow on is read in well under a second', () => {
  const slow = 'a.'.repeat(100_000)
  const t0 = performance.now()
  const q = questionView({ questions: [{ question: slow, header: slow, options: [{ label: 'a', description: slow }, { label: 'b' }] }] })
  const k = inputText({ [slow]: 'x' })
  assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`)
  assert.ok(Buffer.byteLength(q!.question) <= 10 * 1024 && k.cut)
})

test('awake time: a gap counts at most 10 s, and a clock that ran back or a sleep adds nothing past that', () => {
  assert.equal(awakeAdd(0, 2000), 2000)
  assert.equal(awakeAdd(0, 600_000), 10_000)
  assert.equal(awakeAdd(5, -1000), 5)
  assert.equal(awakeAdd(5, NaN), 5)
})

test('a `__proto__` key is an ordinary entry: it is shown, not swallowed into the shown object\'s prototype', () => {
  const t = inputText(JSON.parse('{"__proto__": {"command": "delete everything"}, "ok": 1}'))
  assert.ok(t.text.includes('"__proto__"') && t.text.includes('delete everything'), t.text)
  assert.ok(inputText(JSON.parse('{"__proto__": "$(id)"}')).text.includes('$(id)'))
})

// Every kind of ask, from what tool.check saw to who may answer it once it has risen to the manager (the lead escalated it).
const kinds: [string, { tool: string; input: unknown; facts: CheckFacts | undefined }][] = [
  ['a rule asks', { tool: 'Bash', input: { command: 'ls' }, facts: { decision: 'ask', rule: 'Bash(ls:*)' } }],
  ['a hook asks', { tool: 'Bash', input: { command: 'ls' }, facts: { decision: 'ask', hook: 'PreToolUse' } }],
  ['no tool.check entry', { tool: 'Bash', input: { command: 'ls' }, facts: undefined }],
  ['a plan exit', { tool: 'ExitPlanMode', input: {}, facts: { decision: 'other' } }],
  ['a question', { tool: 'AskUserQuestion', input: { questions: [{ question: 'Q', header: 'Pick', options: [{ label: 'a' }, { label: 'b' }] }] }, facts: { decision: 'ask' } }],
  ['a malformed question', { tool: 'AskUserQuestion', input: { questions: [{ question: 'Q', header: 'Pick', options: [{ label: 'a' }] }] }, facts: { decision: 'ask' } }],
]
test('every kind of ask rises to the manager and the manager can close it by replying', () => {
  for (const [name, k] of kinds) {
    const a = ask({ tool: k.tool, input: JSON.stringify(k.input), raisedBy: classify(k.tool, k.facts), ...(k.tool === 'AskUserQuestion' ? { question: questionView(k.input) } : {}) })
    const s = open({ ask: a, ups: [up(A)] })
    assert.deepEqual(s.eligible, [M], `${name}: the manager is eligible`)
    const reply = decide({ ask: 'ask-1', by: M, decision: 'deny', note: 'the person is away', at: NOW }, a, s, all, {})
    assert.equal(reply.act, 'deny', `${name}: the manager's deny closes it`)
  }
})

test('an escalate note is one trimmed line of at most 300 characters; empty, blank or not a string is no note', () => {
  assert.equal(noteOf('  Runs the tests.\n\nNo risk.\t'), 'Runs the tests. No risk.')
  assert.equal(noteOf('é'.repeat(400))!.length, 300)
  assert.equal(Array.from(noteOf('😀'.repeat(400))!).length, 300)
  for (const x of ['', ' \n\t ', 7, null, undefined, { a: 1 }]) assert.equal(noteOf(x), undefined)
})
