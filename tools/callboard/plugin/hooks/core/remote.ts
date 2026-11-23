// A lane's Remote Control wish and how the lane applies it. Pure. Remote Control sends the person's phone a push for every ask of a connected session, so a lane starts with it off.
// The row's `remote` is the wish (set by a lead's `lane_remote` or the person's `/callboard remote NAME on|off`; no field is the default, off). The lane's own tick makes its panel match
// once, asking the window that holds the panel (the spool's `remote` op), and then records the wish as met in its row and stops: a switch the person makes by hand afterwards (the chip)
// stays, until a lead or the person sets the wish again (setting it to the same value is a new wish: it has a new `at`). The mark is in the row and names the process that met the wish, so a
// `/clear`, a handover and a plugin reload keep it, and a new process (a restart, a resume) applies the wish once more. A panel that is found already matching is marked met only once it has
// matched for a pause (Remote Control connects a moment after a panel starts).
import type { RefuseCode } from './msg.ts'
import type { Row, Sid, View } from './model.ts'

// Asks of one wish before the lane gives up, and the pause between two.
export const REMOTE_TRIES = 5
export const REMOTE_GAP_MS = 30_000

// Why the row cannot carry a wish: it is no row, a lead's (its Remote Control is the person's), the manager's, off, or no lane's (nothing is above it).
export function remoteRefusal(v: View, key: Sid): RefuseCode | undefined {
  const r = v.table[key]
  return r === undefined ? 'no-such-lane' : r.lead !== undefined ? 'is-lead' : v.manager === key ? 'is-manager' : r.off ? 'is-off' : r.under === undefined ? 'no-such-lane' : undefined
}
export const isLane = (v: View, s: Sid): boolean => remoteRefusal(v, s) === undefined
// `met`: the process that made the panel match (`procKey`), none while the wish is not met.
export const remoteWish = (r: Row): { on: boolean; at: number; met?: string } => ({ on: r.remote?.on ?? false, at: r.remote?.at ?? 0, ...(r.remote?.met === undefined ? {} : { met: r.remote.met }) })
// A process by its pid and start time, the pair the registry names it by: a restart is a new process even when the session id stays.
export const procKey = (r: { pid: number; procStart: string }): string => `${r.pid}@${r.procStart}`

// What one process remembers of its own wish: the wish (its value and its `at`) the counts are for, the asks that failed, when the last was made, since when the panel has matched and, once it
// gave up, the code it gave up on.
export type RemoteMemo = { wish: boolean; id: number; tries: number; at: number; matched?: number; stopped?: string }
// The memo for this wish: a wish set again starts the counts again.
export const remoteMemo = (m: RemoteMemo | undefined, wish: boolean, id: number): RemoteMemo => (m?.wish === wish && m.id === id ? m : { wish, id, tries: 0, at: 0 })
export const remoteDue = (m: RemoteMemo, now: number): boolean => m.stopped === undefined && now - m.at >= REMOTE_GAP_MS
// After an ask that did not meet the wish. A window without the patch gives up at once: calling again cannot change it. Any other code is tried REMOTE_TRIES times.
export function remoteFailed(m: RemoteMemo, code: string, now: number): RemoteMemo {
  const tries = m.tries + 1
  return { ...m, tries, at: now, ...(code === 'patch-missing' || tries >= REMOTE_TRIES ? { stopped: code } : {}) }
}
