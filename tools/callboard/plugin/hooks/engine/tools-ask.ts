// The ask and go tools: prompt_list, prompt_answer, go_request, go_status, and what the tick and the relay share of the open asks.
// Trust rules held here: an answer's author is the caller's own session id (or the person on his click), never a name in the input; eligibility is checked again at the write and the first
// writer wins; a go is reported only while the protected-paths guard is in place; go_request opens a dialog and returns, and only the person's click on it writes a go.
import type { Ask, Decision, Owner, Sid, View } from '../core/model.ts'
import { capability, chain, isOff, nameOf, refusal } from '../core/model.ts'
import type { Open } from '../core/asks.ts'
import { capBytes, decide, noteOf, stage } from '../core/asks.ts'
import { GO_HOURS, covers, goTextOk } from '../core/go.ts'
import type { RefuseCode } from '../core/msg.ts'
import { T } from '../texts.ts'
import { goDialog, promptList, stamp } from '../ui.ts'
import { awayNow, newId, personDialog, windowNow } from './io.ts'
import { mem } from './mem.ts'
import { askState, getView, guardOk, listGoes, logAsk, offFile, readAsk, readAskLog, readAsks, readRules, writeAnswer, writeGo, writeUp } from './store.ts'
import { deny, isSub, say } from './tools-any.ts'

const ASKS_MS = 10_000
const NOTE_MAX = 300
const GO_DIALOG_MS = 15 * 60_000

// The open asks as this process reads them, kept 10 s unless `fresh`: each with its stage now. A session eligible for an ask with no mark of its own writes a `told` mark once, so it
// stays eligible while it is above the asker.
export async function openAsks($: any, me: Sid, v: View, now: number, fresh = false): Promise<NonNullable<typeof mem.asks>> {
  if (!fresh && mem.asks !== undefined && now - mem.asks.at < ASKS_MS) return mem.asks
  const { asks, ups, answered } = await readAsks($)
  const away = await awayNow($)
  const open: { ask: Ask; st: Open }[] = []
  for (const ask of asks) {
    const st = answered.has(ask.id) ? undefined : stage({ ask, now, ups: ups.get(ask.id) ?? [], v, away })
    if (st?.open !== true) continue
    open.push({ ask, st })
    if (!st.eligible.includes(me) || isOff(v, me) || mem.told.has(ask.id) || (ups.get(ask.id) ?? []).some((u) => u.by === me)) continue
    if (mem.told.size > 500) mem.told.clear()
    mem.told.add(ask.id)
    if (await writeUp($, ask.id, me, 'told', now)) await logAsk($, { ev: 'told', ask: ask.id, asker: ask.asker, by: me })
  }
  const rows = (await readAskLog($, Math.max(mem.since, now - 3_600_000))) ?? mem.asks?.log ?? []
  return (mem.asks = { at: now, open, log: rows })
}

// The question as the ask file keeps it, in the shape decide reads a live input in.
const liveOf = (a: Ask): unknown => {
  const qs = a.questions ?? (a.question === undefined ? undefined : [a.question])
  return qs === undefined ? undefined : { questions: qs.map((q) => ({ header: q.header, question: q.question, options: q.options })) }
}

// One answer, from a session or the person: the ask is read and staged again, the answer is checked with decide, and it is written exclusively.
export async function answerAsk($: any, v: View, id: string, a: { decision: 'allow' | 'deny' | 'answer'; note?: string; option?: number; picks?: number[] }, by: Owner): Promise<Decision> {
  const no = (code: RefuseCode, detail?: string): Decision => refusal('refuse', code, { tool: 'prompt_answer', target: id, ...(detail === undefined ? {} : { detail }) })
  const ask = await readAsk($, id)
  if (ask === undefined) return no('no-such-ask')
  const { ups, answered } = await askState($, id)
  const now = await $.clock.now()
  const st = answered ? undefined : stage({ ask, now, ups, v, away: await awayNow($) })
  if (st?.open !== true) return no('ask-closed')
  const answer = { ask: id, by, decision: a.decision, at: now, ...(a.note === undefined ? {} : { note: capBytes(a.note, NOTE_MAX).text }), ...(a.option === undefined ? {} : { option: a.option }), ...(a.picks === undefined ? {} : { picks: a.picks }) }
  const d = decide(answer, ask, st, v, liveOf(ask))
  if (d.act === 'ignore') return d
  if (!(await guardOk($))) return no('no-guard')
  const w = await writeAnswer($, answer)
  return w === 'ok' ? { act: 'ok', msg: d.act === 'allow' ? 'ask.allowed' : d.act === 'deny' ? 'ask.denied' : 'ask.answered', p: { ask: id } } : w === 'exists' ? no('ask-closed') : no('not-saved', 'answer')
}

// The caller of an ask tool: a main agent that is on, or the refusal.
async function caller($: any, e: any, tool: string): Promise<{ me: Sid; v: View } | Decision> {
  const me = (await $.session.id()) as Sid
  const v = await getView($)
  return isSub(e) ? refusal('refuse', 'bad-input', { tool, detail: 'subagent' }) : isOff(v, me) ? refusal('refuse', 'is-off', { tool }) : { me, v }
}
const isCaller = (c: { me: Sid; v: View } | Decision): c is { me: Sid; v: View } => 'me' in c

export async function promptListCall($: any, e: any, _next: any) {
  const c = await caller($, e, 'prompt_list')
  if (!isCaller(c)) return deny(c)
  if (await offFile($)) return deny(refusal('refuse', 'is-off', { tool: 'prompt_list' }))
  const cap = capability(c.v, c.me)
  if (cap === 'none') return deny(refusal('refuse', 'no-capability', { tool: 'prompt_list' }))
  const now = await $.clock.now()
  const mine = (await openAsks($, c.me, c.v, now, true)).open.filter((o) => o.st.eligible.includes(c.me))
  const views = mine.map(({ ask }) => ({ ask, asker: nameOf(c.v, ask.asker), ageMin: Math.floor((now - ask.t0) / 60_000) }))
  return { result: promptList(cap === 'manager' ? await readRules($) : undefined, views) }
}

export async function promptAnswerCall($: any, e: any, _next: any) {
  const c = await caller($, e, 'prompt_answer')
  if (!isCaller(c)) return deny(c)
  if (await offFile($)) return deny(refusal('refuse', 'is-off', { tool: 'prompt_answer' }))
  const no = (code: RefuseCode, detail?: string) => deny(refusal('refuse', code, { tool: 'prompt_answer', ...(typeof e.id === 'string' ? { target: e.id.slice(0, 32) } : {}), ...(detail === undefined ? {} : { detail }) }))
  const v = await getView($, true)
  if (capability(v, c.me) === 'none') return no('no-capability')
  const id = typeof e.id === 'string' ? e.id : ''
  if (e.decision === 'escalate') {
    const ask = await readAsk($, id)
    const { ups, answered } = await askState($, id)
    const now = await $.clock.now()
    const st = ask === undefined || answered ? undefined : stage({ ask, now, ups, v, away: await awayNow($) })
    if (ask === undefined) return no('no-such-ask')
    if (st?.open !== true) return no('ask-closed')
    if (!st.eligible.includes(c.me)) return no('not-eligible')
    if (!(await writeUp($, id, c.me, 'escalated', now, c.me === v.manager ? noteOf(e.note) : undefined))) return no('not-saved', 'escalate')
    await logAsk($, { ev: 'escalated', ask: id, asker: ask.asker, by: c.me })
    const up = chain(v, ask.asker)
    const next = up.up[up.up.indexOf(c.me) + 1]
    return { result: say({ msg: 'ask.escalated', p: { ask: id, to: next === undefined ? up.top : nameOf(v, next) } }) }
  }
  if (e.decision !== 'allow' && e.decision !== 'deny' && e.decision !== 'answer') return no('bad-input', 'decision')
  const r = await answerAsk($, v, id, { decision: e.decision, ...(typeof e.note === 'string' ? { note: e.note } : {}), ...(Number.isInteger(e.option) ? { option: e.option } : {}) }, c.me)
  return r.act === 'ok' ? { result: say(r) } : deny(r)
}

// The person's click on the go dialog writes the go; the tool has returned by then.
async function goDialogRun($: any, me: Sid, name: string, text: string): Promise<void> {
  try {
    const end = (await $.clock.now()) + GO_HOURS * 3_600_000
    const r = await personDialog($, goDialog(name, text, stamp(end)), GO_DIALOG_MS)
    if (!('label' in r) && r.no !== 'error' && r.no !== 'timeout') return
    const outcome = !('label' in r) ? 'closed' : r.label !== T['dialog.yes']({}) ? 'declined' : (await writeGo($, { id: newId(), giver: me, text, end })) ? 'given' : 'unsaved'
    mem.owed.push(T['go.clicked']({ outcome }))
  } catch {}
}
export async function goRequestCall($: any, e: any, _next: any) {
  const c = await caller($, e, 'go_request')
  if (!isCaller(c)) return deny(c)
  const no = (code: RefuseCode) => deny(refusal('refuse', code, { tool: 'go_request' }))
  if (!goTextOk(e.text)) return no('go-bad-text')
  if ((await windowNow($, true)).state !== 'off') return no('unattended')
  if (mem.dialogs.size > 0) return no('dialog-open')
  const text: string = e.text
  void goDialogRun($, c.me, nameOf(c.v, c.me), text)
  return { result: say({ msg: 'go.requested', p: { text, end: stamp((await $.clock.now()) + GO_DIALOG_MS) } }) }
}

export async function goStatusCall($: any, e: any, _next: any) {
  if (isSub(e)) return deny(refusal('refuse', 'bad-input', { tool: 'go_status', detail: 'subagent' }))
  const me = (await $.session.id()) as Sid
  if (!(await guardOk($))) return { result: say({ msg: 'go.noGuard', p: {} }) }
  const v = await getView($, true)
  const now = await $.clock.now()
  const mine = v.rows === 'unknown' ? [] : (await listGoes($)).filter((g) => covers(g, me, v, now))
  return { result: say(mine.length === 0 ? { msg: 'go.none', p: {} } : { msg: 'go.status', p: { covers: mine.map((g) => ({ giver: nameOf(v, g.giver), text: g.text, end: stamp(g.end) })) } }) }
}
