// lead_resume and lead_compact (ADR 0007): a conductor runs them on the leads it owns, the manager on any lead, every manager call behind the person's dialog.
// Trust rules held here: the target is the one lead record of its name (c.leadRec), or for the manager a live lead with no record found by its registry name and
// presence file; a conductor reaches only a record that names it and that its lead is bound to (boundTo). The target checks run from a fresh read before the
// dialog, after it and so right before the cue; the ledger row is written before the cue, and a row that cannot be written sends nothing. What the lead does
// with the cue is its own mod's decision (engine/lead-cues.ts).
import * as c from '../core.ts'
import { sha, askOnce, timedOut } from './base.ts'
import { cueExchange } from './store.ts'
import type { RegRow } from './store.ts'
import { grantOf, leadReason, leadsFor, leadPresence } from './grants.ts'
import { epochOf } from './levels.ts'
import { leadTool, leadBase, leadCore } from './lanes.ts'
import { loadLeadRecords, boundTo } from './lead-records.ts'
import { ledgerAdd } from './answer-hook.ts'

export type No = (reason: string, why: string) => Promise<{ deny: string }>
type Tool = (typeof c.LEAD_TOOLS)[number]
// The lead's name, its session (none only for a record that names no session, when the caller asked for such targets), its repo and the repo's record key (the
// sha of the repo); rec when the target is a lead record.
export type Target = { name: string; sid?: string; repo: string; key: string; rec?: c.OwnerRec }
// The caller's grant level and epoch when the call began (check e).
export type Start = { level: c.Grant['level']; epoch: number }

// The live lead (not this session) whose registry name is `name`, by its presence file; a lane record or a second lead of the name refuses lane-or-lead.
async function liveLeadByName($: any, live: RegRow[], lanes: c.Lane[], sid: string, name: string): Promise<Target | { no: string } | undefined> {
  const rows = live.map((r) => r.j)
  const found = (await leadsFor($, live, undefined)).filter((x) => x.sid !== sid && c.leadNameOf(rows, x.sid) === name)
  if (found.length === 0) return undefined
  if (found.length > 1 || lanes.some((l) => l.name.toUpperCase() === name.toUpperCase())) return { no: 'lane-or-lead' }
  return { name, sid: found[0].sid, repo: found[0].repo, key: await sha($, found[0].repo) }
}

// The target of a lead tool, or 'none' when no lead carries the name at all (the lane_compact alias then goes on to the lanes). A conductor reaches only a record
// it owns and is bound to; a live lead with no record is the manager's only (t.rec is then undefined: nothing to park or remove). A record that names no session
// is refused no-live-session unless the caller takes such targets (sidless: a retire of an orphan record). Liveness is the caller's to check (targetCheck).
// lanePath (the lane_compact alias): a name a lane in reach carries goes on to the lanes ('none') unless a live lead carries it too (lane-or-lead), whatever the
// lead records say, so a lane's compaction never waits on the record store or on a record left by a lead that is gone.
export async function leadTarget($: any, e: unknown, sid: string, name: unknown, no: No, opts: { sidless?: boolean; lanePath?: boolean } = {}): Promise<{ t: Target; start: Start } | { deny: string } | 'none'> {
  const base = await leadBase($, e, sid)
  if ('err' in base) return no(...base.err)
  const g = base.g
  if (g.level !== 'conductor' && g.level !== 'manager') return no('lead-tool-level', c.reasonWhy('lead-tool-level'))
  const start = { level: g.level, epoch: epochOf(sid) }
  if (opts.lanePath === true && typeof name === 'string' && base.lanes.some((l) => l.name.toUpperCase() === name.toUpperCase())) {
    const by = await liveLeadByName($, base.live, base.lanes, sid, name)
    // With a lane of the name, liveLeadByName never returns a target: no live lead, or lane-or-lead.
    if (by === undefined || !('no' in by)) return 'none'
    return no(by.no, c.leadWhy(by.no))
  }
  const recs = await loadLeadRecords($)
  if (typeof recs === 'string') return no(recs, c.leadWhy(recs))
  const hit = c.leadRec(recs, base.lanes, g, sid, name)
  if (!hit.ok) {
    if (hit.reason !== 'unknown-lead') return no(hit.reason, c.leadWhy(hit.reason))
    const by = await liveLeadByName($, base.live, base.lanes, sid, name as string)
    if (by === undefined) return 'none'
    if ('no' in by) return no(by.no, c.leadWhy(by.no))
    if (g.level !== 'manager') return no('unknown-lead', c.leadWhy('unknown-lead'))
    return { t: by, start }
  }
  const r = hit.rec
  // A record with no session and no proof of its owner reaches nothing, but its own conductor may still remove it (lead_retire, the sidless call). So may it a
  // record whose session has no live registry row (a panel closed without /callboard off): the lead's binding may be gone with it, and a removal gives no reach.
  // The remove path checks again that the session is not live.
  const removable = opts.sidless === true && (r.rec.sid === undefined || !base.live.some((row) => row.j.sessionId === r.rec.sid))
  if (g.level === 'conductor' && !removable && !(await boundTo($, r))) return no('record-changed', c.leadWhy('record-changed'))
  if (r.rec.sid === undefined && opts.sidless !== true) return no('no-live-session', c.leadWhy('no-live-session'))
  if (r.rec.sid === sid) return no('self', c.reasonWhy('self'))
  return { t: { name: r.rec.name, sid: r.rec.sid, repo: r.repo, key: r.key, rec: r }, start }
}

// The target checks, each from a fresh read: (e) the caller's grant level and epoch are the start's; (a) exactly one registry row carries the lead's session, with
// a usable pid; (b) that session holds a live lead presence file for the target's repo; for a record (c, d, e) the record of that name is still the one
// machine-wide, still names the same session and conductor, still in the conductor's repos and bound; for a lead with no record its registry name still is the
// name and no lane carries it. undefined: all hold. A target with no session fails (a), no-live-session. The process check (f) is the stop tools' own.
export async function targetCheck($: any, sid: string, t: Target, start: Start): Promise<string | undefined> {
  if (grantOf(sid)?.level !== start.level || epochOf(sid) !== start.epoch) return 'grant-changed'
  const to = t.sid
  if (to === undefined) return 'no-live-session'
  const base = await leadCore($, sid)
  if ('err' in base) return base.err[0]
  if (base.g.level !== start.level || epochOf(sid) !== start.epoch) return 'grant-changed'
  const rows = base.live.filter((r) => r.j.sessionId === to)
  if (rows.length === 0) return 'no-live-session'
  if (rows.length > 1) return 'session-duplicate'
  if (!Number.isInteger(rows[0].j.pid) || rows[0].j.pid < 2) return 'no-pid'
  const pres = await leadPresence($, base.live, to, t.repo)
  if (pres === 'error') return 'presence-unreadable'
  if (pres === 'no') return 'not-a-lead'
  if (t.rec) {
    const recs = await loadLeadRecords($)
    if (typeof recs === 'string') return recs
    const hit = c.leadRec(recs, base.lanes, base.g, sid, t.name)
    if (!hit.ok) return hit.reason === 'unknown-lead' ? 'record-changed' : hit.reason
    if (hit.rec.key !== t.rec.key || hit.rec.rec.sid !== t.sid || hit.rec.rec.conductorSid !== t.rec.rec.conductorSid) return 'grant-changed'
    if (base.g.level === 'conductor' && !(await boundTo($, hit.rec))) return 'record-changed'
    return undefined
  }
  if (c.leadNameOf(base.live.map((r) => r.j), to) !== t.name) return 'no-live-session'
  if (base.lanes.some((l) => l.name.toUpperCase() === t.name.toUpperCase())) return 'lane-or-lead'
  return undefined
}

// The person's dialog before a manager's lead tool call, every time; the one dialog of the session (askOnce). undefined: the person said yes; otherwise the deny.
// tool names the call in a timed-out deny; yes is the button that confirms.
export async function managerAsk($: any, sid: string, tool: string, question: string, yes: string, no: No, header: string = c.HEADER.manager): Promise<{ deny: string } | undefined> {
  const r = await askOnce($, sid, question, yes, c.MANAGER_LEAD_NO, header)
  if (r === 'busy') return no('busy', c.reasonWhy('busy'))
  if (r === 'timed-out') return { deny: leadReason(tool, `${await timedOut($, sid)}.`) }
  if (r !== 'yes') return no('not-confirmed', 'the person did not confirm.')
  return undefined
}

// One lead tool call on a target: the checks, the manager's dialog and the checks again, the ledger row of a resume, then the cue. A call the engine abandoned
// (cut off while the dialog was open: its answer went out already) writes no row and sends nothing.
async function leadVerb($: any, sid: string, tool: Tool, got: { t: Target; start: Start }, no: No, next: any) {
  const { t, start } = got
  const verb: c.Verb = tool === 'lead_resume' ? 'resume' : 'compact'
  const bad = await targetCheck($, sid, t, start)
  if (bad) return no(bad, c.leadWhy(bad))
  // targetCheck refuses a target with no session.
  const toSid = t.sid as string
  let dialog: 'yes' | 'none' = 'none'
  if (start.level === 'manager') {
    const asked = await managerAsk($, sid, tool, c.managerLeadQuestion(tool, t.name, t.repo, toSid), c.MANAGER_LEAD_YES[tool], no)
    if (asked) return asked
    dialog = 'yes'
    const again = await targetCheck($, sid, t, start)
    if (again) return no(again, c.leadWhy(again))
  }
  if (next?.signal?.aborted === true) return no('abandoned', c.leadWhy('abandoned'))
  if (verb === 'resume') {
    const row = { kind: 'lead-resume' as const, hash: t.key, repo: t.repo, lane: t.name, by: sid, target: toSid, tier: start.level, dialog }
    if (!(await ledgerAdd($, row))) return no('ledger-write', c.reasonWhy('ledger-write'))
  }
  const deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
  const sent = await cueExchange($, sid, t.name, toSid, verb, deadline, (code, why) => no(code, c.leadCueWhy(verb, code, why)), false, 'lead')
  if (sent) return sent
  return { result: `cue ${verb} acted for lead ${t.name}.` }
}

export async function leadToolCall($: any, e: any, next: any, tool: Tool) {
  return leadTool($, e, tool, async (sid, no) => {
    const got = await leadTarget($, e, sid, e.lead, no)
    if (got === 'none') return no('unknown-lead', c.leadWhy('unknown-lead'))
    if ('deny' in got) return got
    return leadVerb($, sid, tool, got, no, next)
  })
}

// lane_compact with a lead's name, for a conductor or the manager: the same call as lead_compact (the manager's dialog included). undefined: no lead carries the
// name, and the caller goes on to the lanes.
export async function leadCompactTo($: any, e: any, sid: string, no: No, next: any): Promise<{ deny: string } | { result: string } | undefined> {
  if (typeof e.lane !== 'string' || !c.NAME_RE.test(e.lane)) return undefined
  const got = await leadTarget($, e, sid, e.lane, no, { lanePath: true })
  if (got === 'none') return undefined
  if ('deny' in got) return got
  return leadVerb($, sid, 'lead_compact', got, no, next)
}
