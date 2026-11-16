import { expect, test } from 'claude-code/testing'
import { REST_TEXT, REST_SET, REST_FAILED, REST_SUBAGENT, REST_TOOL, helpText, LANES_CHANGED_TEXT, nudgeText, KEEPALIVE_TEXT, noticeText, configSetText, CONFIG_DEFAULTS, OFF_NOTHING } from '../hooks/core'
import { toolText } from '../hooks/tool-text'
import { h, GOOD, SID, extraStat, laneSeed, longTest, storeFiles, submitted, toolDefs } from './harness'
import type { Trace } from './harness'
import { advanceQuiet, cue, fileStat, kaLog, lane, LEAD_LANES, leadAt, logged, MIN, newTrace, notices, nudges, OWN_ROW, ownTurn, PERSON, person, pings, realTurn, REG, REGFILE, renameThroughTick, retireTarget, SELFREG, sent, STATUS_NONE, STOREFILE, storeText, stv, ticks, tickTwice, TURN, waitFor, warm } from './fixtures'

longTest('keepalive: an idle session is pinged 50 minutes after its last turn ended, not at 49, and once per gap', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(49 * MIN)
  expect(pings()).toEqual([])
  await h.clock!.advance(MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  expect(kaLog(stdins)).toEqual(['keepalive:'])
  // The ping's own turn never ran here (no hooks in the kit): no second attempt in this gap.
  await h.clock!.advance(7 * MIN)
  expect(pings().length).toBe(1)
  expect(kaLog(stdins)).toEqual(['keepalive:'])
})

test('keepalive: a prompt that ran no turn also starts a new gap', async ($, on) => {
  await warm($, on)
  await advanceQuiet(30 * MIN)
  await $.prompt.submit({ text: 'queued' } as any)
  await advanceQuiet(25 * MIN)
  expect(pings()).toEqual([])
  await advanceQuiet(25 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

longTest('keepalive: past 58 minutes the cache is cold: no ping, logged once; the next turn starts a new gap', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.draftNow = 'typing'
  await advanceQuiet(58 * MIN)
  h.draftNow = ''
  await h.clock!.advance(3 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:cold'])
  await advanceQuiet(10 * MIN)
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:cold'])
  await realTurn($, 'more')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('/callboard rest: no ping and no cache nudge in this gap, logged once; a reload keeps it; the next real turn restores the pings; any origin may type it', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(10 * MIN)
  expect((await $.command.run(lane('rest', { kind: 'plugin', name: 'x' }))).text).toBe(REST_TEXT)
  await advanceQuiet(45 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  // A reload of the mod keeps the state, so the gap stays quiet.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await h.clock!.advance(2 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  // A real turn in this session ends it.
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await ownTurn($, KEEPALIVE_TEXT)
  await h.clock!.advance(10_000)
  // Typed again, it holds for the new gap only.
  await $.command.run(lane('rest'))
  await h.clock!.advance(10_000)
  await realTurn($, 'once more')
  await advanceQuiet(50 * MIN)
  expect(pings().length).toBe(2)
  await ownTurn($, KEEPALIVE_TEXT)
  await h.clock!.advance(10_000)
  // Typed while a real turn is running, it holds past that turn's end.
  await $.prompt.submit({ text: 'long job' } as any)
  await $.turn.start({ turnId: 'real', text: 'long job' } as any)
  await $.command.run(lane('rest'))
  await h.clock!.advance(10_000)
  await $.turn.complete(TURN as any)
  await advanceQuiet(60 * MIN)
  expect(pings().length).toBe(2)
})

const restTool = (input: Record<string, unknown> = {}) => ({ tool: `mcp__callboard__${REST_TOOL}`, ...input }) as any

test('the rest tool: the session\'s own agent sets the same rest as /callboard rest, mid-turn, with no question; the next real turn restores the pings', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  expect(toolDefs).toContain(JSON.stringify({ name: REST_TOOL, description: toolText(REST_TOOL, 'any'), inputSchema: { type: 'object', properties: {} } }))
  // Called while the agent's own turn runs, it holds past that turn's end.
  await $.prompt.submit({ text: 'go idle' } as any)
  await $.turn.start({ turnId: 'real', text: 'go idle' } as any)
  h.lastQuestion = undefined
  expect(await $.tool.call(restTool())).toEqual({ result: REST_SET })
  expect(h.lastQuestion).toBe(undefined)
  expect(logged(stdins)).toContain('command:rest:tool')
  await $.turn.complete(TURN as any)
  await advanceQuiet(55 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  // A real turn in this session ends it, as it ends a typed one.
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('the rest tool: a subagent is refused, so it never rests its parent session', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(10 * MIN)
  expect(await $.tool.call(restTool({ agentId: 'a1' }))).toEqual({ deny: REST_SUBAGENT })
  expect(logged(stdins)).toContain('refused:rest-subagent')
  expect(logged(stdins).some((x) => x.startsWith('command:rest'))).toBe(false)
  await advanceQuiet(40 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  expect(kaLog(stdins)).toEqual(['keepalive:'])
})

test('the rest tool: a reload of the mod keeps the rest, and a state write that fails denies the call and leaves the pings on', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  await advanceQuiet(10 * MIN)
  expect(await $.tool.call(restTool())).toEqual({ result: REST_SET })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await advanceQuiet(45 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  await realTurn($, 'back')
  trace.failKeys = new Set(['restAt'])
  expect(await $.tool.call(restTool())).toEqual({ deny: REST_FAILED })
  expect(logged(stdins).filter((x) => x === 'command:rest:tool').length).toBe(1)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

// How many pings an idle stretch gets, by the stored settings: a slot comes every `ping after` minutes and the stop clock refuses one at or past `stop after`.
for (const [what, cfg, count] of [
  ['the lowest stop (1 h) gives 1 ping', { pingAfterMin: 50, stopAfterH: 1 }, 1],
  ['a stop of 3 h a Mac saved earlier still gives 3', { pingAfterMin: 50, stopAfterH: 3 }, 3],
  ['the widest bounds (ping 30, stop 8 h) give 15', { pingAfterMin: 30, stopAfterH: 8 }, 15],
] as const) {
  longTest(`keepalive: ${what}`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    for (const arg of [`ping ${cfg.pingAfterMin}`, `stop ${cfg.stopAfterH}`]) await $.command.run(lane(`config ${arg}`))
    await realTurn($, 'work on')
    // Below the cache nudge's level, so every slot is a ping.
    h.tokensNow = 120_000
    for (let i = 1; i <= count; i++) {
      await advanceQuiet(cfg.pingAfterMin * MIN)
      expect(sent(stdins)).toBe(i)
      await h.clock!.advance(2000)
      await ownTurn($, KEEPALIVE_TEXT)
    }
    await advanceQuiet(cfg.pingAfterMin * MIN)
    expect(sent(stdins)).toBe(count)
    expect(kaLog(stdins).filter((x) => x === 'keepalive-stopped:')).toEqual(['keepalive-stopped:'])
  })
}

test('keepalive: with the lowest stop (1 h) a large idle session gets its one ping and no cache nudge', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await $.command.run(lane('config stop 1'))
  await realTurn($, 'work on')
  h.tokensNow = 200_000
  await advanceQuiet(50 * MIN)
  expect(sent(stdins)).toBe(1)
  await h.clock!.advance(2000)
  await ownTurn($, KEEPALIVE_TEXT)
  await advanceQuiet(50 * MIN)
  expect(sent(stdins)).toBe(1)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  expect(submitted.includes(nudgeText('cache'))).toBe(false)
})

test('/rest is /callboard rest: the same answer and the same quiet gap, from any origin, with any arguments ignored', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(10 * MIN)
  expect((await $.command.run({ command: 'rest', args: '', origin: { kind: 'plugin', name: 'x' } } as any)).text).toBe(REST_TEXT)
  await advanceQuiet(45 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await ownTurn($, KEEPALIVE_TEXT)
  await h.clock!.advance(10_000)
  expect((await $.command.run({ command: 'rest', args: 'lead', origin: PERSON } as any)).text).toBe(REST_TEXT)
  expect(helpText()).toContain('/rest')
})

test('keepalive: after a restart (the session state is gone) nothing is pinged until a turn has been seen to end', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  for (const k of ['turnEndAt', 'realEndAt', 'pingAt']) trace.st!.delete(k)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await advanceQuiet(56 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual([])
  await $.turn.complete(TURN as any)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('keepalive: a reload of the mod keeps the gap (the state survives): the ping still comes 50 minutes after the turn', async ($, on) => {
  await warm($, on)
  await advanceQuiet(20 * MIN)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await advanceQuiet(29 * MIN)
  expect(pings()).toEqual([])
  await h.clock!.advance(MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

for (const [what, setup] of [
  ['the session has no registry row (a headless run)', async () => { h.sessions = {}; h.ownEntryAuto = false }],
  ['its row is a claude --bg background worker', async () => { h.sessions = OWN_ROW({ kind: 'background' }) }],
  ['its row carries no kind', async () => { h.sessions = OWN_ROW({ kind: undefined }) }],
  ['a draft sits in the box', async () => { h.draftNow = 'typing' }],
  ['it is busy', async () => { h.sessions = OWN_ROW({ status: 'busy' }) }],
  ['it waits for a permission', async () => { h.sessions = OWN_ROW({ waitingFor: 'permission' }) }],
  ['keepalive is off', async ($: any) => { expect((await $.command.run(lane('config keepalive off'))).text).toBe(configSetText('keepalive', { ...CONFIG_DEFAULTS, keepalive: false })) }],
] as const) {
  test(`keepalive: no ping when ${what}`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    await setup($)
    await advanceQuiet(52 * MIN)
    expect(pings()).toEqual([])
    expect(kaLog(stdins)).toEqual([])
  })
}

longTest('keepalive: no ping while a callboard dialog is open', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(50 * MIN - 30_000)
  h.askHang = new Promise<string>(() => undefined)
  const n = h.askCount
  const p = $.command.run(lane('lead', { kind: 'plugin' }))
  await waitFor(() => h.askCount !== n)
  await h.clock!.advance(60_000)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual([])
  await h.clock!.advance(60_000)
  expect((await p).text).toBe('Lead stays off. The question timed out.')
  h.askHang = undefined
})

test('keepalive: no ping while the session has a request of its own', async ($, on) => {
  await person($, on, [], undefined, true)
  h.sessions = OWN_ROW()
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await advanceQuiet(52 * MIN)
  expect(pings()).toEqual([])
})

longTest('keepalive: no ping while a nudge is recorded', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  await advanceQuiet(45 * MIN)
  // The recorded nudge cannot be cleared, so nudgeTick never sends it and it stays recorded through the ping time.
  trace.failKeys = new Set(['nudgeDue'])
  trace.st!.set('nudgeDue', { value: { kind: 'lead', at: h.nowMs }, version: 70 })
  await h.clock!.advance(7 * MIN)
  expect(pings()).toEqual([])
  expect(nudges()).toEqual([])
})

test('keepalive: a plain interactive session that never ran a callboard command is pinged, and /callboard off does not stop it', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(2000)
  await ownTurn($, KEEPALIVE_TEXT)
  await realTurn($, 'more')
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT, KEEPALIVE_TEXT])
  expect(kaLog(stdins)).toEqual(['keepalive:', 'keepalive:'])
})

test('keepalive: a lead is pinged (D4)', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('off'))
  laneSeed.text = LEAD_LANES('/data/x/work')
  await $.command.run(lane('lead'))
  expect((await $.command.run(lane('status'))).text).toContain('| Lane | NONE |\n| Lead | ON |')
  h.sessions = OWN_ROW()
  await $.turn.complete(TURN as any)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

for (const [what, set, line] of [
  ['fails', () => { h.submitFails = true }, 'keepalive-failed:'],
  ['hangs past the timeout', () => { h.submitHangs = true }, 'keepalive-unconfirmed:'],
] as const) {
  test(`keepalive: a ping whose submit ${what} is logged and not tried again in that gap`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    set()
    await advanceQuiet(56 * MIN)
    expect(pings().length).toBe(1)
    expect(kaLog(stdins)).toEqual([line])
  })
}

test('keepalive: a ping turn moves neither the turn mark nor the stop clock and records no nudge; a lane that signed done stays retire-able', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await renameThroughTick($, on, stdins, 1, trace)
  h.sessions = SELFREG({ kind: 'interactive' })
  await realTurn($, 'work on it')
  const realEnd = stv(trace, 'realEndAt')
  expect(typeof realEnd).toBe('number')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  // The lane signs done after the ping went out; the ping's turn runs after that.
  h.reportFile = { text: `# r\nstatus: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  h.tokensNow = 400_000
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  expect(stv(trace, 'turnEndAt')).toBe(h.nowMs)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  expect(await cue(140, 'retire\n', { mtimeSec: h.nowMs / 1000 })).toBe('retire ok - 140\n')
})

for (const [what, make] of [
  ['a nudge', async ($: any) => {
    h.tokensNow = 310_000
    await $.turn.complete(TURN as any)
    await ticks(1)
    h.tokensNow = 150_000
    return nudges()[0]
  }],
  ['a notice', async (_: any, trace: Trace) => {
    trace.st!.set('request', { value: { id: 'r1', phase: 'compacting', mode: 'now', focus: 'f', continuation: 'c', sha256: 'a'.repeat(64), requestedMs: h.nowMs - 20 * MIN, compactingMs: h.nowMs - 16 * MIN }, version: 80 })
    await ticks(1)
    return noticeText('compact-unconfirmed')
  }],
] as const) {
  test(`keepalive: ${what} turn is not real work: it moves the gap but not the stop clock (A)`, async ($, on) => {
    const trace = newTrace()
    await warm($, on, [], trace)
    await advanceQuiet(10 * MIN)
    const text = await make($, trace)
    expect(submitted).toContain(text)
    const realEnd = stv(trace, 'realEndAt')
    await h.clock!.advance(MIN)
    await ownTurn($, text)
    expect(stv(trace, 'realEndAt')).toBe(realEnd)
    expect(stv(trace, 'turnEndAt')).toBe(h.nowMs)
  })
}

test('keepalive: the lanes-changed turn is not real work either (A)', async ($, on) => {
  const trace = newTrace()
  await leadAt($, on, [], { clock: true, trace })
  await $.turn.complete(TURN as any)
  const realEnd = stv(trace, 'realEndAt')
  expect(typeof realEnd).toBe('number')
  await h.clock!.advance(MIN)
  storeFiles.set(STOREFILE, storeText(1))
  await tickTwice()
  expect(notices()).toBe(1)
  await ownTurn($, LANES_CHANGED_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  expect(stv(trace, 'turnEndAt')).toBe(h.nowMs)
})

test('keepalive: a lane a lead started (its start text is real work) and then left idle is pinged', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  extraStat.set('/data/x/work/lab/BRIEF.md', fileStat)
  expect(await cue(43, 'start\n')).toBe('start ok - 43\n')
  h.sessions = { [REGFILE]: REG({ kind: 'interactive' }) }
  await ownTurn($, submitted[0])
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

longTest('keepalive: pings stop 2 hours after the last real turn, so an idle gap gets 2, logged once; a real turn starts them again', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  const realEnd = stv(trace, 'realEndAt')
  // Below the cache nudge's level, so the second slot is a ping too.
  h.tokensNow = 120_000
  for (let i = 1; i <= 2; i++) {
    await advanceQuiet(50 * MIN)
    expect(sent(stdins)).toBe(i)
    await h.clock!.advance(2000)
    // The ping's turn as the engine runs it (no prompt hook of the mod's own): it moves no stop clock.
    await ownTurn($, KEEPALIVE_TEXT)
    expect(stv(trace, 'realEndAt')).toBe(realEnd)
  }
  // 100 minutes after the real turn: the next gap ends past 2 hours.
  await advanceQuiet(50 * MIN)
  expect(sent(stdins)).toBe(2)
  expect(kaLog(stdins).filter((x) => x === 'keepalive-stopped:')).toEqual(['keepalive-stopped:'])
  await h.clock!.advance(30 * MIN)
  expect(kaLog(stdins).filter((x) => x === 'keepalive-stopped:').length).toBe(1)
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(sent(stdins)).toBe(3)
})

for (const [what, arrange] of [
  ['a recorded nudge', (trace: Trace) => trace.st!.set('nudgeDue', { value: { kind: 'lead', at: h.nowMs }, version: 90 })],
  // The session is not a lane, so its own request carries viaNudge (self), as one it made itself would.
  ['a compaction resume', (trace: Trace) => trace.st!.set('request', { value: { id: 'r2', phase: 'compacted', mode: 'now', focus: 'f', continuation: 'next', sha256: 'a'.repeat(64), requestedMs: h.nowMs, compactingMs: h.nowMs, compactedMs: h.nowMs, viaNudge: true }, version: 90 })],
] as const) {
  test(`keepalive: ${what} due in the same tick as a ping goes out alone: one submit per tick (F2a)`, async ($, on) => {
    const trace = newTrace()
    await warm($, on, [], trace)
    await advanceQuiet(50 * MIN - 2000)
    const before = submitted.length
    arrange(trace)
    await h.clock!.advance(2000)
    expect(submitted.length).toBe(before + 1)
    expect(pings()).toEqual([])
  })
}

test('keepalive: an idle session past the idle level gets the nudge in place of the ping, and nothing more in that gap (D2)', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 310_000
  await advanceQuiet(50 * MIN)
  expect(logged(stdins)).toContain('nudge-due:idle')
  await h.clock!.advance(7 * MIN)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(pings()).toEqual([])
})

test('keepalive: a session with background work between the two levels gets the soft nudge in place of the ping', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 350_000
  h.agentsNow = [{ status: 'running' }]
  await advanceQuiet(50 * MIN)
  expect(logged(stdins)).toContain('nudge-due:idle')
  await h.clock!.advance(7 * MIN)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(pings()).toEqual([])
})

for (const [what, arrange] of [
  ['past the idle level, inside the 30-minute nudge gap', (trace: Trace) => { h.tokensNow = 310_000; trace.st!.set('counters', { value: { lastNudgeMs: h.nowMs - 10 * MIN, nudgeTimes: [h.nowMs - 10 * MIN] }, version: 91 }) }],
  ['past the idle level, inside the compaction gap', (trace: Trace) => { h.tokensNow = 310_000; trace.st!.set('counters', { value: { lastCompactMs: h.nowMs - 20 * MIN }, version: 91 }) }],
] as const) {
  test(`keepalive: ${what}: the plain ping (D2)`, async ($, on) => {
    const stdins: string[] = []
    const trace = newTrace()
    await warm($, on, stdins, trace)
    await advanceQuiet(49 * MIN)
    arrange(trace)
    await h.clock!.advance(3 * MIN)
    expect(pings()).toEqual([KEEPALIVE_TEXT])
    expect(nudges()).toEqual([])
    expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  })
}

longTest('keepalive: a nudge recorded in place of a ping that is then dropped is logged once as a missed ping, and not recorded again', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 310_000
  await advanceQuiet(50 * MIN)
  expect(logged(stdins)).toContain('nudge-due:idle')
  h.draftNow = 'typing'
  await advanceQuiet(11 * MIN)
  expect(logged(stdins)).toContain('nudge-dropped:expired')
  h.draftNow = ''
  await h.clock!.advance(5 * MIN)
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:nudge-dropped'])
  expect(logged(stdins).filter((x) => x.startsWith('nudge-due')).length).toBe(1)
  expect(nudges()).toEqual([])
  expect(pings()).toEqual([])
})

// At 200k, past the cache nudge's level and below the idle one, too.
for (const tokens of [400_000, 200_000]) {
  test(`keepalive: a lane signed done gets neither the ping nor a nudge at ping time (D5), at ${tokens / 1000}k`, async ($, on) => {
    const stdins: string[] = []
    await retireTarget($, on, stdins)
    h.sessions = SELFREG({ kind: 'interactive' })
    await $.turn.complete(TURN as any)
    h.tokensNow = tokens
    await advanceQuiet(56 * MIN)
    expect(pings()).toEqual([])
    expect(nudges()).toEqual([])
    expect(submitted.includes(nudgeText('cache'))).toBe(false)
    expect(kaLog(stdins)).toEqual(['keepalive-skipped:lane-done'])
  })
}
