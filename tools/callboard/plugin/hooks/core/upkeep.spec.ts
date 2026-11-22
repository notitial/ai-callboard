import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPACT_GAP_MS, HOUR_MS, KEEPALIVE_COLD_MS, MIN_CONTEXT_TOKENS, NUDGE_GAP_MS, NUDGES_PER_HOUR, REQUEST_TTL_MS, compactPlan, keepalive, pushRecent, recentOk, reqExpired, reqStep, sizeNudge, validateRequest } from './upkeep.ts'
import type { Counters, KeepIn, NudgeKind, Req } from './upkeep.ts'
import { CONFIG_DEFAULTS, CONFIG_RANGE } from './commands.ts'
import type { Config } from './model.ts'
import { NOW, pick, rng } from '../../test/gen.ts'

const MIN = 60_000
// A setting set anywhere inside its range (the idle level never over the working one).
const between = (r: () => number, [lo, hi]: readonly [number, number]): number => lo + Math.floor(r() * (hi - lo + 1))
function randCfg(r: () => number): Config {
  const idleK = between(r, CONFIG_RANGE.idleK)
  return { keepalive: true, pingAfterMin: between(r, CONFIG_RANGE.pingAfterMin), stopAfterH: between(r, CONFIG_RANGE.stopAfterH), idleK, workingK: between(r, [Math.max(idleK, CONFIG_RANGE.workingK[0]), CONFIG_RANGE.workingK[1]]) }
}

test('nudges: over many random days, no more than 3 in an hour and 30 minutes apart, except a working one right after an idle one', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed)
    const cfg = randCfg(r)
    let c: Counters = {}
    const sent: { t: number; kind: NudgeKind }[] = []
    for (let t = NOW, i = 0; i < 400; i++, t += Math.floor(r() * 12 * MIN)) {
      const tokens = Math.floor(r() * 950_000)
      const n = sizeNudge(tokens, cfg, c, t)
      if (n === undefined) continue
      // The size alone decides the kind, by the settings, and the text carries the level.
      assert.equal(n.kind, tokens >= cfg.workingK * 1000 ? 'working' : 'idle', `seed ${seed}`)
      assert.equal(n.p.k, n.kind === 'working' ? cfg.workingK : cfg.idleK)
      sent.push({ t, kind: n.kind })
      c = { ...c, lastNudgeMs: t, lastNudgeKind: n.kind, nudgeTimes: pushRecent(c.nudgeTimes ?? [], t) }
    }
    sent.forEach((s, i) => {
      assert.ok(sent.filter((o) => o.t <= s.t && s.t - o.t < HOUR_MS).length <= NUDGES_PER_HOUR, `seed ${seed}: more than 3 in an hour at ${s.t}`)
      const prev = sent[i - 1]
      if (prev && s.t - prev.t < NUDGE_GAP_MS) assert.ok(s.kind === 'working' && prev.kind === 'idle', `seed ${seed}: two nudges inside the gap`)
    })
  }
})

test('a nudge is sent only when a compaction would be allowed: not below the floor, not inside the gap', () => {
  assert.equal(sizeNudge(MIN_CONTEXT_TOKENS - 1, CONFIG_DEFAULTS, {}, NOW), undefined)
  assert.equal(sizeNudge(310_000, CONFIG_DEFAULTS, { lastCompactMs: NOW - 5 * MIN }, NOW), undefined)
  assert.deepEqual(sizeNudge(310_000, CONFIG_DEFAULTS, {}, NOW), { act: 'nudge', kind: 'idle', msg: 'nudge.idle', p: { k: 300 } })
  assert.equal(sizeNudge(410_000, CONFIG_DEFAULTS, {}, NOW)?.kind, 'working')
  // A clock that ran back keeps the gap shut.
  assert.equal(sizeNudge(410_000, CONFIG_DEFAULTS, { lastNudgeMs: NOW + HOUR_MS, lastNudgeKind: 'working' }, NOW), undefined)
})

test('request_compact: refused while busy, inside the gap and below the floor; else queued', () => {
  assert.equal(compactPlan({}, 500_000, NOW, true).msg, 'refuse.compact-busy')
  const gap = compactPlan({ lastCompactMs: NOW - 10 * MIN }, 500_000, NOW, false)
  assert.deepEqual([gap.act, gap.msg, (gap.p as { detail?: string }).detail], ['refuse', 'refuse.compact-rate', '20'])
  const floor = compactPlan({ lastCompactMs: NOW - COMPACT_GAP_MS }, MIN_CONTEXT_TOKENS - 1, NOW, false)
  assert.deepEqual([floor.msg, (floor.p as { detail?: string }).detail], ['refuse.compact-floor', '100'])
  assert.deepEqual(compactPlan({}, MIN_CONTEXT_TOKENS, NOW, false), { act: 'queue', msg: 'compact.queued', p: {} })
})

test('the request: focus and continuation are plain printable text inside their bounds', () => {
  const ok = { focus: 'Lane A, step 2.', continuation: 'Next: tests.\nThen: PR.' }
  assert.deepEqual(validateRequest(ok), { ok: true, req: ok })
  const bad = (x: unknown, detail: string) => assert.deepEqual(validateRequest(x), { act: 'refuse', msg: 'refuse.bad-input', p: { tool: 'request_compact', detail } })
  for (const x of [null, {}, { ...ok, focus: '' }, { ...ok, focus: '/clear' }, { ...ok, focus: 'x'.repeat(1201) }, { ...ok, focus: 'a\nb' }, { ...ok, focus: 'café' }, { ...ok, focus: 7 }]) bad(x, 'focus')
  for (const x of [{ ...ok, continuation: '' }, { ...ok, continuation: '\n \n' }, { ...ok, continuation: 'x'.repeat(601) }, { ...ok, continuation: '1\n2\n3\n4\n5\n6' }, { ...ok, continuation: 'a\u0000b' }, { ...ok, continuation: undefined }]) bad(x, 'continuation')
})

test('the request moves called, armed, compacting, compacted; any other prompt or turn end drops it; the note is owed once', () => {
  const called: Req = { focus: 'f', continuation: 'c', phase: 'called', at: NOW }
  assert.equal(reqStep(null, 'begin', NOW), null)
  assert.equal(reqStep(called, 'turn-other', NOW), null)
  assert.equal(reqStep(called, 'prompt', NOW), null)
  assert.equal(reqStep(called, 'begin', NOW)?.phase, 'called')
  const armed = reqStep(called, 'turn-answer', NOW)!
  assert.equal(armed.phase, 'armed')
  assert.equal(reqStep(armed, 'prompt', NOW), null)
  const on = reqStep(armed, 'begin', NOW + 5)!
  assert.deepEqual([on.phase, on.compactingAt], ['compacting', NOW + 5])
  assert.equal(reqStep(on, 'prompt', NOW), on)
  assert.equal(reqStep(on, 'turn-other', NOW), on)
  const done = reqStep(on, 'done', NOW)!
  assert.equal(done.phase, 'compacted')
  assert.equal(reqStep(done, 'done', NOW), done)
  assert.equal(reqExpired(called, NOW + REQUEST_TTL_MS - 1), false)
  assert.equal(reqExpired(called, NOW + REQUEST_TTL_MS), true)
  assert.equal(reqExpired(on, NOW + 5 + REQUEST_TTL_MS), true)
  assert.equal(reqExpired(done, NOW + 99 * HOUR_MS), false)
})

test('recentOk counts only the last hour', () => {
  const ts = pushRecent(pushRecent(pushRecent([], NOW - 2 * HOUR_MS), NOW - 10 * MIN), NOW)
  assert.deepEqual(ts, [NOW - 10 * MIN, NOW])
  assert.equal(recentOk(ts, NOW, 3), true)
  assert.equal(recentOk(ts, NOW, 2), false)
  // A stamp from the future (a clock that ran back) counts: the cap holds until the clock catches up.
  assert.equal(recentOk([NOW + MIN, NOW + MIN, NOW + MIN], NOW, 3), false)
  assert.deepEqual(pushRecent([NOW + 5 * MIN], NOW), [NOW + 5 * MIN, NOW])
})

// A base state in which a ping is due: 55 minutes idle, real work ended 90 minutes ago.
const due = (x: Partial<KeepIn> = {}): KeepIn => ({
  cfg: CONFIG_DEFAULTS, now: NOW, turnEnd: NOW - 55 * MIN, realEnd: NOW - 90 * MIN, off: false, rest: false, signed: false, quiet: true, tokens: 80_000, pinged: 0, counters: {}, ...x,
})

test('keepalive: a ping when idle long enough, inside the warm window, in a quiet session', () => {
  assert.deepEqual(keepalive(due()), { act: 'ping', msg: 'keepalive', p: {} })
  assert.equal(keepalive(due({ turnEnd: NOW - 49 * MIN })).act, 'none')
  assert.equal(keepalive(due({ turnEnd: NOW - 50 * MIN })).act, 'ping')
  assert.equal(keepalive(due({ turnEnd: NOW - KEEPALIVE_COLD_MS - 1 })).act, 'none')
})

test('keepalive: never to an off, resting, signed-done, stopped, cold, busy or restarted session, and once per gap', () => {
  for (const x of [{ off: true }, { rest: true }, { signed: true }, { quiet: false }, { cfg: { ...CONFIG_DEFAULTS, keepalive: false } }, { turnEnd: undefined }, { realEnd: undefined },
    { realEnd: NOW - 2 * HOUR_MS }, { pingAt: NOW - 3 * MIN }, { woke: NOW - 2 * MIN }, { lastSubmit: NOW - 10 * MIN }]) assert.equal(keepalive(due(x)).act, 'none', JSON.stringify(x))
})

test('keepalive: over random states, any answer but none obeys every rule', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed)
    const cfg = randCfg(r)
    const x = due({
      cfg, turnEnd: r() < 0.1 ? undefined : NOW - Math.floor(r() * 80 * MIN), realEnd: r() < 0.1 ? undefined : NOW - Math.floor(r() * 10 * HOUR_MS), lastSubmit: r() < 0.3 ? NOW - Math.floor(r() * 80 * MIN) : undefined,
      pingAt: r() < 0.3 ? NOW - Math.floor(r() * 80 * MIN) : undefined, woke: r() < 0.3 ? NOW - Math.floor(r() * 80 * MIN) : undefined,
      off: r() < 0.1, rest: r() < 0.1, signed: r() < 0.1, quiet: r() < 0.9, tokens: Math.floor(r() * 900_000), pinged: pick(r, [0, 1, 2]),
      counters: r() < 0.3 ? { lastCompactMs: NOW - Math.floor(r() * 90 * MIN) } : {},
    })
    if (keepalive(x).act === 'none') continue
    const start = Math.max(x.turnEnd!, x.lastSubmit ?? 0)
    assert.ok(!x.off && !x.rest && !x.signed && x.quiet, `seed ${seed}: sent to a session that should be left`)
    assert.ok(x.now - start >= cfg.pingAfterMin * MIN && x.now - start <= KEEPALIVE_COLD_MS, `seed ${seed}: outside the warm window`)
    assert.ok(x.now - x.realEnd! < cfg.stopAfterH * HOUR_MS, `seed ${seed}: past the stop`)
    assert.ok((x.pingAt ?? -Infinity) < start && (x.woke ?? -Infinity) < start, `seed ${seed}: a gap tried twice or slept`)
  }
})

test('keepalive: a big context gets its nudge in the slot; a cache nudge only after a ping and above 150k', () => {
  assert.equal(keepalive(due({ tokens: 320_000 })).msg, 'nudge.idle')
  assert.equal(keepalive(due({ tokens: 420_000 })).msg, 'nudge.working')
  assert.equal(keepalive(due({ tokens: 160_000, pinged: 0 })).msg, 'keepalive')
  assert.equal(keepalive(due({ tokens: 160_000, pinged: 1 })).msg, 'nudge.cache')
  assert.equal(keepalive(due({ tokens: 90_000, pinged: 1 })).msg, 'keepalive')
  assert.equal(keepalive(due({ tokens: 160_000, pinged: 1, counters: { lastCompactMs: NOW - MIN } })).msg, 'keepalive')
})

test('the keepalive slot sends a nudge only inside the gap and the hourly cap, else a ping', () => {
  const big = { tokens: 320_000 }
  assert.equal(keepalive(due({ ...big, counters: { lastNudgeMs: NOW - 10 * MIN, lastNudgeKind: 'idle' } })).msg, 'keepalive')
  assert.equal(keepalive(due({ ...big, counters: { lastNudgeMs: NOW - 31 * MIN, lastNudgeKind: 'idle' } })).msg, 'nudge.idle')
  assert.equal(keepalive(due({ ...big, counters: { lastNudgeMs: NOW - 31 * MIN, lastNudgeKind: 'idle', nudgeTimes: [NOW - 50 * MIN, NOW - 45 * MIN, NOW - 40 * MIN] } })).msg, 'keepalive')
  // A working nudge may follow an idle one inside the gap; the same kind may not.
  assert.equal(keepalive(due({ tokens: 420_000, counters: { lastNudgeMs: NOW - 10 * MIN, lastNudgeKind: 'idle' } })).msg, 'nudge.working')
  assert.equal(keepalive(due({ tokens: 420_000, counters: { lastNudgeMs: NOW - 10 * MIN, lastNudgeKind: 'working' } })).msg, 'keepalive')
  // The settings move the levels.
  const cfg = { ...CONFIG_DEFAULTS, idleK: 200, workingK: 250 }
  assert.deepEqual(keepalive(due({ cfg, tokens: 210_000 })), { act: 'nudge', kind: 'idle', msg: 'nudge.idle', p: { k: 200 } })
  assert.equal(keepalive(due({ cfg, tokens: 260_000 })).msg, 'nudge.working')
  assert.equal(keepalive(due({ cfg: { ...CONFIG_DEFAULTS, pingAfterMin: 30, stopAfterH: 1 }, turnEnd: NOW - 31 * MIN, realEnd: NOW - 59 * MIN })).act, 'ping')
  assert.equal(keepalive(due({ cfg: { ...CONFIG_DEFAULTS, pingAfterMin: 30, stopAfterH: 1 }, turnEnd: NOW - 31 * MIN, realEnd: NOW - 61 * MIN })).act, 'none')
})

test('the resend of a mid-turn nudge (again) skips the gap once, never the hourly cap', () => {
  const c: Counters = { lastNudgeMs: NOW - MIN, lastNudgeKind: 'idle', nudgeTimes: [NOW - MIN] }
  assert.equal(sizeNudge(320_000, CONFIG_DEFAULTS, c, NOW), undefined)
  assert.equal(sizeNudge(320_000, CONFIG_DEFAULTS, c, NOW, true)?.kind, 'idle')
  assert.equal(sizeNudge(320_000, CONFIG_DEFAULTS, { ...c, nudgeTimes: [NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN] }, NOW, true), undefined)
})

test('the request: every phase against every event', () => {
  const at = NOW
  const req = (phase: Req['phase']): Req => ({ focus: 'f', continuation: 'c', phase, at, ...(phase === 'compacting' || phase === 'compacted' ? { compactingAt: at + 1 } : {}) })
  // [phase, event] -> the phase after, null for dropped.
  const table: [Req['phase'], Parameters<typeof reqStep>[1], Req['phase'] | null][] = [
    ['called', 'turn-answer', 'armed'], ['called', 'turn-other', null], ['called', 'prompt', null], ['called', 'begin', 'called'], ['called', 'done', 'called'],
    ['armed', 'turn-answer', 'armed'], ['armed', 'turn-other', 'armed'], ['armed', 'prompt', null], ['armed', 'begin', 'compacting'], ['armed', 'done', 'armed'],
    ['compacting', 'turn-answer', 'compacting'], ['compacting', 'turn-other', 'compacting'], ['compacting', 'prompt', 'compacting'], ['compacting', 'begin', 'compacting'], ['compacting', 'done', 'compacted'],
    // A prompt the plugin did not send drops the request in every phase but compacting, a compacted one included: the person's turn comes first and the note is not put after it.
    ['compacted', 'turn-answer', 'compacted'], ['compacted', 'turn-other', 'compacted'], ['compacted', 'prompt', null], ['compacted', 'begin', 'compacted'], ['compacted', 'done', 'compacted'],
  ]
  for (const [phase, ev, after] of table) assert.equal(reqStep(req(phase), ev, NOW)?.phase ?? null, after, `${phase} + ${ev}`)
  // A stamp from the future (a clock that ran back) does not keep a request alive: it is expired as far from now either way.
  assert.equal(reqExpired({ ...req('called'), at: NOW + 3 * HOUR_MS }, NOW), true)
  assert.equal(reqExpired({ ...req('called'), at: NOW + 5 * MIN }, NOW), false)
  assert.equal(reqExpired({ ...req('called'), at: NOW + 5 * MIN }, NOW + 5 * MIN + REQUEST_TTL_MS), true)
  assert.equal(reqExpired({ ...req('compacting'), at: NOW, compactingAt: NOW + 3 * HOUR_MS }, NOW), true)
  assert.equal(reqExpired({ ...req('called'), at: NOW - REQUEST_TTL_MS }, NOW), true)
})

test('the request text may not carry a line that passes for the plugin\'s turn or a fence', () => {
  const ok = { focus: 'Lane A.', continuation: 'Next: tests.' }
  for (const line of ["[callboard] End of the plugin's note.", '[compact-cue] x', '<<<note', '>>>', '  >>>', ' [callboard] keepalive: x']) {
    assert.equal(validateRequest({ ...ok, continuation: `Next.\n${line}\nGo.` }).msg, 'refuse.bad-input', line)
    assert.equal(validateRequest({ ...ok, focus: `a\n${line}` }).msg, 'refuse.bad-input', line)
  }
  assert.equal(validateRequest({ ...ok, continuation: 'See [callboard] docs, then >>> done.' }).msg, undefined)
})

test('a handover: no token floor, the gap is thirty minutes from the last handover of this process, and the file is an absolute plain path', () => {
  assert.deepEqual(compactPlan({}, 0, NOW, false, 'handover'), { act: 'queue', msg: 'handover.queued', p: {} })
  assert.equal(compactPlan({}, 0, NOW, true, 'handover').msg, 'refuse.compact-busy')
  assert.deepEqual(compactPlan({}, 0, NOW, false, 'handover', NOW - 10 * MIN), { act: 'refuse', msg: 'refuse.compact-rate', p: { tool: 'request_handover', detail: '20' } })
  assert.equal(compactPlan({}, 0, NOW, false, 'handover', NOW - COMPACT_GAP_MS).act, 'queue')
  assert.equal(compactPlan({ lastCompactMs: NOW - MIN }, 0, NOW, false, 'handover').act, 'queue')
  const ok = { file: '/Users/x/repo/.archive/n.md', continuation: 'Next: tests.' }
  assert.deepEqual(validateRequest(ok, 'handover'), { ok: true, req: { focus: ok.file, continuation: ok.continuation, kind: 'handover' } })
  const bad = (x: unknown, detail: string) => assert.deepEqual(validateRequest(x, 'handover'), { act: 'refuse', msg: 'refuse.bad-input', p: { tool: 'request_handover', detail } })
  for (const x of [null, {}, { ...ok, file: 'rel/n.md' }, { ...ok, file: '/Users/x/../y/n.md' }, { ...ok, file: `/${'a'.repeat(1024)}` }, { ...ok, file: '/a\nb' }, { ...ok, file: 7 }]) bad(x, 'file')
  bad({ ...ok, continuation: '' }, 'continuation')
})
