// The module memory the engine files share: the module state as properties of `mem`, and the per-session maps and sets.
// It imports no engine file, so an import cycle between engine files cannot reach a constant that is not yet initialised.
import * as c from './core.ts'
import * as pr from './prompts.ts'
import type * as pw from './pr-watch.ts'

export const mem = {
  isTicking: false,
  timerOn: false,
  paths: undefined as { uid: number; root: string; sessions: string } | undefined,
  seq: 0,
  submits: 0,
  presenceQ: Promise.resolve() as Promise<unknown>,
  // Presence checks that could not be made, counted: an apply that spans one reads the count before and after its lookups (promptApply).
  presenceErrors: 0,
  // The settings of /callboard config, machine-wide in $.store. Read at session start and then at most once a minute (the tick and the nudge hooks
  // call this), so a change made in one session reaches the others within a minute. A read that fails or times out keeps the last good value (the
  // defaults before any); a field that fell back is logged once per load of the mod.
  cfg: { ...c.CONFIG_DEFAULTS } as c.Config,
  cfgReadAt: undefined as number | undefined,
  // This machine's reserved names (c.RESERVE_KEY), read as the settings are: fresh at each start and fresh again on each
  // path that judges a new name or the manager's (lane_create, /callboard lane, /callboard lead, /callboard manager); else at most once a minute from the tick. A read that fails or times out keeps the last good list. The list lands in core (c.setLocalReserved), where
  // reservedHit and isManagerName read it.
  // The read time moves only on a good read, so a failed one is tried again from the next tick; reservedGen drops a read that a /callboard reserve
  // write overtook (that write set the list itself).
  reservedReadAt: undefined as number | undefined,
  reservedGen: 0,
  // Every timer call records its time, a running tick or not. A gap past SLEEP_GAP_MS since the last one means the Mac slept: wokeAt.
  // A reload loses both, so the first call after it only records.
  lastTimerAt: undefined as number | undefined,
  wokeAt: undefined as number | undefined,
  lastSweepAt: 0,
  sweepFrom: 0,
  lastQuestionsPruneAt: 0,
  // The default-on guard (engine/answer-hook.ts): the last check of the hook and the three markers, kept for GUARD_TTL_MS; the one default-rows write in flight.
  guard: undefined as { at: number; missing?: pr.GuardMissing } | undefined,
  defaultSyncing: undefined as Promise<boolean> | undefined,
  // The unattended window (engine/answer-hook.ts). unattended: the last read, kept for its TTL. unattendedSure: the last state a read was sure of. unattendedUnknown:
  // the run of unknown reads now under way has its ledger row. unattendedHash: the last value
  // hashed, by its canonical text. unattendedLookedAt: when the tick last looked. unattendedCloses: how many windows this process has ended, so a read under way
  // across an end is not kept. unattendedU: the short id of the window last read on, until a read is sure it is off. unattendedBadSeen: a stored value that
  // does not parse (its windowText) and when this process first read it. unattendedOpens: how many windows this process has opened, so a read under way across an
  // open is not kept. unattendedOffDue: the `unattended-off` rows the ledger refused, written again before the next read.
  unattended: undefined as { at: number; w: pr.Window } | undefined,
  unattendedOpens: 0,
  unattendedOffDue: [] as Omit<pr.LedgerRow, 't'>[],
  unattendedBadSeen: undefined as { text: string; at: number } | undefined,
  unattendedSure: undefined as 'on' | 'off' | undefined,
  unattendedU: undefined as string | undefined,
  unattendedUnknown: false,
  unattendedHash: undefined as { text: string; hash: string } | undefined,
  unattendedLookedAt: undefined as number | undefined,
  unattendedCloses: 0,
  // The windows whose end this process has toasted (by short id): one toast per window per process.
  unattendedToasted: new Set<string>(),
  // When the usage files were last swept (usage.ts).
  usageSweptAt: undefined as number | undefined,
  // When this session's tick last swept the presence folder (grants.ts presencePrune).
  presencePrunedAt: undefined as number | undefined,
}

export const own = new Map<string, number>()
// The own texts that are not real work (the ping, a nudge, a notice, the lanes-changed turn), counted as own is; and every own submit, so the tick can
// tell whether anything went out while it ran.
export const unrealOwn = new Map<string, number>()

export const lastLogged = new Map<string, string>()
export const lastSaved = new Map<string, { sig: string; at: number }>()

// The stop calls (by session, verb and the lane as the lead typed it) whose process already got its signal, for the hook's .catch.
export const signalledCalls = new Map<string, { name: string; pid: number }>()

// Store writes of one repo go one at a time inside this process (a lead can issue parallel tool calls).
export const storeLocks = new Map<string, Promise<void>>()

// A release that could not be confirmed (twice) is owed: the tick tries again, up to 30 times, and stops when the folder is gone or names another holder.
// Nothing here lets a lock that names our own pid be removed by another take of the lock.
export const unlockOwed = new Map<string, { key: string; nonce: string; tries: number; dir: string }>()

// Rows ps -p confirmed gone, as pid and start time: that process has ended for good, so a later read need not ask again. A pid reused later has another start
// time, so its row is stale anyway. Cleared whole when full, and at session start.
export const goneSeen = new Set<string>()

// restoredOnce: a restore was decided (restored, declined or refused for good); one asked, attempted or held back is asked again at the next /callboard lane.
export const restoredOnce = new Set<string>()

// One callboard question per session at a time: a second request while one is open is refused, not queued.
export const dialogOpen = new Set<string>()
// Per lead, what the ceiling an unattended window puts on live lanes counts beside its live lanes (core.openedUnbound): the sessions its lane_open opened in
// this process, an open under way, and a session a rename or an unpark is binding now, each with the time it was taken.
export const laneOpened = new Map<string, Map<string, number>>()
// Counts the `off` commands that ran, so a restore or a join that waited on a dialog can see an `off` came in meanwhile and stop.
export const offSeq = new Map<string, number>()
// Sessions whose `here` (/callboard here) ended in this process, by a dropped grant or a key that could not be written: such a session is not here again until the
// person types the command there, whatever the store key says (its delete may have failed, or a slow write may land late).
export const hereGone = new Set<string>()

// The lead grant lives only in this module's memory: a reload or a restart drops it, and /callboard lead has to be run and allowed again.
// It keeps the cwd the lead had when the person gave it, so a later cd cannot move the lead into another repo's lanes.
// The engine has no call that removes a tool, so after `off` the tools stay declared and refuse every call.
// One grant per session, in the shape every level shares (c.Grant).
export const grants = new Map<string, c.Grant>()

// A session is a lane or a lead, never both. Each grant path checks the other's mark and sets its own with no await in
// between, and holds it until its own write has landed, so a lead grant and a lane binding that race cannot both pass.
export const leadGranting = new Set<string>()
export const laneBinding = new Set<string>()

export const leadDeclared = new Set<string>()
// The pin the briefing note was last appended for, per session: one note per grant and pin, dropped with the grant.
export const briefed = new Map<string, string>()

export const presenceText = new Map<string, string>()

// When the tick last rewrote each session's presence file; dropped with the file, so the next tick writes at once.
export const presenceTouchedAt = new Map<string, number>()

// A lane-store file that failed to parse, by its key, with the text that failed (at most STORE_MAX_BYTES a file): the person is told once per file and change (store.ts loadStores).
export const badStoreSeen = new Map<string, string>()

export const presenceErrs = new Map<string, { n: number; at: number }>()
// What a conductor's or the manager's cached presence text was made from (a conductor's repo, name and pins; the manager's compaction stamp).
export const conductorPresenceKey = new Map<string, string>()
// When the manager's compaction began (ms), per session, while one runs. It is in memory only: a restart drops the presence file with it.
export const presenceCompacting = new Map<string, number>()

// The lead grant ends: the tools stay declared and refuse, the presence file goes, the lane-list watch stops.
// Bumped by every leadDrop. A lead restore or a save of the grant that awaited across a drop sees the change and does nothing more, so an
// off or a Cancel is never undone by work that started before it.
export const leadEpoch = new Map<string, number>()

// The lead grant is kept in $.store as lead:<sid> = { pin, savedAt, repoId? }, written at the grant, at a restore and once a day while lead is on; leadSavedAt
// holds the time of the last write (or try) so the daily check reads no store. A failed write is logged and tried again a day later; the grant stays on.
export const leadSavedAt = new Map<string, number>()
// The repo token read for the lead's pin (engine/repo-id.ts): saved with the grant only while its pin is the grant's pin.
export const leadRepoId = new Map<string, { pin: string; id: string }>()

// move: the session's folder, when the saved grant's folder is gone and this one holds the same repo token; the tick then asks the person (leadMoveAsk).
// asking: that question is on screen.
export type LeadPending = { hint: c.LeadHint; tries: number; move?: string; asking?: boolean }
export const leadRestorePending = new Map<string, LeadPending>()

// The cut-compaction mark (c.CMP_PREFIX). cmpMarked: this load wrote the mark, so the tick clears it once the request has left `compacting`.
// cmpCutPending: a fresh mark found at start with no request left in $.state; the tick gives the note once the session counts as a person's.
export const cmpMarked = new Set<string>()
export const cmpCutPending = new Map<string, number>()

// Its facts per session, computed once where the binding is written (birth, attach, restore) and dropped at detach. Module memory: after a reload the
// prompt.compose hook falls back to the binding in the session's state, with the generic lead and report wording.
export const laneBrief = new Map<string, c.LaneFacts>()
// The lane name the briefing note was last appended for, per session: one note per binding, dropped at detach.
export const laneBriefed = new Map<string, string>()

// ---- the lead's watch on its own lane list ----
// cur: the hash of the store file as last read; told: the hash the lead has been told about (or was dropped); seen: the hash at the lead's last lane tool call.
// name: the lead's name that cur was hashed under; last: the store as read for it (rehashed when the name changes).
// kind `lanes` is a lead's watch on its repo's store file (path). Kind `leads` is a conductor's watch on the leads it owns: it has no path, and cur is the hash
// of c.leadWatchText over the lead records, looked at with the conductor's reach refresh and at its own lane tool calls.
export type Watch = { kind: 'lanes' | 'leads'; path?: string; sig?: string; name?: string; last?: { state: string; text: string }; cur: string; told: string; seen: string }
export const watch = new Map<string, Watch>()
export const laneNotices = new Map<string, number[]>()
export const cappedLogged = new Set<string>()

// ---- the usage file (usage.ts), per session ----
// When it was last written, whether a write is owed (a measure came, or the last write did not land), and the write in flight.
export const usageWrittenAt = new Map<string, number>()
export const usageOwed = new Set<string>()
export const usageWriting = new Map<string, Promise<boolean>>()

// A store write of the lead's own (lane_create, a retire or terminate that removes a lane) is in flight: the tick leaves the list alone until watchOwn has taken the new state as known.
export const ownWriting = new Map<string, number>()
// Bumped at the start and the end of each such write by a conductor: a look of its owned leads that began before a bump read the state from before the write.
export const ownGen = new Map<string, number>()

// One registration at a time per session: a /callboard lead after a timed-out one waits for the same registration instead of starting a second.
export const leadToolsInFlight = new Map<string, Promise<void>>()

// Whether a trusted manager (managerTrusted) runs on the Mac, as a lead's or a conductor's tick last saw it, for the lead's on-cue
// section and the conductor's manager section: read at most once a minute, so prompt.compose reads no file. A read that fails or throws counts as none.
// A due look runs under ACTION_TIMEOUT_MS (managerSeenStep); one that times out or throws serves no section (live false) and frees the busy
// mark, so the next minute reads again. managerSeenBusy holds the running look's own token, and an answer is kept only while its stamp is still the one
// stored: a look that timed out, or a drop meanwhile (leadDrop, session.end), leaves nothing behind.
// conductors: the names ('' for none) of the conductors trusted for the lead's pin, as the same look saw them.
// manager: the trusted manager's name (managerTrustedName), as the same look saw it; set whenever live is true.
export const managerSeen = new Map<string, { at: number; live: boolean; manager?: string; conductors?: string[] }>()
export const managerSeenBusy = new Map<string, object>()

// The manager's five lane tools, six lead tools and unattended_off, declared at its grant, then the three prompt tools (fifteen in all, c.MANAGER_TOOLS). The handlers are the lead's (leadBase refuses every other lane tool at manager level).
export const managerDeclared = new Set<string>()

// Lead cue calls to one target go one at a time inside this process (a lead can issue parallel tool calls); they share one answer file.
export const cueInFlight = new Map<string, number>()

// What this session last answered per cue file, so a cue left in place (refused before the move) is not answered every tick.
export const lastAnswer = new Map<string, string>()

// The lane record of this session's binding, for the report path. Looked up once per binding (the cache is keyed by the binding's record hash).
export const boundLane = new Map<string, { name: string; rec: string; l: c.Lane }>()

// The turn mark: when the main agent's turn began and how big the lane's report was. Written at prompt.submit (any origin) and at turn.start of the
// main agent (wakes and queued messages never pass prompt.submit). An unbound session has no report: size null. One stat, only when bound.
export const lastTurnUnknown = new Set<string>()

export const cfgInvalidLogged = new Set<string>()

export const midTurnBusy = new Set<string>()
// The sessions whose turn carried a mid-turn nudge, until that turn ends (midTurnFallback).
export const midDelivered = new Set<string>()
export const midTurnSkip = new Map<string, number>()

export const lastSubmitAt = new Map<string, number>()
export const turnKind = new Map<string, 'ping' | 'unreal'>()
export const kaLogged = new Map<string, string>()
// The pings that went out since the real turn that ended at realEnd.
export const pingCount = new Map<string, { realEnd: number; count: number }>()

// Notice turns sent per session in the last hour (module memory: a reload starts the count over).
export const noticeTimes = new Map<string, number[]>()

// Ticks in a row whose request step threw, per session (module memory): the count and the time of the first throw.
// The request is dropped only after REQUEST_FAILS_MAX throws in a row that span REQUEST_FAIL_SPAN_MS, so a brief fault
// (a slow shasum or agent.list for a few ticks) never costs a session its request or its resume note.
export const requestFails = new Map<string, { n: number; firstMs: number }>()

// claim removes its .taken file, unless a throw or a killed process falls between the move and the rm. This session's own leftovers go, at most once per
// TAKEN_SWEEP_MS: only names claim makes, aged by the claim time in the name (mv keeps the cue's mtime, so a stale cue under claim looks old), and only a
// plain file or a link (rm without -r cannot remove a folder; a folder or another kind is logged and left). Another session's are never touched.
export const takenSwept = new Map<string, number>()

// The rename of an attached session cannot run inside the command (the engine refuses it there), so it runs from the next tick, once.
export const pendingRename = new Map<string, { name: string; until: number; manager?: true; grant?: 'lead' | 'conductor' }>()
// A new lead's start turn, held until its box is empty and it is idle (engine/lead-accept.ts sets it, leadStartTick submits it): the lead's name, repo and brief
// path, the turn count the grant left (a person who typed meanwhile is driving), and when it is given up.
export type LeadStart = { name: string; repo: string; brief: string; turns: number; until: number }
export const leadStarts = new Map<string, LeadStart>()

// A bound session makes sure its own store record names it, once per binding (name, time and record hash): the record of a lane born through lane_rename,
// one restored through the dialog, a rebind and every older record. Run from the tick before the cue is claimed, under a time limit. The key is set
// first, so a failure is not retried in this process (the next restart falls back to the Restore dialog, whose bind is followed by this sync). The write re-checks the binding inside the store queue, so a /callboard off that cleared it meanwhile is not undone.
export const sidSynced = new Map<string, string>()

// Per session: the tries so far, and the record's name once it is known (for the toast when the rebind ends refused). One entry, so ending it ends both.
export const rebindPending = new Map<string, { tries: number; name?: string }>()
// Sessions this process rebound: a Restore question already open when the bind lands ends with no "things changed" toast.
export const rebound = new Set<string>()

// A try still running after the tick's time limit: the next tick does not start another beside it.
export const rebindBusy = new Set<string>()

// Once a minute, whatever the idle gates, a lead observes the lanes in its reach (lanes and registry only, no reports) into laneObs. A lane gone, waiting on a
// prompt 5 min or quiet 30 min (c.checkinItems) and not yet told is then checked against the timing gates: check-ins on, not paused, no wake in the last 30 min,
// the lead idle 20 min since its last turn ended or its last prompt (a waiting prompt skips the idle gate). Only then are reports read (signed done drops gone
// and quiet), and attentionNotice sends.
// A read that fails (lanes, registry, off) is no observation at all, never "all gone".
export const laneObs = new Map<string, Map<string, c.LaneObs>>()
// The same for a conductor and the leads it owns (c.observeLead), by the conductor's session id, then the lead's name (names are one machine-wide space). Kept apart from laneObs, which a
// conductor's lane tool calls also write.
export const leadObs = new Map<string, Map<string, c.LaneObs>>()
export const obsAt = new Map<string, number>()
export const attnTold = new Map<string, Set<string>>()
export const attnCapped = new Set<string>()
// The waiting prompts the last observation left owed (at: its time), for the hook that tells a busy session in the middle of its turn (checkinMidTurn).
export const attnMid = new Map<string, { at: number; items: c.AttentionItem[]; render: (items: c.AttentionItem[]) => string | undefined; label: string }>()
// The waiting prompts the person was told of in a toast, by check-in key: one toast per wait.
export const attnToasted = new Map<string, Set<string>>()
export const checkinBusy = new Set<string>()
// The manager's per-repo lead verdicts, kept across evaluations (by the manager's session id; dropped with the grant).
// Evaluations land 60-62 s apart, so the window spans one of them plus a margin: a verdict is reused once and read
// again at the evaluation after, so leads are read about every 2 min and a gone lead is seen at most ~2 min late (130 s made it ~3 min).
export const leadlessSeen = new Map<string, Map<string, { at: number; leads: c.LeadFile[] | 'held' }>>()
// What a lead read of each lane's end (c.LaneEnd), by the lead's session id, then the lane's name; ep is the grant epoch it was read under, so a new grant
// starts afresh. told: the signatures the lead was told of (c.doneKey), kept while the grant lasts. seen: the observation map the step last ran on (a check-in step that
// observed nothing leaves the same map, and the step then does nothing).
export const laneEnds = new Map<string, { ep: number; by: Map<string, c.LaneEnd>; told: Set<string>; seen?: Map<string, c.LaneObs> }>()
// The done notice's own hourly budget and its "capped" log mark, and the idle time its turn left untouched (c.DoneHold).
export const doneNotices = new Map<string, number[]>()
export const doneCapped = new Set<string>()
export const doneHold = new Map<string, c.DoneHold>()

// What each orderer (lead, conductor or manager) ordered: lane session id to { lane name, time of the first order }, in module memory (lost with the session or a reload,
// then no notice). Once a minute, an order older than c.ORDER_MS is looked up in $.store: the lane's own stamp (c.ORDER_PREFIX + its session id) is still there only if
// no compaction began (orderSpend), so only then, and only while the lane's session is live, the orderer gets one fixed notice, and the stamp goes. Nothing is
// stopped: the notice sends the orderer to the person. kind 'lead': the target is a lead (lead_compact), told with c.orderLeadText.
export const orders = new Map<string, Map<string, { lane: string; at: number; kind?: 'lead' }>>()
export const orderChecked = new Map<string, number>()
export const orderBusy = new Set<string>()

export const renameChecked = new Map<string, number>()

// The saved manager grant, manager:<sid> = { name, cwd, savedAt }: written at the person's yes (or a silent restore) and every MANAGER_REFRESH_MS while the
// manager runs; removed by leadDrop (off) and by a Cancel on the restore question. A failed write is logged and tried again at the next refresh; a drop while the
// write was in flight deletes the key again. managerCwd: the folder the session started in, read when the grant was made (none when it could not be read).
export const managerSavedAt = new Map<string, number>()
export const managerCwd = new Map<string, string>()

// fails: the tries that ended on a refusal that can clear by itself; afterYes: those of them that failed after the yes (yes: the running try got its yes), counted apart. byHand: the person's own
// command ended this restore, so a try still running does not put it back. unanswered: the times the question got no answer. waiting: the question got no answer and is
// asked again only once the person has sent a prompt in this session (managerRestoreWake). asked: a try of this restore was not silent, so no later try is.
export type MgrPending = { hint: c.ManagerHint; tries: number; asking?: boolean; fails?: number; afterYes?: number; unanswered?: number; waiting?: boolean; asked?: boolean; yes?: boolean; byHand?: boolean }
export const managerRestorePending = new Map<string, MgrPending>()
// A restore is offered once per process and session: a session.start that is not a start (a compaction, a reload) never starts a second one.
export const managerRestoreOffered = new Set<string>()

// A conductor's reach is the list file in its own repo (c.CONDUCTOR_FILE), resolved at every read, intersected with the approved list: what the person approved in
// a dialog of this session (the grant, a later add or a restore that asked). The file only narrows. conductorHome: the conductor repo (the session's start folder at
// the grant). conductorApproved: the approved real paths. Both go with leadDrop.
export const conductorHome = new Map<string, string>()
export const conductorApproved = new Map<string, string[]>()
export const conductorSavedAt = new Map<string, number>()
export const conductorDeclared = new Set<string>()

// unanswered: the times the restore question got no answer. waiting: it got no answer and is asked again only once a prompt that is not the mod's own has
// reached this session (conductorRestoreWake).
export type CondPending = { hint: c.ConductorHint; tries: number; last?: string; ask?: { shown: string[]; added: string[] }; asking?: boolean; unanswered?: number; waiting?: boolean }
export const conductorRestorePending = new Map<string, CondPending>()
// The sessions whose restore question was shown in this process: a session.start that is not a start (a compaction) starts no second restore for them, so
// the question is asked again only as its own limits allow. Module memory: a reload of the mod empties it, and the restore then starts over.
export const conductorRestoreAsked = new Set<string>()

export const conductorReadAt = new Map<string, number>()

type CheckEntry = { toolUseId: string; at: number; approver: unknown; facts: pr.CheckFacts; dup: boolean }
// What tool.check saw for an ask, joined to the PermissionRequest that follows by session, tool, whole-input hash and agent. PermissionRequest carries neither
// the approver nor the tool_use_id (probed), so both come from here.
export const checks = new Map<string, CheckEntry>()
// The calls whose request is open (or about to be), by tool_use_id: the three done events mark them, so a person's Yes (which fires no signal) is seen.
export const openReqs = new Map<string, { id?: string; dir?: string }>()
export const doneIds = new Set<string>()
// Requests whose hook ended with no closing row written (the write failed, or the dispatch was cut off by the person's No): the files stay and the tick writes the
// row, so every closed request ends with one. After UNCLOSED_TRIES failed tries the files are left to the sweep (session-gone, or swept after a day).
export const unclosed = new Map<string, { dir: string; row: Omit<pr.LedgerRow, 't'>; tries: number }>()

// The tiers this mod marked asking. At a turn's end the file is removed when the memory holds the mark or a stat finds the file (a reload loses the memory); a relay
// question's own end removes it whatever the memory holds (`always`).
export const askingSids = new Set<string>()
// The tiers that asked a relay question in the turn now running: the turn end sweeps their relays whatever the asking mark says (an answered question spends the mark,
// and an earlier one that was dismissed in the same turn would otherwise never be left).
export const relayAskedTurn = new Set<string>()
// The relay question a tier's permission hook is holding, by session: a token the hold checks at each poll. The question's own end (its answer), the turn's end and a
// later relay question take it away, and the hold then ends without answering.
export const relayHolds = new Map<string, object>()

export const windowsSeen = new Map<string, Record<string, number>>()

// Per tier: the requests whose relay was seen (so that one that goes away with the request still open is told again).
export const promptRelaySeen = new Map<string, Set<string>>()
export const promptTold = new Map<string, Map<string, number>>()
export const promptNotices = new Map<string, number[]>()
export const promptCapLogged = new Set<string>()

// The fallback (like midTurnFallback): the engine may not surface the context, or the model may read it and not act. When the turn that carried a mid-turn notice ends,
// each request of it still open is owed again, once, and the idle tick sends it as the idle turn; that resend is not a mid-turn one (promptMidRetold), so it
// is told twice at most. A request that closed meanwhile is dropped by the tick's scan and its marks here with it.
export const promptMidSent = new Map<string, Set<string>>()
export const promptMidRetold = new Map<string, Set<string>>()
// The tiers whose notice step ran while an unattended window was on: when the window is off again their told marks are cleared once, so a request the window
// kept from the person is told again.
export const windowHeldSeen = new Set<string>()

// A conductor's own lead offers, by its session id: the nonce and the time of each, newest last (capped, one day). conductorGrantCheck reads it to tell a grant it made from one it did not.
export const condOffers = new Map<string, { nonce: string; at: number }[]>()

// When a conductor last swept its own stale offers, by session id.
export const offerSweptAt = new Map<string, number>()

// conductorGrantCheck: when a conductor last read the ledger for grants in its name, and the grants (by nonce) it has already told the person about.
export const grantCheckedAt = new Map<string, number>()
export const grantTold = new Map<string, Set<string>>()

// ---- a lead's conductor (engine/lead-records.ts) ----
// When a bound lead last looked at its own record, and the leads whose changed record is already logged (once, until it matches again or the lead leaves).
export const ownerLooked = new Map<string, number>()
export const ownerFlagged = new Set<string>()
// A lead's rename whose new name is taken: the `old\ncur` pair the person was already told about, so the toast comes once per pair.
export const renameRefused = new Map<string, string>()

// The go (engine/go.ts). goAsked: when each session's go_request calls reached the dialog (the hourly cap). goWatch: what a lead or a conductor has seen of the `go-read` rows of
// its own goes, so a lane or a lead that reads one later is told to the person once (since: when this watch began; a read before it is not told). goBusy: its once-a-minute step.
export const goAsked = new Map<string, number[]>()
export const goWatch = new Map<string, { since: number; at: number | undefined; told: Map<string, Set<string>> }>()
export const goBusy = new Set<string>()

// ---- PR notices (engine/pr-watch.ts, ADR 0010) ----
// A session's own tracker as last read or written, and whether its file was looked at in this load; by tracker session, the one writer at a time.
export const prTrack = new Map<string, pw.Tracker>()
export const prLoaded = new Set<string>()
export const prChain = new Map<string, Promise<void>>()
// When a session last polled, and the poll in flight.
export const prPollAt = new Map<string, number>()
export const prBusy = new Set<string>()
// Failed looks in a row, by tracker session and PR.
export const prFails = new Map<string, number>()
// A lead's looks in a row that found no live session for a lane whose tracker names it, by the lane's session id.
export const prGone = new Map<string, number>()
// A gone lane's round whose tracker write is still owed: the tracker text the round began from and the PRs after it.
export const prHeld = new Map<string, { text: string; prs: unknown[] }>()
// The notes owed to a session as its folder was last read, when that was, and the files already delivered (kept until they are seen gone, so a failed removal
// never delivers one twice in this load).
export const prPending = new Map<string, { file: string; note: pw.Note }[]>()
export const prSpoolAt = new Map<string, number>()
export const prDelivered = new Map<string, Set<string>>()
// The wakes, the first looks and the notes written to a lead in the last hour; the cold stretch a lead was already told about; the cap already logged.
export const prWakes = new Map<string, number[]>()
export const prLooks = new Map<string, number[]>()
export const prLeadNotes = new Map<string, number[]>()
export const prColdTold = new Map<string, number>()
export const prCapLogged = new Set<string>()
// The GitHub CLI's real path as last resolved (undefined: none found), and when the folders of sessions that are gone were last swept.
export const prGh = { path: undefined as string | undefined, at: undefined as number | undefined, sweptAt: undefined as number | undefined }
