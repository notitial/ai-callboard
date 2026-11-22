import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, as, peer, tiers } from '../../test/fake.ts'
import type { Ask } from '../core/model.ts'
import { SELF_TEST, permissionRequest, proxyJudge, proxyRun, toolCheck } from './ask-hook.ts'
import { mem } from './mem.ts'
import { relayTick } from './relay.ts'
import { askOpen, getView, readAnswer, readAskLog, readAsks, rmAsk, writeAsk, writeUp } from './store.ts'
import { promptAnswerCall } from './tools-ask.ts'

type F = ReturnType<typeof tiers>
type G = ReturnType<typeof peer>
const noop = Object.assign(async () => ({}), { signal: undefined })
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
const tickRelay = (g: G) => as(async () => relayTick(g.$, 'sid-boss', await getView(g.$, true), g.h.now))
const mk = (id: string, over: Partial<Ask> = {}): Ask => ({ id, asker: 'sid-me', t0: T0 - 60_000, awake: 60_000, tool: 'Bash', raisedBy: 'unknown', input: '{"command":"make"}', cut: false, beat: T0, ...over })
const logRows = (f: F, event: string): string[] => (f.h.files.get(`${V2}/log/sid-boss.jsonl`) ?? '').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).filter((r) => r.event === event).map((r) => r.reason)
const reach = async (f: F, id: string) => {
  await writeUp(f.$, id, 'sid-lead', 'escalated', T0)
  await writeUp(f.$, id, 'sid-boss', 'escalated', T0)
}
const window = (f: F) => f.h.files.set(`${V2}/unattended.json`, JSON.stringify({ start: T0, end: T0 + 8 * 60 * MIN, readAt: T0 }))
// The manager's session with the plugin's own PermissionRequest hook in place, as the engine runs it before the dialog shows: the hook marks the dialog shown.
const shownBy = (g: G) => void (g.h.permission = (e, next) => permissionRequest(g.$, e, next))
// The plugin's tool.check and tool.run hooks in place too, and the self-test run by a first tick with no ask open: the engine's own dialog is on.
const nativeBy = async (g: G) => {
  shownBy(g)
  g.h.check = (e, next) => toolCheck(g.$, e, next)
  g.h.toolRun = (e, next) => proxyRun(g.$, e, next)
  await tickRelay(g)
  await settle()
  assert.equal(mem.native, true)
}
// One relayed ask waiting on the manager's session, the person's dialog not yet answered.
const open = async (over: Partial<Ask> = {}) => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc', over))
  await reach(f, 'aa11bb22cc')
  let click: (x: unknown) => void = () => undefined
  boss.h.askAnswer = () => new Promise((r) => (click = r))
  shownBy(boss)
  await tickRelay(boss)
  await settle()
  return { f, boss, click: (x: unknown) => click(x) }
}

test('by day an ask escalated past the manager is put to the person as a dialog in the manager\'s session, and his Allow there applies to that ask only', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  boss.h.askAnswer = async () => 'Allow'
  shownBy(boss)
  const out: Record<string, any> = {}
  f.h.onSleep = async () => {
    if (out.done || f.h.now - T0 < 40_000) return
    out.done = true
    out.id = (await readAsks(f.$)).asks[0]!.id
    await as(() => promptAnswerCall(lead.$, { id: out.id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id: out.id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
    await tickRelay(boss)
    await settle()
  }
  assert.deepEqual(await permissionRequest(f.$, { tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1' }, noop), { decision: { behavior: 'allow' } })
  assert.deepEqual(boss.h.calls.map((c) => c.tool), ['AskUserQuestion'], 'one dialog, called by the plugin itself')
  assert.equal(boss.h.asked[0]!.header, 'Your call')
  assert.deepEqual(boss.h.asked[0]!.options, ['Allow', 'Deny'])
  assert.match(boss.h.asked[0]!.question, /"command": "make"/)
  const last = (await readAskLog(f.$, 0))!.at(-1)!
  assert.deepEqual([last.ev, last.by], ['answered', 'PERSON'])
  assert.deepEqual(boss.h.notified, [[out.id, 'lane waits on you: Bash']], 'the notification names the lane and the tool, never the command')
  assert.deepEqual(boss.h.unnotified, [out.id])
  assert.equal(mem.proxy, undefined)
})
test('while unattended no dialog opens: an ask that reached the person waits for a reply and closes only at 15 minutes', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  window(f)
  const out: Record<string, any> = {}
  f.h.onSleep = async () => {
    if (out.done || f.h.now - T0 < 40_000) return
    out.done = true
    const id = (await readAsks(f.$)).asks[0]!.id
    await as(() => promptAnswerCall(lead.$, { id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
    await tickRelay(boss)
    await settle()
  }
  const r: any = await permissionRequest(f.$, { tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1' }, noop)
  assert.match(r.decision.message, /^\[callboard\] Expired/)
  assert.equal(boss.h.calls.length, 0)
  assert.equal((await readAskLog(f.$, 0))!.at(-1)!.ev, 'expired')
})
test('a window that cannot be read opens no dialog', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  f.h.files.set(`${V2}/unattended.json`, 'not json')
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 0)
})
test('the dialog is closed once its ask is closed elsewhere, also while the manager is busy, and the close writes nothing and says nothing', async () => {
  const { f, boss } = await open()
  assert.equal(boss.h.calls.length, 1)
  await tickRelay(boss)
  assert.equal(boss.h.calls[0]!.signal?.aborted, false, 'an open ask keeps its dialog')
  boss.h.draft = 'half a sentence'
  await rmAsk(f.$, 'aa11bb22cc')
  await tickRelay(boss)
  assert.equal(boss.h.calls[0]!.signal?.aborted, true)
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  assert.deepEqual(boss.h.toasts, [])
  assert.deepEqual(boss.h.unnotified, ['aa11bb22cc'])
  assert.equal(mem.proxy, undefined)
})
test('a window that comes on closes the open dialog, and the ask is put again once the window is off', async () => {
  const { f, boss } = await open()
  window(f)
  f.h.now += 11_000
  await tickRelay(boss)
  assert.equal(boss.h.calls[0]!.signal?.aborted, true)
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1, 'none while the window is on')
  f.h.files.delete(`${V2}/unattended.json`)
  f.h.now += 11_000
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 2)
})
test('a pick on an ask closed meanwhile writes nothing and says so, and the next ask waits until the open dialog ends', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  const [a, b] = ['aa11bb22cc', 'dd33ee44ff']
  for (const id of [a, b]) (await writeAsk(f.$, mk(id)), await reach(f, id))
  let click: (l: string) => void = () => undefined
  boss.h.askAnswer = () => new Promise((r) => (click = r))
  shownBy(boss)
  await tickRelay(boss)
  await settle()
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1, 'one dialog at a time')
  const first = mem.proxy!.id
  await rmAsk(f.$, first)
  click('Allow')
  await settle()
  assert.equal(await readAnswer(f.$, first), undefined)
  assert.deepEqual(boss.h.toasts, ['That ask is closed; your click wrote nothing.'])
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 2)
  assert.equal(mem.proxy?.id, first === a ? b : a)
})
test('a question is put as the asker\'s own question, opened with the asker\'s name, and his pick lands as that option once', async () => {
  const question = { header: 'H', question: 'Which?', options: [{ label: 'A', description: 'why' }, { label: 'B', description: '' }] }
  const { f, boss, click } = await open({ tool: 'AskUserQuestion', input: '{"questions":[]}', question })
  assert.deepEqual(boss.h.asked, [{ header: 'H', question: 'lane asks: Which?', options: ['A', 'B'] }])
  assert.deepEqual(boss.h.calls[0]!.input.questions[0].options, [{ label: 'A', description: 'why' }, { label: 'B', description: '' }])
  click('B')
  await settle()
  const got = await readAnswer(f.$, 'aa11bb22cc')
  assert.deepEqual([got?.by, got?.decision, got?.option], ['PERSON', 'answer', 2])
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1, 'an ask is put once')
})
test('a typed answer in place of a pick becomes the person\'s deny with what he typed as the note', async () => {
  const question = { header: 'H', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }
  const { f, click } = await open({ tool: 'AskUserQuestion', input: '{"questions":[]}', question })
  click({ result: { answers: { 'lane asks: Which?': 'neither, use the staging branch' } } })
  await settle()
  const got = await readAnswer(f.$, 'aa11bb22cc')
  assert.deepEqual([got?.by, got?.decision, got?.note], ['PERSON', 'deny', 'neither, use the staging branch'])
})
test('a call of several questions is one dialog, and his picks reach the asker together with the plugin\'s note on every answer', async () => {
  const f = tiers()
  const [lead, boss] = [peer(f, 'sid-lead'), peer(f, 'sid-boss')]
  const q = (question: string, labels: string[]) => ({ header: 'H', question, multiSelect: false, options: labels.map((label) => ({ label, description: 'd' })) })
  const input = { questions: [q('Which?', ['Yes', 'No']), q('Where?', ['Here', 'There', 'Nowhere'])] }
  boss.h.askAnswer = async (text: string) => (text.includes('Which?') ? 'No' : 'There')
  shownBy(boss)
  const out: Record<string, any> = {}
  f.h.onSleep = async () => {
    if (out.done || f.h.now - T0 < 40_000) return
    out.done = true
    const id = (await readAsks(f.$)).asks[0]!.id
    await as(() => promptAnswerCall(lead.$, { id, decision: 'escalate' }, noop))
    await as(() => promptAnswerCall(boss.$, { id, decision: 'escalate' }, noop))
    await tickRelay(boss)
    await settle()
  }
  const r: any = await permissionRequest(f.$, { tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: 't1' }, noop)
  assert.equal(boss.h.calls.length, 1)
  assert.deepEqual(boss.h.asked.map((a) => a.options), [['Yes', 'No'], ['Here', 'There', 'Nowhere']])
  assert.equal(r.decision.behavior, 'allow')
  assert.deepEqual(Object.keys(r.decision.updatedInput.answers), ['Which?', 'Where?'])
  assert.match(r.decision.updatedInput.answers['Which?'], /^No \(chosen by the person/)
  assert.match(r.decision.updatedInput.answers['Where?'], /^There \(chosen by the person/)
})
test('a dismissal of a dialog that went to the person is his deny; one refused before it showed writes nothing and is not put again; one closed by itself while he was idle is put again', async () => {
  const seen = await open()
  seen.click(undefined)
  await settle()
  const got = await readAnswer(seen.f.$, 'aa11bb22cc')
  assert.deepEqual([got?.by, got?.decision], ['PERSON', 'deny'])
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  boss.h.askAnswer = async () => undefined
  await tickRelay(boss)
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined, 'no hook saw it go to him')
  assert.deepEqual(logRows(f, 'relay-refused'), ['aa11bb22cc'])
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1)
  const idle = await open()
  idle.click({ result: { answers: {}, afkTimeoutMs: 60_000 } })
  await settle()
  assert.equal(await readAnswer(idle.f.$, 'aa11bb22cc'), undefined, 'a dialog that closed while he was away is no answer')
  await tickRelay(idle.boss)
  await settle()
  assert.equal(idle.boss.h.calls.length, 2, 'and the ask is put again')
})
test('a hook beneath that answers the dialog in his place writes nothing: only a dialog that went to him is his', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  boss.h.permission = (e, next) => permissionRequest(boss.$, e, Object.assign(async () => ({ decision: { behavior: 'allow' } }), { origin: next.origin, signal: next.signal }))
  boss.h.askAnswer = async () => 'Allow'
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1)
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  assert.deepEqual(logRows(f, 'relay-refused'), ['aa11bb22cc'])
})
test('a cut ask, or a question not shown whole, offers Deny and Leave it; Leave it writes nothing', async () => {
  const cut = await open({ cut: true })
  assert.deepEqual(cut.boss.h.asked[0]!.options, ['Deny', 'Leave it'])
  assert.match(cut.boss.h.asked[0]!.question, /Not shown whole, so you can only deny it\./)
  cut.click('Leave it')
  await settle()
  assert.equal(await readAnswer(cut.f.$, 'aa11bb22cc'), undefined)
  const q = (question: string) => ({ header: 'H', question, options: [{ label: 'A' }, { label: 'B' }] })
  const long = await open({ tool: 'AskUserQuestion', input: '{}', questions: [q('One?'), q('x'.repeat(5000))] })
  assert.deepEqual(long.boss.h.asked.map((a) => a.options), [['Deny', 'Leave it']], 'a call not shown whole cannot be answered, only denied')
  long.click('Deny')
  await settle()
  assert.equal((await readAnswer(long.f.$, 'aa11bb22cc'))?.decision, 'deny')
})
test('the OFF file and a busy manager open no dialog', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  f.h.files.set(`${HOME}/.claude/callboard/OFF`, '')
  await tickRelay(boss)
  f.h.files.delete(`${HOME}/.claude/callboard/OFF`)
  boss.h.draft = 'half a sentence'
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 0)
  boss.h.draft = ''
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1)
})
test('with the guard missing no dialog opens, and a pick that finds it missing says so and leaves the ask to be put again', async () => {
  const { f, boss, click } = await open()
  assert.equal(boss.h.calls.length, 1)
  f.h.files.delete(`${HOME}/.claude/callboard/.protected-checkout`)
  mem.guard = undefined
  click('Allow')
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  assert.match(boss.h.toasts[0]!, /guard/)
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 1)
  f.h.files.set(`${HOME}/.claude/callboard/.protected-checkout`, '')
  mem.guard = undefined
  await tickRelay(boss)
  await settle()
  assert.equal(boss.h.calls.length, 2)
})
test('a folder that cannot be listed leaves the dialog open: the read failed, the ask did not close', async () => {
  const f = tiers()
  await writeAsk(f.$, mk('aa11bb22cc'))
  assert.equal(await askOpen(f.$, 'aa11bb22cc'), true)
  assert.equal(await askOpen(f.$, 'ee11ff22aa'), false)
  const broken = { ...f.$, fs: { ...f.$.fs, list: () => Promise.reject(new Error('x')) } }
  assert.equal(await askOpen(broken, 'ee11ff22aa'), true)
})

test('the first dialog shows the manager\'s own note and no command, never the lead\'s, and offers Allow, Show the command and Deny; an escalate with no note, a cut ask or a question keeps what it showed', async () => {
  const shown = async (id: string, over: Partial<Ask>, lead: string | undefined, boss: string | undefined) => {
    const f = tiers()
    const b = peer(f, 'sid-boss')
    f.h.sleepMoves = false
    await writeAsk(f.$, mk(id, over))
    await writeUp(f.$, id, 'sid-lead', 'escalated', T0, lead)
    await writeUp(f.$, id, 'sid-boss', 'escalated', T0, boss)
    b.h.askAnswer = async () => 'Deny'
    await tickRelay(b)
    await settle()
    return b.h.asked[0]!
  }
  const both = await shown('aa11bb22cc', {}, 'Lead: safe build.', 'Manager: runs make. Low risk.')
  assert.equal(both.question, "lane wants to run Bash.\n\nBOSS's summary: Manager: runs make. Low risk.", 'the label names the manager, never the lead')
  assert.doesNotMatch(both.question, /Lead: safe|"command"/)
  assert.deepEqual(both.options, ['Allow', 'Show the command', 'Deny'])
  const bare = await shown('bb11cc22dd', {}, 'Lead: safe build.', undefined)
  assert.match(bare.question, /"command":"make"/)
  assert.doesNotMatch(bare.question, /Lead: safe|summary:/)
  const cut = await shown('cc11dd22ee', { cut: true }, undefined, 'Manager: runs make.')
  assert.deepEqual(cut.options, ['Deny', 'Leave it'])
  assert.match(cut.question, /Not shown whole, so you can only deny it\./)
  const q = { header: 'H', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }
  const asked = await shown('dd11ee22ff', { tool: 'AskUserQuestion', input: '{}', question: q }, undefined, 'Manager: a note.')
  assert.doesNotMatch(asked.question, /Manager: a note/)
  assert.deepEqual(asked.options, ['A', 'B'])
  const stuck = await shown('ee11ff22aa', { tool: 'AskUserQuestion', input: '{}', cut: true, question: q }, undefined, 'Manager: a note.')
  assert.doesNotMatch(stuck.question, /Manager: a note/)
})

test('with a note, Allow or Deny on it decides at once and Show the command opens the command\'s own dialog; a dismissal or a closed ask at either step writes what it should', async () => {
  const run = async (answers: unknown[], over: Partial<Ask> = {}, between?: (f: F) => Promise<void>) => {
    const f = tiers()
    const b = peer(f, 'sid-boss')
    f.h.sleepMoves = false
    await writeAsk(f.$, mk('aa11bb22cc', over))
    await writeUp(f.$, 'aa11bb22cc', 'sid-lead', 'escalated', T0, 'Lead: safe build.')
    await writeUp(f.$, 'aa11bb22cc', 'sid-boss', 'escalated', T0, 'Manager: runs make. Low risk.')
    shownBy(b)
    b.h.askAnswer = async () => {
      await between?.(f)
      return answers.shift()
    }
    await tickRelay(b)
    await settle()
    return { b, f, got: await readAnswer(f.$, 'aa11bb22cc') }
  }
  const ok = await run(['Show the command', 'Allow'])
  assert.deepEqual(ok.b.h.asked.map((a) => a.options), [['Allow', 'Show the command', 'Deny'], ['Allow', 'Deny']])
  assert.doesNotMatch(ok.b.h.asked[0]!.question, /"command"/)
  assert.match(ok.b.h.asked[1]!.question, /"command":"make"[\s\S]*Your click decides this ask only\./)
  assert.doesNotMatch(ok.b.h.asked[1]!.question, /Manager: runs make/)
  assert.deepEqual([ok.got?.by, ok.got?.decision], ['PERSON', 'allow'])
  assert.equal(mem.proxy, undefined)
  const direct = await run(['Allow'])
  assert.equal(direct.b.h.asked.length, 1)
  assert.deepEqual([direct.got?.by, direct.got?.decision], ['PERSON', 'allow'], 'Allow on the note decides at once, with no second dialog')
  const first = await run(['Deny'])
  assert.equal(first.b.h.asked.length, 1)
  assert.deepEqual([first.got?.by, first.got?.decision], ['PERSON', 'deny'])
  const second = await run(['Show the command', 'Deny'])
  assert.deepEqual([second.b.h.asked.length, second.got?.decision], [2, 'deny'])
  const gone1 = await run([undefined])
  assert.deepEqual([gone1.b.h.asked.length, gone1.got?.decision], [1, 'deny'], 'a dismissal of the note is his deny')
  const gone2 = await run(['Show the command', undefined])
  assert.deepEqual([gone2.b.h.asked.length, gone2.got?.decision], [2, 'deny'])
  const closed = await run(['Show the command'], {}, async (f) => rmAsk(f.$, 'aa11bb22cc'))
  assert.deepEqual([closed.b.h.asked.length, closed.got], [1, undefined], 'an ask closed while the note is up opens no second dialog and writes nothing')
  let calls = 0
  const closed2 = await run(['Show the command', 'Allow'], {}, async (f) => (++calls === 2 ? rmAsk(f.$, 'aa11bb22cc') : undefined))
  assert.deepEqual([closed2.b.h.asked.length, closed2.got], [2, undefined], 'an Allow on an ask closed while the command is up writes nothing')
  assert.equal(closed2.b.h.toasts.length, 1)
  const closed3 = await run(['Allow'], {}, async (f) => rmAsk(f.$, 'aa11bb22cc'))
  assert.deepEqual([closed3.b.h.asked.length, closed3.got], [1, undefined], 'an Allow on the note of an ask closed meanwhile writes nothing')
  const big = await run(['Show the command', 'Deny'], { input: '<'.repeat(6000) })
  assert.deepEqual(big.b.h.asked.map((a) => a.options), [['Show the command', 'Deny'], ['Deny', 'Leave it']], 'a command too large to print leaves no Allow on the note and Deny only in the second dialog')
  assert.match(big.b.h.asked[1]!.question, /Not shown whole, so you can only deny it\./)
})

test('once the self-test stopped its run, a Bash ask is the engine\'s own dialog for the command: his Yes is his allow, his No his deny with what he typed, and a Yes on a changed command writes nothing and is not put again', async () => {
  const run = async (answer: unknown, over: Partial<Ask> = {}, note?: string) => {
    const f = tiers()
    const boss = peer(f, 'sid-boss')
    f.h.sleepMoves = false
    await nativeBy(boss)
    await writeAsk(f.$, mk('aa11bb22cc', over))
    await writeUp(f.$, 'aa11bb22cc', 'sid-lead', 'escalated', T0)
    await writeUp(f.$, 'aa11bb22cc', 'sid-boss', 'escalated', T0, note)
    boss.h.bashAnswer = async () => answer
    await tickRelay(boss)
    await settle()
    return { f, boss, got: await readAnswer(f.$, 'aa11bb22cc') }
  }
  const yes = await run(true, { input: '{"command":"make","description":"Build it"}' }, 'Manager: runs make.')
  assert.deepEqual(yes.boss.h.bash, [SELF_TEST, { command: 'make', description: 'Relayed from lane' }], 'never the asker\'s own description')
  assert.deepEqual(yes.boss.h.reasons, ["Your click decides this ask only. BOSS's summary: Manager: runs make."])
  assert.equal(yes.boss.h.calls.length, 0, 'no question is put')
  assert.deepEqual([yes.got?.by, yes.got?.decision], ['PERSON', 'allow'])
  assert.equal(mem.proxy, undefined)
  const said = await run('use make test instead')
  assert.deepEqual([said.got?.by, said.got?.decision, said.got?.note], ['PERSON', 'deny', 'use make test instead'])
  assert.deepEqual(said.boss.h.reasons, ['Your click decides this ask only.'])
  const no = await run(false)
  assert.deepEqual([no.got?.decision, no.got?.note], ['deny', undefined])
  const changed = await run({ command: 'make install' })
  assert.equal(changed.got, undefined)
  assert.deepEqual(changed.boss.h.toasts, ['The command was changed in the dialog, so your Yes wrote nothing. The ask goes on as before.'])
  await tickRelay(changed.boss)
  await settle()
  assert.equal(changed.boss.h.bash.length, 2, 'an ask is put once')
  const wide = await run(true, { input: '{"command":"make","dangerouslyDisableSandbox":true}' })
  assert.deepEqual([wide.boss.h.bash.length, wide.boss.h.calls.length], [1, 1], 'a key that dialog would not show keeps the question form')
  const hidden = await run(true, { input: JSON.stringify({ command: 'make‮' }) })
  assert.deepEqual([hidden.boss.h.bash.length, hidden.boss.h.calls.length], [1, 1], 'so does a character that could hide text')
})
test('a run the hook did not stop turns the engine\'s dialog off and puts the question in its place; a refusal before it went to him puts the question and keeps it on', async () => {
  const setup = async () => {
    const f = tiers()
    const boss = peer(f, 'sid-boss')
    f.h.sleepMoves = false
    await nativeBy(boss)
    await writeAsk(f.$, mk('aa11bb22cc'))
    await reach(f, 'aa11bb22cc')
    boss.h.bashAnswer = async () => true
    boss.h.askAnswer = async () => 'Allow'
    return { f, boss }
  }
  const ran = await setup()
  ran.boss.h.toolRun = undefined
  await tickRelay(ran.boss)
  await settle()
  assert.equal(mem.native, false)
  assert.deepEqual(logRows(ran.f, 'relay-ran'), ['aa11bb22cc'])
  assert.deepEqual(ran.boss.h.toasts, ['A relayed command ran in this session. Until callboard restarts, it puts asks as its own questions.'])
  assert.equal(ran.boss.h.calls.length, 1)
  assert.deepEqual([(await readAnswer(ran.f.$, 'aa11bb22cc'))?.decision], ['allow'], 'his answer comes from the question')
  const refused = await setup()
  refused.boss.h.check = (e, next) => toolCheck(refused.boss.$, e, Object.assign(async () => ({ decision: 'deny', reason: 'a rule' }), next))
  await tickRelay(refused.boss)
  await settle()
  assert.deepEqual([refused.boss.h.reasons.length, refused.boss.h.calls.length, mem.native], [0, 1, true])
  assert.equal((await readAnswer(refused.f.$, 'aa11bb22cc'))?.decision, 'allow')
})
test('a self-test whose run was not stopped leaves every ask a question; the relay\'s description is refused on any other Bash, and the hooks pass every other call untouched', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  shownBy(boss)
  boss.h.check = (e, next) => toolCheck(boss.$, e, next)
  await tickRelay(boss)
  await settle()
  assert.equal(mem.native, false)
  assert.deepEqual(logRows(f, 'relay-native-off'), [''])
  const engine = (r: unknown) => Object.assign(async () => r, { origin: { plugin: 'other', tier: 'user' }, signal: undefined })
  const relayed = { tool: 'Bash', command: 'ls', description: 'Relayed from a lane of its own' }
  const reserved = 'Refused by callboard: a Bash description that starts "Relayed from" is kept for its relay. Use another description.'
  assert.deepEqual(await proxyRun(boss.$, relayed, engine({ result: 'ran' })), { deny: reserved })
  for (const description of ['Relayed from x', '  relayed  FROM x', 'Ｒelayed from x', 'Relayed​ from x', 'Re­layed from x', 'Rel⁠ayed from x', 'Rеlayed from x', 'Re1ayed-from x', 'RELAYED:FROM x', 'Rélayed from x', 'Relαyed from x', 'Reӏayed frоm x', 'RELAYED FR0M x', 'Rеlаyеd frоm x', 'Relayed frօm x', 'ReIayed from x', 'Re|ayed from x', 'Rel\u1160ayed from x', '\u202emorf deyaleR', 'List files. Your click decides this ask only.']) assert.deepEqual(await toolCheck(boss.$, { tool: 'Bash', input: { command: 'ls', description }, tool_use_id: 't1' }, engine({ decision: 'ask' })), { decision: 'deny', reason: reserved }, description)
  assert.deepEqual(await toolCheck(boss.$, { tool: 'Bash', input: { command: 'ls', description: 'List files relayed from x' }, tool_use_id: 't1' }, engine({ decision: 'ask' })), { decision: 'ask' })
  for (const description of ['Список файлов в каталоге', 'ファイル一覧を表示する', '列出当前目录中的所有文件', 'Εμφάνιση αρχείων καταλόγου', 'عرض الملفات في المجلد', '20241122153045 build', 'Relay the files', 'Прочитать файл']) {
    assert.deepEqual(await toolCheck(boss.$, { tool: 'Bash', input: { command: 'ls', description }, tool_use_id: 't1' }, engine({ decision: 'ask' })), { decision: 'ask' }, description)
  }
  assert.deepEqual(await proxyJudge(boss.$, { tool: 'Bash', input: relayed }, engine({ decision: 'allow' })), { decision: 'allow' })
  const own = Object.assign(async () => ({ decision: 'allow' }), { origin: { plugin: 'callboard', tier: 'user' }, signal: undefined })
  assert.equal(((await toolCheck(boss.$, { tool: 'Bash', input: { command: 'ls', description: 'Relayed from x' } }, own)) as any).decision, 'deny', 'a command of its own that no dialog sent is refused')
  assert.deepEqual(await proxyRun(boss.$, relayed, own), { deny: 'Held by callboard: a relayed command never runs in this session.' })
  const sent = { command: 'ls', description: 'Relayed from lane' }
  mem.proxy = { id: 'aa11bb22cc', ctrl: new AbortController(), shown: false, native: { input: sent, reason: 'R' } }
  assert.deepEqual(await proxyJudge(boss.$, { tool: 'Bash', input: sent }, own), { decision: 'ask', reason: 'R' }, 'auto mode\'s classifier is not asked about the open dialog\'s command')
  assert.deepEqual(await proxyJudge(boss.$, { tool: 'Bash', input: { ...sent, command: 'rm' } }, own), { decision: 'allow' })
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }]
  const seen: any[] = []
  const spy = Object.assign(async (x: any) => (seen.push(x), {}), { origin: { plugin: 'callboard', tier: 'user' }, signal: undefined })
  await permissionRequest(boss.$, { tool_name: 'Bash', tool_input: sent, permission_suggestions: suggestions, tool_use_id: 't1' }, spy)
  await permissionRequest(boss.$, { tool_name: 'Bash', tool_input: SELF_TEST, permission_suggestions: suggestions, tool_use_id: 't2' }, spy)
  assert.deepEqual(seen.map((x) => x.permission_suggestions), [[], []], 'every Bash of the plugin goes down the chain with no suggestions')
})
test('a deny after his Yes that is not the engine\'s rejection writes nothing and is not put again; a tick that closes the dialog writes nothing and puts it again', async () => {
  const f = tiers()
  const boss = peer(f, 'sid-boss')
  f.h.sleepMoves = false
  await nativeBy(boss)
  await writeAsk(f.$, mk('aa11bb22cc'))
  await reach(f, 'aa11bb22cc')
  boss.h.bashAnswer = async () => true
  boss.h.toolRun = async () => ({ deny: 'a hook above refused the run' })
  await tickRelay(boss)
  await settle()
  assert.equal(await readAnswer(f.$, 'aa11bb22cc'), undefined)
  assert.deepEqual(logRows(f, 'relay-unread'), ['aa11bb22cc'])
  await tickRelay(boss)
  await settle()
  assert.deepEqual([boss.h.bash.length, boss.h.calls.length, mem.native], [2, 0, true])
  const g = tiers()
  const b2 = peer(g, 'sid-boss')
  g.h.sleepMoves = false
  await nativeBy(b2)
  await writeAsk(g.$, mk('aa11bb22cc'))
  await reach(g, 'aa11bb22cc')
  b2.h.bashAnswer = () => new Promise(() => undefined)
  await tickRelay(b2)
  await settle()
  window(g)
  g.h.now += 11_000
  await tickRelay(b2)
  await settle()
  assert.equal(await readAnswer(g.$, 'aa11bb22cc'), undefined)
  g.h.files.delete(`${V2}/unattended.json`)
  g.h.now += 11_000
  await tickRelay(b2)
  await settle()
  assert.equal(b2.h.bash.length, 3, 'put again once the window is off')
})
