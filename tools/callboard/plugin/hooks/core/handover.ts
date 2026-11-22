// A handover: a session replaces itself with a clear one in the same panel. What is kept for it, and the moves the plugin makes. Pure. Trust rules held here: a marker is read
// leniently (anything that is not a whole marker is none); the session table is rewritten only by `handOver`, which moves the row of the old id to the new id and the
// `under` of every child, never overwrites a row the new id already has, and gives the new id no power its predecessor did not have.
import type { Folder, Row, Sid, Table, View } from './model.ts'
import { isConductor, isLead } from './model.ts'

// A marker holds the old id as `unknown` for this long (a takeover that has not come by then is a crash); a marker older than the sweep age is removed by any session; the old
// session renames itself back when its `/clear` has not run by the wait.
export const HANDING_MS = 120_000
export const MARKER_SWEEP_MS = 600_000
export const CLEAR_WAIT_MS = 60_000
// How long the new session tries the table write before it takes the old conversation back.
export const TAKEOVER_MS = 30_000
export const HANDOVERS_MAX = 32

// clearing: the old session has run `/clear`. bound: the table moved. undo: the new session could not move it and has asked for the old conversation back.
export type Phase = 'clearing' | 'bound' | 'undo'
// `name`: what the session is called (null: only a name Claude generated, which is not restored); `historic`: NAME~N. `file`: the session's own handover file; `brief`: a lane's. `nw`: the
// session that took the table, set from `bound` on.
export type Marker = { old: Sid; pid: number; procStart: string; name: string | null; historic: string; file: string; continuation: string; phase: Phase; at: number; failed: string[]; brief?: string; nw?: Sid }
const isStr = (x: unknown): x is string => typeof x === 'string'
export function parseMarker(raw: unknown): Marker | undefined {
  const m = (raw ?? {}) as Partial<Marker>
  const ok = isStr(m.old) && Number.isInteger(m.pid) && isStr(m.procStart) && (m.name === null || isStr(m.name)) && isStr(m.historic) && isStr(m.file) && isStr(m.continuation) && ['clearing', 'bound', 'undo'].includes(m.phase as string) && Number.isFinite(m.at)
  if (!ok || !Array.isArray(m.failed) || !m.failed.every(isStr) || (m.brief !== undefined && !isStr(m.brief)) || (m.nw !== undefined && !isStr(m.nw))) return undefined
  return { old: m.old!, pid: m.pid!, procStart: m.procStart!, name: m.name!, historic: m.historic!, file: m.file!, continuation: m.continuation!, phase: m.phase!, at: m.at!, failed: m.failed.slice(0, 4), ...(m.brief === undefined ? {} : { brief: m.brief }), ...(m.nw === undefined ? {} : { nw: m.nw }) }
}

// The Session Manager group a session sits in, as the extension files it (groups.js): the manager, a conductor, a lead, a lane; a loose session has none.
export type Group = 'Manager' | 'Conductor' | 'Lead' | 'Lanes'
export function groupOf(v: View, s: Sid): Group | undefined {
  if (v.manager === s) return 'Manager'
  if (v.table[s]?.off) return undefined
  return isConductor(v, s) ? 'Conductor' : isLead(v, s) ? 'Lead' : v.table[s]?.under !== undefined ? 'Lanes' : undefined
}

// ---- the counter file: per name, the last number used and the old sessions handed over (the extension archives them) ----
export type Old = { sid: Sid; group: Group; folder: Folder; at: number }
export type Handovers = { [name: string]: { n: number; old: Old[] } }
const GROUPS: readonly string[] = ['Manager', 'Conductor', 'Lead', 'Lanes']
export function parseHandovers(raw: unknown): Handovers | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Handovers = {}
  for (const [k, e] of Object.entries(raw)) {
    if (k === '__proto__') continue
    const x = e as { n?: unknown; old?: unknown }
    if (!Number.isInteger(x?.n) || !Array.isArray(x.old)) return undefined
    const old = x.old.filter((o: Partial<Old>): o is Old => isStr(o?.sid) && GROUPS.includes(o.group as string) && isStr(o.folder) && Number.isFinite(o.at))
    out[k] = { n: x.n as number, old }
  }
  return out
}
// The next number for a name: one past the larger of the file's and any live or table name that already reads NAME~k.
export function nextNumber(h: Handovers, name: string, taken: readonly (string | undefined)[]): number {
  const k = taken.map((t) => (t?.startsWith(`${name}~`) ? Number(t.slice(name.length + 1)) : 0)).filter((n) => Number.isInteger(n))
  return 1 + Math.max(h[name]?.n ?? 0, ...k)
}
// The file after one handover of `name` as number `n`; the old sessions of all names stay at most HANDOVERS_MAX, the oldest dropped.
export function recordHandover(h: Handovers, name: string, n: number, old: Old | undefined): Handovers {
  const next: Handovers = { ...h, [name]: { n, old: [...(h[name]?.old ?? []), ...(old === undefined ? [] : [old])] } }
  const all = Object.entries(next).flatMap(([k, e]) => e.old.map((o) => [k, o] as const)).sort((a, b) => b[1].at - a[1].at).slice(0, HANDOVERS_MAX)
  return Object.fromEntries(Object.entries(next).map(([k, e]) => [k, { n: e.n, old: e.old.filter((o) => all.some(([, a]) => a === o)) }]))
}
// The file after a handover was undone: the entry of the old id is gone (the number stays used).
export const dropHandover = (h: Handovers, old: Sid): Handovers => Object.fromEntries(Object.entries(h).map(([k, e]) => [k, { n: e.n, old: e.old.filter((o) => o.sid !== old) }]))

// ---- the table move ----
// The row of the old id becomes the row of the new id, under the name the session had; every `under` that named the old id names the new one (a `new:` row too). Done already (the
// old key is gone) is the same table again; both keys present is a clash and moves nothing. A loose session has no row: only the `under` rewrite runs.
export function handOver(t: Table, old: Sid, nw: Sid, name: string | null): Table | 'clash' {
  if (t[old] !== undefined && t[nw] !== undefined) return 'clash'
  const out: Table = {}
  for (const [k, r] of Object.entries(t)) {
    const row: Row = r.under === old ? { ...r, under: nw } : r
    if (k !== old) out[k] = row
    else {
      const { goneAt: _g, parked: _p, ...rest } = row
      out[nw] = { ...rest, ...(name === null ? {} : { name }) }
    }
  }
  return out
}

// The name the old session is given: NAME~N.
export const historicName = (name: string, n: number): string => `${name}~${n}`
