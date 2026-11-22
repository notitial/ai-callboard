// The session start and end, the registration of the tools and commands by what a session may use, the 2 s tick, and the PostToolUse hook that carries the same texts mid-turn.
// Trust rules held here: one tick runs at a time and a step that throws is logged and does not stop the others; at most one text is submitted per tick; a notice is recomputed
// from the sessions under this one now each time it is sent, a key is spent only when the turn carrying it starts, and nothing is sent unless the session is quiet.
import type { Notice, Sid, ToolName, View } from '../core/model.ts'
import { PERSON, TOOLS, capability, children, descendants, isConductor, isOff, nameOf, parent } from '../core/model.ts'
import { tidy } from '../core/lifecycle.ts'
import { sweep } from '../core/asks.ts'
import { digest, notices } from '../core/notices.ts'
import type { DigestItem } from '../core/notices.ts'
import { SLEEP_GAP_MS } from '../core/upkeep.ts'
import { T } from '../texts.ts'
import { TOOL_SCHEMAS } from '../tool-schemas.ts'
import { cueTick } from './cue.ts'
import { handoverTick } from './handover.ts'
import { TICK_MS, log, registerFree, submitOwn, toast } from './io.ts'
import { getUp, mem, resetSession, spendStarted, staleView } from './mem.ts'
import { markDone } from './ask-hook.ts'
import { prClaim, prTick } from './pr.ts'
import { presetRegister, presetTick } from './preset.ts'
import { relayTick } from './relay.ts'
import { askOpen, getView, listGoes, logAsk, readAsks, rmAsk, tidyAsks, tidyAskLogs, updateTable } from './store.ts'
import { isSub, say } from './tools-any.ts'
import { openAsks } from './tools-ask.ts'
import { idle, keepaliveTick, midNudge, nudgeTick, requestTick, signedNow } from './upkeep.ts'
import { usageDrop, usageFlush, usageSweep } from './usage.ts'

// ---- what a session is given: the six tools every session has at its start, the thirteen when it holds a capability (and, once, from the tick or from `/callboard lead`) ----
async function registerTools($: any, group: 'any' | 'parent'): Promise<void> {
  for (const name of TOOLS) {
    const s = TOOL_SCHEMAS[name as ToolName]
    if (s.cap === group) await $.tool.register({ name, description: (T[`tool.${name}`] as (p: unknown) => string)({}), inputSchema: s.input })
  }
}
export async function giveParentTools($: any, v: View, me: Sid): Promise<void> {
  if (mem.parentTools || capability(v, me) === 'none') return
  mem.parentTools = true
  await registerTools($, 'parent').catch(() => void (mem.parentTools = false))
}
// The timer starts before anything is registered, so a registration that throws leaves the session kept warm.
export async function sessionStart($: any, e: any, next: any) {
  if (mem.since === 0) mem.since = await $.clock.now()
  if (!mem.timer) {
    mem.timer = true
    $.clock.every(TICK_MS, () => tick($))
  }
  usageSweep($).catch(() => undefined)
  await registerTools($, 'any')
  mem.taken.clear()
  for (const [name, help] of [['callboard', 'help.status'], ['rest', 'help.rest'], ['unattended', 'help.unattended'], ['lead', 'help.lead'], ['conductor', 'help.conductor']] as const) {
    await registerFree($, name, T[help](), (c) => c.plugin === 'callboard' || c.description === T[help]())
  }
  await presetRegister($).catch(() => undefined)
  return next(e)
}
export async function sessionEnd($: any, e: any, next: any) {
  await usageDrop($, await $.session.id()).catch(() => undefined)
  // The process goes on under a new session id after a `/clear` (a handover's or one typed) and after a `/resume`: what belonged to the id that ended does not carry over.
  if (e?.reason === 'clear' || e?.reason === 'resume') {
    resetSession()
    mem.cleared = e.reason === 'clear'
    staleView()
  }
  return next(e)
}

// ---- the notices ----
// The inputs the ask notices read: the open asks this session is eligible for (each checked open again now), the ask log from this process's cursor, and the sessions whose ask is open.
async function askInputs($: any, me: Sid, v: View, now: number) {
  if (capability(v, me) === 'none') return { asks: [] as { id: string; asker: Sid }[], log: [] as never[], asking: new Set<Sid>() }
  const { open, log: rows } = await openAsks($, me, v, now)
  const asks: { id: string; asker: Sid }[] = []
  for (const o of open) if (o.st.eligible.includes(me) && (await askOpen($, o.ask.id))) asks.push({ id: o.ask.id, asker: o.ask.asker })
  return { asks, log: rows, asking: new Set(open.map((o) => o.ask.asker)) }
}
// One line per event.
function lineOf(v: View, n: Notice, now: number): string | undefined {
  const name = nameOf(v, n.about)
  const reg = v.rows === 'unknown' ? undefined : v.rows.get(n.about)
  if (n.kind === 'done' || n.kind === 'gone') return say({ msg: `event.${n.kind}`, p: { name } })
  if (n.kind === 'waiting') return say({ msg: 'event.waiting', p: { name, why: (reg?.waitingFor ?? '').slice(0, 80) } })
  if (n.kind === 'quiet') return say({ msg: 'event.quiet', p: { name, minutes: Math.floor((now - (reg?.statusAt ?? now)) / 60_000) } })
  const ask = n.ask ?? ''
  if (n.kind === 'ask') return say({ msg: 'event.ask', p: { ask, name, tool: mem.asks?.open.find((o) => o.ask.id === ask)?.ask.tool ?? '' } })
  return say({ msg: 'event.expired', p: { ask, name, tool: mem.asks?.log.find((l) => l.ask === ask && l.code !== undefined && l.ev === 'expired')?.code ?? '' } })
}
type Line = { keys: string[]; line: string }
// One line per digest item; a panel item counts every ask it carries.
const digestLine = (v: View, d: DigestItem): string => (d.kind === 'panel' ? say({ msg: 'digest.panel', p: { name: nameOf(v, d.about), n: d.n } }) : say({ msg: `digest.${d.kind}`, p: { name: nameOf(v, d.about) } }))
// The events owed now, computed again from the sessions under this one: a key already spent, or carried by a text submitted and not yet started, is left out. `since` is the
// manager's digest, worked out only when an event will carry it.
async function owed($: any, me: Sid, v: View, now: number): Promise<{ list: Line[]; since: Line[] }> {
  spendStarted(undefined, now)
  const held = new Set([...mem.pending.values()].flatMap((p) => p.keys))
  const events = notices({ me, v, now, since: mem.since, signed: mem.signed.set, ...(await askInputs($, me, v, now)) })
  const list = events.filter((n) => !mem.spent.has(n.key) && !held.has(n.key)).flatMap((n) => ((l) => (l === undefined ? [] : [{ keys: [n.key], line: l }]))(lineOf(v, n, now)))
  const items = list.length === 0 || capability(v, me) !== 'manager' ? [] : digest({ me, v, since: mem.since, now, log: mem.asks?.log ?? [], signed: mem.signed.set, goes: await listGoes($), spent: new Set([...mem.spent, ...held]) })
  return { list, since: items.map((d) => ({ keys: d.keys, line: digestLine(v, d) })) }
}
// The check-in text and the keys it carries.
const checkIn = (o: { list: Line[]; since: Line[] }): { text: string; keys: string[] } => ({
  text: say({ msg: 'event.turn', p: { lines: o.list.map((x) => x.line), since: o.since.map((x) => x.line) } }),
  keys: [...o.list, ...o.since].flatMap((x) => x.keys),
})
async function quiet($: any, me: Sid): Promise<boolean> {
  return (await getUp($)).req === null && (await idle($, me))
}
async function eventsTick($: any, me: Sid, v: View, now: number): Promise<void> {
  const o = await owed($, me, v, now)
  if (o.list.length === 0 || !(await quiet($, me))) return
  const { text, keys } = checkIn(o)
  mem.pending.set(text, { keys, at: now })
  await submitOwn($, text, false).then(() => log($, me, 'events', String(o.list.length)), () => void mem.pending.delete(text))
}
async function prNoticeTick($: any, me: Sid): Promise<void> {
  if (mem.prNotes.length === 0 || !(await quiet($, me))) return
  const c = prClaim()
  if (c !== undefined) await submitOwn($, c.text, false).catch(() => c.undo())
}
// A session turned off is sent nothing: what it was owed is dropped.
async function owedTick($: any, me: Sid, v: View): Promise<void> {
  if (isOff(v, me)) return void (mem.owed.length = 0)
  const text = mem.owed[0]
  if (text !== undefined && (await quiet($, me))) await submitOwn($, text, false).then(() => void mem.owed.shift(), () => log($, me, 'error', 'owed'))
}
function toasts($: any, v: View, me: Sid): void {
  const once = (key: string, text: string) => (mem.toasted.has(key) ? undefined : (mem.toasted.add(key), toast($, text)))
  if (v.managers.length > 1) once(`two:${v.managers.join()}`, say({ msg: 'toast.twoManagers', p: { a: nameOf(v, v.managers[0]!), b: nameOf(v, v.managers[1]!) } }))
  if (v.manager === null && v.handing.size === 0 && typeof v.managerName === 'string' && parent(v, me) === PERSON) once('no-manager', say({ msg: 'toast.noManager', p: {} }))
  if (v.manager !== null) mem.toasted.delete('no-manager')
}

// ---- the table and the signed set ----
// Every 30 s: names copied, a row no live session carries marked gone, an expired one dropped; written only if it changed, under the table's lock.
async function tableTick($: any, v: View, now: number): Promise<void> {
  if (v.rows === 'unknown' || now - mem.tableAt < 30_000) return
  mem.tableAt = now
  for (const k of Object.keys(v.table)) v.rows.has(k) ? mem.noSince.delete(k) : mem.noSince.has(k) || mem.noSince.set(k, now)
  const next = (t: typeof v.table) => tidy(t, v, (k) => mem.noSince.get(k), now)
  if (JSON.stringify(next(v.table)) !== JSON.stringify(v.table)) await updateTable($, next)
}
// Every 30 s: the sessions, this one and its children (the manager and a conductor: everything under it), whose report is signed.
async function signedTick($: any, v: View, me: Sid, now: number): Promise<void> {
  if (now - mem.signed.at < 30_000) return
  mem.signed.at = now
  const set = new Set<Sid>()
  await Promise.all([me, ...(capability(v, me) === 'none' ? [] : capability(v, me) === 'manager' || isConductor(v, me) ? descendants(v, me) : children(v, me))].map(async (k) => ((await signedNow($, k, v.table[k])) ? set.add(k) : undefined)))
  mem.signed = { at: now, set }
}

// Every 30 s, by any session: the ask files of a dead asker are removed, and so is one whose live asker no longer waits; one the sweeper itself has been awake long enough to judge stale is
// told once to the person. Ask logs older than 90 days go once a day.
async function sweepTick($: any, v: View, me: Sid, now: number): Promise<void> {
  if (now - mem.sweepAt < 30_000) return
  mem.sweepAt = now
  if (now - mem.tidyAt >= 86_400_000) {
    mem.tidyAt = now
    await tidyAskLogs($)
  }
  await tidyAsks($)
  for (const ask of (await readAsks($)).asks) {
    const awake = now - Math.max(mem.woke ?? 0, mem.since)
    // The view kept 10 s may predate the asker's row: an end is decided on a reading made now.
    const fresh = sweep(ask, v, now, awake) === 'keep' ? v : await getView($, true)
    const r = sweep(ask, fresh, now, awake)
    const waiting = fresh.rows === 'unknown' ? undefined : fresh.rows.get(ask.asker)?.status === 'waiting'
    if (r === 'sweep' || (r === 'stale' && waiting === false)) {
      await logAsk($, { ev: 'swept', ask: ask.id, asker: ask.asker })
      await rmAsk($, ask.id)
    } else if (r === 'stale' && capability(v, me) !== 'none' && !mem.toasted.has(`stuck:${ask.id}`)) {
      mem.toasted.add(`stuck:${ask.id}`)
      toast($, say({ msg: 'toast.askStuck', p: { ask: ask.id, name: nameOf(v, ask.asker) } }))
    }
  }
}

// ---- the tick ----
async function tick($: any): Promise<void> {
  if (mem.ticking) return
  mem.ticking = true
  const me = (await $.session.id().catch(() => '')) as Sid
  const step = (name: string, f: () => Promise<unknown>) => f().catch(() => log($, me, 'error', name))
  try {
    const now = await $.clock.now()
    if (mem.lastTimer !== undefined && now - mem.lastTimer > SLEEP_GAP_MS) mem.woke = now
    mem.lastTimer = now
    const v = await getView($)
    const start = mem.submits
    await step('parent-tools', () => giveParentTools($, v, me))
    await step('table', () => tableTick($, v, now))
    await step('signed', () => signedTick($, v, me, now))
    await step('toasts', async () => toasts($, v, me))
    await step('handover', () => handoverTick($, me, now))
    // A session handed over by this step is a new one from here: the rest of the tick belongs to the next.
    if ((await step('request', () => requestTick($, me))) === true) return
    if (mem.submits === start) await step('cue', () => cueTick($, me, v, now))
    if (mem.submits === start) await step('nudge', () => nudgeTick($, me, v))
    if (mem.submits === start) await step('events', () => eventsTick($, me, v, now))
    await step('asks', () => sweepTick($, v, me, now))
    await step('relay', () => relayTick($, me, v, now))
    await step('pr-poll', () => prTick($, me, v))
    if (mem.submits === start) await step('pr-notice', () => prNoticeTick($, me))
    if (mem.presetRun !== undefined && mem.submits === start) await step('preset', async () => (await quiet($, me)) && presetTick($, me, v))
    if (mem.submits === start) await step('owed', () => owedTick($, me, v))
    await step('keepalive', () => keepaliveTick($, me, v, start))
    await step('usage', () => usageFlush($, me))
  } finally {
    mem.ticking = false
  }
}

// After a tool (its end is marked for the asker's loop first): for the main agent the nudge, the events and the PR notes owed are added to the result as context, never merged into one text, and each is claimed as it is returned.
export async function postToolHook($: any, e: any, next: any) {
  markDone(e)
  const r = await next(e)
  if (isSub(e)) return r
  const texts: string[] = []
  try {
    const me = (await $.session.id()) as Sid
    const nudge = await midNudge($, e)
    const o = await owed($, me, await getView($), await $.clock.now())
    const pr = prClaim()
    const c = o.list.length === 0 ? undefined : checkIn(o)
    for (const k of c?.keys ?? []) mem.spent.add(k)
    texts.push(...[nudge, c?.text, pr?.text].filter((t): t is string => t !== undefined))
  } catch {}
  if (texts.length === 0) return r
  const extra = (r as { additionalContext?: unknown } | null | undefined)?.additionalContext
  return { ...(r ?? {}), additionalContext: [...(Array.isArray(extra) ? extra : []), ...texts] }
}
