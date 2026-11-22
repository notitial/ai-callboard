// A lane's Remote Control: the wish in its row, written by a lead's `lane_remote` or the person's `/callboard remote`, and the lane's own tick that makes its panel match. Trust rules held
// here: only a lane's own process asks, for its own session id; the registry row's bridge session id is the state, and the wish and the state are read again, fresh, before an ask (the view
// is up to ten seconds old); an answer that says the window cannot do it ends the asking, and the other failures are tried REMOTE_TRIES times, REMOTE_GAP_MS apart, then end too: the wish
// is not fought for. A read in doubt changes nothing.
import type { Sid, View } from '../core/model.ts'
import { REMOTE_TRIES, isLane, remoteAnswered, remoteDue, remoteMemo } from '../core/remote.ts'
import { log } from './io.ts'
import { spool } from './cue.ts'
import { mem } from './mem.ts'
import { getView, readOwnRow, updateTable } from './store.ts'

// The wish of one lane's row. The caller has checked the row; a row that is gone by the time the table is read again under its lock is left as it is.
export function setRemote($: any, key: Sid, on: boolean): Promise<boolean> {
  return updateTable($, (t) => {
    const row = t[key]
    if (row === undefined) return t
    const { remote: _, ...rest } = row
    return { ...t, [key]: on ? { ...rest, remote: true as const } : rest }
  })
}

// One ask to the window that holds the panel, and what the answer does to the memo. Runs beside the tick: the window may take the whole spool wait to answer.
async function ask($: any, me: Sid, folder: string, wish: boolean): Promise<void> {
  const a = await spool($, { op: 'remote', sid: me, on: wish, folder }, me).catch(() => undefined)
  const code = a === undefined ? 'no-answer' : a.ok ? 'ok' : a.code
  if (mem.remote?.wish !== wish) return
  mem.remote = remoteAnswered(mem.remote, code, await $.clock.now())
  if (mem.remote.stopped !== undefined) await log($, me, 'remote', `gave up ${wish ? 'on' : 'off'}: ${code}${code === 'patch-missing' ? '' : ` after ${REMOTE_TRIES} tries`}`)
}
export async function remoteTick($: any, me: Sid, v: View, now: number): Promise<void> {
  if (v.rows === 'unknown') return
  const own = v.rows.get(me)
  if (own === undefined || !isLane(v, me)) return void (mem.remote = undefined)
  const wish = v.table[me]!.remote === true
  if (own.bridge === wish) return void (mem.remote = undefined)
  const m = (mem.remote = remoteMemo(mem.remote, wish))
  if (mem.remoteBusy || !remoteDue(m, now)) return
  // Both halves of the comparison are read again: the wish may have changed in another session's write, and the panel may already match.
  const fresh = await getView($, true)
  if ((fresh.table[me]?.remote === true) !== wish || (await readOwnRow($, me))?.bridge === wish) return
  mem.remoteBusy = true
  ask($, me, own.folder, wish).catch(() => undefined).finally(() => void (mem.remoteBusy = false))
}
