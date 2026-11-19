// Every string a person or a model reads, by message id, and the parameters its text takes. The core returns `{ act, msg, p }`; `texts.ts` (not written yet) is typed
// `T: { [K in MsgId]: (p: Params[K]) => string }`, so a missing id or a wrong parameter fails the type check. The ids are listed by group;
// a family written `${...}` is one id per member of the named union. Types only.
import type { Config, CueVerb, StopVerb, ToolName } from './model.ts'

// The codes a refusal carries. One id per code: `refuse.<code>`.
export type RefuseCode =
  | 'not-built'
  | 'bad-input'
  | 'bad-origin' // a command that widens what a session may do, run by anything but his own typed turn
  | 'no-capability' // the caller is neither a lead nor the manager
  | 'not-a-parent' // the target is not a descendant of the caller now
  | 'not-lead'
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
  | 'unattended' // a force stop while a window is on
  | 'no-such-ask'
  | 'not-eligible'
  | 'person-only'
  | 'ask-closed'
  | 'compact-rate'
  | 'compact-floor'
  | 'compact-busy'
  | 'go-bad-text'
  | 'go-declined'
  | 'cue-held'
  | 'cue-refused'

// The command forms. One help row each: `help.<name>`.
export type CommandName = 'status' | 'lanes' | 'help' | 'lead' | 'lead-off' | 'off' | 'on' | 'go' | 'go-off' | 'unattended' | 'config' | 'rest'

// The lane list's columns and states (`/callboard lanes`, `lane_list`).
export type UiColumn = 'name' | 'role' | 'state' | 'parent' | 'folder' | 'context' | 'fiveHour' | 'sevenDay' | 'cost' | 'read'
export type UiState = 'live' | 'busy' | 'parked' | 'gone' | 'done' | 'off' | 'notOpened' | 'unknown'

type E = Record<never, never>
type RefuseP = { tool: string; target?: string; detail?: string }
type Names = { name: string }
type AskRef = { ask: string }

type Fixed = {
  // Notes and briefings: the plugin's frame around a briefing, then the three briefings (a parent with the ask rubric, the manager with its rules file, a child).
  'note.frame': { body: string }
  'brief.parent': { name: string; repos: string[] }
  'brief.manager': { name: string; rules: string; rulesCut: boolean }
  'brief.child': { name: string; parent: string }

  // Cue and compaction notes: the turns a parent's cue and a session's own compaction submit. There is no order nudge and no on-cue note.
  'cue.rename': Names
  'cue.start': { name: string; brief: string }
  'cue.resume': Names
  'compact.queued': E
  'compact.note': { focus: string; continuation: string }
  'compact.cut': E
  'compact.start': E

  // Nudges (the 300k, 400k and 150k kinds) and the keepalive ping.
  'nudge.idle': { k: number }
  'nudge.working': { k: number }
  'nudge.cache': { k: number }
  keepalive: E

  // Notices: the batched turn, then one line per event kind, and a PR note.
  'event.turn': { lines: string[] }
  'event.ask': AskRef & Names & { tool: string }
  'event.expired': AskRef & Names & { tool: string }
  'event.done': Names
  'event.gone': Names
  'event.waiting': Names & { why: string }
  'event.quiet': Names & { minutes: number }
  'event.report': Names & { code: string }
  'pr.watching': { pr: string }
  'pr.note': { pr: string; change: string }

  // The ask: the two close texts, the subagent deny, and what each prompt tool answers.
  'ask.expired': { parent: string }
  'ask.leftForPerson': { parent: string }
  'ask.subagent': E
  'ask.allowed': { ask: string }
  'ask.denied': { ask: string }
  'ask.answered': { ask: string }
  'ask.escalated': { ask: string; to: string }

  // The child tools' results (a refusal is `refuse.<code>`).
  'lane.cued': { verb: CueVerb; name: string }
  // `done`: the process ended (or there was none, so no pid) and, for a retire or terminate, the row is removed; `alive`: it outlived its signal, call again.
  'lane.stopped': { verb: StopVerb; name: string; pid?: number; outcome: 'done' | 'alive' }
  'lane.unparked': { name: string; sid: string }
  'lane.created': { name: string; folder: string }
  'lane.opened': { name: string; sid: string }
  'lane.notOpened': Names
  'lane.adopted': Names

  // Help: its heading; one row per command is `help.<name>`.
  'help.head': E

  // Command results.
  'cmd.usage': E
  'cmd.lead': { repos: string[] }
  'cmd.leadOff': E
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

  // Dialogs: the go, the force stop and the relay pop-up, each as header and question, and their buttons.
  'dialog.go.header': E
  'dialog.go.question': { giver: string; text: string; end: string }
  'dialog.stop.header': E
  'dialog.stop.question': { name: string; verb: StopVerb }
  'dialog.relay.header': { asker: string }
  'dialog.relay.question': { asker: string; tool: string; input: string }
  'dialog.allow': E
  'dialog.deny': E
  'dialog.yes': E
  'dialog.no': E

  // The go: the list of what it never covers (shown with every go), go_status, go_request.
  'go.neverCovers': E
  'go.status': { covers: { giver: string; text: string; end: string }[] }
  'go.none': E
  'go.requested': { text: string; end: string }

  // Toasts.
  'toast.refused': { tool: string; code: RefuseCode }
  'toast.askClosed': E // a click on a relay pop-up whose ask is closed
  'toast.askNoFile': AskRef // the ask file could not be written; the loop still holds the deadline
  'toast.askStuck': AskRef & Names // the sweep found an ask no process answers
  'toast.twoManagers': { a: string; b: string }
  'toast.noManager': E // the manager is off, renamed away from the file's name, or gone
  'toast.report': Names & { code: string } // a refusal or fallback `report()`, where the parent is the person

  // UI: the status page, the lane list, prompt_list (the rules file first), the unattended and go lists.
  'ui.status.head': E
  'ui.lanes.head': E
  'ui.lanes.none': E
  'ui.rules': { rules: string; cut: boolean }
  'ui.rules.none': E
  'ui.asks.none': E
  'ui.unattended.head': { end: string }
  'ui.unattended.none': E
  'ui.goes.head': E
  'ui.goes.none': E
  'ui.usage.footnote': E
}

// The families: a refusal per code, a tool description per tool, a help row per command, a column heading per column, a state label per state.
export type Params = Fixed &
  { [K in `refuse.${RefuseCode}`]: RefuseP } &
  { [K in `tool.${ToolName}`]: E } &
  { [K in `help.${CommandName}`]: E } &
  { [K in `ui.col.${UiColumn}`]: E } &
  { [K in `ui.state.${UiState}`]: E }

export type MsgId = keyof Params

// What a decision says: a message id and its parameters, as one value the compiler keeps in step.
export type Say<K extends MsgId = MsgId> = { [I in K]: { msg: I; p: Params[I] } }[K]
