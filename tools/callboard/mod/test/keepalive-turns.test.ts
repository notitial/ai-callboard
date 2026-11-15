import { expect, test } from 'claude-code/testing'
import { nudgeText, compactResumeText, CONFIG_UNSAVED, CONFIG_UNREADABLE, KEEPALIVE_TEXT } from '../hooks/core'
import { h, longTest, submitted } from './harness'
import { advanceQuiet, framed, kaLog, lane, logged, MIN, newTrace, NOW, nudges, ownTurn, person, pings, realTurn, sent, sleepFor, stv, ticks, TURN, warm } from './fixtures'

// ---- a ping whose submit fails or hangs, and a store call that throws ----
for (const [what, tokens] of [['the ping', 150_000], ['the nudge in its place', 310_000]] as const) {
  test(`a draft typed while the ping step reads stops ${what}: the gap is missed, logged once`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    h.tokensNow = tokens
    await advanceQuiet(50 * MIN - 2000)
    // The session.usage read comes after the idle check; the person starts typing meanwhile.
    h.usageHook = () => { h.draftNow = 'typing' }
    await h.clock!.advance(2000)
    expect(kaLog(stdins)).toEqual(['keepalive-skipped:late'])
    h.draftNow = ''
    await h.clock!.advance(5 * MIN)
    expect(pings()).toEqual([])
    expect(nudges()).toEqual([])
    expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
    expect(kaLog(stdins)).toEqual(['keepalive-skipped:late'])
  })
}

test('a ping whose submit fails after its prompt hook ran leaves no ping mark: the next turn moves the turn mark', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  await advanceQuiet(50 * MIN - 2000)
  h.submitFails = true
  // The engine runs the prompt hooks inside the submit, and the submit fails after them.
  h.submitHook = async (text) => { await $.prompt.submit({ text } as any).catch(() => undefined) }
  await h.clock!.advance(2000)
  expect(kaLog(stdins)).toEqual(['keepalive-failed:'])
  h.submitFails = false
  const mark = stv(trace, 'lastTurnAt')
  await h.clock!.advance(1000)
  await $.turn.start({ turnId: 'wake' } as any)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

// The handlers below throw at once, but the kit hands that to the mod as a rejected call, so this pins the answers and cannot tell a synchronous throw apart.
test('a store call that throws is answered: not read, or not saved', async ($, on) => {
  await person($, on)
  h.storeThrowSync = 'get'
  expect((await $.command.run(lane('config ping 40'))).text).toBe(CONFIG_UNREADABLE)
  h.storeThrowSync = 'set'
  expect((await $.command.run(lane('config ping 40'))).text).toBe(CONFIG_UNSAVED)
  h.storeThrowSync = undefined
  expect(h.store.has('config')).toBe(false)
})

// ---- a ping that hangs after its prompt hook, a prompt sent while the ping step reads, and the stop clock ----
test('a ping whose submit hangs past the timeout after its prompt hook ran keeps its mark: its turn is still a ping turn', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  const realEnd = stv(trace, 'realEndAt')
  await advanceQuiet(50 * MIN - 2000)
  h.submitHangs = true
  // The engine runs the prompt hooks inside the submit; the submit itself then does not confirm in 60 seconds (the ping is queued and may still run).
  h.submitHook = async (text) => {
    h.submitHangs = false
    await $.prompt.submit({ text } as any)
    h.submitHangs = true
  }
  await h.clock!.advance(2000)
  await h.clock!.advance(62_000)
  expect(kaLog(stdins)).toEqual(['keepalive-unconfirmed:'])
  h.submitHangs = false
  const mark = stv(trace, 'lastTurnAt')
  h.tokensNow = 400_000
  await h.clock!.advance(1000)
  await $.turn.start({ turnId: 'late-ping', text: framed(KEEPALIVE_TEXT) } as any)
  await $.turn.complete(TURN as any)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
})

test('a prompt the person sends while the ping step reads (the box already empty again) stops the ping: logged late', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(50 * MIN - 2000)
  // The session.usage read comes after the idle check; the person's prompt goes through its hooks meanwhile and the box is empty again.
  h.usageHook = async () => { await $.prompt.submit({ text: 'one more thing' } as any) }
  await h.clock!.advance(2000)
  expect(h.draftNow).toBe('')
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:late'])
})

// ---- keepalive: own submits the mod's prompt hook never sees, no ping while the Mac sleeps, the cache nudge ----
test('keepalive: a person\'s turn and a wake turn (no own text) restart the stop clock', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  const first = stv(trace, 'realEndAt')
  await h.clock!.advance(MIN)
  await realTurn($, 'more')
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'realEndAt')).not.toBe(first)
  await h.clock!.advance(MIN)
  const mark = stv(trace, 'lastTurnAt')
  await $.turn.start({ turnId: 'wake', text: '' } as any)
  await $.turn.complete(TURN as any)
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

// A person's prompt while a ping is out and its turn has not run: typed while idle or mid-turn (turnId set, its turn comes later), its turn before or after
// the ping's. The person's turn is real; the ping's is a ping.
for (const [what, turnId, personFirst] of [
  ['typed while idle, its turn first', undefined, true],
  ['typed while idle, the ping\'s turn first', undefined, false],
  ['typed mid-turn (turnId set), its turn first', 'earlier', true],
  ['typed mid-turn (turnId set), the ping\'s turn first', 'earlier', false],
] as const) {
  test(`keepalive: a person's prompt ${what}: the person's turn is real, the ping's turn a ping`, async ($, on) => {
    const trace = newTrace()
    await warm($, on, [], trace)
    await advanceQuiet(50 * MIN)
    expect(pings()).toEqual([KEEPALIVE_TEXT])
    await h.clock!.advance(1000)
    await $.prompt.submit({ text: 'one more thing', ...(turnId ? { turnId } : {}) } as any)
    const person = async () => {
      await h.clock!.advance(1000)
      await $.turn.start({ turnId: 'p', text: 'one more thing' } as any)
      await $.turn.complete(TURN as any)
      expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
    }
    const ping = async () => {
      await h.clock!.advance(1000)
      const mark = stv(trace, 'lastTurnAt')
      const realEnd = stv(trace, 'realEndAt')
      await ownTurn($, KEEPALIVE_TEXT)
      expect(stv(trace, 'lastTurnAt')).toEqual(mark)
      expect(stv(trace, 'realEndAt')).toBe(realEnd)
    }
    if (personFirst) {
      await person()
      await ping()
    } else {
      await ping()
      await person()
    }
  })
}

test('keepalive: a ping that timed out and never ran leaves no wrong tag: the next person turn and the compaction resume turn are real', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  on('classic.PostCompact', () => ({}))
  await warm($, on, stdins, trace)
  h.submitHangs = true
  await advanceQuiet(50 * MIN)
  await h.clock!.advance(62_000)
  expect(kaLog(stdins)).toEqual(['keepalive-unconfirmed:'])
  h.submitHangs = false
  await h.clock!.advance(MIN)
  let mark = stv(trace, 'lastTurnAt')
  await realTurn($, 'hello')
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await ticks(1)
  expect(submitted).toContain(compactResumeText(NOW.continuation))
  await h.clock!.advance(MIN)
  mark = stv(trace, 'lastTurnAt')
  await ownTurn($, compactResumeText(NOW.continuation))
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

test('keepalive: an own real submit (the compaction resume) starts a real turn, not one tagged by a ping out at the same time', async ($, on) => {
  const trace = newTrace()
  on('classic.PostCompact', () => ({}))
  await warm($, on, [], trace)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await ticks(1)
  expect(submitted).toContain(compactResumeText(NOW.continuation))
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  // The resume's turn runs only now, with the ping still out.
  await h.clock!.advance(MIN)
  await ownTurn($, compactResumeText(NOW.continuation))
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  await h.clock!.advance(MIN)
  const realEnd = stv(trace, 'realEndAt')
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
})

test('keepalive: a turn that carries the ping text unframed (an engine that stops framing) is still the ping\'s', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  const realEnd = stv(trace, 'realEndAt')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  await $.turn.start({ turnId: 'own', text: KEEPALIVE_TEXT } as any)
  await $.turn.complete(TURN as any)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
})

test('keepalive: a person\'s prompt that only contains the ping text is real, and leaves the ping\'s count to the ping\'s turn', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  await realTurn($, `What is this? ${KEEPALIVE_TEXT}\nIt came in overnight.`)
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
  await h.clock!.advance(1000)
  const realEnd = stv(trace, 'realEndAt')
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
})

test('keepalive: an engine that does show the mod its own ping (the old hook dispatch) counts it once: the ping turn stays a ping, a second turn with its text is real', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  const realEnd = stv(trace, 'realEndAt')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  // The ping's prompt through the mod's own prompt.submit hook, then its turn.
  await $.prompt.submit({ text: KEEPALIVE_TEXT } as any)
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  // One ping went out, so it was counted down once: a stray second turn with its text is real.
  await h.clock!.advance(MIN)
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

longTest('keepalive: a gap the Mac slept in (the clock jumped past 5 minutes between two timer calls) gets no ping, logged once; the next turn\'s gap pings again', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(20 * MIN)
  // The lid is closed for 10 minutes: no timer call in between.
  await sleepFor(10 * MIN)
  await advanceQuiet(25 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:asleep'])
  await h.clock!.advance(5 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:asleep'])
  await realTurn($, 'morning')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('keepalive: a sleep before the last turn ended does not stop that gap\'s ping', async ($, on) => {
  await warm($, on)
  await sleepFor(10 * MIN)
  await h.clock!.advance(MIN)
  await realTurn($, 'after the wake')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

for (const [what, arrange, cache] of [
  ['an idle session at 150k', () => { h.tokensNow = 150_000 }, true],
  ['an idle session below 150k', () => { h.tokensNow = 149_999 }, false],
  ['a working session (a background agent) at 200k', () => { h.tokensNow = 200_000; h.agentsNow = [{ status: 'running' }] }, false],
] as const) {
  test(`keepalive: after 2 pings since the real turn, the third slot of ${what} ${cache ? 'gets the cache nudge in place of the ping' : 'is a ping'}`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    arrange()
    for (let i = 1; i <= 2; i++) {
      await advanceQuiet(50 * MIN)
      expect(sent(stdins)).toBe(i)
      expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
      await h.clock!.advance(2000)
      await ownTurn($, KEEPALIVE_TEXT)
    }
    await advanceQuiet(50 * MIN)
    if (cache) {
      expect(logged(stdins)).toContain('nudge-due:cache')
      await h.clock!.advance(2000)
      expect(logged(stdins)).toContain('nudged:cache')
      expect(submitted.filter((t) => t === nudgeText('cache'))).toEqual([nudgeText('cache')])
      expect(sent(stdins)).toBe(2)
    } else {
      expect(sent(stdins)).toBe(3)
      expect(submitted.includes(nudgeText('cache'))).toBe(false)
      expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
    }
  })
}

test('keepalive: the ping count starts again at a real turn: its first slot is a ping, not the cache nudge', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 200_000
  for (let i = 1; i <= 2; i++) {
    await advanceQuiet(50 * MIN)
    await h.clock!.advance(2000)
    await ownTurn($, KEEPALIVE_TEXT)
  }
  expect(sent(stdins)).toBe(2)
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(sent(stdins)).toBe(3)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
})
