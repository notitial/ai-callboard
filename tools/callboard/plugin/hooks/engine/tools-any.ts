// The tools every session has (`rest`) and the helpers the tool and command bodies share: a decision said as text, a refusal as a tool's deny, the rest mark.
import type { Decision } from '../core/model.ts'
import { refusal } from '../core/model.ts'
import type { Say } from '../core/msg.ts'
import { T } from '../texts.ts'
import { log } from './io.ts'
import { patchUp } from './mem.ts'

// The words of a decision: its message id and parameters through the one texts table.
export const say = (d: Say): string => (T[d.msg] as (p: unknown) => string)(d.p)
export const deny = (d: Decision) => ({ deny: say(d) })
// A call made by a subagent: the engine stamps its agent id.
export const isSub = (e: any): boolean => (typeof e?.agentId === 'string' && e.agentId !== '') || (typeof e?.agent_id === 'string' && e.agent_id !== '')

// `/callboard rest` and the `rest` tool: this session is left alone for this idle gap. A real turn that starts ends it (turnStart).
export async function restSet($: any, sid: string, via: 'command' | 'tool'): Promise<boolean> {
  try {
    const at = await $.clock.now()
    await patchUp($, (u) => ({ ...u, restAt: at }))
  } catch {
    return false
  }
  await log($, sid, 'rest', via).catch(() => undefined)
  return true
}
// A subagent is refused: the rest is the session's, and its call would rest the parent.
export async function restCall($: any, e: any, _next: any) {
  const sid = await $.session.id()
  if (isSub(e)) return deny(refusal('refuse', 'bad-input', { tool: 'rest', detail: 'subagent' }))
  return (await restSet($, sid, 'tool')) ? { result: T['cmd.rest']({}) } : deny(refusal('refuse', 'bad-input', { tool: 'rest', detail: 'unsaved' }))
}
