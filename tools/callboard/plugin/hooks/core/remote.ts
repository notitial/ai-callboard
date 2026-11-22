// A lane's Remote Control wish and how the lane applies it. Pure. Remote Control sends the person's phone a push for every ask of a connected session, so a lane starts with it off:
// the row's `remote` is the wish (set by a lead's `lane_remote` or the person's `/callboard remote NAME on|off`; no field is off), and the lane's own tick makes its panel match, asking the
// window that holds the panel (the spool's `remote` op). A chip click on a lane is overruled at the next tick: the wish is the row's, not the panel's.
import type { RefuseCode } from './msg.ts'
import type { Sid, View } from './model.ts'

// Asks of one wish before the lane gives up, and the pause between two.
export const REMOTE_TRIES = 5
export const REMOTE_GAP_MS = 30_000

// Why the row cannot carry a wish: it is no row, a lead's (its Remote Control is the person's), the manager's, off, or no lane's (nothing is above it).
export function remoteRefusal(v: View, key: Sid): RefuseCode | undefined {
  const r = v.table[key]
  return r === undefined ? 'no-such-lane' : r.lead !== undefined ? 'is-lead' : v.manager === key ? 'is-manager' : r.off ? 'is-off' : r.under === undefined ? 'no-such-lane' : undefined
}
export const isLane = (v: View, s: Sid): boolean => remoteRefusal(v, s) === undefined

// What one process remembers of its own wish: the wish the counts are for, the asks made, when the last was made and, once it gave up, the code it gave up on.
export type RemoteMemo = { wish: boolean; tries: number; at: number; stopped?: string }
// The memo for this wish: a changed wish starts the counts again.
export const remoteMemo = (m: RemoteMemo | undefined, wish: boolean): RemoteMemo => (m?.wish === wish ? m : { wish, tries: 0, at: 0 })
export const remoteDue = (m: RemoteMemo, now: number): boolean => m.stopped === undefined && now - m.at >= REMOTE_GAP_MS
// After an ask. `ok` is asked again only if the panel still differs after the pause (the registry row may lag the toggle). A window without the patch gives up at once: calling again
// cannot change it. Any other code is tried REMOTE_TRIES times.
export function remoteAnswered(m: RemoteMemo, code: string, now: number): RemoteMemo {
  const tries = code === 'ok' ? 0 : m.tries + 1
  return { ...m, tries, at: now, ...(code === 'patch-missing' || tries >= REMOTE_TRIES ? { stopped: code } : {}) }
}
