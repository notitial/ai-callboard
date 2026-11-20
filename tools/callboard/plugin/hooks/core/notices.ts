// Notices: the one table of who is told what (RECEIVES), the events a session computes each tick from its own reading of the sessions under it now, and where a PR
// note goes. Pure. Trust rules held here: events follow current relationships, never a stored recipient; a gone row routes nothing but its own `gone` or `done`; the manager
// is told only of asks and expired asks; a session with neither capability is told nothing.
import type { AskLogRow, Go, Notice, Receives, Sid, View } from './model.ts'
import { PERSON, capability, children, descendants, isConductor, isOff, liveness, parent } from './model.ts'
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
  // A conductor is told of every kind from its children, and of asks and expired asks from everything under it (its leads' lanes too).
  const wide = isConductor(x.v, x.me) ? new Set(descendants(x.v, x.me)) : scope
  const all: Notice[] = []
  for (const a of x.asks) all.push({ kind: 'ask', key: `ask:${a.id}`, about: a.asker, ask: a.id })
  for (const l of x.log) if (l.ev === 'expired') all.push({ kind: 'expired', key: `expired:${l.ask}`, about: l.asker, ask: l.ask })
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
  return all.filter((n) => r.kinds.includes(n.kind) && (n.kind === 'ask' || n.kind === 'expired' ? wide : scope).has(n.about) && (n.kind === 'gone' || n.kind === 'done' || x.v.table[n.about]?.goneAt === undefined))
}

// What the manager is also told on a check-in, "since your last turn": asks that ended in the asker's own panel (the ask log's `closed` by `click`: a click, or an interruption), counted per
// session; sessions under it that signed done or went; gos that ended. Data from the logs, at most DIGEST_MAX items; a key already spent is left out. The manager is not woken
// by it: it rides a check-in an ask or an expired ask caused.
export const DIGEST_MAX = 5
export type DigestItem = { kind: 'panel' | 'done' | 'gone' | 'go'; about: Sid; n: number; keys: string[] }
export type DigestIn = { me: Sid; v: View; since: number; now: number; log: readonly AskLogRow[]; signed: ReadonlySet<Sid>; goes: readonly Go[]; spent: ReadonlySet<string> }
export function digest(x: DigestIn): DigestItem[] {
  if (capability(x.v, x.me) !== 'manager') return []
  const scope = new Set(descendants(x.v, x.me))
  const items: DigestItem[] = []
  const panel = new Map<Sid, string[]>()
  for (const l of x.log) if (l.ev === 'closed' && l.code === 'click' && scope.has(l.asker) && !x.spent.has(`digest:panel:${l.ask}`)) panel.set(l.asker, [...(panel.get(l.asker) ?? []), `digest:panel:${l.ask}`])
  for (const [about, keys] of [...panel].sort((a, b) => b[1].length - a[1].length)) items.push({ kind: 'panel', about, n: keys.length, keys })
  for (const s of scope) {
    const goneAt = x.v.table[s]?.goneAt
    if (x.signed.has(s) && !x.spent.has(`digest:done:${s}`)) items.push({ kind: 'done', about: s, n: 1, keys: [`digest:done:${s}`] })
    else if (!x.signed.has(s) && goneAt !== undefined && goneAt >= x.since && !s.startsWith(NEW_KEY) && !x.spent.has(`digest:gone:${s}:${goneAt}`)) items.push({ kind: 'gone', about: s, n: 1, keys: [`digest:gone:${s}:${goneAt}`] })
  }
  for (const g of x.goes) if (g.end <= x.now && g.end >= x.since && (g.giver === x.me || scope.has(g.giver)) && !x.spent.has(`digest:go:${g.id}`)) items.push({ kind: 'go', about: g.giver, n: 1, keys: [`digest:go:${g.id}`] })
  return items.slice(0, DIGEST_MAX)
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
