// The relay: by day, an ask that has reached the person is put to them in the manager's session as an AskUserQuestion that callboard calls there itself (`$.agent.call`), one at a
// time, raised only while the manager is idle: the asker's own questions, or for a tool ask a question that names the call. The dialog is the engine's own, and its abort signal
// is the plugin's handle on it: each tick first closes the open one once its ask is closed elsewhere or a window is not off. Trust rules held here: the answer is the person's pick
// in that dialog, written as theirs by answerAsk after the ask is read again (a pick on a closed ask writes nothing and says so); only a dialog the ask hook saw go to the person
// is theirs, so a result or a refusal that came before it writes nothing, and a dismissal after it is their deny; a dialog that was cut or closed by itself writes nothing and is
// put again; nothing is raised unless the window reads off; the OS notification names the asker by a plain name or its id, and the tool, never the command.
import type { Ask, Question, Sid, View } from '../core/model.ts'
import { NAME_RE, PERSON, nameOf } from '../core/model.ts'
import type { Picked } from '../core/asks.ts'
import { QUESTION_TOOL, readAnswers } from '../core/asks.ts'
import { T } from '../texts.ts'
import type { AskQuestion, DialogSpec } from '../ui.ts'
import { askOf, mirrorOf, relayDialog, relayNote } from '../ui.ts'
import { log, notify, toast, unnotify, windowNow } from './io.ts'
import { mem } from './mem.ts'
import { askOpen, askState, getView, guardOk, offFile } from './store.ts'
import { answerAsk, openAsks } from './tools-ask.ts'
import { say } from './tools-any.ts'
import { idle } from './upkeep.ts'

type Relay = NonNullable<typeof mem.proxy>
type Answer = { decision: 'allow' | 'deny' | 'answer'; note?: string; option?: number; picks?: number[] }
// What came of one dialog: his picks or his note, his dismissal, or nothing (cut, never shown to him, closed by itself, or empty).
type Out = Picked | 'dismissed'
type Chosen = { label: string } | Exclude<Out, { picks: number[] }>

// One dialog in the manager's session. The call resolves with the tool's result, or `{ deny }` once he dismissed it, a check refused it, or the tick cut it. Only a dialog the
// ask hook saw go to him is his: a result a hook gave in his place is nothing. One that closed by itself while he was idle is put again (`idle`).
async function put($: any, p: Relay, questions: AskQuestion[]): Promise<Out> {
  p.first = questions[0]!.question
  p.shown = false
  const r = await $.agent.call({ tool: QUESTION_TOOL, input: { questions } }, { signal: p.ctrl.signal })
  if (p.ctrl.signal.aborted || !p.shown) return undefined
  if (r?.deny !== undefined) return 'dismissed'
  if (r?.result?.afkTimeoutMs !== undefined) p.idle = true
  return readAnswers(questions, r?.result)
}
// A pop-up of the plugin's own: the label he picked, or what else came of it.
async function pick($: any, p: Relay, spec: DialogSpec): Promise<Chosen> {
  const qs = askOf(spec)
  const r = await put($, p, qs)
  return r !== undefined && r !== 'dismissed' && 'picks' in r ? { label: qs[0]!.options[r.picks[0]! - 1]!.label } : r
}
// Allow and Deny decide; a dismissal is a deny, and his note a deny that carries it; Leave it, or nothing, writes nothing.
const answerOf = (r: Chosen): Answer | undefined =>
  r === undefined ? undefined : r === 'dismissed' ? { decision: 'deny' } : 'note' in r ? { decision: 'deny', note: r.note } : r.label === T['dialog.allow']({}) ? { decision: 'allow' } : r.label === T['dialog.deny']({}) ? { decision: 'deny' } : undefined

// A tool ask the manager escalated with a note: the note first, where Allow or Deny decides and Show the command opens the command's own pop-up; an ask closed between the two
// ends it. Without a note, or for a cut ask, it is the command's pop-up alone.
async function relayCall($: any, p: Relay, ask: Ask, name: string, note: string | undefined): Promise<Answer | undefined> {
  if (note !== undefined && !ask.cut) {
    const r = await pick($, p, relayNote(name, ask.tool, note, ask.input))
    if (r === undefined || r === 'dismissed' || 'note' in r || r.label !== T['dialog.show']({})) return answerOf(r)
    if (!(await askOpen($, ask.id))) return undefined
  }
  return answerOf(await pick($, p, relayDialog(name, ask.tool, ask.input, ask.cut)))
}
// A question, or a call of several: the asker's own questions in one dialog, his pick for each sent together. A question not shown whole gets the command's pop-up, Deny only.
async function relayQuestions($: any, p: Relay, ask: Ask, name: string, qs: readonly Question[]): Promise<Answer | undefined> {
  const sent = mirrorOf(name, qs)
  if (sent === undefined || ask.cut) return answerOf(await pick($, p, relayDialog(name, ask.tool, ask.input, true)))
  const r = await put($, p, sent)
  return r === undefined || r === 'dismissed' || 'note' in r ? answerOf(r) : qs.length === 1 ? { decision: 'answer', option: r.picks[0]! } : { decision: 'answer', picks: r.picks }
}

// The dialog waits as long as the ask lives: its close is the tick's.
async function relayRun($: any, me: Sid, ask: Ask, v: View): Promise<void> {
  const p: Relay = { id: ask.id, ctrl: new AbortController(), shown: false }
  mem.proxy = p
  try {
    const name = nameOf(v, ask.asker)
    notify($, ask.id, T['notify.relay']({ name: NAME_RE.test(name) ? name : ask.asker, tool: ask.tool }))
    const qs = ask.questions ?? (ask.question === undefined ? undefined : [ask.question])
    // The note the person reads is the manager's own, never a lead's: an escalate of the manager's with no note shows the command.
    const note = qs === undefined ? (await askState($, ask.id)).ups.find((u) => u.kind === 'escalated' && u.by === v.manager)?.note : undefined
    const a = await (qs === undefined ? relayCall($, p, ask, name, note) : relayQuestions($, p, ask, name, qs))
    if (a === undefined) {
      // Cut while still open (a window came on), or closed by itself while he was idle: offered again. Never shown to him: not offered again, and logged.
      if (p.ctrl.signal.aborted || p.idle) mem.relayed.delete(ask.id)
      else if (!p.shown) await log($, me, 'relay-refused', ask.id)
      return
    }
    const out = await answerAsk($, await getView($, true), ask.id, a, PERSON)
    if (out.act === 'ok') return
    const bare = out.msg === 'refuse.no-guard'
    if (bare) mem.relayed.delete(ask.id)
    toast($, say(bare ? out : { msg: 'toast.askClosed', p: {} }))
  } catch {
    await log($, me, 'relay-error', ask.id)
  } finally {
    if (mem.proxy === p) mem.proxy = undefined
    unnotify($, ask.id)
  }
}

export async function relayTick($: any, me: Sid, v: View, now: number): Promise<void> {
  // The close comes first, before every gate, so it runs while the manager is busy too.
  const p = mem.proxy
  if (p !== undefined && !p.ctrl.signal.aborted && ((await windowNow($)).state !== 'off' || !(await askOpen($, p.id)))) p.ctrl.abort()
  if (mem.proxy !== undefined || v.manager !== me || (await offFile($)) || !(await guardOk($)) || !(await idle($, me))) return
  let hit: { ask: Ask } | undefined
  for (const o of (await openAsks($, me, v, now)).open) if (o.st.relay && o.ask.asker !== me && !mem.relayed.has(o.ask.id) && (o.ask.tool !== QUESTION_TOOL || o.ask.question !== undefined || o.ask.questions !== undefined) && (await askOpen($, o.ask.id))) {
      hit = o
      break
    }
  if (hit === undefined || (await windowNow($, true)).state !== 'off') return
  if (mem.relayed.size > 500) mem.relayed.clear()
  mem.relayed.add(hit.ask.id)
  void relayRun($, me, hit.ask, v)
}
