// The lead, manager and conductor grants and their check-ins, presence files and saved grants, the config and reserved names, and the briefings the hooks add.
// Trust rules held here: the grant checks (the dialog, the checks before and after the click, epochs, holder exclusions, restore gates, presence first for the manager).
import type { Request } from '../../types'
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import {
  grants,
  leadGranting,
  presenceText,
  presenceTouchedAt,
  conductorHome,
  conductorPresenceKey,
  presenceErrs,
  leadEpoch,
  briefed,
  watch,
  cappedLogged,
  laneObs,
  leadObs,
  attnTold,
  attnCapped,
  attnMid,
  attnToasted,
  obsAt,
  orders,
  orderChecked,
  managerSeen,
  managerSeenBusy,
  leadlessSeen,
  laneEnds,
  doneNotices,
  doneCapped,
  doneHold,
  leadSavedAt,
  leadRestorePending,
  conductorApproved,
  conductorSavedAt,
  conductorRestorePending,
  conductorReadAt,
  managerSavedAt,
  managerCwd,
  laneBinding,
  ownWriting,
  ownGen,
  laneNotices,
  turnKind,
  managerDeclared,
  cfgInvalidLogged,
  checkinBusy,
  lastSubmitAt,
  orderBusy,
  dialogOpen,
  offSeq,
  renameChecked,
  managerRestorePending,
  rebindPending,
  conductorDeclared,
  laneBrief,
  laneBriefed,
  midDelivered,
  promptMidSent,
  promptMidRetold,
  renameRefused,
  mem,
} from '../mem.ts'
import type { Watch, MgrPending, CondPending } from '../mem.ts'
import {
  withTimeout,
  logq,
  where,
  log,
  run,
  RM,
  realR,
  gitRoot,
  TICK_MS,
  logFail,
  toast,
  real,
  readSmallR,
  psOne,
  statR,
  dirOk,
  facts,
  sha,
  countDown,
  submitOwn,
  ACTION_TIMEOUT_MS,
  MKDIR,
  INSTALL,
  TEE,
  MV,
  askOnce,
  timedOut,
} from './base.ts'
import {
  registryEntries,
  writeIn,
  readStoreFile,
  storePath,
  idleCheck,
  loadLanes,
  editLanes,
  registryOf,
  regOnce,
  lockStore,
} from './store.ts'
import type { RegRow, Reg } from './store.ts'
import { ownOwner } from './lead-records.ts'
import { sessionRoot, leadToolsOnce, promptToolsRegister, leadCore, readReport } from './lanes.ts'
import type { Bound } from './lanes.ts'
import { interactive, busyAgents, personRow, backgroundShells } from './compaction.ts'
import { loadLeadRecords, boundState } from './lead-records.ts'
import { managerCommand } from './commands.ts'
import { ownerLeave, ownerRename, leadNameHeld } from './lead-records.ts'
import { goGrantorOff } from './go.ts'
import { epochOf, heldNo, levelBrief, levelSave } from './levels.ts'
import { usageDrop, usageSweep } from './usage.ts'
import type { LevelDesc, GrantDialog } from './levels.ts'
import { getCheckinPause, getLane, getNudgeDue, getRequest, getTurnEnd } from '../state.ts'

// A lead's one pin; undefined for no grant, and for any other level (a conductor or manager has no single pin and reads its grant whole).
export const pinOf = (sid: string): string | undefined => {
  const g = grants.get(sid)
  return g?.level === 'lead' ? g.pins[0] : undefined
}

export const leadBusy = (sid: string) => grants.has(sid) || leadGranting.has(sid)

// The three levels as one record each, read by levels.ts. lead:<sid> = { pin, savedAt }, manager:<sid> = { name, cwd?, savedAt } and conductor:<sid> = { home, repos:
// approved, savedAt }: written at the grant, and for the conductor at each add or remove in this session and after a ratchet, and again every refreshMs (a day; the
// manager's, which is what a silent restore reads as the last time it was live, 5 minutes). A write that ends
// after a drop deletes its key again, even when a new grant came meanwhile.
export const LEAD: LevelDesc = {
  level: 'lead',
  hint: c.LEAD_HINT_PREFIX,
  savedAt: leadSavedAt,
  refreshMs: c.HINT_REFRESH_MS,
  silentGraceMs: 0,
  unsaved: 'lead-unsaved',
  hintDelete: 'lead-hint-delete',
  saved: (_sid, pin) => ({ pin: pin! }),
  held: (sid, pin) => pinOf(sid) === pin,
  pending: leadRestorePending,
  isOn: (sid) => grants.has(sid) || leadRestorePending.has(sid),
  offText: 'Lead is now off.',
  kept: c.LEAD_KEPT,
  noteKey: (pin) => pin,
  note: (sid, pin) => c.leadBriefingNote(pin, sid),
  noteErr: 'lead-briefing',
  notYes: 'person-or-no',
  presenceFirst: false,
  offToast: c.TIMED_OUT_LEAD_OFF_TOAST,
}
export const MANAGER: LevelDesc = {
  level: 'manager',
  hint: c.MANAGER_HINT_PREFIX,
  savedAt: managerSavedAt,
  refreshMs: c.MANAGER_REFRESH_MS,
  silentGraceMs: c.MANAGER_SILENT_GRACE_MS,
  unsaved: 'manager-unsaved',
  hintDelete: 'manager-hint-delete',
  saved: (sid) => {
    const g = grants.get(sid)
    const cwd = managerCwd.get(sid)
    return g?.level === 'manager' ? { name: g.name, ...(cwd !== undefined ? { cwd } : {}) } : undefined
  },
  held: (sid) => grants.get(sid)?.level === 'manager',
  pending: managerRestorePending,
  isOn: (sid) => grants.get(sid)?.level === 'manager',
  offText: 'Manager is now off.',
  kept: c.MANAGER_KEPT,
  noteKey: (name) => `manager:${name}`,
  note: (_sid, name) => c.managerBriefingNote(name),
  noteErr: 'manager-briefing',
  notYes: 'none',
  presenceFirst: true,
  presence: { err: 'presence', fields: (g) => ({ level: 'manager', name: g.name }) },
}
export const CONDUCTOR: LevelDesc = {
  level: 'conductor',
  hint: c.CONDUCTOR_HINT_PREFIX,
  savedAt: conductorSavedAt,
  refreshMs: c.HINT_REFRESH_MS,
  silentGraceMs: 0,
  unsaved: 'conductor-unsaved',
  hintDelete: 'conductor-hint-delete',
  saved: (sid) => {
    const home = conductorHome.get(sid)
    const repos = conductorApproved.get(sid)
    return grants.get(sid)?.level === 'conductor' && home !== undefined && repos !== undefined ? { home, repos: [...repos] } : undefined
  },
  held: (sid) => grants.get(sid)?.level === 'conductor',
  pending: conductorRestorePending,
  isOn: (sid) => grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid),
  offText: 'Conductor is now off.',
  kept: c.CONDUCTOR_KEPT,
  noteKey: (home) => `conductor:${home}`,
  note: (sid, home) => {
    const g = grants.get(sid)
    return c.conductorBriefingNote(g?.name ?? '', home, g?.pins ?? [])
  },
  noteErr: 'conductor-briefing',
  notYes: 'person-no',
  presenceFirst: false,
  presence: { err: 'conductor-presence', fields: (g, home) => ({ level: 'conductor', name: g.name, repos: g.pins, home }), key: (g, home) => `${home}\n${g.name}\n${g.pins.join('\n')}` },
}
export const grantOf = (sid: string): c.Grant | undefined => grants.get(sid)
// The grant's name: the session's registry name just after the grant, by c.leadNameOf ('' when it gives none). Set only if the grant is still the same object,
// so an off or a re-grant meanwhile is never overwritten. Nothing reads it for reach: leadCore reads the name from the live registry again at every lead tool
// call. It is read by lane_create, to tell a lead that had a name at its grant and lost it (refused lead-unnamed) from one that never had one, and by the
// rename carry (leadRenameTick), which moves it when the lead is renamed.
// Run last on both grant paths, so its registry scan never widens the window in which an off races the grant; bounded by NAME_GRANT_MS.
const NAME_GRANT_MS = 5000
export async function nameGrant($: any, sid: string) {
  const g = grants.get(sid)
  if (!g) return
  try {
    const rows = await withTimeout($, registryEntries($), NAME_GRANT_MS)
    const n = (rows === 'timeout' || !rows ? undefined : c.leadNameOf(rows.map((e) => e.j), sid)) ?? ''
    if (grants.get(sid) === g) grants.set(sid, { ...g, name: n })
  } catch {
    await logq($, sid, 'error', 'grant-name')
  }
}

// The verb of a lane tool is its name without `lane_`; lead_open names itself.
export const leadReason = (verb: string, why: string) => `${verb.startsWith('lead_') ? '' : 'lane_'}${verb} refused: ${why}`

export const homeOf = (p: { root: string }) => p.root.slice(0, -'/.claude/callboard'.length)

// ---- the lead's presence file: <root>/leads/<lead sid>.json, a filter that says a lead runs for a repo; nothing is ever sent to the sid in it ----
// Written at the grant (only for a pin lane_create would accept), rewritten by the tick (a lead's every PRESENCE_TOUCH_MS, the others' every tick) and at the start of every lead tool call so its mtime stays fresh,
// removed on off, on a Deny, at session start and at session end. Its writes and its removal go one at a time, so a removal is not undone by a write in flight.
const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const r = mem.presenceQ.then(fn, fn)
  mem.presenceQ = r.catch(() => undefined)
  return r
}
// presenceText: undefined = not set up yet; '' = this pin cannot hold lanes, so no file. A check that failed (not a no) is not cached: the next tick or lead
// tool call tries again, then the pin is cached as a no and logged once PRESENCE_TRIES failures have been counted. At most one failure counts per tick
// interval, so a burst of lead tool calls against an error that comes back at once cannot spend the budget in a second.
const PRESENCE_TRIES = 5

// This session's one registry entry (with two, the pid could be a twin's), as the pid and start time its presence file names.
async function presenceSelf($: any, sid: string): Promise<{ pid: number; procStart: string } | undefined> {
  const mine = (await registryEntries($))?.filter((e) => e.j.sessionId === sid) ?? []
  const me = mine.length === 1 && String(mine[0].j.pid) === mine[0].pid ? mine[0] : undefined
  return me && typeof me.j.procStart === 'string' ? { pid: Number(me.pid), procStart: me.j.procStart } : undefined
}

// A manager's or conductor's file names no repo, so none of the pin checks; it resolves true once the file was written. A conductor's names its repos (its pins now)
// and its own repo, is rewritten when those change, and goes when no repo is left in reach.
export function presenceTouch($: any, sid: string): Promise<boolean | void> {
  return queued(async () => {
    const pin = pinOf(sid)
    const g = grants.get(sid)
    const p = await where($)
    if ((g?.level === 'manager' || g?.level === 'conductor') && p) {
      const d = (g.level === 'manager' ? MANAGER : CONDUCTOR).presence!
      const home = conductorHome.get(sid)
      if (g.level === 'conductor') {
        if (home === undefined) return false
        if (g.pins.length === 0) {
          presenceText.delete(sid)
          conductorPresenceKey.delete(sid)
          await run($, [RM, '-f', '--', `${p.root}/leads/${sid}.json`])
          return false
        }
      }
      const key = d.key?.(g, home)
      let text = presenceText.get(sid)
      if (text === undefined || (key !== undefined && conductorPresenceKey.get(sid) !== key)) {
        const me = await presenceSelf($, sid)
        if (!me) return false
        text = c.leadFileText({ sid, ...me, ...d.fields(g, home) } as Parameters<typeof c.leadFileText>[0]) ?? ''
        // The grant may have ended while the registry was read: its file is not written.
        if (grants.get(sid) !== g) return false
        presenceText.set(sid, text)
        if (key !== undefined) conductorPresenceKey.set(sid, key)
      }
      if (text === '') return false
      const w = await writeIn($, 'leads', `${sid}.json`, text)
      if ('err' in w) await log($, sid, 'error', d.err)
      return !('err' in w)
    }
    if (pin === undefined || !p) return
    let text = presenceText.get(sid)
    if (text === undefined) {
      const r = c.pinRefusal(pin, homeOf(p)) !== undefined ? 'no' : await realR($, pin)
      const g = r === 'no' || r === 'error' || r === 'absent' || r.path !== pin ? undefined : await gitRoot($, pin)
      if (r === 'error' || g === 'error') {
        const now = await $.clock.now()
        const was = presenceErrs.get(sid)
        const n = was && now - was.at < TICK_MS ? was.n : (was?.n ?? 0) + 1
        if (n !== was?.n) presenceErrs.set(sid, { n, at: now })
        if (n < PRESENCE_TRIES) return await log($, sid, 'error', 'presence-check')
        presenceText.set(sid, '')
        return await log($, sid, 'error', 'presence-git-error')
      }
      if (g !== 'yes') {
        presenceText.set(sid, '')
        return
      }
      // Exactly one entry of this session, else no file. The text is computed once, from that one entry, so it stays right if a twin appears later.
      const me = await presenceSelf($, sid)
      if (!me) return
      text = c.leadFileText({ sid, ...me, repo: pin }) ?? ''
      presenceText.set(sid, text)
    }
    if (text === '') return
    const w = await writeIn($, 'leads', `${sid}.json`, text)
    if ('err' in w) await log($, sid, 'error', 'presence')
    else presenceTouchedAt.set(sid, await $.clock.now())
  })
}
// The tick's test for a presence write. A lead's file is rewritten once PRESENCE_TOUCH_MS has passed since its last write; a conductor's and the manager's
// are rewritten on every tick, as they are few and other sessions' tier checks lean on them.
export function presenceDue(sid: string, now: number): boolean {
  return grants.get(sid)?.level !== 'lead' || c.dueEvery(presenceTouchedAt.get(sid), now, c.PRESENCE_TOUCH_MS)
}
export function presenceDrop($: any, sid: string) {
  presenceText.delete(sid)
  presenceTouchedAt.delete(sid)
  presenceErrs.delete(sid)
  conductorPresenceKey.delete(sid)
  return queued(async () => {
    const p = await where($)
    if (p) await run($, [RM, '-f', '--', `${p.root}/leads/${sid}.json`])
  })
}

// Resolves true when the saved grant is gone, false when its delete failed (the off and Cancel replies then say lead may come back after a restart).
export function leadDrop($: any, sid: string): Promise<boolean> {
  // The goes this lead or conductor gave end with its grant (ADR 0009); the rows are written beside the drop, which does not wait for them.
  if (grants.get(sid)?.level === 'lead' || grants.get(sid)?.level === 'conductor') void goGrantorOff($, sid).catch(() => undefined)
  leadEpoch.set(sid, epochOf(sid) + 1)
  grants.delete(sid)
  briefed.delete(sid)
  watch.delete(sid)
  cappedLogged.delete(sid)
  // The check-in memory goes with the grant; laneNotices (the hourly cap) stays.
  laneObs.delete(sid)
  leadObs.delete(sid)
  attnTold.delete(sid)
  attnCapped.delete(sid)
  attnMid.delete(sid)
  attnToasted.delete(sid)
  obsAt.delete(sid)
  orders.delete(sid)
  orderChecked.delete(sid)
  // What the lead last saw of a manager and the manager's lead-less verdicts go too, so a new grant reads afresh.
  managerSeen.delete(sid)
  managerSeenBusy.delete(sid)
  leadlessSeen.delete(sid)
  laneEnds.delete(sid)
  doneCapped.delete(sid)
  doneHold.delete(sid)
  leadSavedAt.delete(sid)
  leadRestorePending.delete(sid)
  renameRefused.delete(sid)
  // A conductor's repo, approved list and pending restore go too, and its saved grant below.
  conductorHome.delete(sid)
  conductorApproved.delete(sid)
  conductorSavedAt.delete(sid)
  conductorRestorePending.delete(sid)
  conductorReadAt.delete(sid)
  // The manager's saved-grant clock goes too. Its pending restore and saved grant do not: a Cancel on a lead's or a conductor's question, or a
  // failed manager grant, must not delete a mark the person never answered (managerForget, from /callboard off and the restore's Cancel, does).
  managerSavedAt.delete(sid)
  managerCwd.delete(sid)
  // The saved grant goes too, so the session is not lead again after a restart.
  const unsave = Promise.resolve()
    .then(() => $.store.delete(`${c.LEAD_HINT_PREFIX}${sid}`))
    .then(() => $.store.delete(`${c.CONDUCTOR_HINT_PREFIX}${sid}`))
    // A lead's owner binding goes with its grant, so nothing is obeyed for a session that is no lead (ownerLeave, called before this, also removes the record).
    .then(() => $.store.delete(`${c.OWNER_PREFIX}${sid}`))
    .then(
      () => true,
      async () => {
        await logq($, sid, 'error', 'lead-hint-delete')
        return false
      },
    )
  return Promise.all([presenceDrop($, sid), unsave]).then((r) => r[1])
}

// The grant dialog of the three levels, in one order: ask once, a click that is not yes, the checks again after a yes, the tools and the grant, the epoch, the saved
// grant and the presence file (the manager's first), the briefing. The command's own checks before the question stay with the command.
export async function grantDialog($: any, sid: string, d: LevelDesc, g: GrantDialog): Promise<{ text: string; code?: string }> {
  const seq = g.seq ?? offSeq.get(sid) ?? 0
  const offNow = () => (offSeq.get(sid) ?? 0) !== seq
  const label = d.level.charAt(0).toUpperCase() + d.level.slice(1)
  const r = g.silent ? (dialogOpen.has(sid) ? 'busy' : 'yes') : await askOnce($, sid, g.question, g.yes, g.no, g.header)
  if (r === 'busy') return g.busy()
  if (r !== 'yes') {
    if (g.onNotYes) return g.onNotYes(r)
    // A timeout ends the grant only where the level's notYes says so; the text then says it is now off.
    const wasOn = g.on()
    const was = wasOn && (r !== 'timed-out' || d.notYes === 'person-or-no')
    const drops = d.notYes === 'person-no' ? r === 'no' && g.person : d.notYes === 'person-or-no' ? r === 'no' || g.person : false
    // A lead grant that ends here takes its conductor tie with it (the binding and the record), so no orphan record keeps the lead's name.
    if (drops && wasOn && d.level === 'lead') await ownerLeave($, sid, 'off').catch(() => undefined)
    const kept = drops && !(await leadDrop($, sid)) ? d.kept : ''
    let why = ''
    if (r === 'timed-out') {
      await timedOut($, sid, 'timed-out', was && !g.on() ? (d.offToast ?? c.TIMED_OUT_TOAST) : c.TIMED_OUT_TOAST)
      why = ` ${c.TIMED_OUT_SENTENCE}`
    } else await log($, sid, 'refused', `${d.level}-not-confirmed`)
    return { text: `${g.on() ? `${label} stays on.${why}` : was ? `${label} is now off.${why}` : `${label} stays off.${why}`}${kept}` }
  }
  const no = g.postClick()
  if (no) return no
  leadGranting.add(sid)
  let grantEpoch = -1
  try {
    const bad = await g.recheck()
    if (bad) return bad
    if (offNow()) {
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.', code: 'off-meanwhile' }
    }
    const granted = await g.apply(offNow)
    if (typeof granted === 'object') return granted
    grantEpoch = granted
  } finally {
    leadGranting.delete(sid)
  }
  const gone = { text: d.offText }
  // A new grant may pin another folder: the old file and its checks go first.
  const writePresence = async () => {
    await presenceDrop($, sid).catch(() => undefined)
    return d.presenceFirst ? presenceTouch($, sid).catch(() => false) : presenceTouch($, sid).catch(logFail($, sid, d.presence?.err ?? 'presence'))
  }
  if (d.presenceFirst) {
    const refused = await g.afterPresence!(await writePresence(), grantEpoch)
    if (refused) return refused
  }
  await levelSave($, sid, d, g.pin)
  // An off or a Cancel during the save leaves no presence, log, briefing or "on" behind.
  if (epochOf(sid) !== grantEpoch) return gone
  if (!d.presenceFirst) {
    await writePresence()
    await g.afterPresence?.(undefined, grantEpoch)
  }
  await log($, sid, g.onLog[0], g.onLog[1])
  if (g.toast) toast($, g.toast)
  await levelBrief($, sid, d, g.briefArg)
  await g.after(grantEpoch)
  return { text: g.text }
}

// One try of a silent restore (the lead's and the conductor's): a try that throws is rejected as `error`; one that ended (undefined), or that a drop overtook,
// clears the pending entry. What it returns is the code (or question) the caller keeps the entry for or gives up on.
async function restoreAttempt<A>($: any, me: string, d: LevelDesc, attempt: () => Promise<A | undefined>): Promise<A | undefined> {
  const epoch = epochOf(me)
  let again: A | undefined
  try {
    again = await attempt()
  } catch {
    again = undefined
    await logq($, me, `${d.level}-restore-rejected`, 'error')
    toast($, c.notRestoredToast(d.level, 'error'))
  }
  if (again !== undefined && epochOf(me) === epoch) return again
  d.pending.delete(me)
}

// A session whose saved grant names its own folder is lead again when it starts, with no question. Started in session.start; a cwd read or a tool
// registration that does not answer in time is tried again from the tick, up to LEAD_RESTORE_TRIES ticks, and the key is kept. A grant for another folder is
// deleted. A bound session keeps the key and is not made lead. The briefing note stays in the history from the first grant: no second note.
export const LEAD_RESTORE_TRIES = 15

// One try: a code when it is to be tried again, undefined when it ended (made lead, or refused and logged).
async function leadRestoreTry($: any, me: string, hint: c.LeadHint): Promise<string | undefined> {
  const reject = (code: string) => log($, me, 'lead-restore-rejected', code)
  // A final end that no toast of its own tells. `told`: the reason the person reads, when the log's code would say more than is known.
  const end = async (code: string, told = code) => {
    await reject(code)
    toast($, c.notRestoredToast('lead', told))
  }
  const epoch = epochOf(me)
  const dropped = () => epochOf(me) !== epoch
  // A lead that still holds its grant in memory (a compaction) has nothing to restore: no check runs, so none can say it was not restored.
  if (grants.get(me)?.level === 'lead') return
  // A person's session only: a headless run resumed under this id is not made lead; the key is kept and the tick asks again (the registry row of a
  // reopened panel may come a moment after session.start).
  if (!(await interactive($, me))) return dropped() ? undefined : 'not-interactive'
  if (dropped()) return
  let cwd: unknown
  try {
    cwd = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return 'cwd-unreadable'
  }
  if (dropped()) return
  if (cwd === 'timeout' || typeof cwd !== 'string') return 'cwd-unreadable'
  if (cwd !== hint.pin) {
    await $.store.delete(`${c.LEAD_HINT_PREFIX}${me}`)
    void goGrantorOff($, me).catch(() => undefined)
    return void (await end('wrong-folder'))
  }
  // A lane is never a lead too (the rebind refuses a lead in turn); a read that does not answer counts as a binding.
  const held = await withTimeout($, getLane($), c.ENGINE_CALL_TIMEOUT_MS)
  if (dropped()) return
  if (held === 'timeout' || held?.value != null || laneBinding.has(me)) return void (await end('lane-holder', held === 'timeout' ? 'lane-check-slow' : undefined))
  // The person granted lead meanwhile: that grant stands.
  if (leadBusy(me)) return
  leadGranting.add(me)
  try {
    // The same second-lead check as /callboard lead. A refusal ends the try, keeps the key and tells the person. An unreadable session list or a
    // check that does not answer is tried again from the tick, as a cwd read is; the person is told once the tries run out (leadRestore).
    const named = await withTimeout($, secondLeadNo($, me, hint.pin), c.ENGINE_CALL_TIMEOUT_MS)
    if (dropped()) return
    if (named === 'timeout') return 'lead-check-slow'
    // A reopened panel's name can land in the registry a few ticks after session.start: a lead with no name yet beside another lead is tried again.
    if (named === 'registry-unreadable' || named === 'lead-needs-name') return named
    if (named !== undefined) {
      await reject(named)
      return void toast($, c.leadNotRestoredToast(named))
    }
    let set: unknown
    try {
      set = await withTimeout($, leadToolsOnce($, me), c.ENGINE_CALL_TIMEOUT_MS)
    } catch {
      return void (await end('tools'))
    }
    // An off or a Cancel while the tools were registering: nothing is granted, and nothing is tried again.
    if (dropped()) return
    if (set === 'timeout') return 'tools-timeout'
    grants.set(me, c.leadGrant(hint.pin))
  } finally {
    leadGranting.delete(me)
  }
  await levelSave($, me, LEAD, hint.pin)
  // An off or a Cancel during the save: no note, log or toast says lead is on.
  if (dropped()) return
  briefed.set(me, LEAD.noteKey(hint.pin))
  await log($, me, 'lead-restored')
  toast($, c.leadRestoredToast(hint.pin))
  await nameGrant($, me)
}
export async function leadRestore($: any, me: string, hint: c.LeadHint, tries: number) {
  const again = await restoreAttempt($, me, LEAD, () => leadRestoreTry($, me, hint))
  if (again === undefined) return
  if (tries >= LEAD_RESTORE_TRIES) {
    leadRestorePending.delete(me)
    await log($, me, 'lead-restore-rejected', again)
    // The key is kept, and the person is told why the lead did not come back. A session that never showed as a person's has nobody to tell.
    if (again === 'registry-unreadable' || again === 'lead-check-slow' || again === 'lead-needs-name') toast($, c.leadNotRestoredToast(again))
    else if (again !== 'not-interactive') toast($, c.notRestoredToast('lead', again))
    return
  }
  leadRestorePending.set(me, { hint, tries })
}

export const regEntry = (r: RegRow): c.RegEntry => ({ sessionId: r.j.sessionId as string, name: r.j.name, nameSource: r.j.nameSource, entrypoint: r.j.entrypoint, cwd: r.j.cwd, pid: String(r.j.pid) === r.pid ? r.j.pid : undefined, procStart: r.j.procStart, startedAt: r.j.startedAt, status: r.j.status, statusUpdatedAt: r.j.statusUpdatedAt, waitingFor: r.j.waitingFor })

// One presence file, every check: a plain 0600 file of ours, at most c.LEAD_FILE_MAX (4096) bytes, written in the last 30 s, naming its own file name as the sid; the registry has the
// pid's own file for that session with the same start time, and ps agrees; the repo is one lane_create would accept; the asking folder is in it.
// With cwd undefined, the folder check is skipped (the manager's lane_compact looks a lead up by name, in any repo).
// errs, when given, is set when the presence check could not be made (a lead not clearly gone).
// only: a filter on the file's repo that runs before any process is asked about it (the list of a conductor reads only the leads of its repos).
async function leadFileOk($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, cwd: string | undefined, errs?: { error: boolean }, only?: (repo: string) => boolean): Promise<c.LeadFile | undefined> {
  const lf = await presenceFileOk($, p, live, sid, (f) => f.level === 'lead' && (cwd === undefined || cwd === f.repo || c.within(f.repo, cwd)) && (only === undefined || only(f.repo)), errs)
  if (lf?.level !== 'lead') return undefined
  if (c.pinRefusal(lf.repo, homeOf(p)) !== undefined || (await real($, lf.repo)) !== lf.repo || (await gitRoot($, lf.repo)) !== 'yes') return undefined
  return lf
}
// The checks every presence file gets, whatever its level; want filters the parsed file before any process is asked about it.
async function presenceFileOk($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, want: (f: c.PresenceFile) => boolean, errs?: { error: boolean }): Promise<c.PresenceFile | undefined> {
  const r = await presenceCheck($, p, live, sid, want)
  if (r === 'error' && errs) errs.error = true
  return typeof r === 'string' ? undefined : r
}

// The same checks, saying how a file failed them: 'no' for a clear no (gone, not a plain file of ours, stale, another level, no
// registry row, a dead pid, another start time, not claude), 'error' for a check that could not be made (a read that failed or kept changing, a ps that failed).
// A trust check (presenceFileOk) takes both as no; manager-exists and a manager's stop count 'error' as a file that holds (fail closed).
export async function presenceCheck($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, want: (f: c.PresenceFile) => boolean): Promise<c.PresenceFile | 'no' | 'error'> {
  const r = await presenceRead($, p, live, sid, want)
  if (r === 'error') mem.presenceErrors++
  return r
}
async function presenceRead($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, want: (f: c.PresenceFile) => boolean): Promise<c.PresenceFile | 'no' | 'error'> {
  const path = `${p.root}/leads/${sid}.json`
  // A lead rewrites its file by renaming a new one into place: a read that met the swap gets one more try.
  let f = await readSmallR($, path, p.uid, c.LEAD_FILE_MAX)
  if (f.state === 'changed') f = await readSmallR($, path, p.uid, c.LEAD_FILE_MAX)
  // One more read before a failed or changing read counts as 'error', so a passing failure is not a check that failed.
  if (f.state === 'failed' || f.state === 'changed') f = await readSmallR($, path, p.uid, c.LEAD_FILE_MAX)
  if (f.state === 'failed' || f.state === 'changed') return 'error'
  if (f.state !== 'ok' || !c.leadFileFresh(await $.clock.now(), f.mtimeMs)) return 'no'
  const lf = c.parsePresenceFile(f.text, sid)
  if (!lf || !want(lf)) return 'no'
  const reg = live.find((e) => e.pid === String(lf.pid) && e.j.sessionId === sid && c.sameStart(e.j.procStart, lf.procStart) && String(e.j.pid) === e.pid)
  if (!reg) return 'no'
  const start = await psOne($, lf.pid, 'lstart=')
  if (start === 'error') return 'error'
  if (c.pidRefusal(regEntry(reg), start === 'gone' ? undefined : start.out) !== undefined) return 'no'
  // The presence pid must be a claude process, as for the stop tools: a file naming some other live process is not a lead.
  const args = await psOne($, lf.pid, 'args=')
  if (args === 'error') return 'error'
  if (c.processRefusal(args === 'gone' ? undefined : args.out, lf.pid, undefined) !== undefined) return 'no'
  return lf
}
// The fresh presence file names, cut to the fresh ones before the cap (as leadsFor). strict: a list that throws throws, not "none".
async function freshPresence($: any, p: { root: string }, strict = false): Promise<string[]> {
  const now = await $.clock.now()
  const list = (await (strict ? $.fs.list(`${p.root}/leads`) : $.fs.list(`${p.root}/leads`).catch(() => []))) as { name: string; mtimeMs?: number }[]
  return list.filter((f) => f.name.endsWith('.json') && c.SID_RE.test(f.name.slice(0, -5)) && typeof f.mtimeMs === 'number' && c.leadFileFresh(now, f.mtimeMs)).map((f) => f.name.slice(0, -5)).sort().slice(0, c.LEAD_FILES_MAX)
}
// Every live manager file of another session, each with its registry name if that is a reserved one (c.managerNameOf). manager-exists counts
// every such file, whatever its name; a lead takes a compact cue only while one with a reserved name is live.
// A fresh file whose check could not be made (a read or ps that failed) is listed too, unverified, with no name: manager-exists counts it
// (fail closed); managerTrusted never does.
// A leads folder that is there but fails its checks, or whose list throws, is one unverified manager (manager-exists counts it); a missing
// folder is none.
export async function managersLive($: any, live: RegRow[], except: string): Promise<{ sid: string; name?: string; unverified?: true }[]> {
  const d = await presenceNames($)
  if (d === 'none') return []
  if (d === 'error') return [{ sid: '', unverified: true }]
  const p = d.p
  const rows = live.map((r) => r.j)
  const out: { sid: string; name?: string; unverified?: true }[] = []
  for (const s of d.names) {
    if (s === except) continue
    const r = await presenceCheck($, p, live, s, (f) => f.level === 'manager')
    if (r === 'error') out.push({ sid: s, unverified: true })
    else if (r !== 'no') out.push({ sid: s, name: c.managerNameOf(rows, s) })
  }
  return out
}
// A live manager whose cue a session may take: its file passed every check and the registry gives it a reserved
// name no other live row carries.
export async function managerTrusted($: any, live: RegRow[], except: string): Promise<boolean> {
  return (await managersLive($, live, except)).some((m) => m.unverified !== true && m.name !== undefined)
}
// Whether the one conductor `sid` is trusted for the pin: its fresh conductor file passes presenceCheck and lists the pin, its home is its own real path, not too
// broad and a git root, its saved grant (conductor:<sid>) parses, names the same home and approves the pin, and the list file at that home, resolved, lists the
// pin. Any read that fails: not trusted. A filter, not proof (as the manager's). Who may route to it is the lead's record (ownerLive), not this.
export async function conductorTrustedSid($: any, live: RegRow[], except: string, pin: string | undefined, sid: string): Promise<boolean> {
  if (pin === undefined) return false
  return (await conductorsReaching($, live, except, (r) => r === pin, sid)).length > 0
}
// The same checks for the conductors whose approved list holds a repo that `match` accepts (a request's folder is in a conductor's reach when a pin holds it,
// the same within-folder match a lead's pin gets), every one of them judged against the pins that matched. With `only`, no other session is examined. Each row
// carries the conductor's home.
export async function conductorsReaching($: any, live: RegRow[], except: string, match: (repo: string) => boolean, only?: string): Promise<{ sid: string; name?: string; home: string }[]> {
  const d = await presenceNames($)
  if (typeof d === 'string') return []
  const p = d.p
  const rows = live.map((r) => r.j)
  const now = await $.clock.now()
  const out: { sid: string; name?: string; home: string }[] = []
  for (const s of d.names) {
    if (s === except || (only !== undefined && s !== only)) continue
    const f = await presenceCheck($, p, live, s, (x) => x.level === 'conductor' && x.repos.some(match))
    if (typeof f === 'string' || f.level !== 'conductor') continue
    const home = f.home
    if (c.pinRefusal(home, homeOf(p)) !== undefined || (await real($, home)) !== home || (await gitRoot($, home)) !== 'yes') continue
    const raw = await (async () => $.store.get(`${c.CONDUCTOR_HINT_PREFIX}${s}`))().catch(() => undefined)
    const h = c.parseConductorHint(raw, now, homeOf(p))
    if (!h || h.home !== home || !h.repos.some(match)) continue
    const lf = await readConductorFile($, home)
    if (lf.state !== 'ok') continue
    if (!(await resolveConductorList($, home, lf.entries)).ok.some(match)) continue
    const name = c.laneLeadOf(rows, s)?.name
    out.push({ sid: s, ...(name ? { name } : {}), home })
  }
  return out
}
// Whether a session holds a fresh presence file of any level (a lead, a conductor, the manager) that passes the checks, or
// whose check could not be made (fail closed). A manager's stop is never sent to such a session.
// A leads folder that is there but fails its checks, or whose list throws, counts as held; a missing folder does not.
export async function presenceHeld($: any, live: RegRow[], sid: string): Promise<boolean> {
  const d = await presenceNames($)
  if (d === 'none') return false
  if (d === 'error') return true
  if (!d.names.includes(sid)) return false
  return (await presenceCheck($, d.p, live, sid, () => true)) !== 'no'
}
// The fresh presence file names for a check that fails closed: 'none' when the callboard or leads folder is not there,
// 'error' when one is there but fails dirOk's rules, its stat could not be made, or the list throws.
async function presenceNames($: any): Promise<{ p: { uid: number; root: string }; names: string[] } | 'none' | 'error'> {
  const p = await where($)
  if (!p) return 'error'
  for (const dir of [p.root, `${p.root}/leads`]) {
    const f = await statR($, dir)
    if (f === 'absent') return 'none'
    if (f === 'error' || f.kind !== 'dir' || f.uid !== p.uid || f.mode !== 0o700) return 'error'
  }
  try {
    return { p, names: await freshPresence($, p, true) }
  } catch {
    return 'error'
  }
}

async function leadsDirOk($: any): Promise<{ uid: number; root: string } | undefined> {
  const p = await where($)
  return p && (await dirOk($, p.root, p.uid)) && (await dirOk($, `${p.root}/leads`, p.uid)) ? p : undefined
}

// Every live lead whose repo holds this folder. The list is cut to the fresh files before the cap, so a pile of old files cannot push a live one out of it.
// With cwd undefined, every live lead in any repo. With errs, the folder and its list fail closed (presenceNames), and errs is set when they,
// or a lead's check, could not be made.
export async function leadsFor($: any, live: RegRow[], cwd: string | undefined, repo?: string, errs?: { error: boolean }, only?: (repo: string) => boolean): Promise<c.LeadFile[]> {
  const d = errs ? await presenceNames($) : await leadsDirOk($).then(async (p) => (p ? { p, names: await freshPresence($, p) } : ('none' as const)))
  if (d === 'error') errs!.error = true
  if (typeof d === 'string') return []
  const p = d.p
  const found: c.LeadFile[] = []
  for (const s of d.names) {
    const lf = await leadFileOk($, p, live, s, cwd, errs, only)
    if (lf && (repo === undefined || lf.repo === repo)) found.push(lf)
  }
  return found
}

// The live lead for this folder: the one there is, or with several the one named pick. Several and no pick: the choices, their usable names (c.leadNameOf)
// sorted, and ambiguous-lead when none has one. A pick no live lead carries any more: changed.
export async function findLead($: any, live: RegRow[], cwd: string, pick?: string): Promise<{ lead: c.LeadFile } | { no: string } | { choices: string[] }> {
  const found = await leadsFor($, live, cwd)
  const rows = live.map((r) => r.j)
  if (pick !== undefined) {
    const hit = found.find((x) => c.leadNameOf(rows, x.sid) === pick)
    return hit ? { lead: hit } : { no: 'changed' }
  }
  if (found.length <= 1) return found.length === 1 ? { lead: found[0] } : { no: 'no-lead' }
  const choices = found.flatMap((x) => c.leadNameOf(rows, x.sid) ?? []).sort()
  return choices.length > 0 ? { choices } : { no: 'ambiguous-lead' }
}

// A second lead in the repo of the pin needs a usable name, and so does every other lead there (c.secondLeadRefusal). An unreadable registry refuses.
// `want`: the NAME the person typed for this session, judged in place of its current name.
export async function secondLeadNo($: any, sid: string, pin: string, want?: string): Promise<string | undefined> {
  const live = await registryEntries($)
  if (!live) return 'registry-unreadable'
  const others = (await leadsFor($, live, pin, pin)).filter((x) => x.sid !== sid)
  const rows = live.map((r) => (want !== undefined && r.j.sessionId === sid ? { ...r.j, name: want } : r.j))
  const refused = c.secondLeadRefusal(rows, sid, others.map((x) => x.sid))
  if (refused !== undefined) return refused
  // A name a lead record holds is not free for another session, in any repo, with or without a session of its own (a record kept for its lanes keeps its
  // name). A read that failed refuses.
  const name = c.leadNameOf(rows, sid)
  if (name === undefined) return undefined
  const held = await leadNameHeld($, sid, name, false)
  return held === true ? 'name-in-use' : held === false ? undefined : 'store-unreadable'
}

// An attached lane works with whichever lead holds a valid grant for its repo (consent given under one lead carries to the next one the person allows there);
// the store is writable by any process of the user, so the presence file passes every check; the record's leadName can only narrow it, never stand in.
// The lead's repo must be the lane's own repo, not any repo that happens to hold the folder (a lead at a parent repo has no business with a nested one).
// A record naming its lead needs a live lead of that repo with that registry name (c.leadNameOf); a legacy record, any lead of the repo.
export async function leadHere($: any, cwd: string, repo: string, leadName: string | undefined, reg: Reg = () => registryEntries($)): Promise<boolean> {
  const live = await reg()
  if (!live) return false
  const leads = await leadsFor($, live, cwd, repo)
  const rows = live.map((r) => r.j)
  return leadName === undefined ? leads.length > 0 : leads.some((x) => c.leadNameOf(rows, x.sid) === leadName)
}

// A lead's tick, once every PRESENCE_PRUNE_MS, removes presence files nobody has written for ten minutes (a session that died without its end hook), and the usage files of sessions that are gone.
export async function presencePrune($: any) {
  const p = await leadsDirOk($)
  if (!p) return
  await usageSweep($).catch(() => undefined)
  const now = await $.clock.now()
  for (const f of (await $.fs.list(`${p.root}/leads`).catch(() => [])) as { name: string; mtimeMs?: number }[]) {
    if (f.name.endsWith('.json') && c.SID_RE.test(f.name.slice(0, -5)) && typeof f.mtimeMs === 'number' && now - f.mtimeMs > c.LEAD_PRUNE_MS) await run($, [RM, '-f', '--', `${p.root}/leads/${f.name}`])
  }
}

export async function watchPoll($: any, sid: string) {
  const w = watch.get(sid)
  const p = await where($)
  // A conductor's watch is over computed text, looked at by leadWatchLook (conductorTick, watchLook), not polled here every tick.
  if (!w || w.kind !== 'lanes' || w.path === undefined || !p) return
  const f = await facts($, w.path)
  const sig = f ? `${f.ino}:${f.size}:${f.mtimeMs}` : 'none'
  // The lead's name is set after the grant (nameGrant) and moves on a rename: a change of it alone is not news, so a settled watch is moved with it.
  const name = grants.get(sid)?.name ?? ''
  if (sig === w.sig && name === w.name) return
  // A change of the name alone rehashes what was read last, with no new read.
  const cur = sig === w.sig && w.last ? w.last : f ? await readStoreFile($, w.path, p.uid) : { state: 'absent', text: '' }
  const was = w.cur
  // The text last hashed, under the name that is now this lead's: what the lead had been told, as it reads now.
  const settled = name !== w.name && w.last ? await sha($, c.watchText(w.last.state, w.last.text, { name, sid })) : undefined
  w.sig = sig
  w.last = cur
  // Hashed as this lead sees the list (c.watchText): its own lanes and legacy ones, without each lane's sid and parked.
  w.cur = await sha($, c.watchText(cur.state, cur.text, { name, sid }))
  if (name !== w.name) {
    w.name = name
    if (settled !== undefined && was === w.told) w.told = settled
    if (settled !== undefined && was === w.seen) w.seen = settled
  }
}
// The first look at grant time is the baseline: no notice for what was already there.
export async function watchInit($: any, sid: string) {
  const pin = pinOf(sid)
  const p = await where($)
  if (pin === undefined || !p) return
  const w: Watch = { kind: 'lanes', path: await storePath($, await sha($, pin)), cur: '', told: '', seen: '' }
  watch.set(sid, w)
  await watchPoll($, sid)
  w.told = w.seen = w.cur
}
// A conductor's look at the leads it owns: the hash of c.leadWatchText over the records of its reach. The first look is the baseline (no notice for what was already
// there). A look that could not be made (the records folder unreadable, no reach left) keeps the last good hash and is logged once: a passing read error is not news.
export async function leadWatchLook($: any, sid: string, own = false) {
  const g = grants.get(sid)
  if (g?.level !== 'conductor') return
  const ep = epochOf(sid)
  // A look that overlaps one of the conductor's own writes (ownWrite) does not set the hash: the write's own look, at its end, takes the new state as known.
  const gen = ownGen.get(sid) ?? 0
  const stores = g.pins.length > 0 ? await loadLeadRecords($) : 'no-reach'
  if (typeof stores === 'string') return logq($, sid, 'error', `lead-watch-${stores}`)
  // The leads it owns as the check-in counts them: bound to their record, and with a session. A binding that could not be read is no look at all.
  const owned: typeof stores = []
  for (const s of stores) {
    if (!g.pins.includes(s.store.repo)) continue
    const leads: c.LeadRec[] = []
    for (const rec of s.store.leads) {
      if (rec.conductorSid !== sid || rec.sid === undefined) continue
      const state = await boundState($, { key: s.key, repo: s.store.repo, rec })
      if (state === 'error') return logq($, sid, 'error', 'lead-watch-binding')
      if (state === 'bound') leads.push(rec)
    }
    owned.push({ key: s.key, store: { repo: s.store.repo, leads } })
  }
  const cur = await sha($, c.leadWatchText(owned, sid, g.pins))
  if (epochOf(sid) !== ep || grants.get(sid)?.level !== 'conductor') return
  const w = watch.get(sid)
  if (!w) return void watch.set(sid, { kind: 'leads', cur, told: cur, seen: cur })
  if (!own && (ownWriting.has(sid) || (ownGen.get(sid) ?? 0) !== gen)) return
  w.cur = cur
}
// A lead's own call and write look at what moves for it: the store file for a lead, the owned leads for a conductor.
export async function watchLook($: any, sid: string, own = false) {
  if (grants.get(sid)?.level === 'conductor') await leadWatchLook($, sid, own)
  else await watchPoll($, sid)
}
// The lead's own write is not news to it, unless something else changed before it.
async function watchOwn($: any, sid: string) {
  const w = watch.get(sid)
  if (!w) return
  // Taken before the poll: a name fill in it rebases told and seen, and the rebased values no longer equal what was there before this write.
  const { cur: was, told, seen } = w
  await watchLook($, sid, true)
  if (was === told) w.told = w.cur
  if (was === seen) w.seen = w.cur
}

export async function ownWrite<T>($: any, sid: string, fn: () => Promise<T>): Promise<T> {
  ownWriting.set(sid, (ownWriting.get(sid) ?? 0) + 1)
  ownGen.set(sid, (ownGen.get(sid) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    await watchOwn($, sid).catch(() => undefined)
    // A look that began meanwhile and ends after this write read the state before it: it is dropped (leadWatchLook).
    ownGen.set(sid, (ownGen.get(sid) ?? 0) + 1)
    countDown(ownWriting, sid)
  }
}
export async function watchTick($: any, sid: string) {
  // A check-in runs beside the tick; one that went out during this step's reads wins the moment.
  const submitsAt = mem.submits
  if (ownWriting.has(sid)) return
  // After a compaction the resume text goes out from the tick: a notice must not take the idle moment before it.
  if (((await getRequest($)).value as Request | null | undefined)?.phase === 'compacted') return
  await watchPoll($, sid)
  const w = watch.get(sid)
  if (!w || w.cur === w.told) return
  const now = await $.clock.now()
  const times = laneNotices.get(sid) ?? []
  // A change over the hourly cap stays owed (told is not moved): it goes out on a later tick, once the hour has a free slot. It is logged once per
  // capped stretch, whatever else the tick logs, and the stretch ends when a notice goes out.
  if (!c.noticeAllowed(times, now, c.LANES_NOTICES_PER_HOUR)) {
    if (cappedLogged.has(sid)) return
    cappedLogged.add(sid)
    return log($, sid, 'notice-capped', w.kind === 'leads' ? 'leads-changed' : 'lanes-changed')
  }
  if ((await idleCheck($, sid)) !== undefined) return
  if (mem.submits !== submitsAt) return
  const before = w.told
  const seenBefore = w.seen
  // The notice is the telling: seen moves with told, so the lane_list the lead makes in answer carries no footer for the same change.
  w.told = w.seen = w.cur
  cappedLogged.delete(sid)
  laneNotices.set(sid, c.pushRecent(times, now))
  // A notice that did not go out is still owed: told and seen go back (unless something moved them meanwhile).
  await submitOwn($, w.kind === 'leads' ? c.LEADS_CHANGED_TEXT : c.LANES_CHANGED_TEXT, false).catch(async () => {
    turnKind.delete(sid)
    if (w.told === w.cur) w.told = before
    if (w.seen === w.cur) w.seen = seenBefore
    await log($, sid, 'notice-failed')
  })
}

const MANAGER_SEEN_EVERY_MS = 60_000
async function managerSeenTick($: any, sid: string, stamp: { at: number; live: boolean; conductors?: string[] }) {
  let live = false
  let conductors: string[] = []
  try {
    const rows = await registryEntries($)
    live = rows !== undefined && (await managerTrusted($, rows, sid))
    const o = rows === undefined ? undefined : await ownOwner($, sid, rows)
    conductors = typeof o === 'object' ? [o.name ?? ''] : []
  } catch {
    await logq($, sid, 'error', 'manager-seen')
  }
  if (managerSeen.get(sid) === stamp) managerSeen.set(sid, { at: stamp.at, live, conductors })
}
export async function managerSeenStep($: any, sid: string) {
  if (managerSeenBusy.has(sid)) return
  const now = await $.clock.now()
  const last = managerSeen.get(sid)
  if (managerSeenBusy.has(sid) || (last !== undefined && !c.dueEvery(last.at, now, MANAGER_SEEN_EVERY_MS))) return
  // The conductors last seen stay served while the new look runs, as live does.
  const stamp = { at: now, live: last?.live ?? false, conductors: last?.conductors }
  managerSeen.set(sid, stamp)
  const token = {}
  managerSeenBusy.set(sid, token)
  const failed = async (reason: string) => {
    if (managerSeen.get(sid) === stamp) managerSeen.set(sid, { at: now, live: false })
    await logq($, sid, 'error', reason)
  }
  void withTimeout($, managerSeenTick($, sid, stamp), ACTION_TIMEOUT_MS)
    .then((r) => (r === 'timeout' ? failed('manager-seen-timeout') : undefined), () => failed('manager-seen'))
    .catch(() => undefined)
    .finally(() => {
      if (managerSeenBusy.get(sid) === token) managerSeenBusy.delete(sid)
    })
}

export async function managerTools($: any, sid: string) {
  if (managerDeclared.has(sid)) return
  const lane = { type: 'object', properties: { lane: { type: 'string' } }, required: ['lane'] }
  const lead = { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] }
  const tools: [string, string, unknown][] = [
    ['lane_list', 'List every lane on this Mac, as one table (a plain header line, then one row per lane with its lead, repo folder name, session and waiting columns; a lead no live session carries is marked not live): each lane, its folder when it is outside the repo root, whether a live session carries its name or it is parked, and how many minutes it has waited on a prompt.', { type: 'object', properties: {} }],
    ['lane_resume', "Cue a lane's session to resume from its own notes. The session applies its own limits. lane: the lane name.", lane],
    ['lane_compact', "Ask a lane's session to compact: at once if it asked for that with request_compact on-cue, otherwise it orders the lane to compact (it asks on-cue, whatever its context size, and compacts at the end of its turn). lane: the lane name, or the name of a lead (then it works as lead_compact, the person's dialog included).", lane],
    ['lane_terminate', "Stop a lane's session with SIGTERM, whatever it is doing. Every stop asks the person: they confirm in a dialog that names the lane, its repo, the session and the pid. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and report stay). A lane with no live session is removed directly. lane: the lane name.", lane],
    ['lane_retire', "Stop a lane's session once it confirms it can end: idle, empty prompt box, no background agents or shells, and its report signed done. Every stop asks the person: they confirm in a dialog first, then the lane must confirm. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and signed report stay). A lane with no live session is removed directly, with no signed report. Retire is final. lane: the lane name.", lane],
    ['lead_resume', `Cue a lead's session to resume from its own notes: it gets one fixed turn and continues only work already authorised. Every call asks the person first: they confirm in a dialog that names the lead, its repo and its session. The lead must be idle with an empty prompt box, and takes at most ${c.RESUME_PER_HOUR} resumes an hour. lead: the lead's name.`, lead],
    ['lead_compact', `Ask a lead's session to compact. Every call asks the person first, in a dialog that names the lead, its repo and its session. The lead compacts at once if it asked for that with request_compact on-cue; with no request of its own it is ordered to compact only while its conductor is live (it asks on-cue, whatever its context size), and otherwise refuses no-request. lead: the lead's name.`, lead],
    ['lead_park', `Park a lead: its session stops and its record is marked parked, so lead_unpark can reopen the same conversation within ${c.UNPARK_MAX_MS / 86_400_000} days. Every call asks the person first, in a dialog that names the lead, its repo and its session. The lead must be idle with an empty prompt box and no background agents or shells, no live lane may name it, and the lead confirms it can stop. The call waits up to 40 seconds for the idle time. lead: the lead's name.`, lead],
    ['lead_unpark', `Reopen a parked lead's conversation in a new panel, as the lead, within ${c.UNPARK_MAX_MS / 86_400_000} days of its park. Every call asks the person first, in a dialog that names the lead, its repo and its session. Needs the panels extension 1.4.0 or later. lead: the lead's name.`, lead],
    ['lead_retire', "Stop a lead's session once it confirms it can end: idle, empty prompt box, no background agents or shells, and its report signed done. Refused while any lane record names the lead (retire or remove its lanes first). Every call asks the person first, in a dialog that names the lead, its repo and its session; then the lead must confirm. The call waits up to 40 seconds for the idle time. Once the session has stopped, the lead's record is deleted (its .archive folder and report stay). A lead record no live session carries is removed directly, after the dialog. Retire is final. lead: the lead's name.", lead],
    ['lead_terminate', "Stop a lead's session with SIGTERM, whatever it is doing. Every stop asks the person: they confirm in a dialog that names the lead, its repo, the session, the pid and how many live lanes name it. Once the session has stopped, the lead's record is deleted, or kept with no session while any lane names the lead (then lead_retire removes it once its lanes are gone). lead: the lead's name.", lead],
  ]
  for (const [name, description, inputSchema] of tools) await $.tool.register({ name, description, inputSchema })
  await promptToolsRegister($)
  managerDeclared.add(sid)
}

export async function cfgGet($: any, sid: string, force = false): Promise<c.Config> {
  const now = await $.clock.now()
  if (!force && !c.dueEvery(mem.cfgReadAt, now, c.CONFIG_READ_MS)) return mem.cfg
  mem.cfgReadAt = now
  try {
    const raw = await withTimeout($, (async () => $.store.get(c.CONFIG_KEY))(), c.ENGINE_CALL_TIMEOUT_MS)
    if (raw === 'timeout') throw new Error('timeout')
    const parsed = c.parseConfig(raw)
    mem.cfg = parsed.cfg
    for (const f of parsed.invalid) {
      if (cfgInvalidLogged.has(f)) continue
      cfgInvalidLogged.add(f)
      await logq($, sid, 'config-invalid', f)
    }
  } catch {
    await logq($, sid, 'error', 'config-read')
  }
  return mem.cfg
}

// The switch read for a power the person can turn off: a forced read that says undefined when the store did not answer, so the caller refuses instead of using the cache.
export async function cfgReadStrict($: any, sid: string): Promise<c.Config | undefined> {
  try {
    const raw = await withTimeout($, (async () => $.store.get(c.CONFIG_KEY))(), c.ENGINE_CALL_TIMEOUT_MS)
    if (raw === 'timeout') throw new Error('timeout')
    mem.cfg = c.parseConfig(raw).cfg
    mem.cfgReadAt = await $.clock.now()
    return mem.cfg
  } catch {
    await logq($, sid, 'error', 'config-read')
    return undefined
  }
}

export async function reservedGet($: any, sid: string, force = false): Promise<readonly string[]> {
  const now = await $.clock.now()
  if (!force && !c.dueEvery(mem.reservedReadAt, now, c.CONFIG_READ_MS)) return c.localReservedNames()
  const gen = mem.reservedGen
  try {
    const raw = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS)
    if (raw === 'timeout') throw new Error('timeout')
    if (gen === mem.reservedGen) {
      c.setLocalReserved(c.parseReserved(raw))
      mem.reservedReadAt = now
    }
  } catch {
    await logq($, sid, 'error', 'reserve-read')
  }
  return c.localReservedNames()
}

// Every other session's live conductor file that passes presenceCheck, with its registry name (c.laneLeadOf) or none; display only. A file that fails the
// check gives no box; a leads folder that cannot be read is 'error' (the table is drawn without the Conductor column).
export async function conductorsLive($: any, live: RegRow[], except: string): Promise<c.ConductorView[] | 'error'> {
  const d = await presenceNames($)
  if (d === 'none') return []
  if (d === 'error') return 'error'
  const rows = live.map((r) => r.j)
  const out: c.ConductorView[] = []
  for (const s of d.names) {
    if (s === except) continue
    const f = await presenceCheck($, d.p, live, s, (x) => x.level === 'conductor')
    if (typeof f === 'string' || f.level !== 'conductor') continue
    const name = c.laneLeadOf(rows, s)?.name
    out.push({ ...(name ? { name } : {}), repos: f.repos, sid: s })
  }
  return out
}

// Display only: the live leads a conductor (the leads it owns, in the repos it lists) or the manager (every repo) reaches, each with its registry name, so a lead with no lanes is listed.
// Each presence file passes leadFileOk, the checks every lead lookup uses (fresh, registry row, start time, claude process, repo a git root); a lead without a
// usable name is left out (no lane can name it either). A lead's own list never asks. Any read that fails leaves the leads out, as for a lead that is gone.
export async function leadsInReach($: any, live: RegRow[], g: c.Grant): Promise<c.LiveLead[]> {
  if (g.level === 'lead') return []
  const rows = live.map((r) => r.j)
  const out: c.LiveLead[] = []
  for (const lf of await leadsFor($, live, undefined, undefined, undefined, g.level === 'manager' ? undefined : (r) => g.pins.includes(r))) {
    const name = c.leadNameOf(rows, lf.sid)
    const row = live.find((r) => r.j.sessionId === lf.sid)
    if (name === undefined || (g.level === 'conductor' && !(g.owns ?? []).some((o) => o.repo === lf.repo && o.sid === lf.sid))) continue
    out.push({ name, repo: lf.repo, sid: lf.sid, ...(row ? c.leadStateOf(regEntry(row)) : {}) })
  }
  return out
}

// ---- lead check-ins and the shared attention notice ----
const LEADLESS_KEEP_MS = c.CHECKIN_EVERY_MS + 10_000

// A lead's observation is due once a minute; the stamp is taken here, so a step that fails or times out waits for the next minute.
export async function checkinDue($: any, sid: string): Promise<boolean> {
  // The manager too, over the lanes no live lead reaches; a conductor over the leads it owns (conductorCheckin).
  if (!grants.has(sid)) return false
  const now = await $.clock.now()
  const last = obsAt.get(sid)
  if (!c.dueEvery(last, now, c.CHECKIN_EVERY_MS)) return false
  obsAt.set(sid, now)
  // The last step has not settled (an engine read that hangs): no new one; logged once per stall (the log keeps one line per event and reason).
  if (checkinBusy.has(sid)) {
    await logq($, sid, 'checkin-stalled')
    return false
  }
  return true
}
// The told set keeps only conditions that still hold: one that cleared and comes back has a new since. Returns the items not told yet.
function owedItems(sid: string, items: c.AttentionItem[]): { told: Set<string>; owed: c.AttentionItem[] } {
  const told = attnTold.get(sid) ?? new Set<string>()
  attnTold.set(sid, told)
  const keys = new Set(items.map(c.checkinKey))
  for (const k of told) if (!keys.has(k)) told.delete(k)
  return { told, owed: items.filter((i) => !told.has(c.checkinKey(i))) }
}
// The turn end a check-in counts the lead's idle time from: a done notice's own turn does not restart it (c.idleTurnEnd).
function idleEnd(sid: string, turnEnd: unknown): unknown {
  if (typeof turnEnd !== 'number') return turnEnd
  const r = c.idleTurnEnd(turnEnd, doneHold.get(sid))
  if (r.hold) doneHold.set(sid, r.hold)
  else doneHold.delete(sid)
  return r.at
}
// The timing gates of a check-in: on in the config, not paused, no wake in the last 30 minutes ('off' otherwise). 'all' once the session has been idle for 20
// minutes; before that 'prompt': only a waiting prompt is due (c.checkinDueItems).
async function checkinGates($: any, sid: string, now: number): Promise<'off' | 'prompt' | 'all'> {
  if (!(await cfgGet($, sid)).checkin) return 'off'
  const pause = (await getCheckinPause($)).value
  if (typeof pause === 'number' && pause > now) return 'off'
  if (mem.wokeAt !== undefined && now - mem.wokeAt < c.CHECKIN_WAKE_MS) return 'off'
  const turnEnd = idleEnd(sid, (await getTurnEnd($)).value)
  return typeof turnEnd === 'number' && now - Math.max(turnEnd, lastSubmitAt.get(sid) ?? 0) >= c.CHECKIN_IDLE_MS ? 'all' : 'prompt'
}
// The waiting prompts among the items that are due: left for the mid-turn hook (a busy session gets no idle submit).
function promptsMid(sid: string, now: number, due: c.AttentionItem[], render: (items: c.AttentionItem[]) => string | undefined, label: string) {
  const prompts = due.filter((i) => i.code === 'prompt')
  if (prompts.length === 0) attnMid.delete(sid)
  else attnMid.set(sid, { at: now, items: prompts, render, label })
}
// The person's toast, one per wait: for every waiting prompt this session would be told of, whatever the timing gates say (the switch, a pause, a wake, a
// busy session), so it is the one alert no gate holds back. all: every condition that holds now; a toasted key whose condition cleared is forgotten.
function promptToast($: any, sid: string, prompts: c.AttentionItem[], all: c.AttentionItem[], what: 'Lane' | 'Lead') {
  const toasted = attnToasted.get(sid) ?? new Set<string>()
  attnToasted.set(sid, toasted)
  const keys = new Set(all.map(c.checkinKey))
  for (const k of toasted) if (!keys.has(k)) toasted.delete(k)
  const fresh = prompts.filter((i) => i.code === 'prompt' && !toasted.has(c.checkinKey(i)))
  const text = c.promptWaitingToast(what, fresh.map((i) => i.lane))
  for (const i of fresh) toasted.add(c.checkinKey(i))
  if (text !== undefined) toast($, text)
}
export async function checkinTick($: any, sid: string, submitsAtStart: number) {
  if (grants.get(sid)?.level === 'conductor') return conductorCheckin($, sid, submitsAtStart)
  const now = await $.clock.now()
  const ep = epochOf(sid)
  const base = await leadCore($, sid)
  // A lead that had a name and has no usable one now (a twin row, a rename, a reserved name) sees only legacy lanes for a while: no observation,
  // as for a failed read. A lead that never had a name (a lone lead may stay unnamed) is observed as usual.
  if ('err' in base || (base.g.level === 'lead' && base.g.name === '' && (grants.get(sid)?.name ?? '') !== '') || epochOf(sid) !== ep) return
  const entries = base.live.map(regEntry)
  const prev = laneObs.get(sid) ?? new Map<string, c.LaneObs>()
  // A repo's leads are kept LEADLESS_KEEP_MS across evaluations (leadlessSeen); a lead check that could not be made ('held': not clearly gone) counts as a live
  // lead of the repo. It serves the notice's reach below and the manager's leadless filter further down.
  const rows = base.live.map((r) => r.j)
  const byRepo = leadlessSeen.get(sid) ?? new Map<string, { at: number; leads: c.LeadFile[] | 'held' }>()
  leadlessSeen.set(sid, byRepo)
  const repoLeads = async (repo: string) => {
    let seen = byRepo.get(repo)
    if (!seen || now < seen.at || now - seen.at > LEADLESS_KEEP_MS) {
      const errs = { error: false }
      const leads = await leadsFor($, base.live, repo, repo, errs).catch(() => undefined)
      byRepo.set(repo, (seen = { at: now, leads: errs.error || leads === undefined ? 'held' : leads }))
    }
    return seen.leads
  }
  // Parked lanes are skipped: someone stopped them on purpose. A lead is told of its own lanes and legacy ones; a lane of another lead (named by its session id)
  // only once that lead is not live (c.noticeReach); its quiet and gone times then start from that first look.
  const obs = new Map<string, c.LaneObs>()
  for (const l of base.lanes) {
    if (l.parked !== undefined || !c.inReach(base.g, l)) continue
    if (base.g.level === 'lead' && c.laneLead(l, { name: base.g.name, sid }) === 'other') {
      const leads = l.repo ? await repoLeads(l.repo) : 'held'
      if (!c.noticeReach(base.g, l, sid, leads === 'held' || leads.some((x) => x.sid === c.laneLeadSid(l)))) {
        // A lead check that could not be made keeps what was seen of the lane: its quiet clock and told key survive a transient read error.
        const kept = leads === 'held' ? prev.get(l.name) : undefined
        if (kept) obs.set(l.name, kept)
        continue
      }
    }
    obs.set(l.name, c.observeLane(prev.get(l.name), l, entries, sid, now))
  }
  // The repo reads above wait: an off or a re-grant meanwhile has cleared this grant's memory, and the observations are not written back over it.
  if (epochOf(sid) !== ep) return
  laneObs.set(sid, obs)
  const items = c.checkinItems(obs, now)
  const { told, owed } = owedItems(sid, items)
  const gate = owed.length === 0 ? 'off' : await checkinGates($, sid, now)
  const due = gate === 'off' ? [] : c.checkinDueItems(owed, gate === 'all')
  // The manager is told only of lanes no live lead reaches, by leadHere's rule (a lane naming its lead: a live
  // lead of its repo with that registry name; a legacy lane: any live lead of its repo). The leads of a repo are read at most once per evaluation. A lane a lead
  // reaches is left untold, so it is told once its lead is gone. The filter runs right after the timing gates, before the notice's own gate
  // reads, and a manager left with nothing owed stops here.
  // A 'held' repo counts as having a live lead, so no notice. A prompt that has waited CHECKIN_PROMPT_MANAGER_MS is the manager's too, live lead or not: the
  // lead was told at CHECKIN_PROMPT_MS and the lane still waits.
  const leadless = async (items: c.AttentionItem[]) => {
    const out: c.AttentionItem[] = []
    for (const i of items) {
      if (c.promptWaitedLong(i, now)) {
        out.push(i)
        continue
      }
      const l = base.lanes.find((x) => x.name === i.lane)
      if (!l?.repo) continue
      const leads = await repoLeads(l.repo)
      if (leads !== 'held' && !(l.leadName !== undefined ? leads.some((x) => c.leadNameOf(rows, x.sid) === l.leadName) : leads.length > 0)) out.push(i)
    }
    return out
  }
  const mgr = base.g.level === 'manager'
  const mine = mgr ? await leadless(due) : due
  const prompts = items.filter((i) => i.code === 'prompt')
  const toastFor = mgr ? await leadless(prompts) : prompts
  // A turn that goes out carries every owed item, not only the due ones: a prompt-only turn would start the session's 20 idle minutes over and hold the
  // others back.
  const send = mine.length === 0 ? [] : mgr ? await leadless(owed) : owed
  // The repo reads of the filter wait: an off or a re-grant meanwhile has cleared this grant's memory.
  if (epochOf(sid) !== ep) return
  promptToast($, sid, toastFor, items, 'Lane')
  promptsMid(sid, now, mine, c.checkinText, 'checkin')
  if (send.length === 0) return
  // Signed done drops gone and quiet. Read only once the notice's own gates hold; quiet by the live session's id, gone by the record's.
  const signed = async (items: c.AttentionItem[]) => {
    const send: c.AttentionItem[] = []
    for (const i of items) {
      const l = base.lanes.find((x) => x.name === i.lane)
      if (i.code !== 'prompt' && l) {
        const r = await readReport($, l).catch(() => ({ no: 'report-read' }))
        // A lane signed done is told as done: its report is not read again while the condition holds.
        if (!('no' in r) && c.reportSigned(r.text, i.code === 'quiet' ? (obs.get(i.lane)?.sid ?? '') : l.sid)) {
          told.add(c.checkinKey(i))
          continue
        }
      }
      send.push(i)
    }
    return send
  }
  await attentionNotice($, sid, send, submitsAtStart, ep, signed)
}

// A conductor's check-in, over the leads it owns: a record of a repo in its reach that names it, whose lead is bound to it, that has a session and is not parked.
// Gone, a prompt waiting and quiet are the lane check-in's observations of the lead's own session; quiet only counts once no lane of the lead is live (c.observeLead).
// The conductor hears nothing of lanes here: a lane whose lead is gone is told to the manager.
async function conductorCheckin($: any, sid: string, submitsAtStart: number) {
  const now = await $.clock.now()
  const ep = epochOf(sid)
  const base = await leadCore($, sid)
  if ('err' in base || base.g.level !== 'conductor' || epochOf(sid) !== ep) return
  const stores = await loadLeadRecords($)
  // A read that failed is no observation at all, never "all gone".
  if (typeof stores === 'string') return
  const entries = base.live.map(regEntry)
  const prev = leadObs.get(sid) ?? new Map<string, c.LaneObs>()
  const obs = new Map<string, c.LaneObs>()
  const repos = new Map<string, { repo: string; sid: string }>()
  for (const s of stores) {
    if (!base.g.pins.includes(s.store.repo)) continue
    for (const rec of s.store.leads) {
      if (rec.conductorSid !== sid || rec.sid === undefined || rec.parked !== undefined) continue
      const state = await boundState($, { key: s.key, repo: s.store.repo, rec })
      if (state === 'unbound') continue
      // A binding that could not be read is no observation of this lead: what was seen of it last stands, so its clocks and told marks are kept.
      const last = prev.get(rec.name)
      if (state === 'error') {
        if (last) obs.set(rec.name, last)
        repos.set(rec.name, { repo: s.store.repo, sid: rec.sid })
        continue
      }
      const liveLane = base.lanes.some((l) => l.repo === s.store.repo && c.laneLead(l, { name: rec.name, sid: rec.sid ?? '' }) === 'me' && c.laneSession(entries, l, sid).ok)
      obs.set(rec.name, c.observeLead(prev.get(rec.name), rec, entries, now, liveLane))
      repos.set(rec.name, { repo: s.store.repo, sid: rec.sid })
    }
  }
  // The reads above wait: an off or a re-grant meanwhile has cleared this grant's memory, and the observations are not written back over it.
  if (epochOf(sid) !== ep) return
  leadObs.set(sid, obs)
  const items = c.checkinItems(obs, now)
  const { owed: all } = owedItems(sid, items)
  const gate = all.length === 0 ? 'off' : await checkinGates($, sid, now)
  const due = gate === 'off' ? [] : c.checkinDueItems(all, gate === 'all')
  // The gate reads wait: an off or a re-grant meanwhile has cleared this grant's memory.
  if (epochOf(sid) !== ep) return
  promptToast($, sid, items, items, 'Lead')
  promptsMid(sid, now, due, c.leadCheckinText, 'lead-checkin')
  if (due.length === 0) return
  // The turn carries every owed item, as a lead's does.
  const owed = all
  // Signed done drops gone and quiet, as for a lane: the lead's report (.archive/<NAME>/REPORT.md of its repo) ends in `status: done <sid>`. Read only once the notice's
  // own gates hold; quiet by the live session's id, gone by the record's.
  const told = attnTold.get(sid)
  const signed = async (items: c.AttentionItem[]) => {
    const send: c.AttentionItem[] = []
    for (const i of items) {
      const at = repos.get(i.lane)
      if (i.code !== 'prompt' && at) {
        const r = await readReport($, { name: i.lane, repo: at.repo, folder: at.repo, brief: '' }).catch(() => ({ no: 'report-read' }))
        if (!('no' in r) && c.reportSigned(r.text, i.code === 'quiet' ? (obs.get(i.lane)?.sid ?? '') : at.sid)) {
          told?.add(c.checkinKey(i))
          continue
        }
      }
      send.push(i)
    }
    return send
  }
  await attentionNotice($, sid, owed, submitsAtStart, ep, signed, { render: c.leadCheckinText, label: 'lead-checkin' })
}

// ---- a lane's end: signed done to the lead, gone unsigned to the person ----
// Runs after a lead's check-in step and only reads what it observed (laneObs); a check-in step that observed nothing leaves it nothing to do. The report of
// a lane seen idle is read once per status time, that of a lane gone (and seen live under this grant) once per goneSince; with nothing new to read and nothing
// owed, no file is touched. A signature is told to the lead once per lane, session and signature, through the attention notice's gates, when check-ins are on
// and not paused and the lead has been idle c.LANE_DONE_IDLE_MS. The notice has its own hourly budget (c.LANE_DONE_PER_HOUR), and its turn does not restart
// the idle time a check-in waits for. A lane gone with no signed report is toasted once (not within 30 minutes of a wake: the lanes slept too); the wake
// does not hold the done notice. The manager and a conductor get neither.
export async function laneEndTick($: any, sid: string, submitsAtStart: number) {
  if (grants.get(sid)?.level !== 'lead') return
  // The end of the notice's own turn is learned here, at every step (once a minute), so a turn that ends a minute or more after it is not taken for it.
  if (doneHold.has(sid)) idleEnd(sid, (await getTurnEnd($)).value)
  const obs = laneObs.get(sid)
  if (!obs) return
  const ep = epochOf(sid)
  let kept = laneEnds.get(sid)
  if (kept?.ep !== ep) laneEnds.set(sid, (kept = { ep, by: new Map<string, c.LaneEnd>(), told: new Set<string>() }))
  // The check-in step writes a new map at each observation: the same map means it observed nothing this minute (a failed read), so nothing is new.
  if (kept.seen === obs) return
  kept.seen = obs
  const { by: ends, told } = kept
  for (const k of [...ends.keys()]) if (!obs.has(k)) ends.delete(k)
  const now = await $.clock.now()
  if (!(await cfgGet($, sid)).checkin) return
  const pause = (await getCheckinPause($)).value
  if (typeof pause === 'number' && pause > now) return
  const awake = mem.wokeAt === undefined || now - mem.wokeAt >= c.CHECKIN_WAKE_MS
  const reads = c.laneEndReads(obs, ends).filter((r) => r.kind === 'idle' || awake)
  if (reads.length > 0) {
    const base = await leadCore($, sid)
    if ('err' in base) return
    const read: { r: (typeof reads)[number]; sig: string | undefined; failed: boolean }[] = []
    for (const r of reads) {
      const l = base.lanes.find((x) => x.name === r.lane)
      // A record parked or cleared of its session since the observation was stopped on purpose: nothing ended by itself.
      if (!l || (r.kind === 'gone' && (l.sid === undefined || l.parked !== undefined))) continue
      // Idle by the live session's id, gone by the record's, as the check-in reads a signature.
      const signer = r.kind === 'idle' ? obs.get(r.lane)?.sid ?? '' : (l.sid as string)
      const rep: Awaited<ReturnType<typeof readReport>> = await readReport($, l).catch(() => ({ no: 'report-read' }))
      // No file at the path is a lane that has not signed; any other failed read says nothing of the report.
      read.push({ r, sig: !('no' in rep) && c.reportSigned(rep.text, signer) ? c.doneSig(signer, rep.size) : undefined, failed: 'no' in rep && rep.gone !== true })
    }
    // The reads wait: an off or a re-grant meanwhile ends this step, and nothing is kept or said for the old grant.
    if (epochOf(sid) !== ep || !grants.has(sid)) return
    const unsigned: string[] = []
    const unread: string[] = []
    for (const { r, sig, failed } of read) {
      const e = ends.get(r.lane) ?? {}
      // A failed read is tried again at the next observation, c.LANE_END_READ_TRIES times in all for that status time or exit; then the report counts as unread.
      const n = c.laneEndTries(e, r.kind, r.at)
      if (failed && n < c.LANE_END_READ_TRIES) {
        ends.set(r.lane, { ...e, tried: { kind: r.kind, at: r.at, n } })
        continue
      }
      ends.set(r.lane, { ...(r.kind === 'idle' ? { at: r.at, gone: e.gone } : { at: e.at, gone: r.at }), sig })
      if (r.kind === 'gone' && sig === undefined) (failed ? unread : unsigned).push(r.lane)
    }
    for (const [names, bad] of [[unsigned, false], [unread, true]] as const) {
      const text = c.laneGoneToast(names, bad)
      if (text === undefined) continue
      toast($, text)
      await logq($, sid, 'lane-gone-toast', `${bad ? 'unread' : 'unsigned'}:${names.length}`)
    }
  }
  const owed = c.laneDoneItems(obs, ends, told)
  if (owed.length === 0) return
  const turnEnd = (await getTurnEnd($)).value
  if (typeof turnEnd !== 'number' || now - Math.max(turnEnd, lastSubmitAt.get(sid) ?? 0) < c.LANE_DONE_IDLE_MS) return
  // Since when the lead was idle for a check-in, before this notice: its own turn leaves that time as it was.
  const from = Math.max(c.idleTurnEnd(turnEnd, doneHold.get(sid)).at, lastSubmitAt.get(sid) ?? 0)
  const sigs = new Map(owed.map((i) => [i.lane, ends.get(i.lane)?.sig]))
  // A submit that timed out may never start a turn: it sets no hold, so the next turn to end is not taken for the notice's. A hold an earlier notice left stays.
  const sent = async (items: c.AttentionItem[], confirmed: boolean) => {
    for (const i of items) {
      const sig = sigs.get(i.lane)
      if (sig !== undefined) told.add(c.doneKey(i.lane, sig))
    }
    if (confirmed) doneHold.set(sid, { from, prevEnd: turnEnd })
  }
  await attentionNotice($, sid, owed, submitsAtStart, ep, undefined, { render: c.doneText, label: 'lane-done', sent, budget: { times: doneNotices, capped: doneCapped, max: c.LANE_DONE_PER_HOUR } })
}

// ---- the deadline of an order ----
export async function orderDue($: any, sid: string): Promise<boolean> {
  if (!grants.has(sid) || !(orders.get(sid)?.size ?? 0) || orderBusy.has(sid)) return false
  const now = await $.clock.now()
  const last = orderChecked.get(sid)
  if (!c.dueEvery(last, now, c.CHECKIN_EVERY_MS)) return false
  orderChecked.set(sid, now)
  return true
}
export async function orderTick($: any, sid: string, submitsAtStart: number) {
  const mine = orders.get(sid)
  if (!mine) return
  const now = await $.clock.now()
  const ep = epochOf(sid)
  // A lane whose session is gone (stopped, retired) cannot comply: no notice. A registry that cannot be read is not "gone".
  const live = await registryEntries($)
  const owed: c.AttentionItem[] = []
  const leadsOwed = new Set<string>()
  for (const [toSid, o] of mine) {
    if (now < o.at || now - o.at > c.ORDER_STALE_MS || (live && !live.some((r) => r.j.sessionId === toSid))) mine.delete(toSid)
    else if (now - o.at >= c.ORDER_MS) {
      const stamp = await $.store.get(`${c.ORDER_PREFIX}${toSid}`).then((v: unknown) => v, () => 'error' as const)
      if (stamp === 'error') continue
      const at = (stamp as { at?: unknown } | null | undefined)?.at
      if (typeof at !== 'number') mine.delete(toSid)
      else {
        // A newer order of the lane (the orderer ordered again) restarts the 15 minutes.
        if (at > o.at) o.at = at
        if (now - o.at >= c.ORDER_MS) {
          owed.push({ lane: o.lane, code: 'ordered', since: o.at })
          if (o.kind === 'lead') leadsOwed.add(o.lane)
        }
      }
    }
  }
  if (owed.length === 0) return
  const told = attnTold.get(sid) ?? new Set<string>()
  attnTold.set(sid, told)
  const sent = async (items: c.AttentionItem[]) => {
    for (const i of items) {
      const hit = [...mine].find(([, o]) => o.lane === i.lane && o.at === i.since)
      if (!hit) continue
      mine.delete(hit[0])
      await $.store.delete(`${c.ORDER_PREFIX}${hit[0]}`).catch(() => undefined)
    }
  }
  // Lanes and leads get a notice each, in their own words; in the rare minute with both, the second waits for a later tick (one submit per tick).
  const lanes = owed.filter((i) => !leadsOwed.has(i.lane))
  const leads = owed.filter((i) => leadsOwed.has(i.lane))
  if (lanes.length > 0) await attentionNotice($, sid, lanes, submitsAtStart, ep, undefined, { render: (items) => c.orderText(items.map((i) => i.lane)), label: 'order-notice', sent })
  if (leads.length > 0) await attentionNotice($, sid, leads, submitsAtStart, ep, undefined, { render: (items) => c.orderLeadText(items.map((i) => i.lane)), label: 'order-notice', sent })
}

// The shared attention notice: the caller owns timing and pause, this owns the mechanical gates. One notice per key; the hourly cap is
// the lanes-changed notice's unless the caller brings its own budget (a notice over it stays owed, logged once per capped stretch); a submit that throws puts its items back, one that times out does not.
// filter: the caller's own last reads (the check-in's report signatures), run only once the gates hold.
async function attentionNotice($: any, sid: string, items: c.AttentionItem[], submitsAtStart: number, ep: number, filter?: (items: c.AttentionItem[]) => Promise<c.AttentionItem[]>, opts?: { render?: (items: c.AttentionItem[]) => string | undefined; label?: string; sent?: (items: c.AttentionItem[], confirmed: boolean) => Promise<void>; budget?: { times: Map<string, number[]>; capped: Set<string>; max: number } }) {
  const render = opts?.render ?? c.checkinText
  const told = attnTold.get(sid)
  if (!told) return
  const untold = (xs: c.AttentionItem[]) => xs.filter((i) => !told.has(c.checkinKey(i)))
  if (render(untold(items)) === undefined || dialogOpen.has(sid) || mem.submits !== submitsAtStart) return
  const sentAt = lastSubmitAt.get(sid)
  if ((await getRequest($)).value != null || (await getNudgeDue($)).value != null) return
  // The hourly cap: the lanes-changed notice's, or the caller's own budget (opts.budget), which then leaves the shared one untouched.
  const times = opts?.budget?.times ?? laneNotices
  const cappedSet = opts?.budget?.capped ?? attnCapped
  const capped = async () => {
    if (c.noticeAllowed(times.get(sid) ?? [], await $.clock.now(), opts?.budget?.max ?? c.LANES_NOTICES_PER_HOUR)) return false
    if (!cappedSet.has(sid)) {
      cappedSet.add(sid)
      await log($, sid, 'notice-capped', opts?.budget ? (opts.label ?? 'attention') : 'attention')
    }
    return true
  }
  if (await capped()) return
  if (await busyAgents($)) return
  const reg = regOnce($)
  if ((await idleCheck($, sid, reg)) !== undefined) return
  if (!(await personRow($, sid, reg))) return
  if ((await backgroundShells($, sid, reg)) !== undefined) return
  const kept = filter ? await filter(untold(items)) : items
  // The reads since the first checks take time: a draft, a prompt, a dialog, a request or nudge, another submit or a grant change meanwhile wins. The cap and
  // the told set are read again. Every read comes before the last guard, so nothing is awaited between it and the submit.
  if (await capped()) return
  const now = await $.clock.now()
  if (dialogOpen.has(sid) || (await getRequest($)).value != null || (await getNudgeDue($)).value != null) return
  if ((await idleCheck($, sid)) !== undefined) return
  const draft = (await $.prompt.read()).text
  if (draft !== '' || dialogOpen.has(sid) || mem.submits !== submitsAtStart || lastSubmitAt.get(sid) !== sentAt || !grants.has(sid) || epochOf(sid) !== ep) return
  const fresh = untold(kept)
  const text = render(fresh)
  if (text === undefined) return
  const keys = fresh.map(c.checkinKey)
  for (const k of keys) told.add(k)
  cappedSet.delete(sid)
  if (!opts?.budget) cappedLogged.delete(sid)
  times.set(sid, c.pushRecent(times.get(sid) ?? [], now))
  const sent = await withTimeout($, submitOwn($, text, false).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'failed') {
    turnKind.delete(sid)
    for (const k of keys) told.delete(k)
  }
  if (sent !== 'failed') await opts?.sent?.(fresh, sent === 'ok').catch(() => undefined)
  const codes = [...new Set(fresh.map((i) => i.code))].sort().join('+')
  const label = opts?.label ?? 'checkin'
  await log($, sid, sent === 'ok' ? label : sent === 'timeout' ? `${label}-unconfirmed` : `${label}-failed`, `${codes}:${fresh.length}`)
}

// The check-in in the middle of a turn (like promptMidTurnNotice): a busy lead, conductor or manager gets no idle submit, and a lane waiting on a prompt would wait
// until its turn ends. After a main-agent tool call the hook returns the fixed check-in text for the waiting prompts the last observation left owed (attnMid), as
// additionalContext beside the tool's result. It reads no file. Same told marks and hourly cap as the idle notice, so a wait is told once, by whichever path
// comes first. An observation older than two periods is not used (a stalled check-in step), the switch, the pause and the wake gate are read again here, and a
// compaction that is armed or waiting to resume keeps it owed.
export async function checkinMidTurn($: any, e: any): Promise<string | undefined> {
  if (typeof e?.agent_id === 'string' && e.agent_id !== '') return undefined
  const sid = await $.session.id()
  if (typeof sid !== 'string' || !c.SID_RE.test(sid) || !grants.has(sid)) return undefined
  const mid = attnMid.get(sid)
  const told = attnTold.get(sid)
  if (!mid || !told || !mid.items.some((i) => !told.has(c.checkinKey(i)))) return undefined
  try {
    if ((await getRequest($)).value != null) return undefined
    const now = await $.clock.now()
    if (now < mid.at || now - mid.at > 2 * c.CHECKIN_EVERY_MS) return undefined
    // A pause or the switch turned off since the observation: nothing is told.
    if ((await checkinGates($, sid, now)) === 'off') return undefined
    if (!c.noticeAllowed(laneNotices.get(sid) ?? [], now, c.LANES_NOTICES_PER_HOUR)) {
      if (!attnCapped.has(sid)) {
        attnCapped.add(sid)
        await log($, sid, 'notice-capped', 'attention')
      }
      return undefined
    }
    // Nothing is awaited between this read of the marks and their change.
    if (attnMid.get(sid) !== mid || attnTold.get(sid) !== told) return undefined
    const fresh = mid.items.filter((i) => !told.has(c.checkinKey(i)))
    const text = mid.render(fresh)
    if (text === undefined) return undefined
    for (const i of fresh) told.add(c.checkinKey(i))
    attnMid.delete(sid)
    attnCapped.delete(sid)
    laneNotices.set(sid, c.pushRecent(laneNotices.get(sid) ?? [], now))
    await logq($, sid, mid.label, `prompt:${fresh.length} mid-turn`)
    return text
  } catch {
    await logq($, sid, 'error', 'mid-turn-checkin')
    return undefined
  }
}

// ---- the rename carry ----
// A lead that is renamed keeps the lanes its own session made or joined: once a lead's registry name (c.leadNameOf) differs from the one cached at its grant, the
// records of its repo that name its session id (c.leadOwns: `lead` of an attached record, `leadSid` of a made one) and its old name take the new name, in one store
// write under the lock. A record it cannot prove is its own (a lane made before records carried `leadSid`; a lead that restarted has another session id) is left
// as it is. A rename that
// leaves no usable name carries nothing and keeps the old name cached, so the next valid name still finds the records. An empty cached name is filled in the
// same way, so the lane-list watch (watchPoll) hears the name. Checked at most every RENAME_CHECK_MS.
const RENAME_CHECK_MS = 10_000

export async function leadRenameTick($: any, sid: string) {
  const g = grantOf(sid)
  const epoch = epochOf(sid)
  if (g?.level !== 'lead' || (g.name !== '' && g.pins.length !== 1)) return
  const now = await $.clock.now()
  const last = renameChecked.get(sid)
  if (!c.dueEvery(last, now, RENAME_CHECK_MS)) return
  renameChecked.set(sid, now)
  const live = await registryEntries($)
  if (!live) return
  const cur = c.leadNameOf(live.map((r) => r.j), sid)
  if (cur === undefined || cur === g.name) return
  // An empty cached name (the registry gave none at the grant: a timeout, or a session not yet named) takes the first usable name, with no lanes to carry.
  if (g.name === '') {
    if (grants.get(sid) === g) grants.set(sid, { ...g, name: cur })
    return
  }
  const old = g.name
  // A bound lead's record takes the new name first, in one write; the lanes follow only once it has moved. A name that is taken carries nothing: the lead stays
  // bound under the old name and the person is told once per pair. Any other failure is tried again at the next look.
  const moved = await ownerRename($, sid, cur)
  if (typeof moved === 'object') {
    await logq($, sid, 'error', `lead-rename-owner ${c.hasText(moved.no) ? moved.no : 'other'}`)
    if (moved.no === 'name-in-use' && renameRefused.get(sid) !== `${old}\n${cur}`) {
      renameRefused.set(sid, `${old}\n${cur}`)
      toast($, c.renameTakenToast(old, cur))
    }
    return
  }
  if (grantOf(sid)?.level !== 'lead' || epochOf(sid) !== epoch) return
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return
  const mine = lanes.filter((l) => l.src !== undefined && l.repo === g.pins[0] && c.leadOwns(l, sid) && l.leadName === old)
  if (mine.length > 0) {
    const r = await ownWrite($, sid, () => editLanes($, mine[0].src!, async (store) => {
      const rows = await registryEntries($)
      if (!rows) return { no: 'registry-unreadable' }
      // The last checks before the write: the name is still the one seen, and this is still the same grant.
      if (c.leadNameOf(rows.map((x) => x.j), sid) !== cur || grantOf(sid)?.level !== 'lead' || epochOf(sid) !== epoch) return { no: 'changed' }
      const own = (l: c.Store['lanes'][number]) => c.leadOwns(l, sid) && l.leadName === old
      if (!store.lanes.some(own)) return { skip: true }
      const t = c.storeText({ ...store, lanes: store.lanes.map((l) => (own(l) ? { ...l, leadName: cur } : l)) })
      if ('no' in t) return t
      return { text: t.text, landed: (s) => !!s && !s.lanes.some(own) }
    })).catch(() => ({ no: 'store-busy' }))
    if ('no' in r) {
      await log($, sid, 'error', `lead-rename-carry ${r.no}`)
      return
    }
    if (r.text !== '') await log($, sid, 'lead-rename-carried', String(mine.length))
  }
  if (grants.get(sid) === g) grants.set(sid, { ...g, name: cur })
}

// /callboard off: the pending restore and the saved grant go. Resolves false when the delete failed (the reply then says the manager may come back).
export async function managerForget($: any, sid: string): Promise<boolean> {
  managerRestorePending.delete(sid)
  try {
    await $.store.delete(`${c.MANAGER_HINT_PREFIX}${sid}`)
    return true
  } catch {
    await logq($, sid, 'error', 'manager-hint-delete')
    return false
  }
}
// A session whose saved manager grant is there when it starts is asked once whether to restore it, as the conductor's widened list is (conductorRestoreAsk): only
// in a person's session (a registry row of kind interactive: never a --bg worker), and only once the session is idle with an empty prompt box. A session that
// still holds the grant in memory (a compaction) is never asked. Manager: the usual grant with every usual check again after the yes (one per Mac, a reserved
// name, not a lane, lead or conductor). A saved grant that names the folder the session started in and was saved less than MANAGER.silentGraceMs ago
// (c.managerSilentOk, judged in managerCommand) is granted with no question and every one of those checks; any silent-only condition that fails asks as
// before. Cancel: the saved grant goes. No answer: it stays, nothing is restored, and the same question is asked again once the person has sent a prompt in
// this session (managerRestoreWake), a few times at most. A check that fails: logged, nothing restored, the saved grant stays; a failure that can clear by
// itself is tried again from the tick, each try the whole restore with its question and checks (c.managerRestoreStep holds the limits); once a try had to ask,
// every later try asks too. Every final end that
// is not the person's own (an off, a Cancel, a grant by hand) gets one toast. The tries count only the ticks before the registry shows the session's own row.
const MANAGER_RESTORE_TRIES = 15

// A final end found by the tick or the start: the entry goes, the log line, and the toast unless nobody is there to read it.
async function managerRestoreEnd($: any, sid: string, pend: MgrPending, why: string, tell = true) {
  if (managerRestorePending.get(sid) === pend) managerRestorePending.delete(sid)
  await log($, sid, 'manager-restore-rejected', why)
  if (tell) toast($, c.notRestoredToast('manager', why))
}
async function managerRestoreAsk($: any, me: string, pend: MgrPending) {
  let busy = false
  const seq = offSeq.get(me) ?? 0
  let code: string | undefined
  pend.asking = true
  pend.yes = false
  try {
    code = (await managerCommand($, me, 'prompt', pend.hint.name, async () => {
      busy = true
      return { text: '' }
      // A restore that once had to ask never comes back with no question on a later try: the saved grant is passed only until then.
    }, true, () => managerRestorePending.get(me) === pend, pend.asked ? undefined : pend.hint, pend)).code
  } catch {
    code = 'error'
    await logq($, me, 'manager-restore-rejected', 'error')
  } finally {
    pend.asking = false
  }
  // A question already open asks again at the next idle tick. A grant (this restore's, or the person's own meanwhile) has ended the restore.
  if (busy || grants.get(me)?.level === 'manager') return
  // An off typed meanwhile, or the person's own /callboard manager, is the person's end: nothing is tried or asked again.
  let step: c.RestoreStep = { next: 'end' }
  if ((offSeq.get(me) ?? 0) === seq && !pend.byHand) {
    // A failure after the yes is counted apart, whatever its code: each new try asks the person again, or grants and steps back again.
    const afterYes = pend.yes === true
    if (code === 'unanswered') pend.unanswered = (pend.unanswered ?? 0) + 1
    else if (afterYes) pend.afterYes = (pend.afterYes ?? 0) + 1
    else pend.fails = (pend.fails ?? 0) + 1
    step = c.managerRestoreStep(code, (afterYes ? pend.afterYes : pend.fails) ?? 0, pend.unanswered ?? 0, afterYes)
  }
  if (step.next === 'end') {
    if (managerRestorePending.get(me) === pend) managerRestorePending.delete(me)
  } else {
    // A try that granted and stepped back dropped the entry: it is put back for the next try.
    pend.waiting = step.next === 'wait'
    managerRestorePending.set(me, pend)
    if (step.next === 'retry') await log($, me, 'manager-restore-retry', code)
  }
  if (step.toast !== undefined) toast($, step.toast)
}
// A prompt that is not the mod's own reached this session (the person's, or a message another session sent: the hook cannot tell them apart): a restore
// question that got no answer is asked again at the next idle tick. The person's click in the dialog is still the only yes.
export function managerRestoreWake(sid: string) {
  const pend = managerRestorePending.get(sid)
  if (pend?.waiting) pend.waiting = false
}
export async function managerTick($: any, sid: string) {
  if (grants.get(sid)?.level === 'manager') {
    managerRestorePending.delete(sid)
    // Only once the grant's own save has set the mark: a grant still being confirmed (the presence file, the second-manager check) is saved by nobody else, so a step
    // back leaves no saved grant behind.
    const at = managerSavedAt.get(sid)
    if (at !== undefined && c.leadRefreshDue(at, await $.clock.now(), MANAGER.refreshMs)) await levelSave($, sid, MANAGER)
    return
  }
  const pend = managerRestorePending.get(sid)
  if (!pend || pend.asking || pend.waiting) return
  const row = await registryOf($, sid)
  if (managerRestorePending.get(sid) !== pend) return
  if (row === undefined && pend.tries++ < MANAGER_RESTORE_TRIES) return
  // A row of another kind (a --bg worker) has no person to tell; a row that never showed may have one.
  if (row?.kind !== 'interactive') return void (await managerRestoreEnd($, sid, pend, 'not-person', row === undefined))
  // A lane on its way back (a rebind still waiting, a lane hint, a store record naming this session) is not asked, as the conductor's restore (conductorRestoreTry).
  if (rebindPending.has(sid)) return
  const reject = (why: string) => managerRestoreEnd($, sid, pend, why)
  if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), await $.clock.now())?.lane) return void (await reject('lane-holder'))
  const lanes = await loadLanes($).catch(() => 'lanes-error')
  // A lane list that cannot be read is tried again at the next tick, within the same limit as a failed try.
  if (typeof lanes === 'string') {
    if (managerRestorePending.get(sid) !== pend) return
    pend.fails = (pend.fails ?? 0) + 1
    return pend.fails <= c.MANAGER_RESTORE_RETRIES ? undefined : void (await reject('lanes-error'))
  }
  if (lanes.some((l) => l.sid === sid)) return void (await reject('lane-holder'))
  if ((await idleCheck($, sid)) !== undefined) return
  if (managerRestorePending.get(sid) !== pend) return
  void managerRestoreAsk($, sid, pend).catch(logFail($, sid, 'manager-restore-ask'))
}

// ---- the conductor level ----
// The list file, read as a plain small file of the user's (group and other may read it, not write it), with one more try when a read failed or met a swap.
// absent: no .claude folder or no file. unsafe: .claude or the file is a link, has two links or is not the user's. bad: too big or not a list. error: a check or
// read that failed or kept changing.
type CondRead = { state: 'ok'; entries: string[]; text: string } | { state: 'absent' | 'unsafe' | 'bad' | 'error' }
async function readConductorFile($: any, home: string): Promise<CondRead> {
  const p = await where($)
  if (!p) return { state: 'error' }
  const d = await statR($, `${home}/.claude`)
  if (d === 'error') return { state: 'error' }
  if (d === 'absent') return { state: 'absent' }
  // Nor a .claude group or other may write.
  if (d.kind !== 'dir' || d.uid !== p.uid || (d.mode & 0o022) !== 0) return { state: 'unsafe' }
  const path = `${home}/${c.CONDUCTOR_FILE}`
  const f = await statR($, path)
  if (f === 'error') return { state: 'error' }
  if (f === 'absent') return { state: 'absent' }
  if (f.kind !== 'file' || f.uid !== p.uid || f.nlink !== 1 || (f.mode & 0o7022) !== 0) return { state: 'unsafe' }
  let r = await readSmallR($, path, p.uid, c.CONDUCTOR_FILE_MAX, true)
  if (r.state === 'changed' || r.state === 'failed') r = await readSmallR($, path, p.uid, c.CONDUCTOR_FILE_MAX, true)
  if (r.state === 'changed' || r.state === 'failed') return { state: 'error' }
  if (r.state !== 'ok') return { state: 'bad' }
  const entries = c.parseConductorFile(r.text)
  return entries ? { state: 'ok', entries, text: r.text } : { state: 'bad' }
}

// Each entry to its real path: it must be its own real path, not too broad, not the conductor repo or inside or around it, and a git root. An entry that fails is
// left out and named with why; 'error' is a check that could not be made (it is left out of reach now, but no ratchet drops it).
export type CondOut = { entry: string; why: 'not-found' | 'not-real' | 'not-git' | 'broad' | 'nested' | 'error' | 'unapproved' }
async function resolveConductorList($: any, home: string, entries: string[]): Promise<{ ok: string[]; out: CondOut[] }> {
  const p = await where($)
  const ok: string[] = []
  const out: CondOut[] = []
  for (const entry of entries) {
    const path = c.entryPath(home, entry)
    if (!p) {
      out.push({ entry, why: 'error' })
      continue
    }
    if (c.pinRefusal(path, homeOf(p)) !== undefined) {
      out.push({ entry, why: 'broad' })
      continue
    }
    if (path === home || c.within(home, path) || c.within(path, home)) {
      out.push({ entry, why: 'nested' })
      continue
    }
    const r = await realR($, path)
    if (r === 'error') out.push({ entry, why: 'error' })
    else if (r === 'absent') out.push({ entry, why: 'not-found' })
    else if (r.path !== path) out.push({ entry, why: 'not-real' })
    else {
      const g = await gitRoot($, path)
      // Two entries naming one repo (../app and its absolute path, written by hand) reach it once.
      if (g === 'yes') ok.includes(path) ? undefined : ok.push(path)
      else out.push({ entry, why: g === 'error' ? 'error' : 'not-git' })
    }
  }
  return { ok, out }
}

// The conductor repo: the session's start folder, a clean path that is not too broad, its own real path and a git root.
export async function conductorHere($: any): Promise<{ home: string } | { no: string }> {
  const p = await where($)
  if (!p) return { no: 'conductor-here' }
  let home: unknown
  try {
    home = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return { no: 'conductor-here' }
  }
  if (typeof home !== 'string' || !c.isCleanAbs(home) || c.pinRefusal(home, homeOf(p)) !== undefined) return { no: 'conductor-here' }
  const r = await realR($, home)
  if (r === 'error' || r === 'absent' || r.path !== home || (await gitRoot($, home)) !== 'yes') return { no: 'conductor-here' }
  return { home }
}

// A conductor repo is a repo of its own: no lane store with a lane, and no live lead whose repo holds it (a lead on a parent repo included).
// A check that cannot be made refuses (conductor-repo-check).
async function conductorRepoInUse($: any, home: string): Promise<string | undefined> {
  const p = await where($)
  if (!p) return 'conductor-repo-check'
  const st = await readStoreFile($, await storePath($, await sha($, home)), p.uid).catch(() => ({ state: 'bad' as const, text: '' }))
  if (st.state === 'bad') return 'conductor-repo-check'
  if (st.state === 'ok') {
    const parsed = c.parseStore(st.text)
    if (!parsed.ok || parsed.store.lanes.length > 0) return 'conductor-repo-in-use'
  }
  const live = await registryEntries($)
  if (!live) return 'registry-unreadable'
  const errs = { error: false }
  const leads = await leadsFor($, live, home, undefined, errs)
  if (leads.length > 0) return 'conductor-repo-in-use'
  return errs.error ? 'conductor-repo-check' : undefined
}

// The list file writer, beside writeBrief: one write at a time per conductor repo in this process; .claude must be a real folder of the user's (made 0755 when
// absent); an existing list file is replaced only while it is a plain file of the user's with one link; the file is read, the new list computed, the file read
// again (a change meanwhile refuses conductor-file-changed), then a temp file is renamed into place.
export async function writeConductorFile($: any, home: string, fn: (entries: string[]) => string[] | { no: string }): Promise<{ entries: string[] } | { no: string }> {
  const p = await where($)
  if (!p) return { no: 'conductor-file-error' }
  const release = await lockStore(`conductor:${home}`)
  try {
    const dir = `${home}/.claude`
    const path = `${home}/${c.CONDUCTOR_FILE}`
    const dirState = async (): Promise<'ok' | 'absent' | 'bad' | 'error'> => {
      const f = await statR($, dir)
      if (f === 'absent' || f === 'error') return f
      return f.kind === 'dir' && f.uid === p.uid && (f.mode & 0o022) === 0 && (await real($, dir)) === dir ? 'ok' : 'bad'
    }
    let d = await dirState()
    if (d === 'absent') {
      await run($, [MKDIR, '-m', '755', '--', dir])
      d = await dirState()
    }
    if (d === 'bad') return { no: 'conductor-file-unsafe' }
    if (d !== 'ok') return { no: 'conductor-file-error' }
    const unsafe = async (): Promise<string | undefined> => {
      const f = await statR($, path)
      if (f === 'error') return 'conductor-file-error'
      return f !== 'absent' && (f.kind !== 'file' || f.uid !== p.uid || f.nlink !== 1) ? 'conductor-file-unsafe' : undefined
    }
    const before = await unsafe()
    if (before) return { no: before }
    const cur = await readConductorFile($, home)
    if (cur.state === 'unsafe') return { no: 'conductor-file-unsafe' }
    if (cur.state === 'bad') return { no: 'conductor-file-bad' }
    if (cur.state === 'error') return { no: 'conductor-file-error' }
    const next = fn(cur.state === 'ok' ? cur.entries : [])
    if ('no' in next) return next
    const text = c.conductorFileText(next)
    if (text.length > c.CONDUCTOR_FILE_MAX) return { no: 'conductor-too-long' }
    const tmp = `${dir}/.callboard-conductor.json.${await $.clock.now()}.${++mem.seq}.tmp`
    const drop = async (code: string) => {
      await run($, [RM, '-f', '--', tmp])
      return { no: code }
    }
    // A step that throws removes the temp file too.
    try {
      await run($, [INSTALL, '-m', '644', '/dev/null', tmp])
      const t = await facts($, tmp)
      if (!t || t.kind !== 'file' || t.uid !== p.uid || (t.mode & 0o7022) !== 0 || t.nlink !== 1) return drop('conductor-file-write')
      if ((await run($, [TEE, '--', tmp], text)).exitCode !== 0) return drop('conductor-file-write')
      // The temp file is still the one checked (not swapped for a link) before it is renamed into place.
      const t2 = await facts($, tmp)
      if (!t2 || t2.ino !== t.ino || t2.uid !== p.uid || t2.kind !== 'file' || t2.nlink !== 1) return drop('conductor-file-write')
      const again = await readConductorFile($, home)
      if (again.state !== cur.state || (again.state === 'ok' && cur.state === 'ok' && again.text !== cur.text)) return drop('conductor-file-changed')
      const after = await unsafe()
      if (after) return drop(after)
      if ((await run($, [MV, '-f', '--', tmp, path])).exitCode !== 0) return drop('conductor-file-write')
    } catch (e) {
      await drop('conductor-file-write').catch(() => undefined)
      throw e
    }
    return { entries: next }
  } finally {
    release()
  }
}

// /callboard conductor add ARG: the target a folder name or ../NAME resolves to (the sibling at the same depth), or the path given.
const conductorTarget = (home: string, arg: string): string => (c.siblingName(arg) ? c.siblingOf(home, arg) : c.entryPath(home, arg))
// Every check of an add before the dialog and again after a yes; the list as it would be, shown whole in the dialog.
export async function conductorAddPlan($: any, sid: string, arg: string, marks: boolean): Promise<{ home: string; target: string; list: string[] } | { no: string; home?: string }> {
  const held = await heldNo($, sid, 'conductor', marks)
  if (held) return { no: held }
  const here = await conductorHere($)
  if ('no' in here) return here
  const home = here.home
  const used = await conductorRepoInUse($, home)
  if (used) return { no: used, home }
  const p = await where($)
  if (!p) return { no: 'conductor-check-failed', home }
  const target = conductorTarget(home, arg)
  if (c.pinRefusal(target, homeOf(p)) !== undefined) return { no: 'conductor-broad', home }
  const r = await realR($, target)
  if (r === 'error') return { no: 'conductor-check-failed', home }
  if (r === 'absent') return { no: 'conductor-not-found', home }
  if (r.path !== target) return { no: 'conductor-not-real', home }
  const g = await gitRoot($, target)
  if (g !== 'yes') return { no: g === 'error' ? 'conductor-check-failed' : 'conductor-not-git', home }
  const cur = await readConductorFile($, home)
  if (cur.state === 'unsafe') return { no: 'conductor-file-unsafe', home }
  if (cur.state === 'bad') return { no: 'conductor-file-bad', home }
  if (cur.state === 'error') return { no: 'conductor-file-error', home }
  const entries = cur.state === 'ok' ? cur.entries : []
  const paths = entries.map((e) => c.entryPath(home, e))
  const nest = c.nestRefusal(home, paths, target)
  if (nest) return { no: nest, home }
  const list = [...paths, target]
  if (list.length > c.CONDUCTOR_REPOS_MAX) return { no: 'conductor-cap', home }
  if (!c.conductorPresenceFits(home, list)) return { no: 'conductor-too-long', home }
  // No repo may be added that no grant dialog could carry.
  const h = homeOf(p)
  // Also the grant and restore questions that may follow, with the new repo marked.
  if (c.conductorQuestion(home, list, h, [target]).length > c.QUESTION_MAX || c.conductorAddQuestion(home, target, list, h, true).length > c.QUESTION_MAX || c.conductorRestoreQuestion(home, list, [target], h).length > c.QUESTION_MAX) return { no: 'conductor-list-long', home }
  return { home, target, list }
}

// The reach of a conductor now: the list file at its repo, resolved, intersected with the approved list. Every read that parses also ratchets the approved list
// (approved := approved ∩ what the file still lists and resolves; a check that could not be made keeps its repo) and saves it when it shrank. off: no conductor
// grant (or one dropped meanwhile); conductor-list: the file is unreadable or bad, or nothing is left in reach.
export async function conductorReach($: any, sid: string): Promise<{ pins: string[]; out: CondOut[] } | { no: 'off' | 'conductor-list' }> {
  const epoch = epochOf(sid)
  const home = conductorHome.get(sid)
  if (grants.get(sid)?.level !== 'conductor' || home === undefined) return { no: 'off' }
  // The approved list as this read began; an add click that lands during the read is not ratcheted away by it.
  const snap = conductorApproved.get(sid) ?? []
  const f = await readConductorFile($, home)
  if (epochOf(sid) !== epoch || grants.get(sid)?.level !== 'conductor') return { no: 'off' }
  if (f.state !== 'ok') {
    // Nothing is in reach, so the presence file, the briefing and the status say none (the approved list stays).
    const g0 = grants.get(sid)!
    if (g0.pins.length > 0) grants.set(sid, { ...g0, pins: [] })
    return { no: 'conductor-list' }
  }
  const r = await resolveConductorList($, home, f.entries)
  if (epochOf(sid) !== epoch || grants.get(sid)?.level !== 'conductor') return { no: 'off' }
  const approved = conductorApproved.get(sid) ?? []
  const keep = new Set([...r.ok, ...r.out.filter((o) => o.why === 'error').map((o) => c.entryPath(home, o.entry))])
  const kept = approved.filter((a) => keep.has(a) || !snap.includes(a))
  if (kept.length < approved.length) {
    conductorApproved.set(sid, kept)
    await log($, sid, 'conductor-ratchet', String(approved.length - kept.length))
    await levelSave($, sid, CONDUCTOR)
  }
  const pins = r.ok.filter((x) => kept.includes(x))
  const out: CondOut[] = [...r.out, ...r.ok.filter((x) => !kept.includes(x)).map((x) => ({ entry: c.entryFor(home, x), why: 'unapproved' as const }))]
  const g = grants.get(sid)
  if (epochOf(sid) !== epoch || g?.level !== 'conductor') return { no: 'off' }
  if (g.pins.join('\n') !== pins.join('\n')) grants.set(sid, { ...g, pins })
  if (pins.length === 0) return { no: 'conductor-list' }
  return { pins, out }
}

// ---- the conductor grant by dialog, its saved grant and restore, its tools ----
// The conductor's tools (three lane tools, lead_open, the six lead tools and go_request), declared at its grant, then the three prompt tools (fourteen in all, c.CONDUCTOR_TOOLS). The handlers are the lead's (leadBase refuses every other lane tool at conductor level).
async function conductorTools($: any, sid: string) {
  if (conductorDeclared.has(sid)) return
  const lane = { type: 'object', properties: { lane: { type: 'string' } }, required: ['lane'] }
  const lead = { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] }
  const tools: [string, string, unknown][] = [
    ['lane_list', "List your leads and their lanes, as one table under a Conductor header line (one row per lane with its lead, repo folder name, session and waiting columns; a lead no live session carries is marked not live): each lane of a lead you own, its folder when it is outside the repo root, whether a live session carries its name or it is parked, and how many minutes it has waited on a prompt. A lead you own with no lanes is one row with – in the lane cells.", { type: 'object', properties: {} }],
    ['lane_compact', "Ask a session to compact. lane: a lane of one of your leads (at once if it asked on-cue, otherwise it is ordered to compact), or the session name of a live lead you own (then it works as lead_compact).", lane],
    ['lane_terminate', "Stop a lane of a lead you own with SIGTERM, whatever it is doing. Every stop asks the person: they confirm in a dialog that names the lane, its repo, the session and the pid. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and report stay). A lane with no live session is removed directly. lane: the lane name. To stop a lead you own, use lead_terminate.", lane],
    ['lead_open', "Open a panel for a new lead in one of your repos, write the task to its brief (<repo>/.archive/<NAME>/BRIEF.md) and make it the lead without asking the person. The repo must be one of yours, and no open may be running, one succeeded in the last hour, or three been tried in the last hour. The person sees a toast. repo: the repo's absolute path. name: the new lead's name. task: the brief text, as for lane_create. model: opus, sonnet, haiku or fable (default as lane_create); the new lead is set to it. job: true for a small task the new lead does itself, with no lanes; it signs its report and stops, and you end it with lead_retire.", { type: 'object', properties: { repo: { type: 'string' }, name: { type: 'string' }, task: { type: 'string' }, model: { type: 'string' }, job: { type: 'boolean' } }, required: ['repo', 'name', 'task'] }],
    ['lead_resume', `Cue a lead you own to resume from its own notes: it gets one fixed turn and continues only work already authorised. It must be idle with an empty prompt box, and takes at most ${c.RESUME_PER_HOUR} resumes an hour. lead: the lead's name.`, lead],
    ['lead_compact', `Ask a lead you own to compact: at once if it asked for that with request_compact on-cue, otherwise it is ordered to compact (it asks on-cue, whatever its context size, and compacts at the end of its turn). If it has not asked within ${c.ORDER_MS / 60_000} minutes, you are told. lead: the lead's name.`, lead],
    ['lead_park', `Park a lead you own: its session stops and its record is marked parked, so lead_unpark can reopen the same conversation within ${c.UNPARK_MAX_MS / 86_400_000} days. The lead must be idle with an empty prompt box and no background agents or shells, no live lane may name it, and the lead confirms it can stop. The call waits up to 40 seconds for the idle time. lead: the lead's name.`, lead],
    ['lead_unpark', `Reopen a parked lead you own in a new panel, as the lead, within ${c.UNPARK_MAX_MS / 86_400_000} days of its park. Needs the panels extension 1.4.0 or later. lead: the lead's name.`, lead],
    ['lead_retire', "Stop a lead you own once it confirms it can end: idle, empty prompt box, no background agents or shells, and its report signed done. Refused while any lane record names the lead (its lanes are retired or removed first). The call waits up to 40 seconds for the idle time. Once the session has stopped, the lead's record is deleted (its .archive folder and report stay). A lead record no live session carries is removed directly; for a parked lead the person confirms first. Retire is final. lead: the lead's name.", lead],
    ['lead_terminate', "Stop a lead you own with SIGTERM, whatever it is doing. Every stop asks the person: they confirm in a dialog that names the lead, its repo, the session, the pid and how many live lanes name it. Once the session has stopped, the lead's record is deleted, or kept with no session while any lane names the lead (then lead_retire removes it once its lanes are gone). lead: the lead's name.", lead],
    ['go_request', "Ask the person for one go that counts in the leads you own and in their lanes (ADR 0009). It only opens the person's dialog in this session: text says what the work is (1 to 1500 bytes of plain text; the person reads it, and the leads and lanes read it back from go_status). The dialog lists your leads with their lanes, the end (24 hours) and what a go never covers. The result says whether the go was given. Main agent of a conductor only; at most 6 dialogs an hour. Call it when lead_open says no go covers a lead that has risk-list work.", { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }],
  ]
  for (const [name, description, inputSchema] of tools) await $.tool.register({ name, description, inputSchema })
  await promptToolsRegister($)
  conductorDeclared.add(sid)
}

// The grant itself, for /callboard conductor and the restore. The caller holds leadGranting. The tools first; then, unless an off came meanwhile (epoch), the
// grant with its pins, the conductor repo and the approved list.
export async function conductorApply($: any, sid: string, home: string, approved: string[], pins: string[], epoch: number): Promise<'ok' | 'tools' | 'timeout' | 'dropped'> {
  let set: unknown
  try {
    set = await withTimeout($, conductorTools($, sid), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return 'tools'
  }
  if (epochOf(sid) !== epoch) return 'dropped'
  if (set === 'timeout') return 'timeout'
  const prev = grants.get(sid)
  grants.set(sid, { level: 'conductor', pins: [...pins], name: prev?.level === 'conductor' ? prev.name : '' })
  conductorHome.set(sid, home)
  conductorApproved.set(sid, [...approved])
  return 'ok'
}

// The conductor list as the grant shows it: every check of the conductor repo, then the file read and resolved. ok: the repos in reach, out: the ones that
// are not and why.
export async function conductorShowable($: any, sid: string, marks: boolean): Promise<{ home: string; ok: string[]; out: CondOut[] } | { no: string; home?: string; out?: CondOut[] }> {
  const held = await heldNo($, sid, 'conductor', marks)
  if (held) return { no: held }
  const here = await conductorHere($)
  if ('no' in here) return here
  const home = here.home
  const used = await conductorRepoInUse($, home)
  if (used) return { no: used, home }
  const f = await readConductorFile($, home)
  if (f.state === 'unsafe') return { no: 'conductor-file-unsafe', home }
  if (f.state === 'bad') return { no: 'conductor-file-bad', home }
  if (f.state === 'error') return { no: 'conductor-file-error', home }
  if (f.state === 'absent') return { no: 'conductor-list', home }
  const r = await resolveConductorList($, home, f.entries)
  if (r.ok.length === 0) return { no: 'conductor-list', home, out: r.out }
  return { home, ok: r.ok, out: r.out }
}

// A session whose saved conductor grant names its own folder is a conductor again when it starts, as a lead is (leadRestore), with these differences:
// the gate is a person's own registry row (personRow: never a --bg worker); a lane on its way back keeps it off; and the approved list caps the reach. A list
// that names nothing new (the same, or narrowed) restores with no question; one that names a repo outside the approved list asks first (conductorRestoreAsk,
// from the tick once the session is idle with an empty prompt box). The tries count only the ticks before a dialog.
const CONDUCTOR_RESTORE_TRIES = 15

// One try: a code when it is to be tried again, { ask } when the person must be asked, undefined when it ended (made a conductor, or refused and logged).
// box.hint is the hint as the try leaves it (a ratchet narrows it).
async function conductorRestoreTry($: any, me: string, box: { hint: c.ConductorHint }): Promise<string | { shown: string[]; added: string[] } | undefined> {
  const hint = box.hint
  const key = `${c.CONDUCTOR_HINT_PREFIX}${me}`
  const reject = (code: string) => log($, me, 'conductor-restore-rejected', code)
  // A final end that no toast of its own tells. `told`: the reason the person reads, when the log's code would say more than is known.
  const end = async (code: string, told = code) => {
    await reject(code)
    toast($, c.notRestoredToast('conductor', told, hint.home))
  }
  const epoch = epochOf(me)
  const dropped = () => epochOf(me) !== epoch
  // A conductor that still holds its grant in memory (a compaction) has nothing to restore: no check runs, so none can say it was not restored.
  if (grants.get(me)?.level === 'conductor') return
  // A person's own row: kind interactive. No row yet: tried again (a reopened panel's row may come a moment after session.start). Another kind (a
  // --bg worker resumed under this id) or none: the try ends and the key is kept.
  const row = await registryOf($, me)
  if (dropped()) return
  if (row === undefined) return 'not-person'
  if (row.kind !== 'interactive') return void (await reject('not-person'))
  let cwd: unknown
  try {
    cwd = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return 'cwd-unreadable'
  }
  if (dropped()) return
  if (cwd === 'timeout' || typeof cwd !== 'string') return 'cwd-unreadable'
  if (cwd !== hint.home) {
    await $.store.delete(key)
    void goGrantorOff($, me).catch(() => undefined)
    return void (await end('wrong-folder'))
  }
  // A lane on its way back: its binding, its restore hint, or a store record naming this session. A pending rebind alone is tried again:
  // rebindTick clears it once it finds no record, and waits for this restore while it is pending.
  const held = await withTimeout($, getLane($), c.ENGINE_CALL_TIMEOUT_MS)
  if (dropped()) return
  if (held === 'timeout' || held?.value != null || laneBinding.has(me)) return void (await end('lane-holder', held === 'timeout' ? 'lane-check-slow' : undefined))
  const now = await $.clock.now()
  if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${me}`).catch(() => undefined), now)?.lane) return void (await end('lane-holder'))
  const lanes = await loadLanes($).catch(() => 'lanes-error')
  if (dropped()) return
  if (typeof lanes === 'string') return 'lanes-error'
  if (lanes.some((l) => l.sid === me)) return void (await end('lane-holder'))
  if (rebindPending.has(me)) return 'rebind-pending'
  if (grants.get(me)?.level === 'conductor') return
  // A lead (a grant or a pending lead restore) stands.
  if (leadBusy(me) || leadRestorePending.has(me)) return void (await end('lead-holder'))
  const used = await conductorRepoInUse($, hint.home)
  if (dropped()) return
  if (used === 'conductor-repo-in-use') return void (await end(used))
  if (used) return used
  // A list file that cannot be read now restores nothing and is tried again; one that is not there has nothing to restore.
  const f = await readConductorFile($, hint.home)
  if (dropped()) return
  if (f.state === 'absent') {
    toast($, c.conductorNoReposToast(hint.home))
    return void (await reject('no-repos'))
  }
  if (f.state !== 'ok') return 'file-bad'
  const r = await resolveConductorList($, hint.home, f.entries)
  if (dropped()) return
  // The ratchet: the approved list keeps only what the file still lists and resolves (a check that could not be made keeps its repo).
  const keep = new Set([...r.ok, ...r.out.filter((o) => o.why === 'error').map((o) => c.entryPath(hint.home, o.entry))])
  const approved = hint.repos.filter((x) => keep.has(x))
  if (approved.length < hint.repos.length) {
    await log($, me, 'conductor-ratchet', String(hint.repos.length - approved.length))
    box.hint = { ...hint, repos: approved, savedAt: now }
    await Promise.resolve($.store.set(key, box.hint)).catch(() => logq($, me, 'conductor-unsaved'))
    // An off that landed during the write deleted the key first; delete it again, as levelSave does.
    if (dropped()) return void (await Promise.resolve($.store.delete(key)).catch(logFail($, me, 'conductor-hint-delete')))
  }
  const added = r.ok.filter((x) => !approved.includes(x))
  if (added.length > 0) return { shown: r.ok, added }
  if (r.ok.length === 0) {
    toast($, c.conductorNoReposToast(hint.home))
    return void (await reject('no-repos'))
  }
  if (leadBusy(me)) return
  leadGranting.add(me)
  try {
    const a = await conductorApply($, me, hint.home, approved, r.ok, epoch)
    if (a === 'dropped') return
    if (a === 'timeout') return 'tools-timeout'
    if (a !== 'ok') return void (await end('tools'))
  } finally {
    leadGranting.delete(me)
  }
  await levelSave($, me, CONDUCTOR)
  if (dropped()) return
  // No note: the history has it from the grant.
  briefed.set(me, CONDUCTOR.noteKey(hint.home))
  await presenceTouch($, me).catch(logFail($, me, 'conductor-presence'))
  await log($, me, 'conductor-restored')
  toast($, c.conductorRestoredToast(hint.home, r.ok.length))
  await nameGrant($, me)
}
export async function conductorRestore($: any, me: string, hint: c.ConductorHint, tries: number, last?: string) {
  const box = { hint }
  const again = await restoreAttempt($, me, CONDUCTOR, () => conductorRestoreTry($, me, box))
  if (again === undefined) return
  if (typeof again === 'object') return void conductorRestorePending.set(me, { hint: box.hint, tries, ask: again })
  if (tries >= CONDUCTOR_RESTORE_TRIES) {
    conductorRestorePending.delete(me)
    await log($, me, 'conductor-restore-rejected', again)
    toast($, again === 'file-bad' ? c.conductorFileBadToast(box.hint.home) : c.notRestoredToast('conductor', again, box.hint.home))
    return
  }
  if ((again === 'rebind-pending' || again === 'file-bad') && again !== last) await log($, me, 'conductor-restore-retry', again)
  conductorRestorePending.set(me, { hint: box.hint, tries, last: again })
}
// The restore dialog, when the list names repos the person has not approved: every repo shown, the new ones named. Conductor restores with the
// whole shown list (the approved list becomes it); Cancel is the person's no (the saved grant goes); no answer restores nothing and keeps the key. An
// off or a lead grant while it is open grants nothing, and the list resolved after the click must be the one shown.
async function conductorRestoreAsk($: any, me: string, pend: CondPending) {
  const { hint } = pend
  const { shown, added } = pend.ask!
  const key = `${c.CONDUCTOR_HINT_PREFIX}${me}`
  const epoch = epochOf(me)
  const mine = () => conductorRestorePending.get(me) === pend && epochOf(me) === epoch
  const end = () => {
    if (conductorRestorePending.get(me) === pend) conductorRestorePending.delete(me)
  }
  pend.asking = true
  try {
    const p = await where($)
    const question = c.conductorRestoreQuestion(hint.home, shown, added, p ? homeOf(p) : undefined)
    const r = question.length > c.QUESTION_MAX ? 'error' : await askOnce($, me, question, c.CONDUCTOR_YES, c.CONDUCTOR_NO, c.HEADER.conductor)
    if (r === 'busy') return
    if (!mine()) return void (await log($, me, 'conductor-restore-rejected', 'changed'))
    if (r === 'no') {
      end()
      await Promise.resolve($.store.delete(key)).catch(logFail($, me, 'conductor-hint-delete'))
      void goGrantorOff($, me).catch(() => undefined)
      return void (await log($, me, 'conductor-restore-cancelled'))
    }
    if (r !== 'yes') {
      end()
      await log($, me, 'conductor-restore-unanswered')
      return void toast($, c.conductorUnansweredToast(hint.home))
    }
    end()
    // A check that fails after the click is a final end: logged, and the person is told.
    const refused = async (code: string, told = code) => {
      await log($, me, 'conductor-restore-rejected', code)
      toast($, c.notRestoredToast('conductor', told, hint.home))
    }
    if (leadBusy(me) || leadRestorePending.has(me)) return void (await refused('lead-holder'))
    // Every check again after the click.
    const held = await withTimeout($, getLane($), c.ENGINE_CALL_TIMEOUT_MS)
    if (held === 'timeout' || held?.value != null || laneBinding.has(me)) return void (await refused('lane-holder', held === 'timeout' ? 'lane-check-slow' : undefined))
    const used = await conductorRepoInUse($, hint.home)
    if (used) return void (await refused(used))
    const f = await readConductorFile($, hint.home)
    const r2 = f.state === 'ok' ? await resolveConductorList($, hint.home, f.entries) : undefined
    if (epochOf(me) !== epoch) return void (await log($, me, 'conductor-restore-rejected', 'changed'))
    if (!r2 || [...r2.ok].sort().join('\n') !== [...shown].sort().join('\n')) {
      toast($, c.conductorUnansweredToast(hint.home))
      return void (await log($, me, 'conductor-restore-rejected', 'changed'))
    }
    if (leadBusy(me)) return
    leadGranting.add(me)
    try {
      const a = await conductorApply($, me, hint.home, shown, shown, epoch)
      if (a !== 'ok') return void (await (a === 'dropped' ? log($, me, 'conductor-restore-rejected', 'changed') : refused('tools')))
    } finally {
      leadGranting.delete(me)
    }
    await levelSave($, me, CONDUCTOR)
    if (epochOf(me) !== epoch) return
    await presenceTouch($, me).catch(logFail($, me, 'conductor-presence'))
    await log($, me, 'conductor-restored', `widened ${added.length}`)
    await levelBrief($, me, CONDUCTOR, hint.home)
    toast($, c.conductorRestoredToast(hint.home, shown.length))
    await nameGrant($, me)
  } finally {
    pend.asking = false
  }
}
// The tick's part: a running conductor's reach (the ratchet, the presence text, an empty reach) at most every CONDUCTOR_REFRESH_MS and its saved grant once a
// day; a pending restore's next try, or its dialog once the session is idle with an empty prompt box (not awaited: the dialog waits up to 90 s).
const CONDUCTOR_REFRESH_MS = 10_000

export async function conductorTick($: any, sid: string) {
  const pend = conductorRestorePending.get(sid)
  if (pend && !pend.asking) {
    if (!pend.ask) {
      const r = await withTimeout($, conductorRestore($, sid, pend.hint, pend.tries + 1, pend.last), ACTION_TIMEOUT_MS).catch(() => 'error' as const)
      if (r === 'timeout' || r === 'error') await logq($, sid, 'error', `conductor-restore-${r}`)
    } else if ((await personRow($, sid)) && (await idleCheck($, sid)) === undefined) {
      void conductorRestoreAsk($, sid, pend).catch(logFail($, sid, 'conductor-restore-ask'))
    }
  }
  if (grants.get(sid)?.level !== 'conductor') return
  const now = await $.clock.now()
  if (c.leadRefreshDue(conductorSavedAt.get(sid), now, CONDUCTOR.refreshMs)) await levelSave($, sid, CONDUCTOR)
  const last = conductorReadAt.get(sid)
  if (c.dueEvery(last, now, CONDUCTOR_REFRESH_MS)) {
    conductorReadAt.set(sid, now)
    await conductorReach($, sid)
    // Not during the conductor's own write (lead_open): its end looks once and moves told with cur (watchOwn).
    if (!ownWriting.has(sid)) await leadWatchLook($, sid).catch(logFail($, sid, 'lead-watch'))
  }
}

// /color from a mod is refused inside a hook the turn waits on and works from a timer. Best effort, while the same grant holds; logged either way.
const COLOR_AFTER_MS = 1000
export function colorLater($: any, sid: string, epoch: number) {
  const failed = () => logq($, sid, 'error', 'manager-color')
  try {
    Promise.resolve(
      $.clock.after(COLOR_AFTER_MS, async () => {
        if (grants.get(sid)?.level !== 'manager' || epochOf(sid) !== epoch) return
        try {
          await $.command.run({ command: 'color', args: 'cyan' })
          await log($, sid, 'manager-color')
        } catch {
          await failed()
        }
      }),
    ).catch(failed)
  } catch {
    void failed()
  }
}

// Best effort: a session that ends without it leaves a presence file that goes stale in 30 s.
export async function sessionEnd($: any, e: any, next: any) {
  const sid = await $.session.id()
  laneBrief.delete(sid)
  laneBriefed.delete(sid)
  midDelivered.delete(sid)
  promptMidSent.delete(sid)
  promptMidRetold.delete(sid)
  // What a lead last saw of a manager goes with the session.
  managerSeen.delete(sid)
  managerSeenBusy.delete(sid)
  await presenceDrop($, sid).catch(() => undefined)
  await usageDrop($, sid).catch(() => undefined)
  return next(e)
}

// The lead's briefing: one session-scope section, only while lead is on in this session. The hook sees the request's tools and traits but not an agent id, so a
// request that does not offer the lane tools (a subagent with a narrow tool list) or that is a teammate's render of its lead's prompt gets nothing.
// The lane's briefing, in the same hook (the engine takes one prompt.compose hook per module): one session-scope section while this session is a bound lane
// (laneBrief, filled where the binding is written). The request must offer request_compact: every session registers it, so this only keeps out a subagent
// with a narrow tool list; the binding is the real gate. After a reload the module memory is empty: a binding still in the session's state gets the text
// with the generic lead and report wording; a read that throws gets nothing.
export async function promptCompose($: any, e: any, next: any) {
  // The gates are decided before next runs, so the trailing catch can never call next a second time.
  const sid = await $.session.id()
  const pin = pinOf(sid)
  const leadTools = !e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes(c.LEAD_LANE_TOOL)
  const gated = pin !== undefined && leadTools
  // The manager's section, on the same gates.
  const mg = grants.get(sid)
  const managerText = mg?.level === 'manager' && leadTools ? c.managerBriefing(mg.name) : undefined
  // The conductor's section, on the same gates.
  const condHome = conductorHome.get(sid)
  const conductorText = mg?.level === 'conductor' && condHome !== undefined && leadTools ? c.conductorBriefing(mg.name, condHome, mg.pins) : undefined
  let brief: c.LaneFacts | undefined
  if (!e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes(c.LANE_COMPACT_TOOL)) {
    brief = laneBrief.get(sid)
    if (!brief) {
      try {
        const b = (await getLane($)).value as Bound | null | undefined
        if (b && typeof b.name === 'string') brief = { name: b.name, sid, attached: b.adopted === true }
      } catch {}
    }
  }
  const laneText = brief ? c.laneBriefing(brief) : undefined
  // A lead is told of on-cue compaction only while its tick last saw a live manager (no file read here).
  const leadManager = gated && grants.get(sid)?.level === 'lead' && managerSeen.get(sid)?.live === true
  // And of a trusted conductor over its repo.
  const seenConductors = gated && grants.get(sid)?.level === 'lead' ? (managerSeen.get(sid)?.conductors ?? []) : []
  const out = await next(e)
  if ((!gated && laneText === undefined && managerText === undefined && conductorText === undefined) || !Array.isArray(out?.sections)) return out
  let sections = out.sections
  // The section with this id, replaced (or left out, with no text), at the end.
  const setSection = (id: string, text: string | undefined) => {
    sections = [...sections.filter((x) => x.id !== id), ...(text !== undefined ? [{ id, text, scope: 'session' as const }] : [])]
  }
  if (gated) setSection(c.LEAD_BRIEFING_ID, c.leadBriefing(pin, sid))
  if (gated) setSection(c.LEAD_MANAGER_ID, leadManager ? c.LEAD_MANAGER_TEXT : undefined)
  // ADR 0004: the lead's prompt section, beside the briefing (whose approved text is left alone).
  if (gated) setSection(pr.LEAD_PROMPTS_ID, grants.get(sid)?.level === 'lead' ? pr.LEAD_PROMPT_BRIEFING : undefined)
  if (gated) setSection(c.LEAD_CONDUCTOR_ID, seenConductors.length > 0 ? c.leadConductorText(seenConductors) : undefined)
  if (managerText !== undefined) setSection(c.MANAGER_BRIEFING_ID, managerText)
  if (conductorText !== undefined) setSection(c.CONDUCTOR_BRIEFING_ID, conductorText)
  // The conductor's and the manager's prompt section (the lead's is above).
  {
    const lvl = grants.get(sid)?.level
    const tierText = lvl === 'conductor' && conductorText !== undefined ? pr.tierPromptBriefing('conductor') : lvl === 'manager' && managerText !== undefined ? pr.tierPromptBriefing('manager') : undefined
    setSection(pr.TIER_PROMPTS_ID, tierText)
  }
  if (laneText !== undefined) setSection(c.LANE_BRIEFING_ID, laneText)
  return { ...out, sections }
}

// A lead tool's check b (engine/lead-tools.ts): the session holds a fresh lead presence file, passing presenceCheck, whose repo is exactly `repo`. 'error' when
// the folder fails its rules or the check could not be made (fail closed).
export async function leadPresence($: any, live: RegRow[], sid: string, repo: string): Promise<'ok' | 'no' | 'error'> {
  const d = await presenceNames($)
  if (d === 'error') return 'error'
  if (d === 'none' || !d.names.includes(sid)) return 'no'
  const f = await presenceCheck($, d.p, live, sid, (x) => x.level === 'lead' && x.repo === repo)
  return f === 'error' ? 'error' : f === 'no' ? 'no' : 'ok'
}
