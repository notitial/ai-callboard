// The ask hook: the `tool.check` join, PermissionRequest, the done hooks, and the one loop an ask lives in. Trust rules held here: every ask the hook sees enters the loop, whose only
// exits are a click, a decision that passes decide() against the live input, and a close from stage(); the loop runs whether or not its file could be written; an OFF file or an off
// session leaves the dialog with the person; a throw returns the chain beneath, so the dialog stays; the answer returned is built from the live input, never from a file.
import type { Ask, AskEvent, Owner, Sid } from '../core/model.ts'
import { capability, isOff, parent } from '../core/model.ts'
import type { CheckFacts } from '../core/asks.ts'
import { QUESTION_TOOL, awakeAdd, classify, decide, inputText, questionView, questionsView, stage } from '../core/asks.ts'
import { PRINT_CAP, printed } from '../ui.ts'
import { log, newId, pause, toast, windowNow } from './io.ts'
import { mem } from './mem.ts'
import { askState, getView, guardOk, logAsk, offFile, readAnswer, readOwnRow, rmAnswer, rmAsk, writeAsk } from './store.ts'
import { isSub, say } from './tools-any.ts'

const JOIN_TTL_MS = 60_000
const JOIN_MAX = 64
const JOIN_KEY_MAX = 100_000
const POLL_MS = 2000
const BEAT_MS = 10_000
const PAUSE_FAILS_MAX = 3

// The input with its keys in order, in objects with no prototype (a `__proto__` key is an ordinary entry): the same call gives the same key in both hooks.
const sorted = (_k: string, v: unknown): unknown => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const o: Record<string, unknown> = Object.create(null)
  for (const k of Object.keys(v).sort()) o[k] = (v as Record<string, unknown>)[k]
  return o
}
const joinKey = (tool: string, input: unknown): string => `${tool}\n${JSON.stringify(input, sorted)}`
const decided = (x: any): boolean => x?.decision !== undefined || x?.hookSpecificOutput?.decision !== undefined

// The relay's own dialog in the manager's session (engine/relay.ts): the AskUserQuestion this plugin called there itself, known by its first question. It is no ask: the person
// alone answers it, so both hooks pass it through untouched.
const PLUGIN = 'callboard'
const isProxy = (tool: unknown, input: any, next: any): boolean => tool === QUESTION_TOOL && next?.origin?.plugin === PLUGIN && mem.proxy?.first !== undefined && input?.questions?.[0]?.question === mem.proxy.first

// tool.check only observes: it keeps what it saw for a call that is neither allowed nor denied (a dialog may follow), 60 s, and returns the engine's verdict unchanged, every time.
export async function toolCheck($: any, e: any, next: any) {
  const r = await next(e)
  if (isProxy(e.tool, e.input, next)) return r
  try {
    if (r?.decision !== 'allow' && r?.decision !== 'deny' && typeof e.tool_use_id === 'string' && !isSub(e)) {
      const key = joinKey(String(e.tool), e.input)
      const now = await $.clock.now()
      const old = mem.checks.get(key)
      const dup = old !== undefined && now - old.at <= JOIN_TTL_MS && old.toolUseId !== e.tool_use_id
      if (key.length <= JOIN_KEY_MAX) mem.checks.set(key, { toolUseId: e.tool_use_id, at: now, dup, approver: e.approver, facts: { reason: r?.reason, rule: r?.rule, hook: r?.hook, setting: r?.setting, plugin: r?.plugin, ceiling: r?.ceiling } })
      for (const [k, c] of mem.checks) if (now - c.at > JOIN_TTL_MS || mem.checks.size > JOIN_MAX) mem.checks.delete(k)
    }
  } catch {}
  return r
}
// A call's end (a Yes click fires no signal) or a refusal: the asker's loop learns of a click by this id.
export function markDone(e: any): void {
  const tid = typeof e?.tool_use_id === 'string' ? e.tool_use_id : undefined
  if (tid === undefined) return
  mem.done.add(tid)
  if (mem.done.size > 200) mem.done.delete(mem.done.values().next().value as string)
  for (const [k, c] of mem.checks) if (c.toolUseId === tid) mem.checks.delete(k)
}
export async function doneHook(_$: any, e: any, next: any) {
  markDone(e)
  return next(e)
}

// One of this session's own open dialogs, shown through this hook as a question: exactly one question whose header and text match, from the main agent. Only the person answers it.
function ownDialog(tool: unknown, input: any, e: any): boolean {
  const qs = input?.questions
  return tool === QUESTION_TOOL && !isSub(e) && Array.isArray(qs) && qs.length === 1 && mem.dialogs.has(`${qs[0]?.header}\n${qs[0]?.question}`)
}

export async function permissionRequest($: any, e: any, next: any) {
  // The relay's dialog goes to the person unless a hook beneath decides it; the relay writes his dismissal as a deny only when it went to him.
  if (isProxy(e.tool_name, e.tool_input, next)) {
    const p = mem.proxy
    const r = await next(e)
    if (!decided(r) && p !== undefined) p.shown = true
    return r
  }
  const me = (await $.session.id()) as Sid
  const v = await getView($)
  if (isOff(v, me) || (await offFile($))) return next(e)
  if (ownDialog(e.tool_name, e.tool_input, e)) return {}
  if (isSub(e)) {
    // A subagent's dialog is shown only after the hooks return, so nothing can wait for it: the chain beneath, else a deny that sends the main agent to run the call itself, but only
    // where the main session's own ask could rise (a lead is above it, or a window is on and it rises to the manager).
    const under = await next(e)
    const lead = capability(v, parent(v, me) as Sid) === 'lead'
    return decided(under) || !(lead || (await windowNow($)).state === 'on') ? under : { decision: { behavior: 'deny', message: say({ msg: 'ask.subagent', p: {} }) } }
  }
  const t0 = await $.clock.now()
  const key = joinKey(String(e.tool_name), e.tool_input)
  const c = mem.checks.get(key)
  mem.checks.delete(key)
  const beneath = await next(e)
  if (decided(beneath)) return beneath
  try {
    return await hold($, e, beneath, next.signal, me, t0, c !== undefined && !c.dup && t0 - c.at <= JOIN_TTL_MS ? c : undefined)
  } catch {
    return beneath
  }
}

// The loop. Each poll: a click, the OFF file, the close, the beat, an answer. Awake time is the polls' own gaps, capped, so a Mac that slept adds nothing.
async function hold($: any, e: any, beneath: any, signal: AbortSignal | undefined, me: Sid, t0: number, entry: { toolUseId: string; approver: unknown; facts: CheckFacts } | undefined): Promise<unknown> {
  const tool = String(e.tool_name)
  const input = e.tool_input
  // A host (a hook, a mode) answers: nobody waits on the person, so it is not ours.
  if (entry !== undefined && entry.approver !== 'person') return beneath
  const tid = entry?.toolUseId
  const shown = inputText(input)
  const q = tool === QUESTION_TOOL ? questionView(input) : undefined
  const qs = tool === QUESTION_TOOL ? questionsView(input) : undefined
  const base: Ask = { id: newId(), asker: me, t0, awake: 0, raisedBy: classify(tool, entry?.facts), tool, input: shown.text, cut: shown.cut || printed(shown.text, PRINT_CAP).cut, beat: t0, ...(q === undefined ? {} : { question: q }), ...(qs === undefined ? {} : { questions: qs }) }
  await logAsk($, { ev: 'raised', ask: base.id, asker: me, code: tool })
  const finish = async (ev: AskEvent, out: unknown, by?: Owner, code?: string) => {
    await logAsk($, { ev, ask: base.id, asker: me, ...(by === undefined ? {} : { by }), ...(code === undefined ? {} : { code }) })
    await rmAsk($, base.id)
    return out
  }
  let awake = 0
  let last = t0
  let beatAt = -Infinity
  let wrote = true
  let seen = false
  let fails = 0
  // The dialog counts as clicked once the own row has been seen waiting after the ask began and is then not waiting; a row that is missing is unknown.
  const clicked = async (): Promise<boolean> => {
    const row = await readOwnRow($, me)
    if (row === undefined) return false
    const waiting = row.status === 'waiting' && (row.waitingFor ?? null) !== null
    if (waiting && (row.statusAt ?? 0) >= t0) seen = true
    return seen && !waiting
  }
  try {
    for (;;) {
      const now = await $.clock.now()
      if (signal?.aborted || (tid !== undefined && mem.done.has(tid)) || (await clicked())) return finish('closed', beneath, undefined, 'click')
      const v = await getView($)
      if (isOff(v, me) || (await offFile($))) return finish('closed', beneath, undefined, 'off')
      // The one early close: the manager's own dialog while the person is away. Nobody is above it, and its turn is the one that answers every ask below.
      if (v.manager === me && (await windowNow($)).state === 'on') return finish('closed', { ...beneath, decision: { behavior: 'deny', message: say({ msg: 'ask.away', p: {} }) } }, undefined, 'away')
      const ask: Ask = { ...base, awake }
      const { ups, answered } = await askState($, ask.id)
      const st = stage({ ask, now, ups, v })
      if (!st.open) return finish('expired', { ...beneath, decision: { behavior: 'deny', message: say(st) } }, undefined, tool)
      if (now - beatAt >= BEAT_MS) {
        beatAt = now
        const ok = await writeAsk($, { ...ask, beat: now })
        if (!ok && wrote) toast($, say({ msg: 'toast.askNoFile', p: { ask: ask.id } }))
        wrote = ok
      }
      const a = answered ? await readAnswer($, ask.id) : undefined
      if (answered) {
        const d = a === undefined ? undefined : decide(a, ask, st, v, input)
        const guarded = await guardOk($)
        if (!guarded || a === undefined || d === undefined || d.act === 'ignore') {
          await rmAnswer($, ask.id)
          await log($, me, 'answer-dropped', !guarded ? 'no-guard' : d === undefined ? 'shape' : d.msg.slice(7))
        } else if (await clicked()) return finish('closed', beneath, undefined, 'click')
        else {
          const decision = d.act === 'allow' ? { behavior: 'allow' } : d.act === 'deny' ? { behavior: 'deny', message: say(d) } : { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(d.picks.map((x) => [x.question, say({ msg: 'ask.answerText', p: { label: x.label, by: d.by } })])) } }
          return finish('answered', { ...beneath, decision }, a.by)
        }
      }
      const ran = await pause($, POLL_MS)
      const after = await $.clock.now()
      if (ran) {
        fails = 0
        awake = awakeAdd(awake, after - last)
      } else if (!signal?.aborted && ++fails >= PAUSE_FAILS_MAX) return finish('closed', beneath, undefined, 'hook-failed')
      last = after
    }
  } catch {
    return finish('closed', beneath, undefined, 'error')
  }
}
