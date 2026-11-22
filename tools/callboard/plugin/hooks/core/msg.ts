// Every string a person or a model reads, by message id, and the parameters its text takes. The core returns `{ act, msg, p }`; `texts.ts` is typed
// `T: { [K in MsgId]: (p: Params[K]) => string }`, so a missing id or a wrong parameter fails the type check. The ids are listed by group;
// a family written `${...}` is one id per member of the named union. Types only.
import type { Capability, Config, CueVerb, Question, RaisedBy, StopVerb, ToolName } from './model.ts'
import type { PrNote } from './pr.ts'

// The codes a refusal carries. One id per code: `refuse.<code>`.
export type RefuseCode =
  | 'bad-input'
  | 'bad-origin' // a command that widens what a session may do, run by anything but his own typed turn
  | 'no-capability' // the caller is neither a lead nor the manager
  | 'not-a-parent' // the target is not a descendant of the caller now
  | 'not-lead'
  | 'not-conductor' // lane_create role lead by a lead that is not a conductor
  | 'folder-outside' // the folder is not inside the lead's allowlist
  | 'name-taken'
  | 'name-reserved'
  | 'name-bad'
  | 'cap' // MAX_LIVE_CHILDREN
  | 'no-such-lane'
  | 'has-live-session'
  | 'no-live-session'
  | 'not-found' // adopt: no live session of that name
  | 'ambiguous' // adopt: more than one
  | 'not-loose'
  | 'is-lead'
  | 'is-manager'
  | 'is-off'
  | 'unknown-liveness' // a doubtful read: try again
  | 'not-idle'
  | 'report-unsigned'
  | 'unattended' // a force stop or go_request while a window is on
  | 'no-such-ask'
  | 'not-eligible'
  | 'ask-closed'
  | 'no-guard' // an answer while the protected-paths guard is not in place
  | 'input-cut' // an allow of an ask whose input a reader has not seen whole
  | 'compact-rate'
  | 'compact-floor'
  | 'compact-busy'
  | 'go-bad-text'
  | 'dialog-open' // go_request while another dialog is open: the person was not asked
  | 'stop-declined' // a force stop the person did not confirm
  | 'signal-failed' // the signal to the session's process did not go
  | 'table-unwritten' // the lane table could not be written
  | 'not-saved' // a command or tool could not save what it changes; the detail says what
  | 'window-refused' // the window answered a spool request with a refusal code
  | 'cue-held'
  | 'cue-refused'

// The command forms. One help row each: `help.<name>`.
export type CommandName = 'status' | 'lanes' | 'help' | 'lead' | 'lead-off' | 'conductor' | 'off' | 'on' | 'go' | 'go-off' | 'unattended' | 'config' | 'rest' | 'handover'

// The lane list's columns and states (`/callboard lanes`, `lane_list`).
export type UiColumn = 'name' | 'role' | 'state' | 'folder' | 'context' | 'fiveHour' | 'sevenDay' | 'cost' | 'read'
export type UiState = 'live' | 'busy' | 'parked' | 'gone' | 'done' | 'off' | 'notOpened' | 'unknown'

// One row of /callboard status: what is shown and its value, as the person reads it (a name, `PERSON` or `unknown` for a parent; whole minutes left of a window, or null).
export type StatusRow =
  | { field: 'role'; value: 'manager' | 'lead' | 'conductor' | 'lane' | 'session' }
  | { field: 'parent' | 'manager'; value: string | null }
  | { field: 'off' | 'keepalive'; value: boolean }
  | { field: 'unattended'; value: number | null }
  | { field: 'goes'; value: number }
  | { field: 'taken'; value: string[] }

type E = Record<never, never>
type RefuseP = { tool: string; target?: string; detail?: string }
type Names = { name: string }
type AskRef = { ask: string }

export type Fixed = {
  // Notes and briefings: the plugin's frame around a briefing, then the three briefings (a parent with the ask rubric, the manager with its rules file, a child).
  'note.frame': { body: string }
  // `conductor`: the name of the conductor above this lead (a minted lead), which it asks for a go and for answers; `brief.conductor` is added for a conductor.
  'brief.parent': { name: string; sid: string; repos: string[]; conductor?: string }
  'brief.conductor': { repos: string[] }
  'brief.manager': { name: string; rules: string; rulesCut: boolean }
  // `lead`: the parent is a lead, so the lane sends its questions to it instead of opening a dialog.
  'brief.child': { name: string; sid: string; parent: string; lead: boolean }

  // Cue and compaction notes: the turns a parent's cue and a session's own compaction submit.
  'cue.start': { name: string; brief: string; parent: string }
  'cue.resume': Names
  'compact.queued': E
  'compact.note': { focus: string; continuation: string }
  'compact.notRun': { reason: string }
  'compact.unconfirmed': { reason: string }
  'compact.start': E // toast: callboard starts this session's own compaction
  // Handover: the queued result, the toast, the refusal turn, and the turn the new session starts with (the handover file, a lane's brief, the continuation, the steps that did not land).
  'handover.queued': E
  'handover.start': E
  'handover.notRun': { reason: string }
  'handover.note': { name: string; file: string; brief?: string; continuation: string; failed: string[] }

  // Nudges (the 300k, 400k and 150k kinds) and the keepalive ping.
  'nudge.idle': { k: number }
  'nudge.working': { k: number }
  'nudge.cache': { k: number }
  keepalive: E

  // Notices: the batched turn, then one line per event kind, and a PR note.
  'event.turn': { lines: string[]; since?: string[] }
  'digest.panel': Names & { n: number }
  'digest.done': Names
  'digest.gone': Names
  'digest.go': Names
  'event.ask': AskRef & Names & { tool: string }
  'event.expired': AskRef & Names & { tool: string }
  'event.done': Names
  'event.gone': Names
  'event.waiting': Names & { why: string }
  'event.quiet': Names & { minutes: number }
  'pr.turn': { lines: string[] }
  'pr.watching': { pr: string }
  'pr.note': Omit<PrNote, 'at'>

  // The ask: the two close texts, the subagent deny, and what each prompt tool answers.
  'ask.expired': { parent: string }
  'ask.away': E
  'ask.subagent': E
  'ask.allowed': { ask: string }
  'ask.denied': { ask: string }
  'ask.answered': { ask: string }
  'ask.escalated': { ask: string; to: string }
  // What the asker reads when a session or the person decides its ask: a deny with its note, or the chosen label (bare when by is the person).
  'ask.denyText': { by: string; note: string }
  'ask.answerText': { label: string; by: string }

  // The child tools' results (a refusal is `refuse.<code>`).
  'lane.cued': { verb: CueVerb; name: string }
  // `done`: the process ended (or there was none, so no pid) and, for a retire or terminate, the row is removed; `alive`: it outlived its signal, call again.
  'lane.stopped': { verb: StopVerb; name: string; pid?: number; outcome: 'done' | 'alive' }
  'lane.unparked': { name: string; sid: string }
  'lane.created': { name: string; folder: string; lead: string; role?: 'lead' }
  'lane.opened': { name: string; sid: string }
  'lane.notOpened': Names
  'lane.adopted': { name: string; lead: string }
  // The file a lane's brief is written to: the lead's name and the task.
  'lane.brief': { name: string; lead: string; text: string }

  // Help: its heading; one row per command is `help.<name>`.
  'help.head': E

  // Command results.
  'cmd.usage': E
  'cmd.lead': { repos: string[] }
  'cmd.leadOff': E
  'cmd.conductorReset': E
  'cmd.conductor': { repos: string[] }
  'cmd.off': E
  'cmd.on': E
  'cmd.go': { id: string; end: string }
  'cmd.goOff': { n: number }
  'cmd.unattendedOn': { end: string }
  'cmd.unattendedOff': E
  'cmd.config': { cfg: Config }
  'cmd.configSet': { key: keyof Config; value: string }
  'cmd.configReset': E
  'cmd.rest': E
  // His typed /callboard handover: the turn that asks the session to write its state and call request_handover (also the command's own answer).
  'cmd.handover': E
  // The notice turn after his own step in this session: a typed /callboard command that changed something, or his click on the go dialog.
  'cmd.told': { result: string }
  // The same after a folder's lead preset command, sent once its name, model and effort steps ran; `failed` names the steps that did not land.
  'cmd.toldPreset': { command: string; result: string; failed: string[] }
  // The typeahead line of a preset's command.
  'cmd.presetHelp': { name: string; model: string; effort: string }
  'go.clicked': { outcome: 'given' | 'declined' | 'unsaved' | 'closed' }

  // Dialogs: the go, the force stop and the relay dialog, each as header and question, and their buttons.
  'dialog.go.header': E
  'dialog.go.question': { giver: string; text: string; end: string }
  'dialog.stop.header': E
  'dialog.stop.question': { name: string }
  'dialog.relay.header': E
  'dialog.relay.question': { asker: string; tool: string; input: string; cut: boolean }
  'dialog.relay.note': { asker: string; tool: string; note: string; by?: string } // by: the manager's plain name, if it has one
  'dialog.relay.asks': { asker: string; question: string } // an asker's own question, as the manager's session shows it
  'dialog.relay.native': { asker: string } // the description line of a relayed command in the engine's own dialog
  'dialog.relay.reason': { note?: string; by?: string } // that dialog's reason line, with the manager's note if there is one
  'dialog.relay.held': E // the deny that stops a relayed command where it would run
  'dialog.relay.reserved': E // the deny of any other Bash that uses the relay's description
  'dialog.relay.hidden': E // the deny of a Bash description with a hidden character or the reason line's sentence
  'dialog.allow': E
  'dialog.show': E
  'dialog.leave': E // the second option beside a lone Deny: it writes nothing
  'dialog.deny': E
  'dialog.yes': E
  'dialog.no': E

  // The go: the list of what it never covers (shown with every go), go_status, go_request.
  'go.neverCovers': E
  'go.status': { covers: { giver: string; text: string; end: string }[] }
  'go.none': E
  'go.requested': { text: string; end: string }
  'go.noGuard': E // the protected-paths guard is not in place, so no go counts

  // Toasts.
  'toast.askClosed': E // a click on a relay dialog whose ask is closed
  'toast.relayAmended': E // a Yes on a relayed command the person changed first
  'toast.relayRan': E // a relayed command ran in the manager's session
  'notify.relay': { name: string; tool: string } // the OS notification beside a relayed ask's dialog, taken back when it closes
  'toast.askNoFile': AskRef // the ask file could not be written; the loop still holds the deadline
  'toast.askStuck': AskRef & Names // the sweep found an ask no process answers
  'toast.twoManagers': { a: string; b: string }
  'toast.noManager': E // the manager is off, renamed away from the file's name, or gone

  // UI: the status page, the lane list, prompt_list (the rules file first), the go list. A status row is its label and its value in one text.
  'ui.status.head': E
  'ui.status.row': StatusRow
  'ui.lanes.head': E
  'ui.lanes.none': E
  'ui.rules': { rules: string; cut: boolean }
  'ui.rules.none': E
  'ui.asks.none': E
  'ui.ask': { id: string; asker: string; tool: string; ageMin: number; raisedBy: RaisedBy; input: string; cut: boolean; question?: Question }
  'ui.usage.footnote': E
}

// The families: a refusal per code, a tool description per tool, a help row per command, a column heading per column, a state label per state.
export type Params = Fixed &
  { [K in `refuse.${RefuseCode}`]: RefuseP } &
  { [K in `tool.${ToolName}`]: E } &
  { [K in `help.${CommandName}`]: E } &
  { [K in `ui.col.${UiColumn}`]: E } &
  { [K in `ui.role.${Capability}`]: E } &
  { [K in `ui.state.${UiState}`]: E }

export type MsgId = keyof Params

// What a decision says: a message id and its parameters, as one value the compiler keeps in step.
export type Say<K extends MsgId = MsgId> = { [I in K]: { msg: I; p: Params[I] } }[K]
