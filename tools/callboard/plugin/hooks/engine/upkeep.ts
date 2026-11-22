// request_compact, the compaction itself, PostCompact, the turn marks, and the keepalive and nudge sends: the adapter over core/upkeep.ts. Trust rules held here: a session compacts only
// itself (its request carries the session id it was made in, and the tool is the main agent's); nothing is sent to a session that is not an interactive one, idle with an empty prompt box;
// at most one text is submitted per tick; a ping or a nudge is not work and moves no stop clock.
import type { Row, Sid, View } from '../core/model.ts'
import { signedBy } from '../core/lifecycle.ts'
import { isOff, refusal } from '../core/model.ts'
import type { NudgeAct, ReqEvent } from '../core/upkeep.ts'
import { compactPlan, keepalive, pushRecent, reqExpired, reqStep, sizeNudge, validateRequest } from '../core/upkeep.ts'
import { compactWhy } from '../texts.ts'
import { countDown, log, ownTextOf, submitOwn, toast } from './io.ts'
import type { Up } from './mem.ts'
import { getUp, mem, patchUp, spendStarted } from './mem.ts'
import { cfgNow, getView } from './store.ts'
import { deny, isSub, say } from './tools-any.ts'

const BUSY_AGENT = ['pending', 'running', 'waiting']
const NUDGE_DUE_MS = 10 * 60_000
const RESUME_MS = 120_000
const MID_SKIP_MS = 60_000

const rowOf = (v: View, sid: Sid) => (v.rows === 'unknown' ? undefined : v.rows.get(sid))
const interactive = (v: View, sid: Sid): boolean => rowOf(v, sid)?.kind === 'interactive'
async function tokensOf($: any): Promise<number> {
  return ((await $.session.usage()).context?.tokens as number | undefined) ?? 0
}
async function busyAgents($: any): Promise<boolean> {
  return ((await $.agent.list().catch(() => [{ status: 'running' }])) as { status: string }[]).some((a) => BUSY_AGENT.includes(a.status))
}
async function draft($: any): Promise<string> {
  return (await $.prompt.read()).text
}
// An interactive session that is idle and waiting for nothing, with no dialog of ours open, no text of ours not yet started and an empty prompt box: the one place "quiet enough to be
// sent a turn" is decided. Its own row is read now, not taken from the view kept 10 s: a turn that began a moment ago must show.
export async function idle($: any, sid: Sid): Promise<boolean> {
  const r = rowOf(await getView($, true), sid)
  return r?.kind === 'interactive' && r.status === 'idle' && !r.waitingFor && mem.dialogs.size === 0 && mem.pending.size === 0 && (await draft($)) === ''
}

// The request after an event: the core moves its phase, the session id it was made in and the time its compaction ended stay.
function stepReq(u: Up, ev: ReqEvent, now: number): Up['req'] {
  const r = reqStep(u.req, ev, now)
  return r === null || u.req === null ? null : { ...u.req, ...r }
}

// ---- the tool and the hooks that move a request ----
export async function requestCompactCall($: any, e: any, _next: any) {
  const sid = (await $.session.id()) as Sid
  const no = (detail: string) => deny(refusal('refuse', 'bad-input', { tool: 'request_compact', detail }))
  if (isSub(e)) return no('subagent')
  const v = validateRequest(e)
  if (!('ok' in v)) return deny(v)
  if (!interactive(await getView($), sid)) return no('not-interactive')
  const now = await $.clock.now()
  const plan = compactPlan((await getUp($)).counters, await tokensOf($), now, await busyAgents($))
  if (plan.act === 'refuse') return deny(plan)
  await patchUp($, (u) => ({ ...u, due: null, req: { ...v.req, phase: 'called', at: now, sid } }))
  await log($, sid, 'requested')
  return { result: say(plan) }
}

// A size past a level at the end of an answer: one nudge is recorded, and the tick sends it once the session is quiet. A nudge that went mid-turn is sent once more (`again`).
async function recordNudge($: any, sid: Sid, now: number): Promise<void> {
  const again = mem.mid
  mem.mid = false
  const up = await getUp($)
  if (up.req === null && up.due === null && interactive(await getView($), sid) && sizeNudge(await tokensOf($), await cfgNow($), up.counters, now, again) !== undefined)
    await patchUp($, (u) => ({ ...u, due: { at: now, ...(again ? { again: true as const } : {}) } }))
}
// Whether a session's report's last line is signed by its own id. The report path is the row's, inside the row's own folder.
export async function signedNow($: any, k: Sid, r: Row | undefined): Promise<boolean> {
  if (r?.report === undefined || !r.report.startsWith(`${r.folder}/.archive/`) || r.report.includes('..')) return false
  const st = (await $.fs.stat(r.report).catch(() => undefined)) as { size: number; kind?: string } | undefined
  const size = st?.kind === 'file' ? st.size : undefined
  const t = size === undefined ? undefined : await $.fs.read(r.report, { offset: Math.max(0, size - 1024), length: 1024 }).catch(() => undefined)
  return typeof t === 'string' && signedBy(t, k)
}
// A turn's end: the nudge it leaves due is recorded, unless the turn signed the session's report. The signed set the nudge and the keepalive read is refreshed only
// every 30 s (tick.ts), so a lane's signing turn is marked here, at once: nothing callboard sends gives a signed lane a new turn.
export async function turnComplete($: any, e: any, next: any) {
  if (!isSub(e)) {
    try {
      const now = await $.clock.now()
      const kind = mem.turnKind
      mem.turnKind = undefined
      const answered = e.reason === 'answer'
      if (!answered) mem.mid = false
      await patchUp($, (u) => ({ ...u, turnEnd: now, ...(kind === undefined ? { realEnd: now } : {}), req: stepReq(u, answered ? 'turn-answer' : 'turn-other', now) }))
      const sid = (await $.session.id()) as Sid
      if (await signedNow($, sid, (await getView($)).table[sid])) mem.signed.set.add(sid)
      else if (kind !== 'ping' && answered) await recordNudge($, sid, now)
    } catch {
      await log($, await $.session.id(), 'error', 'turn-end').catch(() => undefined)
    }
  }
  return next(e)
}
export async function promptSubmit($: any, e: any, next: any) {
  if (e.origin?.kind === 'plugin' || mem.own.has(e.text)) return next(e)
  const now = await $.clock.now()
  mem.lastSubmit = now
  const up = await getUp($)
  if (up.req !== null && up.req.phase !== 'compacting') {
    await patchUp($, (u) => ({ ...u, req: stepReq(u, 'prompt', now) }))
    if (up.req.phase !== 'compacted') toast($, say({ msg: 'compact.notRun', p: { reason: 'a new prompt came in' } }))
  }
  return next(e)
}
// A turn that carries one of our own texts is that submit's: counted down, and not work unless it was sent as work. Any other turn is real, and ends a rest.
export async function turnStart($: any, e: any, next: any) {
  if (!isSub(e)) {
    const t = ownTextOf(e.text)
    const own = t === undefined ? undefined : mem.own.get(t)
    if (t !== undefined) countDown(t)
    mem.turnKind = own === undefined || own.real ? undefined : t === say({ msg: 'keepalive', p: {} }) ? 'ping' : 'unreal'
    spendStarted(e.text, await $.clock.now())
    // A panel's channel gets its session id with its first message, so a lane that found none asks again at a turn's start.
    if (mem.remote?.stopped === 'no-channel') mem.remote = undefined
    if (mem.turnKind === undefined && typeof (await getUp($)).restAt === 'number') await patchUp($, (u) => ({ ...u, restAt: undefined }))
  }
  return next(e)
}
export async function postCompact($: any, e: any, next: any) {
  const now = await $.clock.now()
  await patchUp($, (u) => ({ ...u, counters: { ...u.counters, lastCompactMs: now }, req: ((r) => (r?.phase === 'compacted' ? { ...r, doneAt: now } : r))(stepReq(u, 'done', now)) })).catch(() => undefined)
  return next(e)
}

// ---- the tick's steps ----
// The request: dropped when it is another session's or has waited too long, resumed with its note once the compaction ended and the session is quiet (for at most RESUME_MS), compacted at the end of the turn that made it.
export async function requestTick($: any, sid: Sid): Promise<void> {
  const up = await getUp($)
  const r = up.req
  if (r === null) return
  const now = await $.clock.now()
  const drop = async (why: string, shown?: string) => {
    await patchUp($, (u) => ({ ...u, req: null }))
    await log($, sid, 'dropped', why)
    if (shown !== undefined) toast($, say({ msg: 'compact.notRun', p: { reason: shown } }))
  }
  if (r.sid !== sid) return drop('other-session')
  if (r.phase === 'compacted') {
    if (r.doneAt === undefined || now - r.doneAt > RESUME_MS) return drop('resume-expired')
    if (!(await idle($, sid))) return
    let took = false
    await patchUp($, (u) => ((took = u.req?.phase === 'compacted' && u.req.doneAt === r.doneAt), took ? { ...u, req: null } : u))
    if (!took) return
    return submitOwn($, say({ msg: 'compact.note', p: { focus: r.focus, continuation: r.continuation } })).then(() => undefined, () => log($, sid, 'resume-failed'))
  }
  if (reqExpired(r, now)) {
    await drop('expired')
    return r.phase === 'compacting' ? toast($, say({ msg: 'compact.unconfirmed', p: { reason: 'the compaction did not report back' } })) : undefined
  }
  if (r.phase !== 'armed') return
  const plan = compactPlan(up.counters, await tokensOf($), now, await busyAgents($))
  if (plan.act === 'refuse') return drop('refused', compactWhy(plan.msg.slice(7), (plan.p as { detail?: string }).detail))
  if ((await draft($)) !== '') return drop('draft-in-box', 'there is a draft in the prompt box')
  if ((await patchUp($, (u) => ({ ...u, req: stepReq(u, 'begin', now) }))).req?.phase !== 'compacting') return
  toast($, say({ msg: 'compact.start', p: {} }))
  Promise.resolve($.command.run({ command: 'compact', args: r.focus })).catch(() => drop('rejected', 'the engine refused the command'))
}

// A nudge is sent for the size it has now, once, and counted; it is not work.
async function sendNudge($: any, sid: Sid, n: NudgeAct, now: number): Promise<void> {
  const sent = await submitOwn($, say(n), false).then(() => true, () => false)
  if (sent) await patchUp($, (u) => ({ ...u, due: null, counters: { ...u.counters, lastNudgeMs: now, lastNudgeKind: n.kind, nudgeTimes: pushRecent(u.counters.nudgeTimes ?? [], now) } }))
  await log($, sid, sent ? 'nudged' : 'nudge-failed', n.kind)
}
export async function nudgeTick($: any, sid: Sid, v: View): Promise<void> {
  const up = await getUp($)
  if (up.due === null) return
  const now = await $.clock.now()
  const drop = async (why: string) => {
    await patchUp($, (u) => ({ ...u, due: null }))
    await log($, sid, 'nudge-dropped', why)
  }
  if (now - up.due.at >= NUDGE_DUE_MS) return drop('expired')
  if (up.req !== null || !interactive(v, sid) || isOff(v, sid) || mem.signed.set.has(sid)) return drop('not-eligible')
  if (!(await idle($, sid))) return
  const n = sizeNudge(await tokensOf($), await cfgNow($), up.counters, now, up.due.again === true)
  return n === undefined ? drop('below-level') : sendNudge($, sid, n, now)
}
// The nudge in the middle of a turn, returned as text for the tool's result: the size alone decides, the same limits as the idle one; a session that may not be nudged is not looked at again for a minute.
export async function midNudge($: any, e: any): Promise<string | undefined> {
  const now = await $.clock.now()
  if (isSub(e) || mem.midSkip > now) return undefined
  const cfg = await cfgNow($)
  const tokens = await tokensOf($)
  if (tokens < cfg.idleK * 1000) return undefined
  const v = await getView($)
  const sid = (await $.session.id()) as Sid
  const up = await getUp($)
  const n = up.req === null && interactive(v, sid) && !isOff(v, sid) && !mem.signed.set.has(sid) ? sizeNudge(tokens, cfg, up.counters, now) : undefined
  if (n === undefined) {
    mem.midSkip = now + MID_SKIP_MS
    return undefined
  }
  await patchUp($, (u) => ({ ...u, due: null, counters: { ...u.counters, lastNudgeMs: now, lastNudgeKind: n.kind, nudgeTimes: pushRecent(u.counters.nudgeTimes ?? [], now) } }))
  mem.mid = true
  await log($, sid, 'nudged', `${n.kind} mid-turn`)
  return say(n)
}

// The keepalive ping, and in its slot a compaction nudge: the core decides; here the reads it needs, one stamp per gap, and a late check that a submit or a draft came meanwhile.
export async function keepaliveTick($: any, sid: Sid, v: View, submitsAtStart: number): Promise<void> {
  const up = await getUp($)
  const cfg = await cfgNow($)
  const now = await $.clock.now()
  if (!cfg.keepalive || up.turnEnd === undefined || up.realEnd === undefined || mem.submits !== submitsAtStart) return
  const gapStart = Math.max(up.turnEnd, mem.lastSubmit ?? 0)
  if (now - gapStart < cfg.pingAfterMin * 60_000 || (up.pingAt ?? 0) >= gapStart) return
  if (mem.pinged.realEnd !== up.realEnd) mem.pinged = { realEnd: up.realEnd, n: 0 }
  const x = {
    cfg, now, turnEnd: up.turnEnd, realEnd: up.realEnd, lastSubmit: mem.lastSubmit, pingAt: up.pingAt, woke: mem.woke, off: isOff(v, sid), rest: typeof up.restAt === 'number', signed: mem.signed.set.has(sid),
    quiet: true, tokens: await tokensOf($), pinged: mem.pinged.n, counters: up.counters,
  }
  // The quiet check reads the registry and runs `ps`, so it runs only for a gap the core would act on: a session idle all night is answered `none` without it.
  if (keepalive(x).act === 'none') return
  const act = keepalive({ ...x, quiet: up.req === null && up.due === null && interactive(v, sid) && (await idle($, sid)) })
  if (act.act === 'none') return
  await patchUp($, (u) => ({ ...u, pingAt: now }))
  if (mem.submits !== submitsAtStart || (mem.lastSubmit ?? 0) > gapStart || (await draft($)) !== '') return log($, sid, 'keepalive-skipped', 'late')
  if (act.act === 'nudge') return sendNudge($, sid, act, now)
  mem.pinged.n++
  await submitOwn($, say(act), false).then(() => log($, sid, 'keepalive'), () => log($, sid, 'keepalive-failed'))
}
