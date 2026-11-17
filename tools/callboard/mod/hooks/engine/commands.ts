// The /callboard command handler and the commands under it (lane, manager, conductor list and grant, config, reserve, check-in, rest, escalation).
// Trust rules held here: a command that grants a level asks the person first; the person-only commands run only from the person's own origin.
import type { Request } from '../../types'
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import {
  grants,
  offSeq,
  hereGone,
  restoredOnce,
  managerDeclared,
  conductorDeclared,
  dialogOpen,
  laneBinding,
  pendingRename,
  conductorRestorePending,
  leadGranting,
  managerRestorePending,
  conductorHome,
  managerCwd,
  conductorApproved,
  rebindPending,
  leadEpoch,
  laneObs,
  attnTold,
  attnMid,
  attnToasted,
  laneBrief,
  mem,
} from '../mem.ts'
import { logq, where, askOnce, askLimited, timedOut, log, pickLead, pickFrom, ask, sha, withTimeout, toast, logFail } from './base.ts'
import type { Asked } from './base.ts'
import { editStore, registryEntries, keptLanes, loadLanes } from './store.ts'
import {
  cfgGet,
  cfgReadStrict,
  homeOf,
  leadBusy,
  reservedGet,
  managersLive,
  managerTools,
  leadDrop,
  MANAGER,
  LEAD,
  grantDialog,
  CONDUCTOR,
  colorLater,
  conductorHere,
  writeConductorFile,
  conductorReach,
  conductorAddPlan,
  conductorShowable,
  conductorApply,
  nameGrant,
  leadsFor,
  managerForget,
  pinOf,
  secondLeadNo,
  watchInit,
  regEntry,
} from './grants.ts'
import type { CondOut } from './grants.ts'
import {
  detach,
  attachPlan,
  dropRecord,
  undoLate,
  keepLaneFacts,
  briefLane,
  laneTable,
  sessionRoot,
  leadToolsOnce,
  sidClearAll,
} from './lanes.ts'
import type { Bound, Plan } from './lanes.ts'
import { ownerWrite, joinCands, ownerLeave, bindingOf, joinPlanNow, ownerStatusNow } from './lead-records.ts'
import { restoreFromHint, saveHint, bump, isEligible, dropRequest } from './compaction.ts'
import { ensureTimer } from './tick.ts'
import { grantNameNo } from './lead-open.ts'
import { epochOf, heldNo, holdsOf, levelSave } from './levels.ts'
import type { LevelDesc } from './levels.ts'
import { ANSWERING_KEY, ledgerAdd, promptsOff, escalationNow, defaultForget, hereRead, hereDrop, unattendedNow, unattendedClose, ledgerRowsFor, unattendedOpen, unattendedVoid, unattendedOffMark, unattendedOffSince, unattendedClosesNow, unattendedBusy } from './answer-hook.ts'
import { ledgerRestore } from './answer-tiers.ts'
import * as go from '../go.ts'
import { goCommand, goGrantorOff } from './go.ts'
import { getCheckinPause, getLane, getRequest, setCheckinPause, setLane, setNudgeDue, setNudgedAt, setRequest, setRest } from '../state.ts'

// The refusal of a person-only command from another origin: logged as <command>-not-person:<origin>, answered with the command's fixed text.
async function notPerson($: any, sid: string, command: string, code: c.OriginCode, text: string): Promise<{ text: string }> {
  await logq($, sid, 'refused', `${command}-not-person:${code}`)
  return { text }
}

// Sets the rest for this session and logs it: the one path of the command and the tool. False when the session state could not be written.
async function restSet($: any, sid: string, code: string): Promise<boolean> {
  try {
    if ((await setRest($, await $.clock.now())).isSet === false) return false
  } catch {
    return false
  }
  await logq($, sid, 'command', `rest:${code}`)
  return true
}
async function restCommand($: any, sid: string, code: string) {
  return { text: (await restSet($, sid, code)) ? c.REST_TEXT : c.REST_FAILED }
}

// The `rest` tool: /callboard rest set by the calling session's own main agent, through the same restSet. It asks nothing, as the command: it only
// narrows. A subagent is refused, because the rest is the session's and its call would rest the parent.
export async function restCall($: any, e: any) {
  const sid = await $.session.id()
  ensureTimer($)
  if ((e as { agentId?: string }).agentId !== undefined) {
    await logq($, sid, 'refused', 'rest-subagent')
    return { deny: c.REST_SUBAGENT }
  }
  return (await restSet($, sid, 'tool')) ? { result: c.REST_SET } : { deny: c.REST_FAILED }
}

// /callboard checkin pause [<N>m|<N>h] and checkin resume: the person's own, as config; a plugin, another session or a script gets a fixed refusal.
async function checkinCommand($: any, sid: string, code: c.OriginCode, op: c.CheckinOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.CHECKIN_USAGE }
  if (!c.originIsPerson(code)) return notPerson($, sid, 'checkin', code, c.CHECKIN_NOT_PERSON)
  if (!grants.has(sid)) return { text: c.CHECKIN_NOT_LEAD }
  const now = await $.clock.now()
  const until = op === 'on' ? null : now + op.pauseMs
  if ((await setCheckinPause($, until))?.isSet === false) return { text: c.CHECKIN_UNSAVED }
  await logq($, sid, 'checkin-pause', `${op === 'on' ? 'on' : `${op.pauseMs / 60_000}m`}:${code}`)
  if (until !== null) return { text: c.checkinPausedText(until, now) }
  return { text: (await cfgGet($, sid)).checkin ? c.CHECKIN_ON_TEXT : c.CHECKIN_ON_BUT_OFF }
}

async function laneCommand($: any, sid: string, code: c.OriginCode, arg: c.CommandArg, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const refuse = async (reason: string) => {
    await log($, sid, 'refused', reason)
    return { text: c.refusalText(reason) }
  }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `lane-origin:${code}`)
    return { text: c.refusalText('lane-origin') }
  }
  const bound = (await getLane($)).value as Bound | null | undefined
  if (arg === 'lane-off') {
    if (!bound) return { text: `This session is not a lane. ${c.NO_LANE_RECORD}` }
    const d = await detach($, sid, bound)
    return { text: `This session is no longer lane ${bound.name}.${c.STOPPABLE_BY_NAME(bound.name)}${d.sidKept ? c.SID_KEPT(bound.name) : ''}` }
  }
  const seq = offSeq.get(sid) ?? 0
  const want = (arg as { lane: string | undefined }).lane
  // The Restore fallback: an unbound session whose hint names a lane, with no restore decided yet, is asked
  // the Restore question first (restoreFromHint, every check as before). A restored lane or a question nobody answered ends here; no hint, a refused or a
  // declined restore goes on to Join.
  // A session that was the manager skips the Restore question: attachPlan refuses it. So does one that was a conductor.
  if (!bound && want === undefined && !restoredOnce.has(sid) && !managerDeclared.has(sid) && !conductorDeclared.has(sid)) {
    const now = await $.clock.now()
    if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), now)?.lane) {
      if (dialogOpen.has(sid)) return busy()
      dialogOpen.add(sid)
      let asked: 'timed-out' | void
      try {
        asked = await restoreFromHint($, sid, now, () => (offSeq.get(sid) ?? 0) !== seq)
      } catch {
        await logq($, sid, 'error', 'restore')
      } finally {
        dialogOpen.delete(sid)
      }
      if ((offSeq.get(sid) ?? 0) !== seq) {
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.' }
      }
      if (asked === 'timed-out') return { text: `Nothing changed: ${c.TIMED_OUT}.` }
      const got = (await getLane($)).value as Bound | null | undefined
      if (got) {
        // The hint takes the restored binding and the merged counters at once.
        await saveHint($, sid)
        return { text: c.reboundToast(got.name) }
      }
    }
  }
  const first = await attachPlan($, sid, want)
  if ('no' in first) return refuse(first.no)
  // With several leads the person picks one first: the picker and the Join question hold one dialog slot together.
  if (dialogOpen.has(sid)) return busy()
  dialogOpen.add(sid)
  let plan: Plan
  let r: Asked
  try {
    if ('choices' in first) {
      const picked = await pickLead($, first.choices)
      if (picked === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
      if (picked === 'error') {
        await log($, sid, 'refused', 'attach-not-confirmed')
        return { text: 'Cancelled. Nothing changed.' }
      }
      const p = await attachPlan($, sid, want, picked.name)
      if (!('name' in p)) return refuse('no' in p ? p.no : 'changed')
      plan = p
    } else plan = first
    r = await ask($, c.attachQuestion(plan.name, c.folderName(plan.cwd), c.folderName(plan.repo), plan.rename, plan.pick), c.ATTACH_YES, c.ATTACH_NO, c.HEADER.attach)
  } finally {
    dialogOpen.delete(sid)
  }
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'attach-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  if ((offSeq.get(sid) ?? 0) !== seq) {
    await log($, sid, 'refused', 'off-meanwhile')
    return { text: 'Nothing changed: callboard was turned off meanwhile.' }
  }
  // The question stayed open for a while: the same facts must still hold, and the same lead, repo, folder and name. A picked lead is looked for by its name.
  const now2 = await attachPlan($, sid, want, plan.pick)
  if ('no' in now2) return refuse(now2.no)
  if ('choices' in now2) return refuse('changed')
  if (now2.name !== plan.name || now2.rename !== plan.rename || now2.lead !== plan.lead || now2.leadName !== plan.leadName || now2.repo !== plan.repo || now2.cwd !== plan.cwd) return refuse('changed')
  // From here until the binding is written, no lead grant may start, and none may be under way.
  if (leadBusy(sid)) return refuse('lead-holder')
  if (laneBinding.has(sid)) return refuse('already-bound')
  laneBinding.add(sid)
  try {
    const now = await $.clock.now()
    // The record names this session (sid), so the lane rebinds itself when the session starts again; sid is not part of the record's hash.
    const rec: c.Lane & { createdAt: number } = { name: plan.name, folder: plan.cwd, brief: `${plan.cwd}/${c.ATTACH_BRIEF}`, repo: plan.repo, createdAt: now, adopted: true, lead: plan.lead, sid, ...(plan.leadName !== undefined ? { leadName: plan.leadName } : {}) }
    const recHash = await sha($, c.recordText(rec))
    const w = await editStore($, plan.key, async (cur) => {
      if (cur.state === 'bad') return { no: 'store-unreadable' }
      const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
      if (parsed && !parsed.ok) return { no: parsed.reason }
      const st = parsed?.ok ? parsed.store : undefined
      if (st && st.repo !== plan.repo) return { no: 'store-repo' }
      // As lane_create: a record whose folder no longer resolves is invisible to every reader and is dropped here.
      const kept = st ? await keptLanes($, st.lanes) : []
      if (kept.some((l) => l.name === plan.name)) return { no: 'name-taken' }
      if (kept.length >= c.STORE_MAX_LANES) return { no: 'lane-cap' }
      // The lead's name is read again under the lock: a lead renamed since the re-check must not be stamped with its old name.
      const rows = await withTimeout($, registryEntries($), c.ENGINE_CALL_TIMEOUT_MS)
      if (rows === 'timeout' || !rows) return { no: 'registry-unreadable' }
      if (c.leadNameOf(rows.map((e) => e.j), plan.lead) !== plan.leadName) return { no: 'changed' }
      // An attached lane is not a create: the creates list is carried over as it was.
      const text = JSON.stringify({ repo: plan.repo, lanes: [...kept, rec].map(c.storeLaneJson), creates: st?.creates ?? [] })
      if (text.length > c.STORE_MAX_BYTES) return { no: 'store-size' }
      return { text, landed: (s) => !!s?.lanes.some((l) => l.name === plan.name && l.adopted && l.lead === plan.lead && l.leadName === plan.leadName && l.folder === plan.cwd) }
    })
    // The undo of this Join's own write: the record it wrote goes again, with nothing bound to it.
    const undo = () => dropRecord($, plan.name, plan.key, recHash).catch(() => false)
    if ('no' in w) {
      // The write went through but the file does not show it: the record may be there, and nothing is bound to it.
      if (!w.wrote) return refuse(w.no)
      await log($, sid, 'refused', w.no)
      return { text: `Lane not changed: the record was not saved. ${(await undo()) ? 'It was removed.' : c.DETACH_INCOMPLETE}` }
    }
    // /callboard off during the write: the record goes again, and nothing is bound.
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await undo()
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    const binding = { name: plan.name, at: now, turns: -1, rec: recHash, adopted: true, lead: plan.lead }
    let written = false
    // Each engine call held inside the mark has a time limit (the command itself has none): a call that times out takes the failure path below.
    const limited = async <T,>(p: Promise<T>, what: string): Promise<T> => {
      const r = await withTimeout($, p, c.ENGINE_CALL_TIMEOUT_MS)
      if (r === 'timeout') {
        await logq($, sid, 'error', `attach-${what}-timeout`)
        throw new Error(`${what}-timeout`)
      }
      return r
    }
    try {
      await limited(bump($, (ct) => ({ ...ct, startDone: true })), 'counters')
      written = true
      const setting = setLane($, binding)
      const bw = await limited(setting, 'bind').catch((err: unknown) => {
        // A write that timed out may still land after the detach below: it is undone then.
        if (err instanceof Error && err.message === 'bind-timeout') undoLate($, sid, setting, binding)
        throw err
      })
      if (bw?.isSet !== false) await withTimeout($, keepLaneFacts($, sid, rec, true, plan.lead), c.ENGINE_CALL_TIMEOUT_MS)
      // An off that landed while the binding was being set could not unbind it: it ran before there was one.
      if ((offSeq.get(sid) ?? 0) !== seq) {
        await withTimeout($, detach($, sid, binding), c.ENGINE_CALL_TIMEOUT_MS)
        await undo()
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.' }
      }
      await limited(saveHint($, sid), 'hint')
    } catch {
      await logq($, sid, 'error', 'attach-bind')
      // From the binding write on, it may be there: detach clears it, its hint and the briefing facts. The detach has the same time limit; undo takes the record back.
      if (written) await withTimeout($, detach($, sid, binding).catch(() => undefined), c.ENGINE_CALL_TIMEOUT_MS)
      await undo()
      return { text: 'Lane not changed: the session could not be bound.' }
    }
    await withTimeout($, briefLane($, sid), c.ENGINE_CALL_TIMEOUT_MS)
    if (plan.rename) pendingRename.set(sid, { name: plan.name, until: now + c.RENAME_PENDING_MS })
    await log($, sid, 'attached', plan.name)
    toast($, `Lane ${plan.name} joined`)
    return { text: c.attachedText(plan.name, c.folderName(plan.cwd), c.folderName(plan.repo), plan.rename) }
  } finally {
    laneBinding.delete(sid)
  }
}

// ---- /callboard lead join [CONDUCTOR] and lead leave (ADR 0007) ----
// The person's own commands, typed in the lead. A Join only assigns: the same checks run before the question and again after the click, and a lead that has a
// conductor is refused. The write itself is ownerWrite (the ledger row, the record, the binding).

// The Join's last step, shared with the question after a Lead click: every check again, then the write. off-meanwhile when the person turned callboard off, or the grant
// ended, while the question was open; the write that landed in the meantime is then undone.
async function joinWrite($: any, sid: string, repo: string, cand: c.JoinCand, shownName: string | undefined, seq: number, epoch: number): Promise<{ ok: true } | { no: string }> {
  const ended = () => (offSeq.get(sid) ?? 0) !== seq || grants.get(sid)?.level !== 'lead' || epochOf(sid) !== epoch
  if ((offSeq.get(sid) ?? 0) !== seq) return { no: 'off-meanwhile' }
  if (ended()) return { no: 'changed' }
  const again = await joinPlanNow($, sid, repo, undefined, cand.sid)
  if ('no' in again.plan) return { no: again.plan.no }
  const now = 'cand' in again.plan ? again.plan.cand : undefined
  if (!now || now.sid !== cand.sid || now.name !== cand.name || now.home !== cand.home || again.leadName === undefined || again.leadName !== shownName) return { no: 'changed' }
  const w = await ownerWrite($, sid, { repo, name: again.leadName, how: 'joined', conductorSid: cand.sid, conductorName: cand.name })
  if ('no' in w) return w
  if (ended()) {
    const left = await ownerLeave($, sid, 'off').catch(() => undefined)
    if (left?.kept !== undefined) await log($, sid, 'error', `join-cleanup-kept ${c.hasText(left.kept) ? left.kept : 'other'}`)
    return { no: 'off-meanwhile' }
  }
  return { ok: true }
}

async function leadJoinCommand($: any, sid: string, code: c.OriginCode, arg: 'lead-leave' | { leadJoin: string | undefined }, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const refuse = async (reason: string) => {
    await log($, sid, 'refused', reason)
    return { text: c.joinRefusalText(reason) }
  }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `join-origin:${code}`)
    return { text: c.joinRefusalText('join-origin') }
  }
  const repo = pinOf(sid)
  if (grants.get(sid)?.level !== 'lead' || repo === undefined) return refuse('not-lead')
  if (arg === 'lead-leave') {
    const r = await ownerLeave($, sid, 'left')
    if (!r.had) return refuse(r.kept ?? 'no-owner')
    toast($, c.LEFT_TOAST)
    return { text: c.leftText(r.kept) }
  }
  const seq = offSeq.get(sid) ?? 0
  const epoch = epochOf(sid)
  const first = await joinPlanNow($, sid, repo, arg.leadJoin, undefined)
  if ('no' in first.plan) return refuse(first.plan.no)
  if (dialogOpen.has(sid)) return busy()
  dialogOpen.add(sid)
  let cand: c.JoinCand
  let r: Asked
  try {
    if ('choices' in first.plan) {
      const choices = first.plan.choices
      const picked = await pickFrom($, c.JOIN_PICK_QUESTION, choices.map((x) => c.joinLabel(x, first.home)), c.HEADER.join)
      if (picked === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
      if (picked === 'error' || 'extra' in picked) {
        await log($, sid, 'refused', 'join-not-confirmed')
        return { text: 'Cancelled. Nothing changed.' }
      }
      const p = await joinPlanNow($, sid, repo, arg.leadJoin, choices[picked.index].sid)
      if (!('cand' in p.plan)) return refuse('no' in p.plan ? p.plan.no : 'changed')
      cand = p.plan.cand
    } else cand = first.plan.cand
    r = await ask($, c.joinQuestion(first.leadName as string, repo, cand, first.home), c.JOIN_YES, c.JOIN_NO, c.HEADER.join)
  } finally {
    dialogOpen.delete(sid)
  }
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'join-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  const w = await joinWrite($, sid, repo, cand, first.leadName, seq, epoch)
  if ('no' in w) return refuse(w.no)
  await log($, sid, 'owner-joined', cand.name)
  toast($, c.joinedToast(first.leadName as string, cand))
  return { text: c.joinedText(first.leadName as string, cand) }
}

// The question after a Lead click: which conductor runs this lead, or none for now. Only for the person's own command and only for a lead that was just granted
// and has no conductor. It is one dialog: the pick is the click, and it names the conductor with its folder and short id. Anything but a pick changes nothing.
async function leadClickQuestion($: any, sid: string, res: { text: string; code?: string }): Promise<{ text: string; code?: string }> {
  const repo = pinOf(sid)
  if (grants.get(sid)?.level !== 'lead' || repo === undefined) return res
  const seq = offSeq.get(sid) ?? 0
  const epoch = epochOf(sid)
  if ((await bindingOf($, sid)) !== undefined) return res
  const first = await joinPlanNow($, sid, repo, undefined, undefined)
  if ('no' in first.plan) {
    if (first.plan.no !== 'lead-needs-name') return res
    // The hint is only worth giving when a conductor is live to join once the lead has a name.
    const live = await registryEntries($)
    const some = live ? (await joinCands($, live, sid, repo)).length > 0 : false
    return some ? { ...res, text: `${res.text}${c.JOIN_NOT_ASKED_NAME}` } : res
  }
  const list = 'cand' in first.plan ? [first.plan.cand] : first.plan.choices
  if (dialogOpen.has(sid)) return res
  dialogOpen.add(sid)
  let picked: Awaited<ReturnType<typeof pickFrom>>
  try {
    picked = await pickFrom($, c.JOIN_PICK_QUESTION, list.map((x) => c.joinLabel(x, first.home)), c.HEADER.join, c.JOIN_NONE)
  } finally {
    dialogOpen.delete(sid)
  }
  if (typeof picked === 'string' || 'extra' in picked) return { ...res, text: `${res.text}${c.JOIN_NOT_PICKED}` }
  const w = await joinWrite($, sid, repo, list[picked.index], first.leadName, seq, epoch)
  if ('no' in w) {
    await log($, sid, 'refused', w.no)
    return { ...res, text: `${res.text}\n${c.joinRefusalText(w.no)}` }
  }
  await log($, sid, 'owner-joined', list[picked.index].name)
  toast($, c.joinedToast(first.leadName as string, list[picked.index]))
  return { ...res, text: `${res.text}\n${c.joinedText(first.leadName as string, list[picked.index])}` }
}

// ---- /callboard manager [NAME] ----
// Any origin, as /callboard lead: the dialog is the gate the person answers, and another origin is named in its question. Refused before the dialog and again
// after a yes: in a bound lane, in a lead, in a session that ever was a lead (its lane tools stay declared: manager-after-lead), and while another live
// session holds a valid manager file (manager-exists). The grant lives in memory, and the person's yes also saves manager:<sid> (levelSave), so the
// same conversation asks again when it starts or resumes (managerRestoreAsk runs this function with restore set: the restore question, and its own log lines;
// `saved` is the hint it restores from: when it names this session's start folder and is younger than MANAGER.silentGraceMs, nothing is asked and every other
// check runs as after a yes). A restore's result also carries a `code` saying how it ended (the refusal, 'unanswered', 'cancelled'), which managerRestoreAsk
// reads to try again, wait for the person's next prompt or tell them; the person's own command gets no code. `mark` is the caller's note of this try: `asked` is set when a restore is
// not silent, so the caller can keep every later try of the same restore from being silent, and `yes` once the yes is given (or stands in for a silent
// restore), so the caller knows a failure came after it.
// After the grant the presence file must be written (one per machine rests on it), and a second manager that won the same moment makes both step back.
export async function managerCommand($: any, sid: string, code: c.OriginCode, want: string | undefined, busy: () => Promise<{ text: string }>, restore = false, alive: () => boolean = () => true, saved?: c.ManagerHint, mark?: { asked?: boolean; yes?: boolean }): Promise<{ text: string; code?: string }> {
  // The off counter before any await: for a restore with no question, an off typed during the checks below counts as one meanwhile.
  const seq = offSeq.get(sid) ?? 0
  await reservedGet($, sid, true)
  // With no NAME, a session whose registry name (one row) is already reserved keeps it; otherwise MANAGER. An unreadable registry
  // gives MANAGER here and is refused by the check below.
  const own = want === undefined ? ((await registryEntries($).catch(() => undefined)) ?? []).filter((e) => e.j.sessionId === sid) : []
  const name = want ?? (own.length === 1 && c.managerNameRefusal(own[0].j.name) === undefined ? (own[0].j.name as string) : c.MANAGER_DEFAULT)
  const coded = (text: string, code: string): { text: string; code?: string } => (restore ? { text, code } : { text })
  const refuse = async (why: string) => {
    await log($, sid, restore ? 'manager-restore-rejected' : 'refused', why)
    return coded(c.managerRefusalText(why), why)
  }
  if (c.managerNameRefusal(name)) return refuse('manager-name')
  // Another NAME changes nothing, and the answer says so.
  const cur = grants.get(sid)
  if (cur?.level === 'manager') return { text: c.managerAlreadyText(cur.name, want) }
  // marks: the lane and lead marks are this call's to read, not its own (the re-check below runs while it holds leadGranting).
  const held = async (marks: boolean): Promise<string | undefined> => {
    const no = await heldNo($, sid, 'manager', marks)
    if (no) return no
    const live = await registryEntries($)
    if (!live) return 'registry-unreadable'
    return (await managersLive($, live, sid)).length > 0 ? 'manager-exists' : undefined
  }
  const before = await held(true)
  if (before) return refuse(before)
  // A restore whose pending entry went while these checks ran (an /callboard off, a manager grant by hand) asks nothing.
  if (restore && !alive()) return { text: '' }
  // The folder the session started in: saved with the grant, and for a restore the folder the saved grant must name for it to come back with no question. A folder
  // that cannot be read (an error, no answer in time, an empty answer) is none (the grant is saved without one, and a restore asks).
  const root = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
  const here = typeof root === 'string' && root !== '' && root !== 'timeout' ? root : undefined
  const silent = restore && saved !== undefined && c.managerSilentOk(saved, here, await $.clock.now(), MANAGER.silentGraceMs)
  if (restore && !silent && mark) mark.asked = true
  let live: Awaited<ReturnType<typeof registryEntries>>
  let wasBusy = false
  const done = await grantDialog($, sid, MANAGER, {
    silent,
    seq: silent ? seq : undefined,
    question: restore ? c.MANAGER_RESTORE_QUESTION : c.askedFrom(c.MANAGER_QUESTION, code),
    yes: c.MANAGER_YES,
    no: c.MANAGER_NO,
    header: c.HEADER.manager,
    busy: () => {
      wasBusy = true
      return busy()
    },
    person: c.originIsPerson(code),
    on: () => grants.get(sid)?.level === 'manager',
    // A restore: only the person's Cancel removes the saved grant; no answer (a timeout, a dismissal, an error) restores nothing and keeps it, and
    // managerRestoreAsk tells the person and asks again after their next prompt.
    onNotYes: restore
      ? async (r) => {
          if (r === 'no') {
            await Promise.resolve($.store.delete(`${c.MANAGER_HINT_PREFIX}${sid}`)).catch(logFail($, sid, 'manager-hint-delete'))
            await log($, sid, 'manager-restore-cancelled')
          } else await log($, sid, 'manager-restore-unanswered')
          return { text: 'Manager stays off.', code: r === 'no' ? 'cancelled' : 'unanswered' }
        }
      : undefined,
    // The post-click re-check, as the lead's: the marks are read and set with no await between.
    postClick: () => {
      if (mark) mark.yes = true
      if (restore && !alive()) return refuse('changed')
      if (laneBinding.has(sid) || leadGranting.has(sid)) return refuse(laneBinding.has(sid) ? 'lane-holder' : 'lead-holder')
    },
    recheck: async () => {
      const after = await withTimeout($, held(false), c.ENGINE_CALL_TIMEOUT_MS)
      if (restore && !alive()) return refuse('changed')
      if (after !== undefined) return refuse(after === 'timeout' ? 'manager-check-slow' : after)
    },
    apply: async (offNow) => {
      let set: unknown
      try {
        set = await withTimeout($, managerTools($, sid), c.ENGINE_CALL_TIMEOUT_MS)
      } catch {
        set = 'error'
      }
      // A restore whose pending entry went while the tools registered (an off) grants nothing, as an off does.
      if (set !== undefined || offNow() || (restore && !alive())) {
        await logq($, sid, 'error', set === undefined ? 'off-meanwhile' : `manager-register-${set}`)
        return coded(c.MANAGER_FAILED, set === undefined ? 'off-meanwhile' : set === 'timeout' ? 'tools-timeout' : 'tools')
      }
      grants.set(sid, { level: 'manager', pins: [], name })
      if (here !== undefined) managerCwd.set(sid, here)
      else managerCwd.delete(sid)
      // A grant the person made while a restore question was still pending stands; the pending restore ends here.
      managerRestorePending.delete(sid)
      return epochOf(sid)
    },
    afterPresence: async (wrote, grantEpoch) => {
      const stepBack = async (why: string) => {
        if (epochOf(sid) === grantEpoch) await leadDrop($, sid)
        if (why !== 'manager-presence') return refuse(why)
        await log($, sid, 'error', why)
        return coded(c.MANAGER_FAILED, why)
      }
      if (epochOf(sid) !== grantEpoch) return { text: MANAGER.offText }
      if (wrote !== true) return stepBack('manager-presence')
      live = await registryEntries($)
      if (!live) return stepBack('registry-unreadable')
      if ((await managersLive($, live, sid)).length > 0) return stepBack('manager-exists')
      if (epochOf(sid) !== grantEpoch) return { text: MANAGER.offText }
    },
    onLog: [restore ? 'manager-restored' : 'manager-on', restore ? (silent ? 'silent' : '') : code],
    toast: restore ? c.MANAGER_RESTORED_TOAST : undefined,
    briefArg: name,
    // The rename cannot run inside the command: the tick runs it (as attach), unless the session already carries the name (a launch with -n NAME).
    after: async (grantEpoch) => {
      const mine = live!.filter((e) => e.j.sessionId === sid)
      if (mine.length === 1 && mine[0].j.name === name) await log($, sid, 'rename-skipped', 'manager')
      else pendingRename.set(sid, { name, until: (await $.clock.now()) + c.RENAME_PENDING_MS, manager: true })
      colorLater($, sid, grantEpoch)
    },
    text: c.MANAGER_ON_TEXT,
  })
  // The person's own command, once its dialog was answered or left unanswered, ends a restore that still waits: they decided by hand, whatever the answer,
  // so no restore question follows it. The saved grant stays (only the restore's Cancel and an off remove it).
  const waits = managerRestorePending.get(sid)
  if (!restore && !wasBusy && c.originIsPerson(code) && waits) {
    waits.byHand = true
    managerRestorePending.delete(sid)
  }
  return done
}

// /callboard conductor add|remove, the person's own command only (from the prompt or the phone); any other origin is refused with no dialog. add asks once
// (naming the whole list as it would be); remove asks nothing (it only narrows). Neither grants: the grant is /callboard conductor and its own dialog.
async function conductorListCommand($: any, sid: string, code: c.OriginCode, op: { add: string } | { remove: string }, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const verb = 'add' in op ? 'add' : 'remove'
  if (!c.originIsPerson(code)) return notPerson($, sid, 'conductor', code, c.CONDUCTOR_NOT_PERSON)
  const refuse = async (why: string, home = '') => {
    await log($, sid, 'refused', why)
    return { text: c.conductorRefusalText(why, home) }
  }
  const p = await where($)
  const h = p ? homeOf(p) : undefined
  const inConductor = (home: string) => grants.get(sid)?.level === 'conductor' && conductorHome.get(sid) === home
  if ('remove' in op) {
    const held = await heldNo($, sid, 'conductor', true)
    if (held) return refuse(held)
    const here = await conductorHere($)
    if ('no' in here) return refuse(here.no)
    const home = here.home
    let removed: string | undefined
    // The match is made on the file's entries alone, with no filesystem look, so a deleted or renamed repo can still be removed.
    const w = await writeConductorFile($, home, (entries) => {
      const arg = op.remove
      const hits = c.siblingName(arg) ? entries.filter((e) => c.entryPath(home, e).slice(c.entryPath(home, e).lastIndexOf('/') + 1) === arg) : entries.filter((e) => e === arg || c.entryPath(home, e) === c.entryPath(home, arg))
      if (hits.length !== 1) return { no: 'conductor-not-listed' }
      removed = hits[0]
      return entries.filter((e) => e !== removed)
    })
    if ('no' in w) return w.no.startsWith('conductor-file-') && w.no !== 'conductor-file-bad' ? (await log($, sid, 'error', w.no), { text: c.conductorRefusalText(w.no, home) }) : refuse(w.no, home)
    await log($, sid, 'conductor-remove', code)
    if (inConductor(home) && removed !== undefined) {
      const gone = c.entryPath(home, removed)
      const was = conductorApproved.get(sid) ?? []
      if (was.includes(gone)) {
        conductorApproved.set(sid, was.filter((x) => x !== gone))
        await levelSave($, sid, CONDUCTOR)
      }
      await conductorReach($, sid).catch(() => undefined)
    }
    return { text: c.conductorRemovedText(removed ?? op.remove) }
  }
  const plan = await conductorAddPlan($, sid, op.add, true)
  if ('no' in plan) return refuse(plan.no, plan.home)
  // The click approves the repo for this session only when the dialog said so and the grant is the same one after it.
  const askedHere = inConductor(plan.home)
  const askedEpoch = epochOf(sid)
  const r = await askOnce($, sid, c.conductorAddQuestion(plan.home, plan.target, plan.list, h, askedHere), c.CONDUCTOR_ADD_YES, c.CONDUCTOR_ADD_NO, c.HEADER.conductor)
  if (r === 'busy') return busy()
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'conductor-add-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  // Every check again after the click; the target must be the one the dialog named.
  const again = await conductorAddPlan($, sid, op.add, true)
  if ('no' in again) return refuse(again.no, again.home ?? plan.home)
  if (again.home !== plan.home || again.target !== plan.target) return refuse('conductor-file-changed', plan.home)
  const w = await writeConductorFile($, plan.home, (entries) => {
    const paths = entries.map((e) => c.entryPath(plan.home, e))
    const nest = c.nestRefusal(plan.home, paths, plan.target)
    if (nest) return { no: nest }
    if (entries.length + 1 > c.CONDUCTOR_REPOS_MAX) return { no: 'conductor-cap' }
    return [...entries, c.entryFor(plan.home, plan.target)]
  })
  if ('no' in w) return w.no.startsWith('conductor-file-') && w.no !== 'conductor-file-bad' ? (await log($, sid, 'error', w.no), { text: c.conductorRefusalText(w.no, plan.home) }) : refuse(w.no, plan.home)
  await log($, sid, 'conductor-add', code)
  // In a conductor session the click also approves the repo for this session.
  const here = askedHere && inConductor(plan.home) && epochOf(sid) === askedEpoch
  if (here) {
    const was = conductorApproved.get(sid) ?? []
    if (!was.includes(plan.target)) conductorApproved.set(sid, [...was, plan.target])
    await levelSave($, sid, CONDUCTOR)
    await conductorReach($, sid).catch(() => undefined)
  }
  return { text: c.conductorAddedText(plan.home, plan.target, h, here) }
}

// After a lead or conductor grant that carried a NAME: the session is renamed by the tick (renameTick), as the manager's, unless it already carries the name.
async function nameRename($: any, sid: string, name: string, grant: 'lead' | 'conductor') {
  const mine = ((await registryEntries($).catch(() => undefined)) ?? []).filter((e) => e.j.sessionId === sid)
  if (mine.length === 1 && mine[0].j.name === name) await log($, sid, 'rename-skipped', grant)
  else pendingRename.set(sid, { name, until: (await $.clock.now()) + c.RENAME_PENDING_MS, grant })
}

// /callboard conductor, the grant. Any origin, as /callboard lead: the dialog is the gate the person answers, and another origin is named in its question.
// The dialog names every repo in reach (../NAME beside the conductor repo, any other in full; nothing cut). A yes approves exactly that list for this session; the
// file can only narrow it later. In a conductor session the command opens the dialog again only when the file names repos this session has not approved, and
// only from the person's own prompt or phone: another origin never widens a conductor.
// `want`: a NAME typed with the command (the person's own prompt or phone only, checked by the caller). It is judged before the dialog and again after the
// click, the dialog names it, and after the grant the session is renamed to it. A session that is a conductor already is not renamed this way.
async function conductorGrant($: any, sid: string, code: c.OriginCode, busy: () => Promise<{ text: string }>, want?: string): Promise<{ text: string }> {
  const on = () => grants.get(sid)?.level === 'conductor'
  const refuse = async (why: string, home = '', out: CondOut[] = []) => {
    await log($, sid, 'refused', why)
    return { text: `${c.conductorRefusalText(why, home, on() ? 'Conductor stays on' : 'Conductor stays off')}${c.conductorOutText(out)}` }
  }
  const nameNo = async (why: string) => {
    await log($, sid, 'refused', why)
    return { text: `Conductor stays off: ${c.grantNameText(why)}` }
  }
  if (want !== undefined && on()) {
    await log($, sid, 'refused', 'conductor-name-on')
    return { text: c.GRANT_NAME_ON('Conductor') }
  }
  const p = await where($)
  const h = p ? homeOf(p) : undefined
  const first = await conductorShowable($, sid, true)
  if ('no' in first) return refuse(first.no, first.home, first.out)
  const home = first.home
  if (want !== undefined) {
    await reservedGet($, sid, true)
    const bad = await grantNameNo($, sid, want)
    if (bad !== undefined) return nameNo(bad)
  }
  if (on()) {
    const approved = conductorApproved.get(sid) ?? []
    if (!c.originIsPerson(code) || first.ok.every((x) => approved.includes(x))) {
      const reach = await conductorReach($, sid)
      return { text: 'no' in reach ? c.conductorRefusalText('conductor-list', home, 'Conductor stays on') : c.conductorReachText(home, reach.pins, h, reach.out) }
    }
  }
  const approvedNow = on() ? (conductorApproved.get(sid) ?? []) : []
  const question = c.askedFrom(c.conductorQuestion(home, first.ok, h, on() ? first.ok.filter((x) => !approvedNow.includes(x)) : [], want), code)
  if (question.length > c.QUESTION_MAX) return refuse('conductor-list-too-long', home)
  let fresh!: { home: string; ok: string[] }
  return grantDialog($, sid, CONDUCTOR, {
    question,
    yes: c.CONDUCTOR_YES,
    no: c.CONDUCTOR_NO,
    header: c.HEADER.conductor,
    busy,
    person: c.originIsPerson(code),
    on,
    // The post-click re-check, as the lead's and the manager's: the marks are read and set with no await between.
    postClick: () => (laneBinding.has(sid) || leadGranting.has(sid) ? refuse(laneBinding.has(sid) ? 'lane-holder' : 'lead-holder', home) : undefined),
    recheck: async () => {
      const again = await withTimeout($, conductorShowable($, sid, false), c.ENGINE_CALL_TIMEOUT_MS)
      if (again === 'timeout') return refuse('conductor-file-error', home)
      if ('no' in again) return refuse(again.no, again.home ?? home, again.out)
      fresh = again
      if (want !== undefined) {
        const bad = await withTimeout($, grantNameNo($, sid, want), c.ENGINE_CALL_TIMEOUT_MS)
        if (bad !== undefined) return nameNo(bad === 'timeout' ? 'name-check-slow' : bad)
      }
    },
    apply: async () => {
      // The list resolved now must be the list the dialog showed.
      // The same repos in another order (a writer sorts the file) are no change.
      if (fresh.home !== home || [...fresh.ok].sort().join('\n') !== [...first.ok].sort().join('\n')) return refuse('conductor-changed', home)
      // conductorApply sets the grant only while the epoch is still this one, so it is the grant's epoch.
      const epoch = epochOf(sid)
      const a = await conductorApply($, sid, home, first.ok, first.ok, epoch)
      if (a !== 'ok') {
        await logq($, sid, 'error', `conductor-register-${a}`)
        return { text: c.CONDUCTOR_FAILED }
      }
      // A grant the person made while a restore question was still pending stands, as the lead's does; the pending restore ends here,
      // so a later Cancel on its question cannot delete this grant's saved key.
      conductorRestorePending.delete(sid)
      return epoch
    },
    onLog: ['conductor-on', code],
    briefArg: home,
    after: async () => {
      if (want !== undefined) await nameRename($, sid, want, 'conductor')
      await nameGrant($, sid)
    },
    text: `${c.CONDUCTOR_ON_TEXT}${c.conductorOutText(first.out)}`,
  })
}

// /callboard config. Reading works from any origin and logs nothing (as status). A change is the person's own: from the prompt or the phone it is applied,
// from a plugin, another session or a script it is refused with a fixed text and no dialog. That is a convenience, not a control: any same-uid process can
// write the key itself, and the field bounds are what limit it. The change is a read-modify-write right before the write (two sessions in the same second: the
// last write wins), and the two levels are checked against each other as stored.
async function configCommand($: any, sid: string, code: c.OriginCode, op: c.ConfigOp): Promise<{ text: string }> {
  if (op === 'show') {
    // Escalation is on when it is stored or the default holds (the guard), and the OFF file is not there.
    const on = (await escalationNow($)).a !== undefined && !(await promptsOff($))
    return { text: c.configText(await cfgGet($, sid, true), on) }
  }
  if (op === 'bad') return { text: c.CONFIG_USAGE }
  if (!c.originIsPerson(code)) return notPerson($, sid, 'config', code, c.CONFIG_NOT_PERSON)
  // Each store call runs inside an async function, so a call that throws at once is answered like one that rejects.
  const raw = await withTimeout($, (async () => $.store.get(c.CONFIG_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw === 'timeout') return { text: c.CONFIG_UNREADABLE }
  const cur = c.parseConfig(raw).cfg
  let next: c.Config
  if (op === 'reset') next = { ...c.CONFIG_DEFAULTS }
  else if (op.field === 'keepalive' || op.field === 'checkin' || op.field === 'conductorLeads') next = { ...cur, [op.field]: op.value }
  else {
    const no = c.configLevelRefusal(op, cur)
    if (no) return { text: no }
    next = { ...cur, [op.field]: op.value }
  }
  const now = await $.clock.now()
  const w = await withTimeout($, (async () => $.store.set(c.CONFIG_KEY, { ...next, savedAt: now }))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'failed' as const)
  if (w !== 'ok') {
    await logq($, sid, 'error', `config-write-${w}`)
    return { text: c.CONFIG_UNSAVED }
  }
  mem.cfg = next
  mem.cfgReadAt = now
  const field = op === 'reset' ? 'reset' : op.field
  await logq($, sid, 'config-set', `${field}:${code}`)
  return { text: op === 'reset' ? c.CONFIG_RESET_TEXT : c.configSetText(op.field, next) }
}

// /callboard reserve, this machine's reserved names. Showing works from any origin and logs nothing; a change is the person's own,
// as /callboard config (the same convenience, not a control: any same-uid process can write the key, and parseReserved bounds what it can hold). An add is
// refused while a lane record, a lead stamp or a live lead carries the name in any letter case: a lead would lose its lead name and its lanes with it.
async function reserveCommand($: any, sid: string, code: c.OriginCode, op: c.ReserveOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.RESERVE_USAGE }
  if (op === 'show') return { text: c.reserveShowText(await reservedGet($, sid, true)) }
  if (!c.originIsPerson(code)) return notPerson($, sid, 'reserve', code, c.RESERVE_NOT_PERSON)
  // The list as stored now: also what managerNameOf reads for the remove guard below.
  await reservedGet($, sid, true)
  const raw = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw === 'timeout') return { text: c.RESERVE_UNREADABLE }
  const cur = c.parseReserved(raw)
  const key = ('remove' in op ? op.remove : op.add).toUpperCase()
  if ('remove' in op) {
    const hit = cur.find((x) => x.toUpperCase() === key)
    if (!hit) return { text: c.reserveNotListedText(op.remove) }
    // The live manager's name stays reserved while it runs, or leads would stop trusting it with nothing said.
    const live = await registryEntries($)
    if (!live) return { text: c.RESERVE_UNREADABLE }
    const mgrs = await managersLive($, live, '')
    if (mgrs.some((m) => m.unverified)) return { text: c.RESERVE_UNREADABLE }
    if (mgrs.some((m) => m.name?.toUpperCase() === key)) return { text: c.reserveManagerText(hit) }
  } else {
    const name = op.add
    let inUse: string | undefined
    const lanes = await loadLanes($)
    if (typeof lanes === 'string') return { text: c.RESERVE_UNREADABLE }
    // Judged by skeleton, as enforcement is, so a look-alike in use (LEAD2 for LEAD) counts too.
    const hit = (n: unknown) => typeof n === 'string' && c.reservedHit(n, [name])
    const rec = lanes.find((l) => hit(l.name) || hit(l.leadName))
    if (rec) inUse = hit(rec.name) ? `lane ${rec.name}` : `the lead stamp on lane ${rec.name}`
    if (!inUse) {
      const live = await registryEntries($)
      if (!live) return { text: c.RESERVE_UNREADABLE }
      const errs = { error: false }
      const leads = await leadsFor($, live, undefined, undefined, errs)
      if (errs.error) return { text: c.RESERVE_UNREADABLE }
      const rows = live.map((r) => r.j)
      const lead = leads.flatMap((x) => rows.filter((j) => j?.sessionId === x.sid && hit(j.name))).at(0)
      if (lead) inUse = `the live lead ${lead.name}`
    }
    const no = c.reserveAddRefusal(name, cur, inUse)
    if (no) return { text: no }
  }
  // The checks above take time; apply the change to the list as stored right now, so a change another session made meanwhile is kept.
  const raw2 = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw2 === 'timeout') return { text: c.RESERVE_UNREADABLE }
  const fresh = c.parseReserved(raw2)
  let next: string[]
  if ('remove' in op) next = fresh.filter((x) => x.toUpperCase() !== key)
  else {
    const no = c.reserveAddRefusal(op.add, fresh, undefined)
    if (no) return { text: no }
    next = [...fresh, op.add]
  }
  const now = await $.clock.now()
  const w = await withTimeout($, (async () => $.store.set(c.RESERVE_KEY, { names: next, savedAt: now }))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'failed' as const)
  if (w !== 'ok') {
    await logq($, sid, 'error', `reserve-write-${w}`)
    return { text: c.RESERVE_UNSAVED }
  }
  mem.reservedGen++
  c.setLocalReserved(next)
  mem.reservedReadAt = now
  await logq($, sid, 'add' in op ? 'reserve-add' : 'reserve-remove', code)
  return { text: 'add' in op ? c.reserveAddedText(op.add) : c.reserveRemovedText(cur.find((x) => x.toUpperCase() === op.remove.toUpperCase())!) }
}

// A time for the person, in this machine's zone.
const whenLocal = (ms: number): string => go.goWhen(ms, -new Date(ms).getTimezoneOffset())

// /callboard unattended (the person's own command: the state of the window), /callboard unattended on (the person's own, behind its dialog) and /callboard
// unattended off (any origin, no dialog: it only narrows, bringing the questions back to the person). Anything else is the usage line.
async function unattendedCommand($: any, sid: string, code: c.OriginCode, op: pr.UnattendedOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.usageLine('unattended') }
  if (typeof op === 'object') return unattendedOnCommand($, sid, code, op.on)
  if (op === 'off') {
    const marked = await unattendedOffMark($)
    const r = await unattendedClose($, { code: 'command', origin: code })
    if (r === 'store-failed') await logq($, sid, 'error', 'unattended-store')
    if (r === 'store-failed') return { text: pr.UNATTENDED_OFF_FAILED }
    return { text: `${r === 'closed' ? pr.UNATTENDED_ENDED : pr.UNATTENDED_NOT_ON}${marked ? '' : ` ${pr.UNATTENDED_OFF_MARK_FAILED}`}` }
  }
  if (!c.originIsPerson(code)) return notPerson($, sid, 'unattended', code, pr.UNATTENDED_NOT_PERSON)
  const w = await unattendedNow($)
  const list = await unattendedList($, w).catch(() => pr.UNATTENDED_LIST_UNREAD)
  return { text: `${pr.unattendedState(w, whenLocal)}${list === undefined ? '' : `\n\n${list}`}` }
}
// What unattended mode needs, read before its dialog and again after the click: off now; escalation on for every lane, lead and question, with no OFF file; a
// live manager with a trusted name (the ladder's own filter); check-ins on, as the watchdog; no relay open and no tier asking the person. manager: the name
// the dialog shows. lanes: each lead with live lanes and how many (undefined: the lane records could not be read).
type OnPre = { ok: true; manager: string; lanes?: { lead: string; n: number }[] } | { ok: false; why: pr.UnattendedNo; extra?: string }
async function unattendedPre($: any, sid: string): Promise<OnPre> {
  const w = await unattendedNow($, true)
  if (w.state !== 'off') return { ok: false, why: w.state === 'on' ? 'on' : 'unread', extra: pr.unattendedState(w, whenLocal) }
  const esc = await escalationNow($)
  const offFile = await promptsOff($)
  if (!esc.a || esc.a.scope !== 'all' || esc.a.asksScope !== 'all') return { ok: false, why: 'escalation', extra: pr.escalationState(esc.a, offFile, esc.source, esc.why) }
  if (offFile) return { ok: false, why: 'off-file' }
  const live = await registryEntries($)
  if (!live) return { ok: false, why: 'registry' }
  const manager = (await managersLive($, live, '').catch(() => [])).find((m) => m.unverified !== true && m.name !== undefined)?.name
  if (manager === undefined) return { ok: false, why: 'manager' }
  // A settings read that fails permits nothing: the cached or default check-in value is not taken.
  const cfg = await cfgReadStrict($, sid)
  if (!cfg) return { ok: false, why: 'config' }
  if (!cfg.checkin) return { ok: false, why: 'checkin' }
  const busy = await unattendedBusy($)
  if (busy !== 'none') return { ok: false, why: busy === 'unread' ? 'prompts' : busy }
  const lanes = await loadLanes($).catch(() => 'error')
  if (typeof lanes === 'string') return { ok: true, manager }
  const entries = live.flatMap((r) => (typeof r.j.sessionId === 'string' ? [regEntry(r)] : []))
  const byLead = new Map<string, c.Lane[]>()
  for (const l of lanes) if (l.leadName !== undefined) byLead.set(l.leadName, [...(byLead.get(l.leadName) ?? []), l])
  return { ok: true, manager, lanes: [...byLead].map(([lead, ls]) => ({ lead, n: c.liveLaneNames(ls, entries).length })).filter((x) => x.n > 0).sort((a, b) => a.lead.localeCompare(b.lead)) }
}

// /callboard unattended on: from the person's own prompt or phone only. The end is fixed when the dialog opens; after the click every precondition is read
// again, an off that came while the dialog was open wins, and the window then opens with the manager the dialog named. Each refusal stores nothing.
async function unattendedOnCommand($: any, sid: string, code: c.OriginCode, end: pr.UnattendedEnd): Promise<{ text: string }> {
  if (!c.originIsPerson(code)) return notPerson($, sid, 'unattended', code, pr.UNATTENDED_ON_NOT_PERSON)
  const asked = await $.clock.now()
  const until = pr.unattendedEndAt(end, asked)
  if (until === undefined) return { text: pr.UNATTENDED_SPAN }
  const no = async (why: pr.UnattendedNo, extra?: string) => {
    await logq($, sid, 'refused', `unattended-on:${why}`)
    return { text: pr.unattendedNoText(why, extra) }
  }
  const pre = await unattendedPre($, sid)
  if (!pre.ok) return no(pre.why, pre.extra)
  const closes = unattendedClosesNow()
  const r = await askLimited($, sid, pr.unattendedQuestion(whenLocal(until), pre.manager, pre.lanes), {
    yes: pr.UNATTENDED_YES,
    no: pr.UNATTENDED_NO,
    header: pr.UNATTENDED_HEADER,
    ms: pr.UNATTENDED_DIALOG_MS,
    timedOut: pr.UNATTENDED_TIMED_OUT_TOAST,
    late: pr.UNATTENDED_LATE_TOAST,
  })
  if (r !== 'yes') return no(r === 'busy' ? 'busy' : r === 'timed-out' ? 'timed-out' : 'cancelled')
  const again = await unattendedPre($, sid)
  if (!again.ok) return no(again.why, again.extra)
  if (again.manager !== pre.manager) return no('manager-changed')
  // The last look before the window opens: an off typed in any session since the dialog opened.
  const offed = await unattendedOffSince($, asked, closes)
  if (offed !== false) return no(offed === true ? 'off-typed' : 'unread')
  // The window's span is measured from when the person asked, so the time the dialog was open does not count against its least length.
  const now = await $.clock.now()
  const value: pr.Unattended = { v: 1, from: asked, until, by: code === 'phone' ? 'phone' : 'prompt', manager: pre.manager, savedAt: now }
  const opened = await unattendedOpen($, value)
  if (!opened.ok) {
    await logq($, sid, 'error', `unattended-open:${opened.why}`)
    return { text: pr.unattendedNoText(opened.why) }
  }
  // An off that ran while the window was being written found nothing to end: it still wins, and the window it missed is ended here.
  const late = await unattendedOffSince($, asked, closes)
  if (late !== false) {
    if (await unattendedVoid($, value, 'off-during-open')) return no(late === true ? 'off-typed' : 'unread')
    await logq($, sid, 'error', 'unattended-open:store-void')
    return { text: pr.unattendedNoText('store-void') }
  }
  await logq($, sid, 'command', `unattended-on:${code}`)
  return { text: pr.unattendedOnText(whenLocal(until), pre.manager, opened.u) }
}

// unattended_off: the manager's main agent ends the window, as /callboard unattended off does, when the person tells it in their own turn that they are back.
// It can only end one. A subagent and any other level are refused. The result gives the counts of what the window did, never a lane's text.
export async function unattendedOffCall($: any, e: any) {
  const sid = await $.session.id()
  ensureTimer($)
  if ((e as { agentId?: string }).agentId !== undefined) {
    await logq($, sid, 'refused', 'unattended-off-subagent')
    return { deny: pr.UNATTENDED_OFF_SUBAGENT }
  }
  if (grants.get(sid)?.level !== 'manager') {
    await logq($, sid, 'refused', 'unattended-off-not-manager')
    return { deny: pr.UNATTENDED_OFF_NOT_MANAGER }
  }
  const w = await unattendedNow($, true)
  const marked = await unattendedOffMark($)
  const r = await unattendedClose($, { code: 'manager' })
  if (r === 'store-failed') {
    await logq($, sid, 'error', 'unattended-store')
    return { deny: pr.UNATTENDED_OFF_FAILED }
  }
  const unmarked = marked ? '' : ` ${pr.UNATTENDED_OFF_MARK_FAILED}`
  if (r === 'none') return { result: `${pr.UNATTENDED_NOT_ON}${unmarked}` }
  await logq($, sid, 'command', 'unattended-off:manager')
  const p = w.state === 'on' ? await where($) : undefined
  const rows = p && w.state === 'on' ? await ledgerRowsFor($, p, `"u":"${w.u}"`) : 'unreadable'
  return { result: `${pr.UNATTENDED_ENDED} ${w.state === 'on' && rows !== 'unreadable' ? pr.unattendedCounts(w.u, rows) : pr.UNATTENDED_COUNTS_UNREAD}${unmarked}` }
}

// What the live window did, or the last one on record in this month's and last month's ledgers: three bounded reads (the windows opened, the rows that carry
// this window's short id, the reads that gave no answer). undefined: no window is on record.
async function unattendedList($: any, w: pr.Window): Promise<string | undefined> {
  const p = await where($)
  if (!p) return pr.UNATTENDED_LIST_UNREAD
  let u = w.state === 'on' ? w.u : undefined
  if (u === undefined) {
    const opened = await ledgerRowsFor($, p, '"kind":"unattended-on"')
    if (opened === 'unreadable') return pr.UNATTENDED_LIST_UNREAD
    const last = opened.filter((r) => r.kind === 'unattended-on' && typeof r.u === 'string' && pr.U_RE.test(r.u)).sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0)).pop()
    if (!last) return undefined
    u = last.u as string
  }
  const rows = await ledgerRowsFor($, p, `"u":"${u}"`)
  const unknown = await ledgerRowsFor($, p, '"kind":"unattended-unknown"')
  return pr.unattendedListText({ u, live: w.state === 'on', rows: rows === 'unreadable' ? undefined : rows, unknown: unknown === 'unreadable' ? undefined : unknown, when: whenLocal })
}

// /callboard escalation (the person's own command, one dialog) and /callboard escalation off (any origin, no dialog). One Allow stores scope `all` for permission prompts and questions alike;
// the two ledger rows are the ones the audit reads (the plain `answering-on`, then the one with code asks that opens the questions).
async function escalationCommand($: any, sid: string, code: c.OriginCode, op: pr.EscalationOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: pr.ESCALATION_USAGE }
  // Off narrows only: any origin, no dialog. It stores an explicit off in place of the switch, so deleting the OFF file later does not turn escalation back on,
  // and with nothing stored the default (on, behind the guard) does not come back either.
  if (op === 'off') {
    try {
      await $.store.set(ANSWERING_KEY, { off: true, savedAt: await $.clock.now() })
    } catch {
      await logq($, sid, 'error', 'escalation-store')
      // The command is an off for an unattended window whether or not its own write landed.
      const ended = await unattendedClose($, { code: 'escalation-off', origin: code }).catch(() => 'store-failed' as const)
      return { text: `Escalation could not be changed: the store did not answer. Create ~/.claude/callboard/prompts/OFF to stop it now.${ended === 'closed' ? ` ${pr.UNATTENDED_ENDED}` : ended === 'store-failed' ? ` ${pr.UNATTENDED_OFF_FAILED}` : ''}` }
    }
    if (!(await ledgerAdd($, { kind: 'answering-off', code: 'off' }))) await logq($, sid, 'error', 'escalation-ledger')
    // An unattended window needs escalation: this off ends it.
    const ended = await unattendedClose($, { code: 'escalation-off', origin: code }).catch(() => 'store-failed' as const)
    return { text: `Escalation is off on this Mac.${ended === 'closed' ? ` ${pr.UNATTENDED_ENDED}` : ended === 'store-failed' ? ` ${pr.UNATTENDED_OFF_FAILED}` : ''}` }
  }
  // On is the person's own command, with a dialog that names exactly what turns on.
  if (!c.originIsPerson(code)) return notPerson($, sid, 'escalation', code, pr.ESCALATION_NOT_PERSON)
  const r = await askOnce($, sid, pr.ESCALATION_QUESTION, pr.ESCALATION_YES, pr.ESCALATION_NO, pr.ESCALATION_HEADER)
  if (r === 'busy') return { text: 'A callboard question is already open. Answer it first.' }
  if (r !== 'yes') return { text: r === 'timed-out' ? 'Nothing changed: the question timed out.' : 'Cancelled. Nothing changed.' }
  // `asks: false` stays in the value so that an older mod after a rollback still reads it.
  const value: pr.Answering = { scope: 'all', asks: false, asksScope: 'all', leadAsks: true, savedAt: await $.clock.now() }
  // What was stored before (an earlier value, narrower or not) is kept to put back if the rows cannot be written.
  let before: unknown
  try {
    before = await $.store.get(ANSWERING_KEY)
    await $.store.set(ANSWERING_KEY, value)
  } catch {
    return { text: 'Escalation could not be turned on: the store did not answer. Nothing changed.' }
  }
  // The dialog took time: an `escalation off` typed meanwhile is overridden by this Allow, the person's own last word.
  // Both rows must land, plain first: the audit reads a question as covered only by the asks row, and a switch with no row is an anomaly. Else the value before stays.
  const hash = await sha($, pr.canonical(value)).catch(() => undefined)
  const plainRow = await ledgerAdd($, { kind: 'answering-on', hash })
  if (!plainRow || !(await ledgerAdd($, { kind: 'answering-on', code: 'asks', hash }))) {
    await logq($, sid, 'error', 'escalation-ledger')
    try {
      if (before === undefined || before === null) {
        await $.store.delete(ANSWERING_KEY)
        // Nothing stored means the default again; the ledger rows are put right by the next read.
        await defaultForget($)
      } else await $.store.set(ANSWERING_KEY, before)
    } catch {
      return { text: 'Escalation could not be turned on, and the store would not take it back: the ledger did not answer. Whether escalation is on is now unknown. Create ~/.claude/callboard/prompts/OFF to stop it now.' }
    }
    // The plain row may already be in the ledger, which would then read as a wider "on" than the value put back: it gets rows for that value (best effort, the ledger just failed once).
    if (plainRow && before !== undefined && before !== null && !(await ledgerRestore($, before))) await logq($, sid, 'error', 'escalation-ledger-restore')
    return { text: 'Escalation could not be turned on: the ledger did not answer. Nothing changed.' }
  }
  return { text: `${pr.escalationState(value, await promptsOff($))} ${c.DIALOG_LINE}` }
}

// /callboard here (the person's own command, in a lead's, conductor's or manager's session) and /callboard here off (any origin: it only narrows). On: the
// `here-on` row first, then the one store key, which replaces the session that was here before. Off: the key goes first, then its `here-off` row.
async function hereCommand($: any, sid: string, code: c.OriginCode, op: pr.HereOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: pr.HERE_USAGE }
  const before = await hereRead($)
  if (op === 'off') {
    try {
      if ((await withTimeout($, (async () => $.store.delete(pr.HERE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS)) === 'timeout') throw new Error('timeout')
    } catch {
      await logq($, sid, 'error', 'here-store')
      return { text: pr.HERE_OFF_FAILED }
    }
    if (before === undefined) return { text: pr.HERE_OFF_NONE }
    // A key that could not be read may have named a session: its end gets a row too, with no session in it.
    if (!(await ledgerAdd($, { kind: 'here-off', code: 'off', by: sid, ...(before === 'error' ? {} : { was: before.sid }) }))) await logq($, sid, 'error', 'here-ledger')
    await logq($, sid, 'here-off', code)
    return { text: pr.HERE_OFF_TEXT }
  }
  // On is the person's own command: any other origin is refused before any write.
  if (!c.originIsPerson(code)) return notPerson($, sid, 'here', code, pr.HERE_NOT_PERSON)
  const level = grants.get(sid)?.level
  if (level !== 'lead' && level !== 'conductor' && level !== 'manager') {
    await logq($, sid, 'refused', 'here-no-tier')
    return { text: pr.HERE_NO_TIER }
  }
  const epoch = epochOf(sid)
  const at = await $.clock.now()
  const until = at + pr.HERE_HOURS * c.HOUR_MS
  const name = grants.get(sid)?.name
  if (!(await ledgerAdd($, { kind: 'here-on', by: sid, tier: level, end: new Date(until).toISOString(), ...(typeof name === 'string' && name !== '' ? { lane: name } : {}) }))) {
    await logq($, sid, 'error', 'here-ledger')
    return { text: pr.HERE_LEDGER_FAILED }
  }
  // A key that cannot be written, or a grant that went while it was, leaves no `here`: the session is marked (a write that timed out may still land, and
  // the mark keeps it from counting), a key that may be there is removed, and the row gets its end.
  // The write may have replaced the key of the session that was here before: unless that key is read back, that session's `here` has ended too, which gets
  // its own row and a sentence in the reply.
  const prev = before !== 'error' && before !== undefined && before.sid !== sid ? before.sid : undefined
  const undo = async (text: string, drop: boolean) => {
    hereGone.add(sid)
    if (drop) await hereDrop($, sid)
    await ledgerAdd($, { kind: 'here-off', code: 'void', by: sid, was: sid })
    await logq($, sid, 'error', 'here-void')
    if (prev === undefined) return { text }
    const now = await hereRead($)
    if (now !== 'error' && now?.sid === prev) return { text }
    if (!(await ledgerAdd($, { kind: 'here-off', code: 'void', by: sid, was: prev }))) await logq($, sid, 'error', 'here-ledger')
    return { text: `${text} ${pr.HERE_PREV_ENDED}` }
  }
  const value: pr.Here = { v: 1, sid, at, until }
  hereGone.delete(sid)
  let wrote: unknown
  try {
    wrote = await withTimeout($, (async () => $.store.set(pr.HERE_KEY, value))(), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return undo(pr.HERE_STORE_FAILED, false)
  }
  if (wrote === 'timeout') return undo(pr.HERE_STORE_FAILED, true)
  if (grants.get(sid)?.level !== level || epochOf(sid) !== epoch) return undo(pr.HERE_GRANT_CHANGED, true)
  // The session that was here before is here no longer: its end gets a row.
  if (prev !== undefined && !(await ledgerAdd($, { kind: 'here-off', code: 'moved', by: sid, was: prev }))) await logq($, sid, 'error', 'here-ledger')
  await logq($, sid, 'here-on', code)
  return { text: pr.hereOnText(go.goWhen(until, -new Date(until).getTimezoneOffset()), prev !== undefined) }
}

// What a caller other than the person's command adds to a lead grant (the new panel taking a conductor's offer, engine/lead-accept.ts): the grant's question is
// skipped (silent) with the off counter as it stood when the caller began (seq), the folder is pinned as given, and the caller's own checks run among the
// grant's: extraRecheck with the dialog's re-checks, extraApply last of all before the grant is set, with no await between it and the set.
export type LeadGrantOpts = {
  silent?: boolean
  seq?: number
  pinned?: string
  onLog?: [string, string]
  toast?: string
  extraRecheck?: () => Promise<{ text: string; code?: string } | undefined>
  extraApply?: () => Promise<{ text: string; code?: string } | undefined>
  // A NAME typed with the command (the person's own prompt or phone only, checked by the caller): judged before the dialog and after the click, named in the
  // question, and given to the session by a rename after the grant. A session that is a lead already is not renamed this way.
  want?: string
}
type Said = { text: string; code?: string }

// The person's `/callboard lead`: the checks before the question, then the grant dialog. Every lead grant goes through here. A refusal carries its code beside
// its text; a grant that was made carries none.
export async function grantLead($: any, sid: string, code: c.OriginCode, busy: () => Promise<Said>, o: LeadGrantOpts = {}): Promise<Said> {
  // A lane, the manager, a conductor and a session that was the manager or a conductor are never a lead (core's holderNo): asked before the dialog and again
  // after a yes. A conductor restore still pending does not refuse: the person's lead grant stands, and the restore then ends (lead-holder).
  const leadNo = async (code: string) => {
    await log($, sid, 'refused', code === 'lead-after-manager' ? code : `lead-${code}`)
    return { text: `${code === 'lane-holder' && grants.has(sid) ? 'Lead stays on' : 'Lead stays off'}: ${c.REASON_TEXT[code]}`, code }
  }
  const laneHeld = async () => (await getLane($)).value != null
  const held = await heldNo($, sid, 'lead', false)
  if (held) return leadNo(held)
  const want = o.want
  if (want !== undefined && grants.get(sid)?.level === 'lead') {
    await log($, sid, 'refused', 'lead-name-on')
    return { text: c.GRANT_NAME_ON('Lead'), code: 'lead-name-on' }
  }
  let cwd: string
  try {
    cwd = await sessionRoot($)
  } catch {
    await logq($, sid, 'error', 'lead-register')
    return { text: 'Lead could not be set up.', code: 'grant-failed' }
  }
  // A grant from a plugin, session or script keeps the folder an earlier grant pinned; only the person's own prompt or phone moves it.
  const pinned = o.pinned ?? ((!c.originIsPerson(code) && pinOf(sid)) || cwd)
  // With another lead in the repo, both need a usable name. Asked before the dialog and again after a yes.
  const nameNo = async (why: string) => {
    await log($, sid, 'refused', why)
    return { text: `${grants.has(sid) ? 'Lead stays on' : 'Lead stays off'}: ${want === undefined ? c.REASON_TEXT[why] : c.grantNameText(why)}`, code: why }
  }
  await reservedGet($, sid, true)
  const badName = want === undefined ? undefined : await grantNameNo($, sid, want)
  if (badName !== undefined) return nameNo(badName)
  const named = await secondLeadNo($, sid, pinned, want)
  if (named !== undefined) return nameNo(named)
  const res = await grantDialog($, sid, LEAD, {
    question: c.askedFrom(c.leadQuestion(pinned, want), code),
    yes: c.LEAD_YES,
    no: c.LEAD_NO,
    header: c.HEADER.lead,
    busy,
    person: c.originIsPerson(code),
    on: () => grants.has(sid),
    pin: pinned,
    silent: o.silent,
    seq: o.seq,
    // After the click the manager grant is read through wasManager alone.
    postClick: () => {
      const heldAfter = c.holderNo('lead', { ...holdsOf(sid, laneBinding.has(sid), false), manager: false })
      return heldAfter ? leadNo(heldAfter) : undefined
    },
    recheck: async () => {
      // The engine calls held inside the mark have a time limit; a state read that does not answer counts as a lane binding.
      if ((await withTimeout($, laneHeld(), c.ENGINE_CALL_TIMEOUT_MS)) !== false) return leadNo('lane-holder')
      if (want !== undefined) {
        const badNow = await withTimeout($, grantNameNo($, sid, want), c.ENGINE_CALL_TIMEOUT_MS)
        if (badNow !== undefined) return nameNo(badNow === 'timeout' ? 'name-check-slow' : badNow)
      }
      const namedNow = await withTimeout($, secondLeadNo($, sid, pinned, want), c.ENGINE_CALL_TIMEOUT_MS)
      if (namedNow !== undefined) return nameNo(namedNow === 'timeout' ? 'lead-check-slow' : namedNow)
      return o.extraRecheck?.()
    },
    apply: async (offNow) => {
      let set: unknown
      try {
        set = await withTimeout($, leadToolsOnce($, sid), c.ENGINE_CALL_TIMEOUT_MS)
      } catch {
        await logq($, sid, 'error', 'lead-register')
        return { text: 'Lead could not be set up.', code: 'grant-failed' }
      }
      if (set === 'timeout') {
        await logq($, sid, 'error', 'lead-register-timeout')
        return { text: 'Lead could not be set up.', code: 'grant-failed' }
      }
      // The caller's last check: nothing is awaited between its answer and the set below.
      const last = await o.extraApply?.()
      if (last) return last
      if (offNow()) {
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.', code: 'off-meanwhile' }
      }
      // A re-grant with a new folder is a new reach: work in flight for the old one (a check-in) sees the epoch move and stops.
      const oldPin = pinOf(sid)
      if (oldPin !== undefined && oldPin !== pinned) {
        leadEpoch.set(sid, epochOf(sid) + 1)
        laneObs.delete(sid)
        attnTold.delete(sid)
        attnMid.delete(sid)
        attnToasted.delete(sid)
        // The goes this lead gave were for the old folder's lanes: they end, beside the grant, which does not wait for the rows.
        void goGrantorOff($, sid).catch(() => undefined)
      }
      grants.set(sid, c.leadGrant(pinned))
      const epoch = epochOf(sid)
      // The record and binding name the old repo: a lead that moves leaves its conductor, and the person joins one for the new folder. This runs after the
      // grant is set, so nothing is awaited between the last off check and the set; an off typed meanwhile moves the epoch, which the caller compares.
      if (oldPin !== undefined && oldPin !== pinned) await ownerLeave($, sid, 'off').catch(() => undefined)
      return epoch
    },
    afterPresence: async () => {
      await watchInit($, sid).catch(logFail($, sid, 'lane-watch'))
    },
    onLog: o.onLog ?? ['lead-on', ''],
    toast: o.toast,
    briefArg: pinned,
    after: async () => {
      if (want !== undefined) await nameRename($, sid, want, 'lead')
      await nameGrant($, sid)
    },
    text: c.LEAD_ON_TEXT,
  })
  // The question after the click: only the person's own command, and only when the grant was just made (its text), never the accept's silent grant.
  if (o.silent || !c.originIsPerson(code) || res.code !== undefined || res.text !== c.LEAD_ON_TEXT) return res
  // The question reads the session's current name, which is not NAME until the rename lands: with a NAME the person joins by hand, and is told so only when a conductor is live.
  if (want !== undefined) {
    const repo = pinOf(sid)
    const live = repo === undefined || (await bindingOf($, sid)) !== undefined ? undefined : await registryEntries($)
    const some = live && repo !== undefined ? (await joinCands($, live, sid, repo)).length > 0 : false
    return some ? { ...res, text: `${res.text}${c.JOIN_AFTER_RENAME}` } : res
  }
  return leadClickQuestion($, sid, res)
}

// The rows the prompt box's typeahead adds while the draft is /callboard and a word: the words the command table offers there, after the engine's own rows.
export async function commandComplete(_: any, e: { text: string; start: number; token: string }, next: (e: any) => Promise<{ suggestions: readonly c.Completion[] }>) {
  const base = await next(e)
  return { suggestions: [...base.suggestions, ...c.completions(e.text.slice(0, e.start), e.token)] }
}

export async function commandRun($: any, e: any) {
  const sid = await $.session.id()
  ensureTimer($)
  const code = c.originCode((e as { origin?: unknown }).origin)
  const rawArgs = (e as { args?: unknown }).args
  const line = typeof rawArgs === 'string' ? rawArgs.trim().replace(/[ \t]+/g, ' ') : ''
  // Escalation (ADR 0004): `escalation` is read here, so core's parser keeps its own form.
  // It only narrows (it stops pings), so any origin may type it, as `escalation off`.
  if (line === 'rest') return restCommand($, sid, code)
  if (line === 'escalation' || line.startsWith('escalation ')) return escalationCommand($, sid, code, pr.parseEscalationArgs(line.slice(10)))
  // The go (ADR 0009): read here, as escalation is; its text keeps its own words.
  if (line === 'go' || line.startsWith('go ')) return goCommand($, sid, code, go.parseGoArgs(line.slice(2)))
  // Here (ADR 0009, the relay): read here too; `here off` only narrows, so any origin may type it.
  if (line === 'here' || line.startsWith('here ')) return hereCommand($, sid, code, pr.parseHereArgs(line.slice(4)))
  // The unattended window (ADR 0008): read here, as escalation is.
  if (line === 'unattended' || line.startsWith('unattended ')) return unattendedCommand($, sid, code, pr.parseUnattendedArgs(line.slice(10)))
  if (line === '' || line === 'help') return { text: c.helpText() }
  const arg = c.parseCommandArgs(rawArgs)
  if (!arg) return { text: c.HELP_USAGE }
  // Before the verb below, which would take any other object for a lane command.
  if (typeof arg === 'object' && 'config' in arg) return configCommand($, sid, code, arg.config)
  if (typeof arg === 'object' && 'checkin' in arg) return checkinCommand($, sid, code, arg.checkin)
  if (typeof arg === 'object' && 'reserve' in arg) return reserveCommand($, sid, code, arg.reserve)
  if (arg === 'lead-leave' || (typeof arg === 'object' && 'leadJoin' in arg)) {
    await logq($, sid, 'command', `lead-join:${code}`)
    return leadJoinCommand($, sid, code, arg, async () => {
      await log($, sid, 'refused', `busy:lead-join:${code}`)
      return { text: 'A callboard question is already open. Answer it first.' }
    })
  }
  const verb = typeof arg === 'string' ? arg : 'manager' in arg ? 'manager' : 'conductor' in arg ? 'conductor' : 'leadNamed' in arg ? 'lead' : 'lane'
  const busy = async () => {
    await log($, sid, 'refused', `busy:${verb}:${code}`)
    return { text: 'A callboard question is already open. Answer it first.' }
  }
  // A busy request is logged once, by the busy line below (same key, so a loop is de-duplicated); the person's own commands always get their line.
  if (verb !== 'status' && (!dialogOpen.has(sid) || c.originIsPerson(code))) await logq($, sid, 'command', `${verb}:${code}`)
  if (verb === 'lane' || verb === 'lane-off') return laneCommand($, sid, code, arg as c.CommandArg, busy)
  if (typeof arg === 'object' && 'manager' in arg) return managerCommand($, sid, code, arg.manager, busy)
  // The conductor list (add, remove) and the conductor grant.
  if (typeof arg === 'object' && 'conductor' in arg) {
    const op = arg.conductor
    if (op === 'bad') return { text: c.CONDUCTOR_USAGE }
    if (op === 'grant') return conductorGrant($, sid, code, busy)
    // A NAME is the person's own, as the list commands: from another origin it is refused with no dialog.
    if ('grant' in op) return c.originIsPerson(code) ? conductorGrant($, sid, code, busy, op.grant) : notPerson($, sid, 'conductor-name', code, c.CONDUCTOR_NAME_NOT_PERSON)
    return conductorListCommand($, sid, code, op, busy)
  }
  if (typeof arg === 'object' && 'leadNamed' in arg) {
    if (!c.originIsPerson(code)) return notPerson($, sid, 'lead-name', code, c.LEAD_NAME_NOT_PERSON)
    return grantLead($, sid, code, busy, { want: arg.leadNamed })
  }
  // The table lane_list gives the lead, printed to the person with no model turn. Read-only: no store write, no notice, and the lanes-changed news is not marked as told.
  if (arg === 'lanes') {
    const t = await laneTable($, sid)
    if (!('err' in t)) return { text: t.text }
    if (t.err[0] === 'off') return { text: (await isEligible($)) ? c.LANES_IS_LANE : c.LANES_NO_LEVEL }
    return { text: `Lanes unavailable: ${c.hasText(t.err[0]) ? c.REASON_TEXT[t.err[0]] : t.err[1]}` }
  }
  if (arg === 'off' && !c.originIsPerson(code)) {
    const leaves = ((await getLane($)).value as Bound | null | undefined)?.name
    // In a conductor session the question names the conductor and its saved grant.
    const offQ = grants.get(sid)?.level === 'conductor' ? c.CONDUCTOR_OFF_QUESTION : c.offQuestionFor(leaves)
    const r = await askOnce($, sid, c.askedFrom(offQ, code), c.OFF_YES, c.OFF_NO, c.HEADER.enable)
    if (r === 'busy') return busy()
    if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
    if (r !== 'yes') {
      await log($, sid, 'refused', 'off-not-confirmed')
      return { text: 'Cancelled. Nothing changed.' }
    }
  }
  // A saved grant could not be deleted: the reply says its level may come back after a restart.
  let leadKept = false
  // What off found, for its answer, read before the drops below: the level the session holds (a grant, or a saved one still being restored), a rebind still
  // waiting (and the lane it would take, once the tick has read it), and the saved grants of a session that holds none.
  let was: LevelDesc | undefined
  const saved: LevelDesc[] = []
  let rebindWas = false
  let rebindLane: string | undefined
  let ownerOff: Awaited<ReturnType<typeof ownerLeave>> | undefined
  if (arg === 'off') {
    offSeq.set(sid, (offSeq.get(sid) ?? 0) + 1)
    was = [MANAGER, CONDUCTOR, LEAD].find((d) => d.isOn(sid))
    const rebinding = rebindPending.get(sid)
    rebindWas = rebinding !== undefined
    rebindLane = rebinding?.name
    // A rebind still waiting is cancelled before any await: a tick that starts after the bump would pass its own check and could bind after
    // off has read the binding.
    rebindPending.delete(sid)
    if (!was) {
      for (const d of [LEAD, CONDUCTOR, MANAGER]) {
        // A read that timed out says nothing about the grant: the reply then leaves it out.
        const got = await withTimeout($, (async () => $.store.get(`${d.hint}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
        if (d.pending.has(sid) || (got !== undefined && got !== 'timeout')) saved.push(d)
      }
    }
    // The conductor tie goes first, while the lead's name and pin are still known; a session that is no lead any more may still hold a left-behind binding.
    ownerOff = await ownerLeave($, sid, 'off').catch(() => undefined)
    if (!(await leadDrop($, sid))) leadKept = true
    if (!(await managerForget($, sid))) leadKept = true
  }
  if (arg === 'lead') return grantLead($, sid, code, busy)
  const bound = (await getLane($)).value as Bound | null | undefined
  // Every session gets the keepalive and the nudges.
  // A lead's, conductor's or manager's status adds its check-ins.
  const ckStatus: [string, string][] = arg === 'status' && grants.has(sid) ? [['Check-ins', c.checkinStatus((await cfgGet($, sid)).checkin, (await getCheckinPause($)).value, await $.clock.now())]] : []
  // The manager's status names its level in place of the lead's.
  const gs = grants.get(sid)
  const grantPart: [string, string] = gs?.level === 'manager' ? ['Manager', 'ON'] : gs?.level === 'conductor' ? ['Conductor', c.conductorStatus(gs.pins.length)] : ['Lead', grants.has(sid) ? 'ON' : 'OFF']
  const laneLead: [string, string][] = bound ? [["This lane's lead", c.laneStatusLead(laneBrief.get(sid), bound.name)]] : []
  if (arg === 'status') {
    const esc: [string, string][] = [['Escalation', pr.escalationStatus(await escalationNow($), await promptsOff($))], ['Unattended', pr.unattendedStatus(await unattendedNow($), whenLocal)]]
    const ownerRow: [string, string][] = gs?.level === 'lead' ? [['Conductor', await ownerStatusNow($, sid)]] : []
    return { text: c.statusTableText([['Lane', bound ? bound.name : 'NONE'], grantPart, ...ownerRow, ...ckStatus, ...laneLead, ...esc]) }
  }
  if (arg === 'off') {
    // A recorded nudge and an open grant go too. Off does not opt out of nudges: a later turn past the level records a new one.
    await setNudgeDue($, null)
    await setNudgedAt($, null)
    if (!(await leadDrop($, sid))) leadKept = true
    // The rebind was cancelled above. No store record may keep naming a session that is off, or a restart would rebind it.
    // A session that is neither a lane nor a lead keeps its request as it is: off turns nothing off there, and its own request needs no lane.
    const cur = await getRequest($)
    const live = bound || was ? (cur.value as Request | null | undefined) : undefined
    // What off did, for its answer: a request dropped, or a compaction under way that loses its resume.
    let reqDone: 'dropped' | 'no-resume' | undefined
    if (live && live.phase !== 'compacting') {
      await dropRequest($, sid, 'disabled')
      reqDone = 'dropped'
    } else if (live?.viaNudge === true) {
      reqDone = 'no-resume'
      // A compaction under way through the nudge grant finishes, but loses the grant: its resume then needs the session to be eligible, which off
      // has just ended, so the continuation is dropped as not-eligible. If PostCompact moved it on meanwhile, the request is dropped as above.
      const { viaNudge: _granted, ...kept } = live
      if ((await setRequest($, kept, { ifVersion: cur.version })).isSet === false) {
        const again = (await getRequest($)).value as Request | null | undefined
        if (again && again.phase !== 'compacting') {
          await dropRequest($, sid, 'disabled')
          reqDone = 'dropped'
        }
      }
    }
    // A bound session is unbound too: off no longer leaves a lane that a lead can still cue.
    const d = bound ? await detach($, sid, bound) : { sidKept: false }
    const loose = bound ? undefined : await sidClearAll($, sid).catch(() => ({ ok: false, name: undefined }))
    await log($, sid, 'disabled')
    // The answer says what off did; it never stops the keepalive or the nudges, which every session gets.
    const rebindTo = rebindWas ? (rebindLane ?? loose?.name) : undefined
    const did = [
      was ? was.offText : saved[0] ? `Its saved ${saved[0].level} grant was removed.` : '',
      bound ? `This session is no longer lane ${bound.name}.` : '',
      rebindTo !== undefined ? `Lane ${rebindTo} will not rebind automatically.` : '',
      loose?.ok && loose.name !== undefined ? `Lane ${loose.name} no longer names this session.` : '',
      reqDone === 'dropped' ? 'Its compaction request was dropped.' : reqDone === 'no-resume' ? 'The compaction under way will not resume the work.' : '',
      ownerOff?.had ? (ownerOff.kept !== undefined ? c.offOwnerKept(ownerOff.kept) : c.OFF_OWNER_REMOVED).trim() : '',
    ].filter((x) => x !== '').join(' ')
    return { text: `${did || c.OFF_NOTHING}${bound ? c.STOPPABLE_BY_NAME(bound.name) : ''}${bound && d.sidKept ? c.SID_KEPT(bound.name) : ''}${loose && !loose.ok && loose.name ? c.SID_KEPT(loose.name) : ''}${leadKept ? ([CONDUCTOR, MANAGER].find((l) => l === was || saved.includes(l)) ?? LEAD).kept : ''}` }
  }
}
