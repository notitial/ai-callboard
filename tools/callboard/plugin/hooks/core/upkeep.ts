// Upkeep: when a keepalive ping or a compaction nudge is due, whether a session's own request_compact may queue, and what state a request is in. Pure. Trust rules held
// here: every bound is a constant or a setting inside its range; a ping goes to no off, resting, asleep or signed-done session and stops after real work ends; a nudge
// obeys one gap and an hourly cap; a request is refused below the floor and inside the gap, and a session compacts only itself (no mode, no order, no one else's cue).
import type { Config, Decision } from './model.ts'
import { refusal } from './model.ts'
import type { Say } from './msg.ts'

export const HOUR_MS = 3_600_000
// The prompt cache lives an hour from the last call: past this a ping would only re-write a cold cache.
export const KEEPALIVE_COLD_MS = 58 * 60_000
// A gap this long between two timer calls (2 s apart while awake) means the Mac slept; that idle gap gets no ping.
export const SLEEP_GAP_MS = 5 * 60_000
export const NUDGE_GAP_MS = 30 * 60_000
export const NUDGES_PER_HOUR = 3
export const NOTICES_PER_HOUR = 3
export const COMPACT_GAP_MS = 30 * 60_000
export const MIN_CONTEXT_TOKENS = 100_000
export const CACHE_NUDGE_TOKENS = 150_000
export const REQUEST_TTL_MS = 15 * 60_000

// A stamp from the future (a clock that ran back) still counts, so the cap holds until the clock catches up.
const inHour = (ts: readonly number[], now: number): number[] => ts.filter((t) => Math.abs(now - t) < HOUR_MS)
export const pushRecent = (ts: readonly number[], now: number): number[] => [...inHour(ts, now), now]
export const recentOk = (ts: readonly number[], now: number, max: number = NOTICES_PER_HOUR): boolean => inHour(ts, now).length < max

// ---- nudges ----
export type NudgeKind = 'idle' | 'working' | 'cache'
// What the session has been told, kept by the adapter: the last nudge's time and kind, the times of the last hour, and the last compaction's end.
export type Counters = { lastCompactMs?: number; lastNudgeMs?: number; lastNudgeKind?: NudgeKind; nudgeTimes?: readonly number[] }
export type NudgeAct = { act: 'nudge'; kind: NudgeKind } & Say<'nudge.idle' | 'nudge.working' | 'nudge.cache'>

// At most one nudge in NUDGE_GAP_MS, except a working one right after an idle one (it then is the last nudge); `again` (the resend of a mid-turn nudge) skips the gap once.
// A clock that ran back leaves the gap shut. The hourly cap holds for every kind.
export const nudgeOk = (c: Counters, now: number, kind: NudgeKind, again = false): boolean =>
  (again || c.lastNudgeMs === undefined || now - c.lastNudgeMs >= NUDGE_GAP_MS || (kind === 'working' && c.lastNudgeKind === 'idle')) && recentOk(c.nudgeTimes ?? [], now, NUDGES_PER_HOUR)

export function nudgeSay(kind: NudgeKind, cfg: Config): NudgeAct {
  const [msg, k] = kind === 'idle' ? (['nudge.idle', cfg.idleK] as const) : kind === 'working' ? (['nudge.working', cfg.workingK] as const) : (['nudge.cache', CACHE_NUDGE_TOKENS / 1000] as const)
  return { act: 'nudge', kind, msg, p: { k } }
}
// The nudge a context of this size earns: the size alone decides, whatever the session is doing. Sent only while a compaction would be allowed (the floor and the gap).
export function sizeNudge(tokens: number, cfg: Config, c: Counters, now: number, again = false): NudgeAct | undefined {
  const kind = tokens >= cfg.workingK * 1000 ? 'working' : tokens >= cfg.idleK * 1000 ? 'idle' : undefined
  return kind !== undefined && nudgeOk(c, now, kind, again) && compactPlan(c, tokens, now, false).act === 'queue' ? nudgeSay(kind, cfg) : undefined
}

// ---- the session's own compaction ----
// A request is refused while background work runs, inside COMPACT_GAP_MS of the last compaction, and below the floor. The detail is the minutes to wait, or the floor in k.
export function compactPlan(c: Counters, tokens: number, now: number, busy: boolean): Decision<'queue' | 'refuse'> {
  const no = (code: 'compact-busy' | 'compact-rate' | 'compact-floor', detail?: string) => refusal('refuse', code, { tool: 'request_compact', ...(detail === undefined ? {} : { detail }) })
  if (busy) return no('compact-busy')
  if (c.lastCompactMs !== undefined && now - c.lastCompactMs < COMPACT_GAP_MS) return no('compact-rate', String(Math.max(1, Math.ceil((c.lastCompactMs + COMPACT_GAP_MS - now) / 60_000))))
  return tokens < MIN_CONTEXT_TOKENS ? no('compact-floor', String(MIN_CONTEXT_TOKENS / 1000)) : { act: 'queue', msg: 'compact.queued', p: {} }
}
export type Request = { focus: string; continuation: string }
const PRINTABLE = /^[\x20-\x7e]+$/
const PRINTABLE_NL = /^[\x20-\x7e\n]+$/
// A line that opens like the plugin's own turns or a fence: the note is printed between fences, and no line of it may pass for the plugin's.
const FORGED = /^\s*(\[callboard\]|\[compact-cue\]|<<<|>>>)/m
// focus: 1 to 1200 printable ASCII characters, not a slash command. continuation: 1 to 600, at most 5 lines, something other than blanks.
export function validateRequest(r: unknown): { ok: true; req: Request } | Decision<'refuse'> {
  const { focus, continuation } = (r ?? {}) as Record<string, unknown>
  const no = (detail: string) => refusal('refuse', 'bad-input', { tool: 'request_compact', detail })
  if (typeof focus !== 'string' || focus.length < 1 || focus.length > 1200 || !PRINTABLE.test(focus) || focus.startsWith('/') || FORGED.test(focus)) return no('focus')
  if (typeof continuation !== 'string' || continuation.length < 1 || continuation.length > 600 || !PRINTABLE_NL.test(continuation) || !/[^\n ]/.test(continuation) || continuation.split('\n').length > 5 || FORGED.test(continuation)) return no('continuation')
  return { ok: true, req: { focus, continuation } }
}

// called: queued. armed: the turn ended with an answer, so the compaction starts. compacting. compacted: the resume note is owed. `at` is the wall time of the call.
export type Phase = 'called' | 'armed' | 'compacting' | 'compacted'
export type Req = Request & { phase: Phase; at: number; compactingAt?: number }
// turn-answer: the main agent's turn ended with an answer; turn-other: it ended any other way; prompt: a prompt the plugin did not send; begin, done: the compaction.
export type ReqEvent = 'turn-answer' | 'turn-other' | 'prompt' | 'begin' | 'done'
export function reqStep(req: Req | null, ev: ReqEvent, now: number): Req | null {
  if (req === null) return null
  if (ev === 'turn-answer') return req.phase === 'called' ? { ...req, phase: 'armed' } : req
  if (ev === 'turn-other') return req.phase === 'called' ? null : req
  if (ev === 'prompt') return req.phase === 'compacting' ? req : null
  if (ev === 'begin') return req.phase === 'armed' ? { ...req, phase: 'compacting', compactingAt: now } : req
  return req.phase === 'compacting' ? { ...req, phase: 'compacted' } : req
}
// A request that waits or compacts longer than REQUEST_TTL_MS, counted from its own start, is dropped; a start stamped that far ahead of now is dropped too, so a stamp from the future cannot keep one for good.
export const reqExpired = (req: Req, now: number): boolean => req.phase !== 'compacted' && Math.abs(now - (req.compactingAt ?? req.at)) >= REQUEST_TTL_MS

// ---- the keepalive ----
// turnEnd, realEnd (the end of the last turn that was not the plugin's own), lastSubmit and pingAt are the wall times this process saw: absent after a restart, and then
// nothing is sent until a turn ends. woke: when the Mac was last seen to wake. quiet: the adapter's own check that the session is idle and waiting for nothing, its prompt box
// is empty, no dialog or request or due nudge is open, and it is an interactive session. pinged: pings since the last real turn.
export type KeepIn = {
  cfg: Config
  now: number
  turnEnd?: number
  realEnd?: number
  lastSubmit?: number
  pingAt?: number
  woke?: number
  off: boolean
  rest: boolean
  signed: boolean
  quiet: boolean
  tokens: number
  pinged: number
  counters: Counters
}
export type KeepAct = { act: 'none' } | NudgeAct | Decision<'ping'>
// One ping per idle gap, and only inside the window the cache is warm and work was real. The adapter stamps pingAt whenever the answer is not `none`, so a gap is tried once.
export function keepalive(x: KeepIn): KeepAct {
  const none: KeepAct = { act: 'none' }
  const { cfg, now } = x
  if (x.off || x.rest || x.signed || !cfg.keepalive || x.turnEnd === undefined || x.realEnd === undefined) return none
  const gapStart = Math.max(x.turnEnd, x.lastSubmit ?? 0)
  const gap = now - gapStart
  if (gap < cfg.pingAfterMin * 60_000 || (x.pingAt !== undefined && x.pingAt >= gapStart) || (x.woke !== undefined && x.woke >= gapStart)) return none
  if (now - x.realEnd >= cfg.stopAfterH * HOUR_MS || gap > KEEPALIVE_COLD_MS || !x.quiet) return none
  // A session past a compact level gets that nudge in this slot; an idle one past the cache level, once a ping went out since its last real turn, gets the cache nudge.
  const size = sizeNudge(x.tokens, cfg, x.counters, now)
  if (size !== undefined) return size
  const cache = x.pinged >= 1 && x.tokens >= CACHE_NUDGE_TOKENS && nudgeOk(x.counters, now, 'cache') && compactPlan(x.counters, x.tokens, now, false).act === 'queue'
  return cache ? nudgeSay('cache', cfg) : { act: 'ping', msg: 'keepalive', p: {} }
}
