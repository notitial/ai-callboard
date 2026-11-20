// The relay: by day, an ask that has reached the person is put to him as a pop-up in the manager's session, one at a time, only while the manager is idle. Trust rules held here: the answer
// is the person's click on a label the pop-up offered, written as his by answerAsk after the ask is read again at click time (a click on a closed ask writes nothing and says so);
// nothing is shown while a window is on, and no ask is put twice.
import type { Ask, Question, Sid, View } from '../core/model.ts'
import { PERSON, nameOf } from '../core/model.ts'
import { EXPIRE_MS, QUESTION_TOOL } from '../core/asks.ts'
import { T } from '../texts.ts'
import { relayDialog, relayStep } from '../ui.ts'
import { log, notice, personDialog, toast } from './io.ts'
import { mem } from './mem.ts'
import { askOpen, askState, getView, guardOk, logAsk, offFile } from './store.ts'
import { answerAsk, openAsks } from './tools-ask.ts'
import { say } from './tools-any.ts'
import { idle } from './upkeep.ts'

type Got = Awaited<ReturnType<typeof personDialog>> | { picks: number[] }
// A question, or a call of several: one pop-up each, one after the other while the ask stays open; his pick for each is sent together after the last. Leaving one ends it.
// A single question returns his label itself, which relayRun maps to its option.
async function relaySteps($: any, ask: Ask, name: string, qs: readonly Question[]): Promise<Got> {
  const picks: number[] = []
  for (const [k, q] of qs.entries()) {
    if (!(await askOpen($, ask.id))) return { no: 'error' }
    if (mem.shown?.id === ask.id) mem.shown.tid = undefined
    const r = await personDialog($, relayStep(name, q, k + 1, qs.length), EXPIRE_MS)
    if (!('label' in r) || r.label === T['dialog.deny']({}) || qs.length === 1) return r
    picks.push(q.options.findIndex((o) => o.label === r.label) + 1)
  }
  return { picks }
}

// A late click still lands on the dialog, so it waits as long as the ask can live.
async function relayRun($: any, ask: Ask, v: View): Promise<void> {
  try {
    const name = nameOf(v, ask.asker)
    mem.shown = { id: ask.id, name }
    const qs = ask.questions ?? (ask.question === undefined ? undefined : [ask.question])
    // The note the person reads is the manager's own, never a lead's: an escalate of the manager's with no note shows the command.
    const note = qs === undefined ? (await askState($, ask.id)).ups.find((u) => u.kind === 'escalated' && u.by === v.manager)?.note : undefined
    const r = await (qs === undefined || ask.cut ? personDialog($, relayDialog(name, ask.tool, ask.input, ask.cut, ask.question, note), EXPIRE_MS) : relaySteps($, ask, name, qs)).finally(() => (mem.shown = undefined))
    if (!('picks' in r) && !('label' in r)) {
      if (r.no === 'timeout') await logAsk($, { ev: 'relay-unanswered', ask: ask.id, asker: ask.asker })
      else if (r.no !== 'error') mem.relayed.delete(ask.id)
      return
    }
    const option = 'label' in r ? (ask.question?.options.findIndex((o) => o.label === r.label) ?? -1) : -1
    const decision = 'picks' in r ? ({ decision: 'answer', picks: r.picks } as const) : r.label === T['dialog.deny']({}) ? ({ decision: 'deny' } as const) : option >= 0 ? { decision: 'answer', option: option + 1 } : ({ decision: 'allow' } as const)
    const out = await answerAsk($, await getView($, true), ask.id, decision, PERSON)
    if (out.act === 'ok') return
    const bare = out.msg === 'refuse.no-guard'
    if (bare) mem.relayed.delete(ask.id)
    toast($, say(bare ? out : { msg: 'toast.askClosed', p: {} }))
  } catch {}
}

const STALE_MS = 10_000

export async function relayTick($: any, me: Sid, v: View, now: number): Promise<void> {
  // The ask hook should close such a pop-up itself. Where the engine leaves it, a line under it says at once that its ask is decided, and one still on screen STALE_MS later is named once in a toast.
  const s = mem.shown
  if (s !== undefined && !mem.toasted.has(`shown:${s.id}`) && !(await askOpen($, s.id)) && mem.shown?.id === s.id) {
    if (s.stale === undefined) {
      s.stale = now
      if (s.tid !== undefined) notice($, s.tid, say({ msg: 'notice.askDecided', p: {} }))
      await log($, me, 'relay-stale', `${s.tid === undefined ? 'no-call-id' : 'notice'}:${s.id}`)
    }
    if (now - s.stale >= STALE_MS) (mem.toasted.add(`shown:${s.id}`), toast($, say({ msg: 'toast.askDecided', p: { name: s.name } })), await log($, me, 'relay-stale', `toast:${s.id}`))
  }
  if (v.manager !== me || (await offFile($)) || !(await guardOk($)) || !(await idle($, me))) return
  let hit: { ask: Ask } | undefined
  for (const o of (await openAsks($, me, v, now)).open) if (o.st.relay && o.ask.asker !== me && !mem.relayed.has(o.ask.id) && (o.ask.tool !== QUESTION_TOOL || o.ask.question !== undefined || o.ask.questions !== undefined) && (await askOpen($, o.ask.id))) {
      hit = o
      break
    }
  if (hit === undefined) return
  if (mem.relayed.size > 500) mem.relayed.clear()
  mem.relayed.add(hit.ask.id)
  void relayRun($, hit.ask, v)
}
