// lead_open: a conductor opens a panel for a new lead in one of its repos and cues it (ADR 0006). The new panel decides: it runs every check itself and makes itself the lead.
// Trust rules held here: the repo is in the conductor's reach at the call; one open in flight per conductor; per conductor at most LEADS_PER_CONDUCTOR leads it owns at once (live and parked, from the lead records) and OPENS_PER_CONDUCTOR_HOUR successful opens an hour (from the
// ledger, the bound on a conductor that loops); no cap on the live leads of a repo (the new panel's second-lead naming rule still applies at its grant); every check runs before the first write, and a write that fails takes back the offer and voids its row.
import * as c from '../core.ts'
import { conductorHome, condOffers } from '../mem.ts'
import { sha, where, statR, real, logq, rmF, pause } from './base.ts'
import { writeBrief, resultDirOk, sendCue, registryEntries, loadLanes } from './store.ts'
import type { RegRow } from './store.ts'
import { cfgReadStrict, reservedGet, ownWrite } from './grants.ts'
import { leadTool, leadBase, openExchange } from './lanes.ts'
import { ledgerAdd, ledgerRowsFor, promptNewId } from './answer-hook.ts'
import { promptLinkOnce } from './answer-tiers.ts'
import { loadLeadRecords, leadNameHeld } from './lead-records.ts'
import { goLeadTailFor } from './go.ts'

// The conductors that have an open running, by session id, and the names those opens carry (lower case): held until the offer is gone.
const opening = new Set<string>()
const openingNames = new Set<string>()

const TIMEOUT_WHY = 'no window answered in time. A VS Code window with the repo as its first workspace folder must run the callboard panels extension (1.3.0 or later). A panel may still appear in that folder: do not open another.'

// The NAME the person typed for /callboard lead or conductor, judged the way lead_open judges a new lead's name: a code for a refusal, undefined when the name is free.
// The shape (NAME_RE) and the reserved names first; then, in any letter case, no other live session, no lane, no lead stamp on a lane, no lead record of any repo
// (the session's own record excepted; a lane stamp counts unless the session made or joined that lane) and no request in the open folder or in flight carries it. A store that cannot be read refuses. The caller loads the
// machine's reserved names first (reservedGet).
export async function grantNameNo($: any, sid: string, name: string): Promise<string | undefined> {
  if (!c.NAME_RE.test(name)) return 'name-bad'
  if (c.reservedHit(name)) return 'name-reserved'
  const lower = name.toLowerCase()
  const live = await registryEntries($)
  if (!live) return 'registry-unreadable'
  if (live.some((r) => r.j.sessionId !== sid && typeof r.j.name === 'string' && r.j.name.toLowerCase() === lower)) return 'name-in-use'
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return lanes
  if (lanes.some((l) => l.name.toLowerCase() === lower || (l.leadName?.toLowerCase() === lower && !c.leadOwns(l, sid)))) return 'name-in-use'
  const held = await leadNameHeld($, sid, name, false)
  if (held === true) return 'name-in-use'
  if (held !== false) return 'store-unreadable'
  const p = await where($)
  if (!p) return 'no-paths'
  if (openingNames.has(lower)) return 'name-in-open'
  const waiting = ((await $.fs.list(`${p.root}/open`).catch(() => [])) as { name: string }[]).some((f) => f.name.toLowerCase().startsWith(`${lower}.`) && !f.name.toLowerCase().endsWith('.result'))
  return waiting ? 'name-in-open' : undefined
}

export async function leadOpenCall($: any, e: any, next: any) {
  return leadTool($, e, 'lead_open', async (sid, no) => {
    await reservedGet($, sid, true)
    const base = await leadBase($, e, sid)
    if ('err' in base) return no(...base.err)
    if (base.g.level !== 'conductor') return no('not-conductor', c.reasonWhy('not-conductor'))
    const cfg = await cfgReadStrict($, sid)
    if (!cfg) return no('config-unreadable', c.reasonWhy('config-unreadable'))
    if (!cfg.conductorLeads) return no('conductor-leads-off', c.reasonWhy('conductor-leads-off'))
    if (opening.has(sid)) return no('open-in-flight', c.reasonWhy('open-in-flight'))
    // Another conductor's open of the same name is running: its request file would be replaced by this one's.
    const nm = typeof e.name === 'string' ? e.name.toLowerCase() : ''
    if (nm !== '' && openingNames.has(nm)) return no('name-in-open', c.reasonWhy('name-in-open'))
    opening.add(sid)
    if (nm !== '') openingNames.add(nm)
    try {
      // The record the accept writes names this conductor: its own act, so the leads-changed watch moves with it (ownWrite holds the tick's look back meanwhile).
      return await ownWrite($, sid, () => openLead($, e, sid, base, no))
    } finally {
      opening.delete(sid)
      if (nm !== '') openingNames.delete(nm)
    }
  })
}

async function openLead($: any, e: any, sid: string, base: { live: RegRow[]; lanes: c.Lane[]; g: c.Grant }, no: (reason: string, why: string) => Promise<{ deny: string }>) {
  const a = c.leadOpenArgs({ repo: e.repo, name: e.name, task: e.task, model: e.model, job: e.job })
  if (!a.ok) return no(a.reason, c.reasonWhy(a.reason))
  const p = await where($)
  if (!p) return no('no-paths', 'no-paths')
  // The repo must be its own real path and one of the conductor's pins now (the list file read at this call, intersected with its approved list).
  const repo = await real($, a.repo)
  if (repo !== a.repo || !base.g.pins.includes(repo)) return no('not-in-reach', c.reasonWhy('not-in-reach'))
  const home = conductorHome.get(sid)
  if (home === undefined || repo === home || c.within(home, repo) || c.within(repo, home)) return no('conductor-nested', c.reasonWhy('conductor-nested'))
  // The name, in any letter case: no live session, no lane record (or lead stamp) and no request in the open folder carries it. A result file left over is no request.
  const lower = a.name.toLowerCase()
  if (base.live.some((r) => typeof r.j.name === 'string' && r.j.name.toLowerCase() === lower) || base.lanes.some((l) => l.name.toLowerCase() === lower || l.leadName?.toLowerCase() === lower)) return no('name-in-use', c.reasonWhy('name-in-use'))
  // A lead record of any repo holds its name too (a record kept for its lanes keeps it). A read that failed is not "free".
  const recs = await loadLeadRecords($)
  if (typeof recs === 'string') return no('store-unreadable', c.reasonWhy('store-unreadable'))
  if (recs.some((s) => s.store.leads.some((l) => l.name.toLowerCase() === lower))) return no('name-in-use', c.reasonWhy('name-in-use'))
  // The repo's record file holds LEAD_STORE_MAX records at most: with it full the new lead would be on with no record and no conductor, so the open stops here.
  if (recs.some((s) => s.store.repo === repo && s.store.leads.length >= c.LEAD_STORE_MAX)) return no('lead-record-cap', c.reasonWhy('lead-record-cap'))
  const waiting = ((await $.fs.list(`${p.root}/open`).catch(() => [])) as { name: string }[]).some((f) => f.name.toLowerCase().startsWith(`${lower}.`) && !f.name.toLowerCase().endsWith('.result'))
  if (waiting) return no('name-in-open', c.reasonWhy('name-in-open'))
  // No offer or claim for the repo; an unreadable path counts as taken.
  const key = await sha($, repo)
  if (!(await resultDirOk($, p, 'offers'))) return no('unsafe-offers-dir', c.reasonWhy('unsafe-offers-dir'))
  const offer = `${p.root}/offers/${key}.json`
  const now = await $.clock.now()
  // An offer left behind (a crash, a reload) is taken away once it is older than OFFER_STALE_MS; a claim goes the same way, after the same age.
  const left = await statR($, offer)
  if (left !== 'absent' && !(left !== 'error' && left.kind === 'file' && now - left.mtimeMs > c.OFFER_STALE_MS && (await rmF($, offer))?.exitCode === 0)) return no('offer-open', c.reasonWhy('offer-open'))
  // A claim left behind with no offer (its panel never answered) goes with a stale offer, after the same age; a younger one still holds the repo.
  const cl = await statR($, `${p.root}/offers/${key}.claim`)
  if (cl !== 'absent' && !(cl !== 'error' && cl.kind === 'file' && now - cl.mtimeMs > c.OFFER_STALE_MS && (await rmF($, `${p.root}/offers/${key}.claim`))?.exitCode === 0)) return no('offer-open', c.reasonWhy('offer-open'))
  // The offer, grant and void rows of the ledger (kind by kind, so the volume follows opens and not prompts answered); leadOpenLimit keeps the conductor's own. A grant whose nonce was voided does not count.
  const rows: c.LeadOpenRow[] = []
  for (const kind of ['lead-offer', 'lead-grant', 'lead-offer-void']) {
    const part = await ledgerRowsFor($, p, `"kind":"${kind}"`)
    if (part === 'unreadable') return no('ledger-unreadable', c.reasonWhy('ledger-unreadable'))
    rows.push(...part)
  }
  // Only the leads of repos still in the conductor's reach count: lead_retire cannot reach the others, so the person ends those.
  const limit = c.leadOpenLimit(recs.filter((s) => base.g.pins.includes(s.store.repo)).flatMap((s) => s.store.leads), rows, sid, now)
  if (!limit.ok) return no(limit.code, `${limit.code}: ${limit.code === 'lead-cap' ? c.leadCapText(limit.held) : c.openBackstopText(limit.retryAt, now)}`)
  const me = base.live.find((r) => r.j.sessionId === sid)?.j
  if (!me || !Number.isInteger(me.pid) || typeof me.procStart !== 'string') return no('registry-unreadable', c.reasonWhy('registry-unreadable'))

  // The writes, in order: the ledger row, the offer (created only if absent), the request the extension reads, and once the panel is open the brief. A failure takes back the offer and voids the row.
  const nonce = (await promptNewId($)).replace(/-/g, '')
  const voided = (code: string) => ledgerAdd($, { kind: 'lead-offer-void', hash: key, nonce, code })
  if (!(await ledgerAdd($, { kind: 'lead-offer', hash: key, repo, lane: a.name, nonce, by: sid }))) return no('ledger-write', c.reasonWhy('ledger-write'))
  const claim = `${p.root}/offers/${key}.claim`
  const fail = async (code: string, why: string) => {
    await rmF($, [offer, claim])
    await voided(code)
    return no(code, why)
  }
  const text = c.offerText({ v: 1, name: a.name, repo, model: a.model, conductor: { sid, pid: me.pid, start: me.procStart }, at: now, nonce })
  if (text.length > c.OFFER_MAX) {
    await voided('offer-write')
    return no('offer-write', c.reasonWhy('offer-write'))
  }
  const put = await promptLinkOnce($, offer, text)
  // Another offer took the repo between the check and the write: it is not ours to remove.
  if (put === 'exists') {
    await voided('offer-open')
    return no('offer-open', c.reasonWhy('offer-open'))
  }
  if (put !== 'ok') return fail('offer-write', c.reasonWhy('offer-write'))
  // From here the offer is ours: a throw while the request is out (a host call that times out) takes back the request and the offer like any other failure.
  let r: Awaited<ReturnType<typeof openExchange>>
  try {
    r = await openExchange($, sid, a.name, 'lead', c.leadRequestText(nonce, repo), TIMEOUT_WHY, fail, nonce)
  } catch {
    await rmF($, `${p.root}/open/${a.name}.lead`)
    return fail('offer-write', c.reasonWhy('offer-write'))
  }
  if ('deny' in r) return r
  // The panel is open. The brief comes first: with none the new lead has nothing to read, so no cue goes and the offer is voided. None of what follows throws out.
  // A job (job: true) gets the job paragraph before its task; the offer, the record and everything after are the same as for any lead.
  const brief = a.job ? c.leadJobBriefText(a.name, a.task) : c.leadBriefText(a.name, a.task)
  const wb = await writeBrief($, p.uid, c.briefPath(repo, a.name), c.leadBriefHead(a.name), brief).catch(() => 'brief-write')
  if (wb) return fail('brief-write', c.leadNotGrantedText(a.name, r.sid, `its brief could not be written (${wb}).`))
  // The nonce is kept for conductorGrantCheck: a grant that names this conductor and carries a nonce it never offered is told to the person.
  const kept = (condOffers.get(sid) ?? []).filter((o) => now - o.at < c.COND_OFFERS_KEEP_MS)
  condOffers.set(sid, [...kept, { nonce, at: now }].slice(-c.COND_OFFERS_MAX))
  await logq($, sid, 'lead-opened', a.name)

  // The cue: the new panel runs every check itself and answers. One more try when it says it was not ready; its claim is its own, so the same cue finds it again.
  const cue = c.leadCueLine(nonce)
  if (!cue) return fail('grammar', c.leadNotGrantedText(a.name, r.sid, 'the cue was not valid.'))
  let denied: string | undefined
  const cueNo = async (reason: string) => {
    denied = reason
    return { deny: reason }
  }
  let ans: Awaited<ReturnType<typeof sendCue>> | undefined
  for (let i = 0; i < 2; i++) {
    denied = undefined
    ans = await sendCue($, sid, a.name, r.sid, 'lead', cue, (await $.clock.now()) + c.LEAD_CUE_WAIT_MS, cueNo, { quiet: true })
    if ('deny' in ans || ans.outcome !== 'held') break
    if (i === 0) await pause($, 3000)
  }
  const out = ans as Awaited<ReturnType<typeof sendCue>>
  if ('deny' in out) {
    // No answer: the panel may still take the offer, so nothing is taken back here (the sweep removes it once it is old).
    if (denied === 'no-answer') return { result: c.leadNoAnswerText(a.name, r.sid) }
    return fail(denied ?? 'cue-failed', c.leadNotGrantedText(a.name, r.sid, `the cue was not sent (${denied ?? 'cue-failed'}).`))
  }
  if (out.outcome === 'ok') {
    await rmF($, [offer, `${p.root}/offers/${key}.claim`])
    return { result: `${c.leadOpenedText(a.name, r.sid, out.reason === c.LEAD_MODEL_UNSET || out.reason === c.LEAD_BOTH_UNSET, out.reason === c.LEAD_OWNER_UNSET || out.reason === c.LEAD_BOTH_UNSET)}${await goLeadTailFor($, r.sid)}` }
  }
  // A refusal that names no reason (the panel's own tick failed) is as unclear as no answer: nothing is taken back.
  if (out.outcome === 'refused' && out.reason === 'other') return { result: c.leadNoAnswerText(a.name, r.sid) }
  // Refused, or not ready twice: the offer and the claim go, the row is voided (it counts against no limit), and the panel stays an ordinary one.
  await rmF($, [offer, `${p.root}/offers/${key}.claim`])
  await voided(out.reason)
  const why = `${out.outcome === 'held' ? 'it was not ready: ' : ''}${c.reasonWhy(out.reason)}`
  await logq($, sid, 'lead-refused', `${a.name} ${out.reason}`)
  return no(`${out.outcome}-${out.reason}`, c.leadNotGrantedText(a.name, r.sid, why))
}
