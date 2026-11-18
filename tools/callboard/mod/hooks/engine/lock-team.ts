// A read-only view of the workspace lock's owned team (ai-toolkit) in a repo: who owns it, whether a session is a member, who holds the turn. Nothing here
// takes, gives, clears or writes the lock. Every read is bounded and lstat-based; a check that fails gives 'error', which no caller turns into "no team".
import * as c from '../core.ts'
import { where, statR, readSmallR } from './base.ts'

const FILE_MAX = 256

// 'ok': a real folder of the person's uid (any mode: the script makes the lock folders with the person's umask). A link or another owner is an 'error'.
async function folderState($: any, path: string, uid: number): Promise<'ok' | 'absent' | 'error'> {
  const f = await statR($, path)
  if (f === 'absent' || f === 'error') return f
  return f.kind === 'dir' && f.uid === uid ? 'ok' : 'error'
}

// The text of a small value file, 'error' when it is missing, not trustworthy or not readable. optional: a missing file is 'absent' (one more stat) instead.
async function valueFile($: any, path: string, uid: number, optional = false): Promise<string | 'absent' | 'error'> {
  if (optional) {
    const f = await statR($, path)
    if (f === 'absent' || f === 'error') return f
  }
  const r = await readSmallR($, path, uid, FILE_MAX, true)
  return r.state === 'ok' ? r.text : 'error'
}

// <repo>/.workspace-lock/lock.d: undefined when there is no owned team (no lock, an open or solo lock), 'error' when something is there and a check fails.
// A lock folder above the repo, or one WORKSPACE_LOCK_DIR moves elsewhere, is not seen.
// ownerSidWanted: the caller needs the turn only when this session owns the team; any other owner's team is returned without its turn (the turn files are not read).
export async function lockTeam($: any, repo: string, ownerSidWanted?: string): Promise<c.LockTeam | undefined | 'error'> {
  try {
    const p = await where($)
    if (!p) return 'error'
    const root = `${repo}/.workspace-lock`
    const top = await folderState($, root, p.uid)
    if (top === 'absent') return undefined
    if (top === 'error') return 'error'
    const dir = `${root}/lock.d`
    const d = await folderState($, dir, p.uid)
    if (d === 'absent') return undefined
    if (d === 'error') return 'error'
    const kind = await valueFile($, `${dir}/kind`, p.uid, true)
    if (kind === 'absent') return undefined
    if (kind === 'error') return 'error'
    if (kind.split('\n')[0].trim() !== 'owned') return undefined
    const owner = await valueFile($, `${dir}/owner`, p.uid)
    const holder = await valueFile($, `${dir}/holder`, p.uid)
    if (owner === 'error' || holder === 'error' || owner === 'absent' || holder === 'absent') return 'error'
    const slug = c.lockSlugOf(holder)
    const ownerSid = c.lockSidOf(owner)
    if (slug === undefined || ownerSid === undefined) return 'error'
    const team: c.LockTeam = { slug, owner: ownerSid }
    if (ownerSidWanted !== undefined && ownerSid !== ownerSidWanted) return team
    const turnDir = await folderState($, `${dir}/turn.d`, p.uid)
    if (turnDir === 'absent') return team
    if (turnDir === 'error') return { ...team, turn: 'error' }
    const sid = await valueFile($, `${dir}/turn.d/sid`, p.uid)
    const eta = await valueFile($, `${dir}/turn.d/eta_epoch`, p.uid)
    const beat = await valueFile($, `${dir}/turn.d/heartbeat_epoch`, p.uid)
    const taken = await valueFile($, `${dir}/turn.d/taken_at`, p.uid)
    const holderSid = sid === 'absent' || sid === 'error' ? undefined : c.lockSidOf(sid)
    if (holderSid === undefined || [eta, beat, taken].some((x) => x === 'absent' || x === 'error')) return { ...team, turn: 'error' }
    const ended = await statR($, `${dir}/ended/${holderSid}`)
    if (ended === 'error') return { ...team, turn: 'error' }
    return { ...team, turn: c.lockTurnOf(sid as string, eta, beat, taken, ended !== 'absent') }
  } catch {
    return 'error'
  }
}

// Whether the session has a members/<sid> file in the repo's lock.
export async function laneMember($: any, repo: string, sid: string): Promise<boolean | 'error'> {
  try {
    if (!c.SID_RE.test(sid)) return 'error'
    const p = await where($)
    if (!p) return 'error'
    const f = await statR($, `${repo}/.workspace-lock/lock.d/members/${sid}`)
    if (f === 'absent') return false
    if (f === 'error') return 'error'
    return f.kind === 'file' && f.uid === p.uid ? true : 'error'
  } catch {
    return 'error'
  }
}

// The lane list's view of each repo that has an owned team: the team, and for each given session id whether it is a member. Repos with no team are left out.
export async function lockViews($: any, repos: string[], sidsOf: (repo: string) => string[]): Promise<Map<string, c.LockView>> {
  const out = new Map<string, c.LockView>()
  for (const repo of new Set(repos)) {
    const team = await lockTeam($, repo)
    if (team === undefined) continue
    if (team === 'error') {
      out.set(repo, 'error')
      continue
    }
    const member = new Map<string, boolean | 'error'>()
    for (const sid of new Set(sidsOf(repo))) member.set(sid, await laneMember($, repo, sid))
    out.set(repo, { team, member })
  }
  return out
}
