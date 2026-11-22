// A child's life: its state, what each verb of a parent does to it, the cue between them, the signed report, and the table's own upkeep (names, gone, expiry). Pure.
// Trust rules held here: a verb acts only on a descendant of the caller now; a force stop opens the person's dialog only while the window is read off; a typed lead's row is never removed by a verb (a minted lead's is); a retire of a live
// child needs its report signed by its own session id; a cue is acted on only when its sender is above the child now and it is under CUE_MAX_AGE_MS old.
import type { Cue, CueResult, CueVerb, Decision, Folder, RegistryRow, Sid, StopVerb, Table, View, WindowReading } from './model.ts'
import { CUE_VERBS, capRefusal, givenName, isMinted, liveness, mayActOn, nameOf, nameRefusal, parent, refusal } from './model.ts'
import type { RefuseCode, UiState } from './msg.ts'

export const IDLE_MS = 30_000
const GONE_AFTER_MS = 30_000
export const LANE_ROW_KEEP_MS = 24 * 3_600_000
export const PARKED_ROW_KEEP_MS = 28 * 24 * 3_600_000
// The key of a row between lane_create and the opened panel's session id.
export const NEW_KEY = 'new:'
export const CUE_MAX_AGE_MS = 120_000
// How long a parent waits for a child's answer to a cue, and for the window's answer to a spool request (its own open wait is 20 s, plus scan and claim slack).
export const CUE_WAIT_S = 20
export const SPOOL_WAIT_S = 30
// How long the typed `/callboard conductor` waits for the person's click once a window has taken its request; the window's tick list closes itself 10 s sooner
// (the extension's pick.js, PICK_MS). And the most repos a conductor is given.
export const PICK_WAIT_S = 90
export const CONDUCTOR_REPOS_MAX = 32

// The report path is fixed when the row is made, from the name at that time: a rename never moves it.
export const reportPath = (folder: Folder, name: string): string => `${folder}/.archive/${name}/REPORT.md`
// The report's last non-empty line is the signature, `status: done <session id of the writer>`. A filter, not proof: anything running as the person can write it.
export function signedBy(text: string, sid: Sid): boolean {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '')
  return lines[lines.length - 1] === `status: done ${sid}`
}

// Idle: not in a turn and not waiting, for this long by the engine's own status time (undefined when not idle or it cannot tell).
const idleFor = (r: RegistryRow | undefined, now: number): number | undefined =>
  r?.status === 'idle' && (r.waitingFor ?? null) === null && typeof r.statusAt === 'number' && r.statusAt <= now ? now - r.statusAt : undefined
const live = (v: View, key: string) => (key.startsWith(NEW_KEY) ? 'no' : liveness(v, key))

// A child as lane_list shows it.
export function childState(v: View, key: string, signed: boolean, now: number): UiState {
  if (v.table[key]?.off) return 'off'
  if (key.startsWith(NEW_KEY)) return 'notOpened'
  const l = liveness(v, key)
  if (l === 'unknown') return 'unknown'
  if (l === 'no') return v.table[key]?.parked !== undefined ? 'parked' : signed ? 'done' : 'gone'
  return signed ? 'done' : idleFor(v.rows === 'unknown' ? undefined : v.rows.get(key), now) !== undefined ? 'live' : 'busy'
}

export type Verb = CueVerb | StopVerb | 'unpark'
// What a parent's verb does: cue the child's own process, stop it (a force stop through the person's dialog), remove a row no live session carries, or reopen a
// parked one. One body for every verb: the gate, then the child's liveness, then the verb's own condition.
export type VerbPlan = Decision<'cue' | 'stop' | 'remove' | 'reopen' | 'refuse'> & { dialog?: true }
export function verbPlan(verb: Verb, v: View, actor: Sid, key: string, x: { signed: boolean; win: WindowReading; now: number; name?: string }): VerbPlan {
  const name = nameOf(v, key)
  const no = (code: RefuseCode, detail?: string): VerbPlan => refusal('refuse', code, { tool: `lane_${verb}`, target: name, ...(detail === undefined ? {} : { detail }) })
  const stopped = (act: 'stop' | 'remove', dialog?: true): VerbPlan => ({ act, ...(dialog ? { dialog } : {}), msg: 'lane.stopped', p: { verb: verb as StopVerb, name, outcome: 'done' } })
  if (v.table[key]?.off) return no('is-off')
  if (!mayActOn(v, actor, key)) return no('not-a-parent')
  const l = live(v, key)
  if (l === 'unknown') return no('unknown-liveness')
  if (l === 'no') {
    // A typed lead's row holds its grant and repos: no verb of another session removes it. A minted lead's holds nothing of the person's, so it goes like a lane's.
    if (verb === 'retire' || verb === 'terminate') return v.table[key]?.lead !== undefined && !isMinted(v, key) ? no('is-lead') : stopped('remove')
    if (verb !== 'unpark' || v.table[key]?.parked === undefined) return no('no-live-session')
    return capRefusal(v, parent(v, key)) !== undefined ? no('cap') : { act: 'reopen', msg: 'lane.unparked', p: { name, sid: key } }
  }
  if (verb === 'unpark') return no('has-live-session')
  if (verb === 'rename') {
    if (x.name === undefined) return no('bad-input', 'name')
    const bad = nameRefusal(v, x.name, key)
    if (bad !== undefined) return no(bad)
  }
  if ((CUE_VERBS as readonly string[]).includes(verb)) return { act: 'cue', msg: 'lane.cued', p: { verb: verb as CueVerb, name } }
  // The force stop's dialog is for the person: it opens only when the window is read off, never on an unknown reading.
  if (verb === 'terminate') return x.win.state !== 'off' ? no('unattended') : stopped('stop', true)
  if (verb === 'retire' && !x.signed) return no('report-unsigned')
  // A signed lane is done: out of its turn is enough to retire it. A park waits IDLE_MS, so a turn about to start is not cut off.
  const idle = idleFor(v.rows === 'unknown' ? undefined : v.rows.get(key), x.now)
  return idle !== undefined && (verb === 'retire' || idle >= IDLE_MS) ? stopped('stop') : no('not-idle')
}

// ---- the cue ----
const isStr = (x: unknown): x is string => typeof x === 'string'
export function parseCue(raw: unknown): Cue | undefined {
  const c = (raw ?? {}) as Partial<Cue>
  if (!isStr(c.id) || !isStr(c.from) || !Number.isFinite(c.at) || !(CUE_VERBS as readonly unknown[]).includes(c.verb)) return undefined
  return { id: c.id, verb: c.verb!, from: c.from, at: c.at!, ...(isStr(c.name) ? { name: c.name } : {}) }
}
export function parseResult(raw: unknown): CueResult | undefined {
  const r = (raw ?? {}) as Partial<CueResult>
  if (!isStr(r.id) || !['ok', 'refused', 'held'].includes(r.outcome as string)) return undefined
  return { id: r.id, outcome: r.outcome!, ...(isStr(r.code) ? { code: r.code } : {}) }
}
// The child's answer to a cue: refused when stale or unless the sender is above it now, held while a turn runs (the parent tries again).
export function cueAnswer(v: View, self: Sid, cue: Cue, busy: boolean, now: number): CueResult {
  if (now - cue.at > CUE_MAX_AGE_MS) return { id: cue.id, outcome: 'refused', code: 'cue-stale' }
  if (!mayActOn(v, cue.from, self)) return { id: cue.id, outcome: 'refused', code: 'not-a-parent' }
  return busy ? { id: cue.id, outcome: 'held' } : { id: cue.id, outcome: 'ok' }
}
// What the parent's tool says once the child answered (or did not, within its wait).
export function cueReply(r: CueResult | undefined, verb: CueVerb, name: string): Decision {
  if (r?.outcome === 'ok') return { act: 'done', msg: 'lane.cued', p: { verb, name } }
  return refusal('refuse', r?.outcome === 'held' ? 'cue-held' : 'cue-refused', { tool: `lane_${verb}`, target: name, ...(r?.code ? { detail: r.code } : {}) })
}

// ---- the table's own upkeep, run inside every write of it ----
// The name is copied from the registry, unless it is the one Claude generated (givenName); a session read as no on two reads GONE_AFTER_MS apart (noSince: when this process first read it so) and not parked gets
// goneAt, cleared when it comes back. Expiry is by what the row holds: a plain lane row 24 h after goneAt, a parked one 28 days after parking; a row with `lead` or
// `off`, or one a live session carries, never expires by time (a minted lead's row is a lane's in this). Nothing is decided on an unknown read.
export function tidy(t: Table, v: View, noSince: (key: string) => number | undefined, now: number): Table {
  if (v.rows === 'unknown') return t
  const out: Table = {}
  for (const [k, r] of Object.entries(t)) {
    // A session handing over keeps its row as it is: no name is copied from the registry (it holds NAME~N) and no goneAt is set.
    if (v.handing.has(k)) {
      out[k] = r
      continue
    }
    const reg = v.rows.get(k)
    const name = givenName(reg)
    const row = { ...r, ...(name ? { name } : {}) }
    if (reg !== undefined) delete row.goneAt
    else if (row.goneAt === undefined && row.parked === undefined && (noSince(k) ?? now) <= now - GONE_AFTER_MS) row.goneAt = now
    const kept = reg !== undefined || (row.lead !== undefined && !row.lead.minted) || row.off === true
    const expired = !kept && (row.parked !== undefined ? now - row.parked >= PARKED_ROW_KEEP_MS : row.goneAt !== undefined && now - row.goneAt >= LANE_ROW_KEEP_MS)
    if (!expired) out[k] = row
  }
  return out
}
