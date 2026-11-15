// The cues a session holding a lead grant takes (ADR 0007). handle (engine/lanes.ts) calls leadCue for such a session; c.leadCueNo decides who may send what.
// Trust rules held here: a cue carries no sender, so a verb is taken only while a sender that may send it is live and passes its checks; the owner counts only
// through the lead's own binding (ownOwner); a compaction order (compact with no request of the lead's own) needs a live owner. A filter, not proof: any writer
// of the cue folder can send a cue while such a sender is live, and what the lead then does is its own fixed turn or its own request.
import type { Request } from '../../types'
import * as c from '../core.ts'
import { log, submitOwn } from './base.ts'
import { idleCheck, loadLanes } from './store.ts'
import type { Reg, Answer, RegRow } from './store.ts'
import { managerTrusted, conductorsTrusted, pinOf, LEAD } from './grants.ts'
import { counts, bump, leadNudge, busyAgents, backgroundShells } from './compaction.ts'
import { getRequest } from '../state.ts'
import { ownOwner } from './lead-records.ts'
import { levelSave } from './levels.ts'
import { reportTargetOf, retireReportCheck } from './lanes.ts'
import { grants } from '../mem.ts'

export type LeadCueCtx = {
  now: number
  reg: Reg
  refuse: (reason: string) => Promise<void>
  hold: (reason: string) => Promise<void>
  answer: Answer
  compactOwn: (req: Request) => Promise<unknown>
}

export async function leadCue($: any, sid: string, cue: c.Cue, x: LeadCueCtx) {
  const { now, reg, refuse, hold, answer, compactOwn } = x
  if (!c.OWNER_CUE_VERBS.includes(cue.verb) && !c.LEAD_MANAGER_CUE_VERBS.includes(cue.verb)) return refuse('not-eligible')
  const live = await reg()
  if (!live) return refuse('registry-unreadable')
  // The owner: the conductor of the lead's own binding, its record still matching it, live and passing the lead's conductor checks for the record's repo.
  const own = await ownOwner($, sid, live)
  const owner = typeof own === 'object'
  const manager = owner ? false : await managerTrusted($, live, sid)
  // Any other trusted conductor of the lead's repo counts for compact only, the rule from before lead records.
  const conductor = cue.verb === 'compact' && !owner && !manager && (await conductorsTrusted($, live, sid, pinOf(sid))).length > 0
  const no = c.leadCueNo(cue.verb, { owner, manager, conductor })
  // A record that no longer matches the binding, or records that cannot be read, say so when nobody else may send the cue.
  if (no) return refuse(own === 'record-changed' || own === 'store-unreadable' ? own : no)
  const req = (await getRequest($)).value as Request | null | undefined
  if (cue.verb === 'compact') {
    if (req && req.viaLead === true && req.mode === 'on-cue' && req.phase === 'armed') return compactOwn(req)
    // With no request of its own the lead is ordered to compact, only while its owner is live (the cue carries no sender: a manager's compact of an owned lead
    // orders it too, behind the person's dialog). Any other request, or no owner, is no-request.
    if (req || !owner) return refuse('no-request')
    return leadNudge($, sid, now, answer, refuse)
  }
  if (cue.verb === 'park' || cue.verb === 'retire') return leadStop($, sid, cue.verb, live, owner ? own.rec.rec.name : undefined, { now, reg, refuse, hold, answer })
  // resume: idle with an empty prompt box, the lead's name, the lane cap of resumes an hour, then the fixed turn.
  const blocked = await idleCheck($, sid, reg)
  if (blocked) return hold(blocked)
  const name = c.leadNameOf(live.map((r) => r.j), sid) ?? (owner ? own.rec.rec.name : undefined)
  if (name === undefined) return refuse('lead-unnamed')
  const capped = c.resumeAllowed(await counts($), now)
  if (capped) return refuse(capped)
  await bump($, (ct) => ({ ...ct, resumeTimes: [...(ct.resumeTimes ?? []).filter((t) => now - t < c.HOUR_MS), now] }))
  try {
    await submitOwn($, c.leadResumeText(name))
  } catch {
    await bump($, (ct) => ({ ...ct, resumeTimes: (ct.resumeTimes ?? []).filter((t) => t !== now) })).catch(() => undefined)
    await answer('refused', 'submit-failed')
    return log($, sid, 'resume-failed')
  }
  await answer('ok')
  return log($, sid, 'resumed')
}

// park and retire: the lane's rules (idle with an empty prompt box, no background agent or shell), then the lead's own. A park: no lane that names this lead has
// a live session, and the saved lead grant is written again now and read back, so it is under a day old at the park and outlives the 28-day unpark limit (the
// saved grant lasts 30 days). A retire: no lane record names this lead at all, and its own report is signed with its own id since its last turn. Only then ok:
// the caller signals on that answer, and the lead never stops itself. recName: the lead's record name, when its owner was found through it.
async function leadStop($: any, sid: string, verb: 'park' | 'retire', live: RegRow[], recName: string | undefined, x: Omit<LeadCueCtx, 'compactOwn'>) {
  const { now, reg, refuse, hold, answer } = x
  const blocked = await idleCheck($, sid, reg)
  if (blocked) return hold(blocked)
  if (await busyAgents($)) return refuse('background-work')
  const shells = await backgroundShells($, sid, reg)
  if (shells) return refuse(shells)
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return refuse(lanes)
  const entries = live.map((r) => r.j as c.RegEntry)
  const name = c.leadNameOf(entries, sid)
  const mine = c.leadLanes(lanes, { sid, names: [grants.get(sid)?.name, name, recName] })
  if (verb === 'park') {
    if (c.liveLaneNames(mine, entries).length > 0) return refuse('lead-has-live-lanes')
    const pin = pinOf(sid)
    if (pin === undefined) return refuse('grant-unsaved')
    await levelSave($, sid, LEAD, pin)
    // levelSave logs a failed write and returns: the key read back is the proof.
    const saved = (await Promise.resolve($.store.get(`${c.LEAD_HINT_PREFIX}${sid}`)).catch(() => undefined)) as { pin?: unknown; savedAt?: unknown } | undefined
    if (saved?.pin !== pin || typeof saved.savedAt !== 'number' || !(now - saved.savedAt < 60_000) || saved.savedAt > now + 60_000) return refuse('grant-unsaved')
  } else {
    if (mine.length > 0) return refuse('lead-has-lanes')
    const target = await reportTargetOf($, sid)
    if (!target) return refuse('report-unknown')
    const bad = await retireReportCheck($, sid, target)
    if (bad) return refuse(bad)
  }
  await answer('ok')
  return log($, sid, verb === 'retire' ? 'retire-confirmed' : 'park-confirmed', name ?? recName ?? '-')
}
