// The relay: by day, an ask that has reached the person is put to him as a pop-up in the manager's session, one at a time, only while the manager is idle. Trust rules held here: the answer
// is the person's click on a label the pop-up offered, written as his by answerAsk after the ask is read again at click time (a click on a closed ask writes nothing and says so);
// nothing is shown while a window is on, and no ask is put twice.
import type { Ask, Sid, View } from '../core/model.ts'
import { PERSON, nameOf } from '../core/model.ts'
import { EXPIRE_MS, QUESTION_TOOL } from '../core/asks.ts'
import { T } from '../texts.ts'
import { relayDialog } from '../ui.ts'
import { personDialog, toast, windowNow } from './io.ts'
import { mem } from './mem.ts'
import { askOpen, getView, logAsk, offFile } from './store.ts'
import { answerAsk, openAsks } from './tools-ask.ts'
import { say } from './tools-any.ts'
import { idle } from './upkeep.ts'

// A late click still lands on the dialog, so it waits as long as the ask can live.
async function relayRun($: any, ask: Ask, v: View): Promise<void> {
  try {
    const spec = relayDialog(nameOf(v, ask.asker), ask.tool, ask.input, ask.cut, ask.question)
    const r = await personDialog($, spec, EXPIRE_MS)
    if (!('label' in r)) {
      if (r.no === 'timeout') await logAsk($, { ev: 'relay-unanswered', ask: ask.id, asker: ask.asker })
      else if (r.no !== 'error') mem.relayed.delete(ask.id)
      return
    }
    const option = ask.question?.options.findIndex((o) => o.label === r.label) ?? -1
    const decision = r.label === T['dialog.deny']({}) ? ({ decision: 'deny' } as const) : option >= 0 ? { decision: 'answer', option: option + 1 } : ({ decision: 'allow' } as const)
    const out = await answerAsk($, await getView($, true), ask.id, decision, PERSON)
    if (out.act !== 'ok') toast($, say({ msg: 'toast.askClosed', p: {} }))
  } catch {}
}

export async function relayTick($: any, me: Sid, v: View, now: number): Promise<void> {
  if (v.manager !== me || (await windowNow($)).state !== 'off' || (await offFile($)) || !(await idle($, me))) return
  let hit: { ask: Ask } | undefined
  for (const o of (await openAsks($, me, v, now)).open) if (o.st.relay && o.ask.asker !== me && !mem.relayed.has(o.ask.id) && (o.ask.tool !== QUESTION_TOOL || o.ask.question !== undefined) && (await askOpen($, o.ask.id))) {
      hit = o
      break
    }
  if (hit === undefined) return
  if (mem.relayed.size > 500) mem.relayed.clear()
  mem.relayed.add(hit.ask.id)
  void relayRun($, hit.ask, v)
}
