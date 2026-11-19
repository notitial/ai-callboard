// Notices: the one table of who is told what (RECEIVES), the events a session computes each tick from its own reading of the sessions under it now, and where a PR
// note goes. Pure. Trust rules held here: events follow current relationships, never a stored recipient; a gone row routes nothing but its own `gone` or `done`; the manager
// is told only of asks and expired asks; a session with neither capability is told nothing.
import type { AskLogRow, Notice, Receives, Sid, View } from './model.ts'
import { PERSON, capability, children, descendants, isOff, liveness, parent } from './model.ts'
import { NEW_KEY } from './lifecycle.ts'

export const RECEIVES: Receives = {
  lead: { from: 'children', kinds: ['ask', 'expired', 'done', 'gone', 'waiting', 'quiet', 'report'] },
  manager: { from: 'descendants', kinds: ['ask', 'expired'] },
}
export const WAITING_MS = 5 * 60_000
export const QUIET_MS = 30 * 60_000

// since: this process's start (a row gone before it is not told again). asks: the open asks this session is eligible for now. log: the ask log from this process's
// cursor. reports: refusals and fallbacks queued about a session. signed: sessions whose report is signed by their own id. asking: sessions with an open ask, whose
// wait is told as that ask.
export type NoticeIn = {
  me: Sid
  v: View
  now: number
  since: number
  asks: readonly { id: string; asker: Sid }[]
  log: readonly AskLogRow[]
  reports: readonly { about: Sid; code: string; at: number }[]
  signed: ReadonlySet<Sid>
  asking: ReadonlySet<Sid>
}
// Every event this session is owed now. The key keeps "once": the adapter drops a key once the turn carrying it has started, and sends the rest as one turn.
export function notices(x: NoticeIn): Notice[] {
  const cap = capability(x.v, x.me)
  if (cap === 'none') return []
  const r = RECEIVES[cap]
  const scope = new Set(r.from === 'children' ? children(x.v, x.me) : descendants(x.v, x.me))
  const all: Notice[] = []
  for (const a of x.asks) all.push({ kind: 'ask', key: `ask:${a.id}`, about: a.asker, ask: a.id })
  for (const l of x.log) if (l.ev === 'expired' || l.ev === 'left-for-person') all.push({ kind: 'expired', key: `expired:${l.ask}`, about: l.asker, ask: l.ask })
  for (const p of x.reports) all.push({ kind: 'report', key: `report:${p.about}:${p.code}:${p.at}`, about: p.about, code: p.code })
  for (const s of scope) {
    const goneAt = x.v.table[s]?.goneAt
    // A row never opened has no session to go; a signed child's end is its `done`, not a `gone`.
    if (x.signed.has(s)) all.push({ kind: 'done', key: `done:${s}`, about: s })
    else if (goneAt !== undefined && goneAt >= x.since && !s.startsWith(NEW_KEY)) all.push({ kind: 'gone', key: `gone:${s}:${goneAt}`, about: s })
    const reg = x.v.rows === 'unknown' ? undefined : x.v.rows.get(s)
    if (reg?.statusAt === undefined || x.signed.has(s)) continue
    const quiet = reg.status === 'idle' && !reg.waitingFor
    const waiting = reg.status === 'waiting' && !!reg.waitingFor && !x.asking.has(s)
    if ((quiet || waiting) && x.now - reg.statusAt >= (quiet ? QUIET_MS : WAITING_MS)) all.push({ kind: quiet ? 'quiet' : 'waiting', key: `${quiet ? 'quiet' : 'waiting'}:${s}:${reg.statusAt}`, about: s })
  }
  return all.filter((n) => r.kinds.includes(n.kind) && scope.has(n.about) && (n.kind === 'gone' || n.kind === 'done' || x.v.table[n.about]?.goneAt === undefined))
}

// Where a PR note goes: the registrant while it is live; else its parent while the registrant's row is not gone, when that parent is a lead (the manager is woken
// only by asks); a gone or off row routes nothing; an unknown reading holds the note for the next one.
export function prRoute(v: View, registrant: Sid): Sid | 'hold' | 'none' {
  const l = liveness(v, registrant)
  if (isOff(v, registrant)) return 'none'
  if (l === 'yes') return registrant
  const p = parent(v, registrant)
  if (l === 'unknown' || p === 'unknown') return 'hold'
  return v.table[registrant]?.goneAt === undefined && p !== PERSON && capability(v, p) === 'lead' ? p : 'none'
}
