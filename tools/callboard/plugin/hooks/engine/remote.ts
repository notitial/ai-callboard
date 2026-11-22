// A lane's Remote Control: the wish in its row, written by a lead's `lane_remote` or the person's `/callboard remote`, and the lane's own tick that makes its panel match once. Trust rules held
// here: only a lane's own process asks, for its own session id; the registry row's bridge session id is the state, and the wish and the state are read again, fresh, before an ask (the view
// is up to ten seconds old); a wish that was met is marked in the row and never applied again, so a switch the person makes by hand stays and a restart does not redo it; an answer that
// says the window cannot do it ends the asking, and the other failures are tried REMOTE_TRIES times, REMOTE_GAP_MS apart, then end too. A read in doubt changes nothing.
import type { Sid, Table, View } from '../core/model.ts'
import { REMOTE_GAP_MS, REMOTE_TRIES, isLane, remoteDue, remoteFailed, remoteMemo, remoteWish } from '../core/remote.ts'
import { log } from './io.ts'
import { spool } from './cue.ts'
import { mem } from './mem.ts'
import { getView, readOwnRow, updateTable } from './store.ts'

// The wish of one lane's row, not yet met, as set now. The caller has checked the row; a row that is gone by the time the table is read again under its lock is left as it is.
export async function setRemote($: any, key: Sid, on: boolean): Promise<boolean> {
  const at = await $.clock.now()
  return updateTable($, (t) => (t[key] === undefined ? t : { ...t, [key]: { ...t[key]!, remote: { on, at } } }))
}
// The wish is met: marked in the row, unless a lead or the person has set it again meanwhile. The memo goes once the row says so.
async function markMet($: any, me: Sid, w: { on: boolean; at: number }): Promise<void> {
  const same = (t: Table) => t[me] !== undefined && remoteWish(t[me]!).on === w.on && remoteWish(t[me]!).at === w.at && !remoteWish(t[me]!).met
  if (await updateTable($, (t) => (same(t) ? { ...t, [me]: { ...t[me]!, remote: { ...t[me]!.remote, on: w.on, met: true as const } } } : t))) mem.remote = undefined
}

// One ask to the window that holds the panel, and what the answer does. Runs beside the tick: the window may take the whole spool wait to answer.
async function ask($: any, me: Sid, folder: string, w: { on: boolean; at: number }): Promise<void> {
  const a = await spool($, { op: 'remote', sid: me, on: w.on, folder }, me).catch(() => undefined)
  if (a?.ok === true) return markMet($, me, w)
  const code = a?.ok === false ? a.code : 'no-answer'
  if (mem.remote?.wish !== w.on || mem.remote.id !== w.at) return
  mem.remote = remoteFailed(mem.remote, code, await $.clock.now())
  if (mem.remote.stopped !== undefined) await log($, me, 'remote', `gave up ${w.on ? 'on' : 'off'}: ${code}${code === 'patch-missing' ? '' : ` after ${REMOTE_TRIES} tries`}`)
}
export async function remoteTick($: any, me: Sid, v: View, now: number): Promise<void> {
  if (v.rows === 'unknown') return
  const own = v.rows.get(me)
  if (own === undefined || !isLane(v, me)) return void (mem.remote = undefined)
  const wish = remoteWish(v.table[me]!)
  if (wish.met) return void (mem.remote = undefined)
  const m = (mem.remote = remoteMemo(mem.remote, wish.on, wish.at))
  if (own.bridge === wish.on) {
    // A panel found matching is marked met once it has matched for a pause and its own row still says so.
    mem.remote = m.matched === undefined ? { ...m, matched: now } : m
    if (now - mem.remote.matched! >= REMOTE_GAP_MS && (await readOwnRow($, me))?.bridge === wish.on) await markMet($, me, wish)
    return
  }
  if (m.matched !== undefined) mem.remote = { ...m, matched: undefined }
  if (mem.remoteBusy || !remoteDue(m, now)) return
  // Both halves of the comparison are read again: the wish may have changed in another session's write, and the panel may already match.
  const fresh = remoteWish((await getView($, true)).table[me] ?? v.table[me]!)
  if (fresh.on !== wish.on || fresh.at !== wish.at || fresh.met || (await readOwnRow($, me))?.bridge === wish.on) return
  mem.remoteBusy = true
  ask($, me, own.folder, wish).catch(() => undefined).finally(() => void (mem.remoteBusy = false))
}
