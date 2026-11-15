// lead_park, lead_unpark, lead_retire and lead_terminate (ADR 0007): a conductor runs them on the leads it owns, the manager on any lead, every manager call
// behind the person's dialog. A force stop asks the person at both levels, every time; a conductor's retire asks nothing (the lead's signed report and its own
// mod's confirmation are the gate).
// Trust rules held here: the target is found and checked by engine/lead-tools.ts (leadTarget, targetCheck: one record machine-wide, the caller's own lead and
// bound to it for a conductor, a live lead presence file for the record's repo) and by the process check below (not the caller, the registry's start time, a
// claude process). Every check runs again from a fresh read after each wait (the idle wait, the dialog, the target's answer) and right before the signal, which
// goes only to the process checked first. The ledger row is written before the cue or the signal, and a row that cannot be written sends nothing. A record, a
// saved lead grant (lead:<sid>) and a binding (owner:<sid>) of the stopped session go only once its process has ended, and only the exact session the record
// named at the signal.
import * as c from '../core.ts'
import { run, KILL, pause, psOne, psStart, psArgs, toast, askOnce, timedOut, log, logq } from './base.ts'
import { cueExchange, loadLanes, registryEntries, writeIn } from './store.ts'
import { leadReason, grantOf } from './grants.ts'
import { leadTool, readReport, openExchange } from './lanes.ts'
import { editLeadRecs, loadLeadRecords, boundTo } from './lead-records.ts'
import { leadTarget, targetCheck, managerAsk } from './lead-tools.ts'
import type { No, Target, Start } from './lead-tools.ts'
import { epochOf } from './levels.ts'
import { ledgerAdd } from './answer-hook.ts'
import { signalledCalls } from '../mem.ts'

type Tool = c.LeadStopTool
const stopKey = (sid: string, tool: string, lead: unknown) => `${sid}\n${tool}\n${String(lead)}`
const fail = (no: No, code: string) => no(code, c.leadWhy(code))

// ---- the checks ----

// Check f: the process is not the caller's own, has the start time the registry gives it, and is a claude process.
async function procNo($: any, t: c.RegEntry, self: c.RegEntry[]): Promise<string | undefined> {
  if (self.some((x) => x.pid === t.pid)) return 'self'
  const bad = c.pidRefusal(t, await psStart($, t.pid))
  if (bad) return bad
  return c.processRefusal(await psArgs($, t.pid), t.pid, self.length === 1 ? self[0].pid : undefined)
}

// Checks a to f from a fresh read, and, with `first`, the same process (session id, pid, start time) as the one checked before the wait. The entry, and every
// registry row, for the lane checks.
type Live = { entry: c.RegEntry; rows: c.RegEntry[] }
async function fullCheck($: any, sid: string, t: Target, start: Start, first?: c.RegEntry): Promise<Live | string> {
  const bad = await targetCheck($, sid, t, start)
  if (bad) return bad
  const live = await registryEntries($)
  if (!live) return 'registry-unreadable'
  const rows = live.map((r) => r.j as c.RegEntry)
  const mine = rows.filter((x) => x.sessionId === t.sid)
  if (mine.length !== 1) return mine.length === 0 ? 'no-live-session' : 'session-duplicate'
  const entry = mine[0]
  if (first && (entry.pid !== first.pid || !c.sameStart(entry.procStart, first.procStart))) return 'session-changed'
  const p = await procNo($, entry, rows.filter((x) => x.sessionId === sid))
  return p ?? { entry, rows }
}

// A park or retire waits for the lead's idle time itself, up to c.IDLE_WAIT_MS, every poll a full check of the same process. A read that fails now and then is
// polled again; past the wait the refusal names the seconds left.
async function idleWait($: any, sid: string, tool: Tool, t: Target, start: Start, got: Live, no: No, abandoned: () => boolean): Promise<Live | { deny: string }> {
  let cur = got
  const until = (await $.clock.now()) + c.IDLE_WAIT_MS
  while (c.idleRefusal(cur.entry, await $.clock.now())) {
    const left = until - (await $.clock.now())
    if (left <= 0) break
    const waited = await pause($, Math.min(c.IDLE_POLL_MS, left))
    if (abandoned()) return { deny: leadReason(tool, c.reasonWhy('abandoned')) }
    if (!waited) break
    const again = await fullCheck($, sid, t, start, got.entry)
    if (again === 'registry-unreadable' || again === 'store-unreadable') continue
    if (typeof again === 'string') return fail(no, again)
    cur = again
  }
  const now = await $.clock.now()
  return c.idleRefusal(cur.entry, now) ? no('not-idle', c.notIdleText(cur.entry, now)) : cur
}

// The lane records that name the lead (by its session or its name), and those of them with a live session.
async function lanesOf($: any, t: Target, rows?: c.RegEntry[]): Promise<{ named: string[]; live: string[] } | string> {
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return lanes
  const mine = c.leadLanes(lanes, { sid: t.sid, names: [t.name] })
  return { named: mine.map((l) => l.name), live: rows ? c.liveLaneNames(mine, rows) : [] }
}

// The record checks with no live session (an unpark, or the removal of a record no session carries): the grant is the start's, the record of that name is
// still the one machine-wide, with the same repo, session, conductor and parked mark, and a conductor's own and bound.
async function recordCheck($: any, sid: string, t: Target, start: Start): Promise<string | undefined> {
  const g = grantOf(sid)
  if (g?.level !== start.level || epochOf(sid) !== start.epoch || !t.rec) return 'grant-changed'
  const recs = await loadLeadRecords($)
  if (typeof recs === 'string') return recs
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return lanes
  const hit = c.leadRec(recs, lanes, g, sid, t.name)
  if (!hit.ok) return hit.reason === 'unknown-lead' ? 'record-changed' : hit.reason
  const was = t.rec.rec
  const now = hit.rec.rec
  if (hit.rec.key !== t.rec.key || now.sid !== was.sid || now.conductorSid !== was.conductorSid || now.parked !== was.parked) return 'grant-changed'
  if (g.level === 'conductor' && !(await boundTo($, hit.rec))) return 'record-changed'
  return undefined
}

// ---- the writes ----

// The lead-stop ledger row, before its action.
function stopRow($: any, sid: string, t: Target, start: Start, code: 'park' | 'unpark' | 'retire' | 'terminate' | 'remove', dialog: 'yes' | 'none') {
  return ledgerAdd($, { kind: 'lead-stop', hash: t.key, repo: t.repo, lane: t.name, by: sid, ...(t.sid !== undefined ? { target: t.sid } : {}), tier: start.level, code, dialog })
}

// One locked edit of the lead's record: only the record of that name that still names `victim` (no session, for undefined) and the same conductor.
type RecChange = 'park' | 'unpark' | 'remove' | 'unsession'
async function recordEdit($: any, t: Target, victim: string | undefined, change: RecChange, at?: number): Promise<string | undefined> {
  if (!t.rec) return 'unknown-lead'
  const conductor = t.rec.rec.conductorSid
  const r = await editLeadRecs($, t.key, async (store) => {
    if (!store) return { no: 'unknown-lead' }
    const i = store.leads.findIndex((l) => l.name === t.name && l.sid === victim && l.conductorSid === conductor)
    if (i < 0) return { no: 'record-changed' }
    const l = store.leads[i]
    const { sid: _s, parked: _p, ...bare } = l
    const next = change === 'park' ? { ...l, parked: at } : change === 'unpark' ? { ...bare, sid: l.sid } : change === 'unsession' ? bare : undefined
    const leads = next ? store.leads.map((x, j) => (j === i ? (next as c.LeadRec) : x)) : store.leads.filter((_, j) => j !== i)
    return { store: { ...store, leads } }
  }).catch(() => ({ no: 'throw' }))
  return 'no' in r ? r.no : undefined
}

// The stopped session's saved lead grant and owner binding, once its process has ended. false: a delete failed (logged).
async function dropKeys($: any, sid: string, victim: string): Promise<boolean> {
  let ok = true
  for (const k of [`${c.LEAD_HINT_PREFIX}${victim}`, `${c.OWNER_PREFIX}${victim}`]) {
    try {
      await $.store.delete(k)
    } catch {
      ok = false
    }
  }
  if (!ok) await logq($, sid, 'error', 'lead-key-kept')
  return ok
}

// The signal, and the request that the VS Code window close the dead tab (its body carries the folder, so it needs no record). false: the signal failed.
async function signal($: any, sid: string, tool: Tool, e: any, t: Target, victim: c.RegEntry): Promise<boolean> {
  const k = await run($, [KILL, '-TERM', String(victim.pid)])
  if (k.exitCode !== 0) return false
  signalledCalls.set(stopKey(sid, tool, e.lead), { name: t.name, pid: victim.pid as number })
  const closeReq = await writeIn($, 'open', `${t.name}.close`, `${victim.sessionId}\n${victim.pid}\n${t.name}\n${t.repo}\n`).catch(() => ({ err: 'throw' }))
  await log($, sid, 'err' in closeReq ? 'error' : 'close-requested', 'err' in closeReq ? 'close-request' : t.name)
  return true
}

// Whether the signalled process (that pid and start time) has ended, polled up to c.STOP_POLLS times. Only ps's own "no such process", or another start time
// at that pid, is an end.
async function ended($: any, victim: c.RegEntry): Promise<boolean> {
  for (let i = 0; ; i++) {
    const at = await psOne($, victim.pid, 'lstart=').catch((): 'error' => 'error')
    if (at === 'gone' || (at !== 'error' && !c.sameStart(victim.procStart, at.out))) return true
    if (i >= c.STOP_POLLS) return false
    if (!(await pause($, c.STOP_POLL_MS))) throw new Error('pause-failed')
  }
}

// ---- the tools ----

type Ctx = { sid: string; e: any; tool: Tool; no: No; abandoned: () => boolean }

// lead_park: the lead's checks, its own confirmation (park cue), the signal, then the parked mark on its record. The saved lead grant is kept (the lead rewrote
// it before it confirmed), so lead_unpark reopens the conversation as the lead.
async function parkCall($: any, x: Ctx) {
  const { sid, e, tool, no, abandoned } = x
  const got = await leadTarget($, e, sid, e.lead, no)
  if (got === 'none') return fail(no, 'unknown-lead')
  if ('deny' in got) return got
  const { t, start } = got
  // A live lead with no record (the manager's) has nothing to carry the mark.
  if (!t.rec) return fail(no, 'unknown-lead')
  const first = await fullCheck($, sid, t, start)
  if (typeof first === 'string') return fail(no, first)
  const idle = await idleWait($, sid, tool, t, start, first, no, abandoned)
  if ('deny' in idle) return idle
  const lanes = await lanesOf($, t, idle.rows)
  if (typeof lanes === 'string') return fail(no, lanes)
  if (lanes.live.length > 0) return no('lead-has-live-lanes', c.namedLanes(c.reasonWhy('lead-has-live-lanes'), lanes.live))
  let dialog: 'yes' | 'none' = 'none'
  if (start.level === 'manager') {
    const asked = await managerAsk($, sid, tool, c.parkLeadQuestion(t.name, t.repo, t.sid!), c.PARK_YES, no, c.HEADER.stopLead)
    if (asked) return asked
    dialog = 'yes'
    const again = await fullCheck($, sid, t, start, first.entry)
    if (typeof again === 'string') return fail(no, again)
  }
  if (abandoned()) return { deny: leadReason(tool, c.reasonWhy('abandoned')) }
  if (!(await stopRow($, sid, t, start, 'park', dialog))) return fail(no, 'ledger-write')
  const sent = await cueExchange($, sid, t.name, t.sid!, 'park', (await $.clock.now()) + c.RESULT_DEADLINE_MS, (code, why) => no(code, c.leadCueWhy('park', code, why)), true, 'lead')
  if (sent) return sent
  const fresh = await fullCheck($, sid, t, start, first.entry)
  if (typeof fresh === 'string') return fail(no, fresh)
  const now = await $.clock.now()
  if (c.idleRefusal(fresh.entry, now)) return no('not-idle', c.notIdleText(fresh.entry, now))
  if (abandoned()) return { deny: leadReason(tool, c.reasonWhy('abandoned')) }
  await log($, sid, 'parking', t.name)
  if (!(await signal($, sid, tool, e, t, fresh.entry))) return no('kill-failed', 'the signal failed.')
  try {
    const marked = await recordEdit($, t, t.sid, 'park', await $.clock.now())
    toast($, `Lead ${t.name} parked`)
    if (marked) {
      await log($, sid, 'park-unmarked', marked)
      return { result: c.parkUnmarkedLeadText(t.name, fresh.entry.pid as number, marked) }
    }
    await log($, sid, 'parked', t.name)
    return { result: c.parkedLeadText(t.name, fresh.entry.pid as number) }
  } finally {
    signalledCalls.delete(stopKey(sid, tool, e.lead))
  }
}

// lead_unpark: a parked record, within 28 days of its park, whose conversation is not live, is reopened by its session id (the extension's reopen of a lead
// record); the reopened session restores its own lead grant and binding. The parked mark goes once it is open.
async function unparkCall($: any, x: Ctx) {
  const { sid, e, tool, no } = x
  const got = await leadTarget($, e, sid, e.lead, no)
  if (got === 'none') return fail(no, 'unknown-lead')
  if ('deny' in got) return got
  const { t, start } = got
  if (!t.rec) return fail(no, 'unknown-lead')
  const parked = t.rec.rec.parked
  const want = t.sid!
  if (parked === undefined) return fail(no, 'not-parked')
  if ((await $.clock.now()) - parked > c.UNPARK_MAX_MS) return fail(no, 'park-expired')
  // Live: a registry row of that session whose process still has its start time. A row of the parked process that started before the park mark is waited for
  // (up to 5 s): right after lead_park the stopped process can still be exiting.
  const liveOf = async (): Promise<c.RegEntry[] | undefined> => {
    const live = await registryEntries($)
    if (!live) return undefined
    const out: c.RegEntry[] = []
    for (const r of live.map((y) => y.j as c.RegEntry).filter((y) => y.sessionId === want)) if (c.pidRefusal(r, await psStart($, r.pid)) !== 'pid-changed') out.push(r)
    return out
  }
  const stopped = (r: c.RegEntry) => typeof r.startedAt !== 'number' || r.startedAt <= parked
  let live = await liveOf()
  for (let i = 0; i < 10 && live?.some(stopped); i++) {
    if (!(await pause($, c.OPEN_POLL_MS))) break
    live = await liveOf()
  }
  if (!live) return fail(no, 'registry-unreadable')
  if (live.some(stopped)) return fail(no, 'session-live')
  const rows = (await registryEntries($))?.map((r) => r.j as c.RegEntry) ?? []
  if (live.length === 1 && live[0].name === t.name) {
    const bad = await recordEdit($, t, want, 'unpark')
    if (bad) await log($, sid, 'error', `unpark-unmarked ${bad}`)
    return { result: c.alreadyLiveLeadText(t.name, want) }
  }
  if (live.length > 0) return fail(no, 'session-live')
  if (rows.some((r) => r.name === t.name && r.sessionId !== want)) return no('name-in-use', 'a live session already carries that lead name.')
  let dialog: 'yes' | 'none' = 'none'
  if (start.level === 'manager') {
    const asked = await managerAsk($, sid, tool, c.unparkLeadQuestion(t.name, t.repo, want), c.REOPEN_YES, no)
    if (asked) return asked
    dialog = 'yes'
  }
  const bad = await recordCheck($, sid, t, start)
  if (bad) return fail(no, bad)
  if (!(await stopRow($, sid, t, start, 'unpark', dialog))) return fail(no, 'ledger-write')
  // An extension older than 1.4.0 knows no lead record and answers unknown-lane at once: that answer names the version needed.
  const reopenNo: No = (code, why) => (code === 'reopen-unknown-lane' ? fail(no, 'lead-reopen-unknown-lane') : no(code, why))
  const r = await openExchange($, sid, t.name, 'reopen', `${want}\n`, c.leadWhy('reopen-timeout'), reopenNo)
  if ('deny' in r) return r
  if (r.sid !== want) return fail(no, 'reopen-bad-result')
  const unmarked = await recordEdit($, t, want, 'unpark')
  if (unmarked) await log($, sid, 'error', `unpark-unmarked ${unmarked}`)
  await log($, sid, 'reopened', t.name)
  toast($, `Lead ${t.name} reopened`)
  return { result: c.reopenedLeadText(t.name, want) }
}

// lead_retire: refused while any lane record names the lead. A record no live session carries is removed directly (the manager asks first; a conductor asks
// only for a parked record, whose saved conversation it makes unreachable). A live lead: the full checks, the idle wait and the caller's read of the signed
// report; the manager's dialog (a conductor asks nothing); the lead's own confirmation; the signal; then, once the process has ended, its record, saved lead
// grant and binding go.
async function retireCall($: any, x: Ctx) {
  const { sid, e, tool, no, abandoned } = x
  const got = await leadTarget($, e, sid, e.lead, no, { sidless: true })
  if (got === 'none') return fail(no, 'unknown-lead')
  if ('deny' in got) return got
  const { t, start } = got
  const lanes = await lanesOf($, t)
  if (typeof lanes === 'string') return fail(no, lanes)
  if (lanes.named.length > 0) return no('lead-has-lanes', c.namedLanes(c.reasonWhy('lead-has-lanes'), lanes.named))
  const live = await registryEntries($)
  if (!live) return fail(no, 'registry-unreadable')
  if (t.sid === undefined || !live.some((r) => r.j.sessionId === t.sid)) {
    if (!t.rec) return fail(no, 'no-live-session')
    const parked = t.rec.rec.parked !== undefined
    let dialog: 'yes' | 'none' = 'none'
    if (start.level === 'manager' || parked) {
      const r = await askOnce($, sid, c.removeLeadQuestion(t.name, t.repo, parked), c.REMOVE_YES, c.REMOVE_NO, c.HEADER.stopLead)
      if (r === 'busy') return fail(no, 'busy')
      if (r === 'timed-out') return { deny: leadReason(tool, `${await timedOut($, sid)}.`) }
      if (r !== 'yes') return no('not-confirmed', 'the person did not confirm.')
      dialog = 'yes'
    }
    const bad = await recordCheck($, sid, t, start)
    if (bad) return fail(no, bad)
    const now = await registryEntries($)
    if (!now) return fail(no, 'registry-unreadable')
    if (t.sid !== undefined && now.some((r) => r.j.sessionId === t.sid)) return fail(no, 'session-live')
    const again = await lanesOf($, t)
    if (typeof again === 'string') return fail(no, again)
    if (again.named.length > 0) return no('lead-has-lanes', c.namedLanes(c.reasonWhy('lead-has-lanes'), again.named))
    if (!(await stopRow($, sid, t, start, 'remove', dialog))) return fail(no, 'ledger-write')
    const gone = await recordEdit($, t, t.sid, 'remove')
    if (gone) return fail(no, gone)
    const keys = t.sid === undefined ? true : await dropKeys($, sid, t.sid)
    await log($, sid, 'lead-removed', t.name)
    return { result: c.removedLeadNoSessionText(t.name, !keys) }
  }
  const first = await fullCheck($, sid, t, start)
  if (typeof first === 'string') return fail(no, first)
  const idle = await idleWait($, sid, tool, t, start, first, no, abandoned)
  if ('deny' in idle) return idle
  // The caller's own read of the report is a first filter: the lead confirms it again itself.
  const rep = await readReport($, { name: t.name, repo: t.repo, folder: t.repo, brief: '' })
  const repNo = 'no' in rep ? rep.no : c.reportRefusal(rep.text, t.sid!, rep.mtimeMs, idle.entry.startedAt)
  if (repNo) return no(repNo, c.reasonWhy(repNo))
  let dialog: 'yes' | 'none' = 'none'
  if (start.level === 'manager') {
    const asked = await managerAsk($, sid, tool, c.retireLeadQuestion(t.name, t.repo, t.sid!), c.RETIRE_YES, no, c.HEADER.stopLead)
    if (asked) return asked
    dialog = 'yes'
    const again = await fullCheck($, sid, t, start, first.entry)
    if (typeof again === 'string') return fail(no, again)
  }
  if (abandoned()) return { deny: leadReason(tool, c.reasonWhy('abandoned')) }
  if (!(await stopRow($, sid, t, start, 'retire', dialog))) return fail(no, 'ledger-write')
  const sent = await cueExchange($, sid, t.name, t.sid!, 'retire', (await $.clock.now()) + c.RESULT_DEADLINE_MS, (code, why) => no(code, c.leadCueWhy('retire', code, why)), true, 'lead')
  if (sent) return sent
  const fresh = await fullCheck($, sid, t, start, first.entry)
  if (typeof fresh === 'string') return fail(no, fresh)
  const now = await $.clock.now()
  if (c.idleRefusal(fresh.entry, now)) return no('not-idle', c.notIdleText(fresh.entry, now))
  if (abandoned()) return { deny: leadReason(tool, c.reasonWhy('abandoned')) }
  await log($, sid, 'retiring', t.name)
  if (!(await signal($, sid, tool, e, t, fresh.entry))) return no('kill-failed', 'the signal failed.')
  try {
    toast($, `Lead ${t.name} retired (idle, report signed)`)
    return await afterStop($, sid, 'retire', t, fresh.entry)
  } catch {
    await logq($, sid, 'error', 'after-signal-lead_retire')
    return { result: c.afterSignalFailedLeadText('retire', t.name, fresh.entry.pid as number) }
  } finally {
    signalledCalls.delete(stopKey(sid, tool, e.lead))
  }
}

// After the signal of a retire or a force stop: once the process has ended, the keys go, and the record (a retire: always; a force stop: only when no lane
// record names the lead, otherwise it stays with no session, so its lanes keep their place in the owner's tree). A process still running leaves everything.
async function afterStop($: any, sid: string, verb: 'retire' | 'terminate', t: Target, victim: c.RegEntry) {
  const pid = victim.pid as number
  if (!(await ended($, victim))) {
    await logq($, sid, 'error', 'lead-still-running')
    return { result: c.stoppedLeadText(verb, t.name, pid, 'alive') }
  }
  const keys = await dropKeys($, sid, victim.sessionId)
  if (!t.rec) return { result: c.stoppedLeadText(verb, t.name, pid, 'removed', !keys) }
  let change: RecChange = 'remove'
  if (verb === 'terminate') {
    // A lane list that cannot be read keeps the record (with no session): the name stays held, the safe side.
    const lanes = await lanesOf($, t)
    if (typeof lanes === 'string' || lanes.named.length > 0) change = 'unsession'
  }
  const bad = await recordEdit($, t, victim.sessionId, change)
  if (bad && bad !== 'unknown-lead') {
    await logq($, sid, 'error', `lead-unremoved ${bad}`)
    return { result: c.stoppedLeadText(verb, t.name, pid, { unremoved: bad }, !keys) }
  }
  await log($, sid, change === 'remove' ? 'lead-removed' : 'lead-unsessioned', t.name)
  return { result: c.stoppedLeadText(verb, t.name, pid, change === 'remove' ? 'removed' : 'kept', !keys) }
}

// lead_terminate: the person's Force stop click every time, at both levels, after the full checks; the checks again from a fresh read after the click; the
// ledger row; the signal. Nothing reaches the signal without the click.
async function terminateCall($: any, x: Ctx) {
  const { sid, e, tool, no, abandoned } = x
  let lastCode = ''
  const noT: No = (code, why) => {
    lastCode = code
    return no(code, why)
  }
  const got = await leadTarget($, e, sid, e.lead, noT)
  if (got === 'none') return fail(noT, 'unknown-lead')
  if ('deny' in got) return got
  const { t, start } = got
  const first = await fullCheck($, sid, t, start)
  if (first === 'no-live-session') return noT('no-live-session', `${c.leadWhy('no-live-session')} To remove a lead record no session carries, call lead_retire.`)
  if (typeof first === 'string') return fail(noT, first)
  const lanes = await lanesOf($, t, first.rows)
  if (typeof lanes === 'string') return fail(noT, lanes)
  const r = await askOnce($, sid, c.terminateLeadQuestion(t.name, t.repo, t.sid!, first.entry.pid as number, lanes.live.length), c.TERMINATE_YES, c.TERMINATE_NO, c.HEADER.stopLead)
  if (r === 'busy') return fail(noT, 'busy')
  if (r === 'timed-out') return { deny: leadReason(tool, `${await timedOut($, sid)}.`) }
  if (r !== 'yes') return noT('not-confirmed', 'the person did not confirm.')
  const notSent = (d: { deny: string }) => {
    toast($, `Force stop not sent: ${lastCode}`)
    return d
  }
  const fresh = await fullCheck($, sid, t, start, first.entry)
  if (typeof fresh === 'string') return notSent(await fail(noT, fresh))
  if (abandoned()) {
    toast($, 'Force stop not sent: abandoned')
    return { deny: leadReason(tool, c.reasonWhy('abandoned')) }
  }
  if (!(await stopRow($, sid, t, start, 'terminate', 'yes'))) return notSent(await fail(noT, 'ledger-write'))
  await log($, sid, 'terminating', t.name)
  if (!(await signal($, sid, tool, e, t, fresh.entry))) return notSent(await noT('kill-failed', 'the signal failed.'))
  try {
    return await afterStop($, sid, 'terminate', t, fresh.entry)
  } catch {
    await logq($, sid, 'error', 'after-signal-lead_terminate')
    return { result: c.afterSignalFailedLeadText('terminate', t.name, fresh.entry.pid as number) }
  } finally {
    signalledCalls.delete(stopKey(sid, tool, e.lead))
  }
}

export async function leadStopCall($: any, e: any, next: any, tool: Tool) {
  return leadTool($, e, tool, async (sid, no) => {
    const x: Ctx = { sid, e, tool, no, abandoned: () => next?.signal?.aborted === true }
    if (tool === 'lead_park') return parkCall($, x)
    if (tool === 'lead_unpark') return unparkCall($, x)
    if (tool === 'lead_retire') return retireCall($, x)
    return terminateCall($, x)
  })
}

// The hook's .catch: before the signal nothing was done; a call cut off after it answers that the session was signalled, never "failed closed". Nothing here
// may throw.
export async function leadStopFailed($: any, e: any, next: any, tool: Tool) {
  const kind = next?.error?.kind === 'timeout' ? 'timeout' : 'throw'
  const sid = await Promise.resolve($.session.id()).catch(() => undefined)
  const sent = typeof sid === 'string' ? signalledCalls.get(stopKey(sid, tool, e?.lead)) : undefined
  if (typeof sid === 'string') await logq($, sid, 'error', `${tool}-hook-${kind}${sent ? '-after-signal' : ''}`).catch(() => undefined)
  if (!sent) return { deny: `${tool} failed closed.` }
  const verb = tool === 'lead_park' ? 'park' : tool === 'lead_retire' ? 'retire' : 'terminate'
  return { result: c.afterSignalFailedLeadText(verb, sent.name, sent.pid) } as never
}
