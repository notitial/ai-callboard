// The shapes the plugin's parts pass to each other: sessions, rows, asks, answers, cues, goes, the window and the table of events. Types, and the few name
// lists the types are made from. No logic.
import type { Say } from './msg.ts'

export type Sid = string
export type Folder = string

// The person, the one owner above every session. A session id is a UUID, so it never collides with this.
export type Person = 'PERSON'
export type Owner = Sid | Person

// A fact that may not be known: `unknown` is a failed or doubtful read and never closes or moves anything.
export type Liveness = 'yes' | 'no' | 'unknown'

// The tools, by name without the `mcp__callboard__` prefix. A child tool acts on a descendant of the caller; the cue verbs reach the child through its cue file,
// the stop verbs end its process (one body for the three).
export const CUE_VERBS = ['rename', 'start', 'resume'] as const
export const STOP_VERBS = ['park', 'retire', 'terminate'] as const
export type CueVerb = (typeof CUE_VERBS)[number]
export type StopVerb = (typeof STOP_VERBS)[number]
export const TOOLS = [
  'lane_rename', 'lane_start', 'lane_resume', 'lane_park', 'lane_retire', 'lane_terminate', 'lane_unpark', 'lane_list',
  'lane_create', 'lane_open', 'lane_adopt',
  'prompt_list', 'prompt_answer', 'unattended_off',
  'go_request', 'go_status', 'pr_watch', 'request_compact', 'rest',
] as const
export type ToolName = (typeof TOOLS)[number]

// What a session may do beyond what every session does. Granted by rows his commands or a parent's tools wrote and by the manager-name file; never inferred.
export type Capability = 'manager' | 'lead' | 'none'

// A row of the engine's registry (`~/.claude/sessions/<pid>.json`), as the adapter reads it.
export type RegistryRow = {
  sid: Sid
  pid: number
  procStart: string
  folder: Folder
  name?: string
  nameSource?: string
  status?: string
  waitingFor?: string
}
// The registry read: a list, or `unknown` (a changing file, too many files, a `ps` that cannot be trusted, no row of its own, a stale group, a cut `ps` confirm).
export type Registry = RegistryRow[] | 'unknown'

// A session as the registry shows it now: process facts and liveness. Busy (in a tool call, compacting, in a dialog) is still `yes`.
export type Live = {
  sid: Sid
  name?: string
  folder: Folder
  pid?: number
  procStart?: string
  liveness: Liveness
  status?: RegistryRow['status']
}

// One row of the session table (`sessions.json`), keyed by session id, or by `new:<NAME>` between `lane_create` and the opened panel's id. No row is the default:
// a loose session, managed, its parent the manager. `name` is a label refreshed from the registry and decides nothing.
export type Row = {
  name: string
  folder: Folder
  report?: string
  under?: Sid
  lead?: { repos: Folder[] }
  off?: true
  brief?: string
  parked?: number
  goneAt?: number
}
export type Table = { [key: string]: Row }

// What the core is given about one session: its row, if it has one, and its registry view.
export type Session = { sid: Sid; row?: Row; live: Live }

// A decision the core hands an adapter: what to do, and the message id and parameters of what is said about it. The core builds no string.
export type Decision<A extends string = string> = { act: A } & Say

// ---- the ask ----

export type RaisedBy = 'mode' | 'rule' | 'guard' | 'hook' | 'setting' | 'plugin' | 'ceiling' | 'unknown'
export type Question = { header: string; question: string; options: { label: string; description?: string }[]; multi?: boolean }

// `asks/<id>.json`, rewritten only by the asker's hook. `awake` is the time the asker's hook has counted awake, and the 5 and 15 minute steps run on it; `t0` and `beat`
// are wall time. `window` is the start of the window on when the ask was raised, or null. `input` is redacted and capped.
export type Ask = {
  id: string
  asker: Sid
  t0: number
  awake: number
  window: number | null
  personOnly: boolean
  tool: string
  raisedBy: RaisedBy
  input: string
  question?: Question
  beat: number
}

// `asks/<id>.answer`, created exclusively: the first writer wins. `by` is the session that decided, or the person (his click on the relay pop-up).
export type Answer = {
  ask: string
  by: Owner
  decision: 'allow' | 'deny' | 'answer'
  note?: string
  option?: number
  answer?: string
  at: number
}

// `asks/<id>.up.<sid>`: an escalation, or a "told" mark, by that session; created exclusively. `reach` is derived from these and from `awake`.
export type UpMark = { kind: 'escalated' | 'told'; by: Sid; at: number }

export type AskEvent = 'raised' | 'told' | 'escalated' | 'answered' | 'expired' | 'closed' | 'swept' | 'relay-unanswered' | 'left-for-person'
// A row of `asks-YYYY-MM.jsonl`, the one append-only ask log.
export type AskLogRow = { t: number; ev: AskEvent; ask: string; asker: Sid; by?: Owner; code?: string }

// ---- the cue and its result (cue.ts) ----

// `cue/<child sid>`: a parent's ordinary message to a child that needs the child's own process (a rename, the start on its brief, a resume).
export type Cue = { id: string; verb: CueVerb; from: Sid; at: number; name?: string; brief?: string }
// `result/<id>`: the child's answer. `held` is "not now" (a turn is running), retried by the parent.
export type CueResult = { id: string; outcome: 'ok' | 'refused' | 'held'; code?: string }

// ---- the window's spool (the extension's requests) ----

export type SpoolRequest = { op: 'open'; folder: Folder } | { op: 'reopen'; sid: Sid; folder: Folder } | { op: 'close'; sid: Sid; pid: number; folder: Folder }
export type SpoolReply = { ok: true; sid?: Sid } | { ok: false; code: string }

// ---- goes, the unattended window, the settings ----

// `go/<id>.json`. Written only by the go dialog's click or his typed `go`. It covers the giver and the sessions under it now, until `end`.
export type Go = { id: string; giver: Sid; text: string; end: number }
// `unattended.json`. The window's `start` is its id.
export type Window = { start: number; end: number; readAt: number }
// What a reader makes of the window: on (with the file), off, or a failed read (by day for every close).
export type WindowReading = { state: 'on'; window: Window } | { state: 'off' } | { state: 'unknown' }
// `config.json`.
export type Config = { keepalive: boolean; pingAfterMin: number; stopAfterH: number; idleK: number; workingK: number }

// ---- events ----

export type EventKind = 'ask' | 'expired' | 'done' | 'gone' | 'waiting' | 'quiet' | 'report'
// One event a parent is told, computed from its own observation of its children now. `key` keeps "once" per event and process and is spent when the turn
// carrying it starts. `about` is the child; `ask` is the ask's id for the two ask kinds; `code` is the refusal or fallback code of a `report`.
export type Notice = { kind: EventKind; key: string; about: Sid; ask?: string; code?: string }
// Whose events a capability receives: a lead its children's, the manager its descendants'. Only the shape is here; the table is not written yet.
export type Receives = { [C in Exclude<Capability, 'none'>]: { from: 'children' | 'descendants'; kinds: readonly EventKind[] } }
