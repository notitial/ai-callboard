// The shapes the plugin's parts pass to each other (sessions, rows, asks, answers, cues, goes, the window, the table of events), and the model over them: who is live,
// who is whose parent, who may act on whom. Pure: every function reads one View and returns a value for every session, an unknown one included.
import type { RefuseCode, Say } from './msg.ts'

export type Sid = string
export type Folder = string

// The person, the one owner above every session. A session id is a UUID, so it never collides with this.
export type Person = 'PERSON'
export type Owner = Sid | Person

// A fact that may not be known: `unknown` is a failed or doubtful read and never closes or moves anything.
type Liveness = 'yes' | 'no' | 'unknown'

// The tools, by name without the `mcp__callboard__` prefix. A child tool acts on a descendant of the caller; the cue verbs reach the child through its cue file,
// the stop verbs end its process (one body for the three).
export const CUE_VERBS = ['rename', 'start', 'resume'] as const
export const STOP_VERBS = ['park', 'retire', 'terminate'] as const
export type CueVerb = (typeof CUE_VERBS)[number]
export type StopVerb = (typeof STOP_VERBS)[number]
export const TOOLS = [
  'lane_rename', 'lane_start', 'lane_resume', 'lane_park', 'lane_retire', 'lane_terminate', 'lane_unpark', 'lane_list',
  'lane_create', 'lane_open', 'lane_adopt',
  'prompt_list', 'prompt_answer',
  'go_request', 'go_status', 'pr_watch', 'request_compact', 'request_handover', 'rest',
] as const
export type ToolName = (typeof TOOLS)[number]

// What a session may do beyond what every session does. Granted by rows his commands or a parent's tools wrote and by the manager-name file; never inferred.
export type Capability = 'manager' | 'lead' | 'none'

// A row of the engine's registry (`~/.claude/sessions/<pid>.json`), as the adapter reads it. `statusAt` is the engine's `statusUpdatedAt`; `kind` is `interactive` for a person's session.
export type RegistryRow = {
  sid: Sid
  pid: number
  procStart: string
  folder: Folder
  name?: string
  nameSource?: string
  status?: string
  statusAt?: number
  waitingFor?: string | null
  kind?: string
}
// The registry read: the rows whose pid and start time `ps` confirmed, or `unknown` (a changing file, too many files, a `ps` that cannot be trusted, no row of its
// own, a stale group, a cut `ps` confirm). A list with doubt in it is not a list.
export type Registry = RegistryRow[] | 'unknown'

// One row of the session table (`sessions.json`), keyed by session id, or by `new:<NAME>` between `lane_create` and the opened panel's id. No row is the default:
// a loose session, managed, its parent the manager. `name` is a label refreshed from the registry and decides nothing.
export type Row = {
  name: string
  folder: Folder
  report?: string
  under?: Sid
  // `conductor`: set only by his typed `/callboard conductor`; `minted`: a lead a conductor made, whose `under` is read while that conductor lives.
  lead?: { repos: Folder[]; conductor?: true; minted?: true }
  off?: true
  brief?: string
  parked?: number
  goneAt?: number
  model?: LaneModel
  effort?: LaneEffort
}
export type Table = { [key: string]: Row }

// A decision the core hands an adapter: what to do, and the message id and parameters of what is said about it. The core builds no string.
export type Decision<A extends string = string> = { act: A } & Say
// A refusal by its code. The cast is the one place a code becomes its id: `refuse.${RefuseCode}` is a family of ids with one parameter shape.
export const refusal = <A extends string>(act: A, code: RefuseCode, p: { tool: string; target?: string; detail?: string }): Decision<A> => ({ act, msg: `refuse.${code}`, p }) as Decision<A>

// ---- the ask ----

export type RaisedBy = 'mode' | 'rule' | 'guard' | 'hook' | 'setting' | 'plugin' | 'ceiling' | 'unknown'
export type Question = { header: string; question: string; options: { label: string; description?: string }[] }

// `asks/<id>.json`, rewritten only by the asker's hook. `awake` is the time the asker's hook has counted awake, and the 5 and 15 minute steps run on it; `t0` and `beat`
// are wall time. `input` is redacted and capped; `cut` says a reader has not seen all of it.
export type Ask = {
  id: string
  asker: Sid
  t0: number
  awake: number
  tool: string
  raisedBy: RaisedBy
  input: string
  cut: boolean
  question?: Question // the one question of a call, which a session may answer
  questions?: Question[] // the 2 to 4 questions of a call, which only the person answers
  beat: number
}

// `asks/<id>.answer`, created exclusively: the first writer wins. `by` is the session that decided, or the person (his click on the relay dialog). `option` is 1-based,
// as prompt_answer takes it.
export type Answer = {
  ask: string
  by: Owner
  decision: 'allow' | 'deny' | 'answer'
  note?: string
  option?: number
  picks?: number[] // the person's pick (1-based) for each of an ask's questions
  at: number
}

// `asks/<id>.up.<sid>`: an escalation, or a "told" mark, by that session; created exclusively. `reach` is derived from these and from `awake`. note: what the escalator wrote
// for the person (the relay dialog reads it; the ask log never holds it).
export type UpMark = { kind: 'escalated' | 'told'; by: Sid; at: number; note?: string }

export type AskEvent = 'raised' | 'told' | 'escalated' | 'answered' | 'expired' | 'closed' | 'swept'
// A row of `asks-YYYY-MM.jsonl`, the one append-only ask log.
export type AskLogRow = { t: number; ev: AskEvent; ask: string; asker: Sid; by?: Owner; code?: string }

// ---- the cue and its result (cue.ts) ----

// `cue/<child sid>`: a parent's ordinary message to a child that needs the child's own process (a rename, the start on its brief, a resume).
export type Cue = { id: string; verb: CueVerb; from: Sid; at: number; name?: string }
// `result/<id>`: the child's answer. `held` is "not now" (a turn is running), retried by the parent.
export type CueResult = { id: string; outcome: 'ok' | 'refused' | 'held'; code?: string }

// ---- the window's spool (the extension's requests) ----
// One JSON file `v2/open/<id>.req` per request (written as a dot-file and renamed, a fresh random id, the folder as VS Code names the window's first folder), answered in `<id>.result`. A close names the session's name: the window finds the panel's tab by it.
// A `pick` asks the window that holds the conductor's `folder` for its tick list, with the repos saved for that folder ticked; its answer's `folders` are what the person ticked.
export type SpoolRequest = { op: 'open'; folder: Folder } | { op: 'reopen'; sid: Sid; folder: Folder } | { op: 'close'; sid: Sid; pid: number; name: string; folder: Folder } | { op: 'pick'; folder: Folder; ticked: string[] }
export type SpoolReply = { ok: true; sid?: Sid; folders?: string[] } | { ok: false; code: string }

// ---- goes, the unattended window, the settings ----

// `go/<id>.json`. Written only by the go dialog's click or his typed `go`. It covers the giver and the sessions under it now, until `end`.
export type Go = { id: string; giver: Sid; text: string; end: number }
// `unattended.json`. The window's `start` is its id.
export type Window = { start: number; end: number; readAt: number }
// What a reader makes of the window: on (with the file), off, or a failed read (a dialog opens only on off).
export type WindowReading = { state: 'on'; window: Window } | { state: 'off' } | { state: 'unknown' }
// `config.json`.
export type Config = { keepalive: boolean; pingAfterMin: number; stopAfterH: number; idleK: number; workingK: number }

// ---- events ----

type EventKind = 'ask' | 'expired' | 'done' | 'gone' | 'waiting' | 'quiet'
// One event a parent is told, computed from its own observation of its children now. `key` keeps "once" per event and process and is spent when the turn
// carrying it starts. `about` is the child; `ask` is the ask's id for the two ask kinds.
export type Notice = { kind: EventKind; key: string; about: Sid; ask?: string }
// Whose events a capability receives: a lead its children's, the manager its descendants'. The table is `RECEIVES` in notices.ts.
export type Receives = { [C in Exclude<Capability, 'none'>]: { from: 'children' | 'descendants'; kinds: readonly EventKind[] } }

// ---- the model ----

export const PERSON: Person = 'PERSON'
// Claude Code cuts a tab label over 25 characters, and the window's sweep matches a tab by its exact label, so a longer lane name could never be closed.
export const NAME_MAX = 25
export const NAME_RE = new RegExp(`^[A-Za-z0-9_-]{1,${NAME_MAX}}$`)
const RESERVED_NAME = 'MANAGER'
export const MAX_LIVE_CHILDREN = 8
// The models a lead may give a lane at lane_create; the lane switches to it at its start.
export const LANE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const
export type LaneModel = (typeof LANE_MODELS)[number]
// The efforts a lead may give a lane at lane_create; the lane sets it with /effort at its start, after the model.
export const LANE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type LaneEffort = (typeof LANE_EFFORTS)[number]

// The manager-name file as read: its one line, null for no file, `unknown` for a file that could not be read.
export type ManagerName = string | null | 'unknown'
// One reading of the machine, shared by every step of a tick: the live registry rows by session id, the table, and the manager picked from them. `managers` is
// every live session that is not off and carries the manager's name, oldest first; two or more is the toast that names both. `handing`: the sessions in the middle of a
// handover (a fresh marker whose process is live): one of them with no row of its own is `unknown`, never gone.
export type View = { rows: ReadonlyMap<Sid, RegistryRow> | 'unknown'; table: Table; managerName: ManagerName; manager: Sid | null | 'unknown'; managers: Sid[]; handing: ReadonlySet<Sid> }
// What is above a session: an owner, or `unknown` when a read could not tell. Unknown is not nobody: it never moves an ask or a child.
type Up = Owner | 'unknown'

const startMs = (r: RegistryRow): number => (Number.isFinite(Date.parse(r.procStart)) ? Date.parse(r.procStart) : Infinity)
export function liveView(reg: Registry, table: Table, managerName: ManagerName, handing: readonly Sid[] = []): View {
  const rows = reg === 'unknown' ? 'unknown' : new Map(reg.map((r) => [r.sid, r]))
  const named = rows === 'unknown' || managerName === null || managerName === 'unknown' ? [] : [...rows.values()].filter((r) => r.name === managerName && !table[r.sid]?.off)
  const managers = named.sort((a, b) => startMs(a) - startMs(b) || (a.sid < b.sid ? -1 : 1)).map((r) => r.sid)
  return { rows, table, managerName, managers, manager: rows === 'unknown' || managerName === 'unknown' ? 'unknown' : (managers[0] ?? null), handing: new Set(handing) }
}

// yes: a row ps confirmed. no: a complete read without one, unless the session is handing over (its successor is not bound yet): then unknown. Busy (in a tool call, compacting, in a dialog) is yes.
export const liveness = (v: View, s: Sid): Liveness => (v.rows === 'unknown' ? 'unknown' : v.rows.has(s) ? 'yes' : v.handing.has(s) ? 'unknown' : 'no')
export const isOff = (v: View, s: Sid): boolean => v.table[s]?.off === true
export const isLead = (v: View, s: Sid): boolean => v.table[s]?.lead !== undefined && !isOff(v, s)
export const capability = (v: View, s: Sid): Capability => (v.manager === s ? 'manager' : isLead(v, s) ? 'lead' : 'none')
// A conductor is a lead his typed command flagged; a minted lead is one a conductor made. A row holds one of the two: a typed `lead` or `conductor` rewrites the flags.
export const isConductor = (v: View, s: Sid): boolean => isLead(v, s) && v.table[s]!.lead!.conductor === true && v.table[s]!.lead!.minted !== true
export const isMinted = (v: View, s: Sid): boolean => v.table[s]?.lead?.minted === true
// The name a session was given (by /rename or a cue): its name source is `user`, or the registry gives none. Any other source (`auto` and `derived` are the ones seen) is the name
// Claude generated for a new panel, and a row's name wins over it.
export const givenName = (r: RegistryRow | undefined): string | undefined => (r?.nameSource === undefined || r.nameSource === 'user' ? r?.name : undefined)
// A name that spells a sentinel (PERSON, unknown) is not shown: the texts read those two words as the person and as a parent not known, so such a session shows as its id.
export const nameOf = (v: View, s: Sid): string => {
  const reg = v.rows === 'unknown' ? undefined : v.rows.get(s)
  const n = givenName(reg) ?? v.table[s]?.name ?? reg?.name ?? s
  return n === PERSON || n === 'unknown' ? s : n
}

// The one parent: the lead in `under` while it is not known gone, holds the capability and is not off; else the manager, unless this is it; else the person.
// A lead's `under` is read only when the lead is minted and `under` is a conductor, and the manager's parent is the person, so a chain is at most lane, lead, conductor,
// manager. An off session is nobody's child.
export function parent(v: View, s: Sid): Up {
  const row = v.table[s]
  if (row?.off || v.manager === s) return PERSON
  const u = row?.lead && !row.lead.minted ? undefined : row?.under
  if (u !== undefined && isLead(v, u) && liveness(v, u) !== 'no' && (!row?.lead || isConductor(v, u))) return u
  return v.manager ?? PERSON
}
// The sessions above s, nearest first, and what ends the chain: the person, or `unknown`.
export function chain(v: View, s: Sid): { up: Sid[]; top: Person | 'unknown' } {
  const up: Sid[] = []
  for (let p = parent(v, s); ; p = parent(v, p)) {
    if (p === PERSON || p === 'unknown') return { up, top: p }
    up.push(p)
  }
}
export const ancestors = (v: View, s: Sid): Sid[] => chain(v, s).up
// Every session the view knows: live rows and table keys (a parked, gone or not yet opened row has no live row).
const known = (v: View): Sid[] => [...new Set([...(v.rows === 'unknown' ? [] : v.rows.keys()), ...Object.keys(v.table)])]
export const children = (v: View, p: Sid): Sid[] => known(v).filter((s) => parent(v, s) === p)
export function descendants(v: View, p: Sid): Sid[] {
  const out: Sid[] = []
  for (let q = children(v, p); q.length > 0; q = q.flatMap((c) => children(v, c))) out.push(...q)
  return out
}
// The one gate for a parent's tool on a target: the caller is above it now.
export const mayActOn = (v: View, actor: Sid, target: Sid): boolean => ancestors(v, target).includes(actor)

// A lane's name: the grammar, neither MANAGER nor the manager-name file's line, and free among live sessions and rows (`self`, the one renamed, aside).
export function nameRefusal(v: View, name: string, self?: string): RefuseCode | undefined {
  if (!NAME_RE.test(name)) return 'name-bad'
  if (name === RESERVED_NAME || name === v.managerName) return 'name-reserved'
  if (v.rows === 'unknown' || v.managerName === 'unknown') return 'unknown-liveness'
  const taken = [...[...v.rows.values()].filter((r) => r.sid !== self).map((r) => r.name), ...Object.entries(v.table).filter(([k]) => k !== self).map(([, r]) => r.name)]
  return taken.includes(name) ? 'name-taken' : undefined
}
export const liveChildren = (v: View, p: Sid): number => children(v, p).filter((c) => liveness(v, c) === 'yes' && v.table[c]?.parked === undefined).length
// The cap binds a lead's own children; the manager's (the loose sessions) and the person's are not counted.
export const capRefusal = (v: View, p: string): RefuseCode | undefined => (isLead(v, p) && liveChildren(v, p) >= MAX_LIVE_CHILDREN ? 'cap' : undefined)
// A lead's allowlist: its own folder always, and the repos his typed `/callboard lead PATH…` added. Folders are real paths, resolved by the adapter.
const allowlist = (v: View, s: Sid): Folder[] | undefined => (isLead(v, s) ? [v.table[s].folder, ...v.table[s].lead!.repos] : undefined)
// Only an absolute path with no empty, `.` or `..` segment counts, on either side: the root and a relative path are inside nothing and contain nothing.
const plain = (f: Folder): boolean => f.startsWith('/') && f.split('/').slice(1).every((s) => s !== '' && s !== '.' && s !== '..')
const inside = (folder: Folder, repos: readonly Folder[]): boolean => plain(folder) && repos.some((r) => plain(r) && (folder === r || folder.startsWith(`${r}/`)))

// A conductor may also make a lead, but only inside its saved repos and never in its own folder; any other lead is refused it.
export function mayCreate(v: View, actor: Sid, name: string, folder: Folder, role: 'lane' | 'lead' = 'lane'): RefuseCode | undefined {
  const repos = allowlist(v, actor)
  if (repos === undefined) return 'not-lead'
  if (role === 'lead' && !isConductor(v, actor)) return 'not-conductor'
  const ok = role === 'lead' ? folder !== v.table[actor]!.folder && inside(folder, v.table[actor]!.lead!.repos) : inside(folder, repos)
  return ok ? (nameRefusal(v, name) ?? capRefusal(v, actor)) : 'folder-outside'
}
// Adopt by name: exactly one live session of that name, loose now (its parent is the manager or the person), not a lead, the manager or off, in the allowlist.
export function mayAdopt(v: View, actor: Sid, name: string): { ok: Sid } | { no: RefuseCode } {
  const repos = allowlist(v, actor)
  if (repos === undefined) return { no: 'not-lead' }
  if (v.rows === 'unknown' || v.manager === 'unknown') return { no: 'unknown-liveness' }
  const hits = [...v.rows.values()].filter((r) => r.name === name)
  if (hits.length !== 1) return { no: hits.length === 0 ? 'not-found' : 'ambiguous' }
  const t = hits[0].sid
  const p = parent(v, t)
  const no: RefuseCode | undefined = isOff(v, t) ? 'is-off' : t === v.manager ? 'is-manager' : isLead(v, t) ? 'is-lead' : p !== PERSON && p !== v.manager ? 'not-loose' : !inside(hits[0].folder, repos) ? 'folder-outside' : capRefusal(v, actor)
  return no === undefined ? { ok: t } : { no }
}
