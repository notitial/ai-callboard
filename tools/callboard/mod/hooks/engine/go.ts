// The go (ADR 0009): the mod's own dialog in a lead's or conductor's session, the go file and its ledger rows, go_request, go_status and /callboard go.
// Trust rules held here: only the person's click in the mod's dialog writes a go, and no tool lets an agent write or end one; a go counts only while its file and
// its `go-grant` row agree, it has no `go-end` row and its end has not come; a reader is covered by its own session id, checked fresh on every read, and never
// while the protected-paths guard is missing; under a conductor's go every link down to the reader is a session id in a record (the lane's record names its
// lead, the lead's record names the conductor and is bound to it), and a record that cannot be read covers nobody; the manager gives and reads none; each row is
// written before the effect it records.
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import * as g from '../go.ts'
import { dialogOpen, goAsked, goWatch, conductorHome } from '../mem.ts'
import { sha, where, statR, dirOk, readSmallR, run, MKDIR, rmF, log, logq, toast, withTimeout } from './base.ts'
import { loadLanes } from './store.ts'
import { grantOf } from './grants.ts'
import { epochOf } from './levels.ts'
import { leadCore } from './lanes.ts'
import { loadLeadRecords, boundState } from './lead-records.ts'
import type { LeadRecs } from './lead-records.ts'
import { ensureTimer } from './tick.ts'
import { ledgerAdd, ledgerRowsFor, promptNewId, guardCheck, unattendedHeld } from './answer-hook.ts'
import { promptLinkOnce } from './answer-tiers.ts'

type Found = { go: g.Go; rows: pr.LedgerRow[] }
// The live goes, and how many go files could not be read or hashed (after one more try): such a file is no go to a reader, and is told to whoever ends goes.
type Live = Found[] & { missed: number }
type Paths = { uid: number; root: string }
const goDir = (p: Paths): string => `${p.root}/go`
// A time for the person, in this machine's zone.
const when = (ms: number): string => g.goWhen(ms, -new Date(ms).getTimezoneOffset())

// The go folder's entries, or 'absent' (no go was ever given here) or 'unreadable' (not a private folder of ours, or a listing that failed).
async function goNames($: any, p: Paths): Promise<{ name: string; mtimeMs?: number }[] | 'absent' | 'unreadable'> {
  const st = await statR($, goDir(p))
  if (st === 'absent') return 'absent'
  if (st === 'error' || st.kind !== 'dir' || st.uid !== p.uid || st.mode !== 0o700) return 'unreadable'
  try {
    return (await $.fs.list(goDir(p))) as { name: string; mtimeMs?: number }[]
  } catch {
    return 'unreadable'
  }
}

// The live goes on this machine, each with the ledger rows that name it. A file that is not a go file of ours, that names another id than its own, or whose
// row is missing or names another hash is no go. A go past its end gets its one `go-end` row here (the `<id>.ended` mark is taken first, so one reader writes
// it). guard: false skips the guard check, for the calls that only end a go or show one to its giver. A ledger that cannot be read is 'unreadable', never "none".
async function goesLive($: any, opts: { guard?: boolean } = {}): Promise<Live | { no: 'guard'; why: string } | { no: 'unreadable' }> {
  const p = await where($)
  if (!p) return { no: 'unreadable' }
  if (opts.guard !== false) {
    const missing = await guardCheck($)
    if (missing !== undefined) return { no: 'guard', why: pr.GUARD_WHY[missing] }
  }
  const names = await goNames($, p)
  const out: Live = Object.assign([] as Found[], { missed: 0 })
  if (names === 'absent') return out
  if (names === 'unreadable') return { no: 'unreadable' }
  const all = new Set(names.map((n) => n.name))
  // A go whose end was marked is over: its file is not read again.
  for (const name of [...all].filter((n) => g.GO_NAME_RE.test(n) && !all.has(`${n.slice(0, -5)}.ended`)).sort().slice(0, g.GO_SCAN_MAX)) {
    let r = await readSmallR($, `${goDir(p)}/${name}`, p.uid, g.GO_FILE_MAX)
    if (r.state === 'changed' || r.state === 'failed') r = await readSmallR($, `${goDir(p)}/${name}`, p.uid, g.GO_FILE_MAX)
    if (r.state !== 'ok') {
      if (r.state !== 'bad') out.missed++
      continue
    }
    const go = g.parseGo(r.text)
    if (!go || `${go.id}.json` !== name) continue
    const now = await $.clock.now()
    if (now >= go.ends) {
      if ((await promptLinkOnce($, `${goDir(p)}/${go.id}.ended`, 'expired\n')) === 'ok') await ledgerAdd($, { kind: 'go-end', id: go.id, code: 'expired' })
      continue
    }
    const rows = await ledgerRowsFor($, p, `"id":"${go.id}"`)
    if (rows === 'unreadable') return { no: 'unreadable' }
    const text = r.text
    const hash = await sha($, text).catch(() => undefined)
    if (hash === undefined) out.missed++
    else if (g.goState(go, hash, rows, now) === 'live') out.push({ go, rows: rows.filter((x) => x.id === go.id) })
  }
  return out
}

// Go files (and their marks) written longer ago than the longest a go can last plus GO_KEEP_MS are removed, at each new go; the number left, or undefined when
// the folder cannot be listed.
async function goPrune($: any, p: Paths, now: number): Promise<number | undefined> {
  const names = await goNames($, p)
  if (names === 'absent') return 0
  if (names === 'unreadable') return undefined
  const old = names.filter((n) => typeof n.mtimeMs === 'number' && now - n.mtimeMs > g.GO_MAX_HOURS * c.HOUR_MS + g.GO_KEEP_MS && (g.GO_NAME_RE.test(n.name) || /^[0-9a-f-]{36}\.ended$/.test(n.name)))
  if (old.length > 0) await rmF($, old.map((n) => `${goDir(p)}/${n.name}`))
  const gone = new Set(old.map((n) => n.name))
  return names.filter((n) => g.GO_NAME_RE.test(n.name) && !gone.has(n.name)).length
}

// The go dialog: the mod's own, with its own time limit, Cancel first. Only the person's click on Give go is a yes. After the limit the engine dialog may still
// be on screen: a click on it then records nothing, and a toast says so.
async function goAsk($: any, sid: string, question: string): Promise<'yes' | 'no' | 'error' | 'timed-out' | 'busy'> {
  if (dialogOpen.has(sid)) return 'busy'
  dialogOpen.add(sid)
  try {
    const asked = Promise.resolve($.ui.ask(question, { options: [g.GO_NO, g.GO_YES], header: g.GO_HEADER })) as Promise<unknown>
    const a = await withTimeout($, asked.then((x) => ({ x })), g.GO_DIALOG_MS)
    if (a === 'timeout') {
      asked.then((x) => (x === g.GO_YES ? toast($, g.GO_LATE_TOAST) : undefined)).catch(() => undefined)
      toast($, g.GO_TIMED_OUT_TOAST)
      return 'timed-out'
    }
    return a.x === g.GO_YES ? 'yes' : a.x === g.GO_NO ? 'no' : 'error'
  } catch {
    return 'error'
  } finally {
    dialogOpen.delete(sid)
  }
}

// The lead records a conductor's go reaches beyond the leads it holds from the click: among the sessions asked about (`cands`), the ones whose record names the
// granting conductor and whose lead is bound to that record now. The records are loaded once per call (`box`), and only when a conductor's go is live. unread:
// the records, or a binding of one that names this conductor, could not be read, so that link is not known and covers nobody. names: each such lead's record name.
type RecBox = { recs?: LeadRecs | string }
async function ownedFor($: any, go: g.Go, cands: string[], box: RecBox): Promise<{ owned: string[]; unread: boolean; names: Map<string, string> }> {
  const out = { owned: [] as string[], unread: false, names: new Map<string, string>() }
  if (go.v !== 2) return out
  box.recs ??= await loadLeadRecords($)
  if (typeof box.recs === 'string') return { ...out, unread: true }
  for (const s of box.recs) {
    for (const rec of s.store.leads) {
      if (rec.sid === undefined || rec.conductorSid !== go.by.sid || !cands.includes(rec.sid)) continue
      const st = await boundState($, { key: s.key, repo: s.store.repo, rec }).catch(() => 'error' as const)
      if (st === 'error') out.unread = true
      else if (st === 'bound') {
        out.owned.push(rec.sid)
        out.names.set(rec.sid, rec.name)
      }
    }
  }
  return out
}
// The sessions whose lead record decides whether a go covers `reader`: the reader itself (a lead) and the lead its own lane record names by session id.
const leadCands = (reader: string, lanes: c.Lane[]): string[] => [reader, ...lanes.flatMap((l) => (l.sid === reader ? [c.laneLeadSid(l)] : [])).filter((x): x is string => x !== undefined)]

const ZERO_ID = '00000000-0000-4000-8000-000000000000'
type Given = { go: g.Go; ends: string } | { no: string; why?: string }
// One go, from the checks to the file: the session is a lead or a conductor; the text passes; the guard holds; the sessions the dialog counts are the ones the
// tools resolve as this session's now, by the session id each record carries (a lead: its lanes; a conductor: the leads whose bound record names it, and their
// lanes); they fit the caps and one go file; the person clicks Give go; the session still holds the same grant; then the `go-grant` row with the
// hash of the file's bytes, then the file (created only if absent). A file that cannot be written gets a `go-end` row (void), so the row never stands alone.
// capped: a go_request call, counted against the hourly cap once it reaches the dialog.
async function goGive($: any, sid: string, text: unknown, hours: number, author: 'tier' | 'person', capped: boolean): Promise<Given> {
  const level = grantOf(sid)?.level
  if (level !== 'lead' && level !== 'conductor') return { no: level === 'manager' ? 'manager' : 'not-lead' }
  if (g.goTextNo(text) !== undefined) return { no: 'bad-text' }
  const missing = await guardCheck($)
  if (missing !== undefined) return { no: 'guard', why: `${g.GO_REFUSE.guard}: ${pr.GUARD_WHY[missing]}.` }
  const base = await leadCore($, sid)
  if ('err' in base) return { no: base.err[0] === 'conductor-list' ? 'conductor-list' : 'store-unreadable', why: base.err[1] }
  if (base.g.level !== level) return { no: 'not-lead' }
  const epoch = epochOf(sid)
  const held = () => grantOf(sid)?.level === level && epochOf(sid) === epoch
  const repo = level === 'lead' ? base.g.pins[0] : conductorHome.get(sid)
  const p = await where($)
  if (!p || typeof repo !== 'string') return { no: 'go-write' }
  const name = c.NAME_RE.test(base.g.name) ? base.g.name : ''
  const laneOk = (l: c.Lane) => typeof l.sid === 'string' && c.SID_RE.test(l.sid) && l.sid !== sid
  // A lead: its lanes, as the lane tools resolve them. A conductor: the leads whose bound record names it, whatever its list of repos holds now, each once, and
  // the lanes whose record names such a lead by session id. A lane that names no lead, or a lead only by name, is not taken in: under a conductor's go every link
  // is a session id. So what the dialog counts and the file holds is what go_status covers at the click. A record or a binding that cannot be read: no dialog.
  const leads: g.GoConductor['leads'] = []
  if (level === 'conductor') {
    const recs = await loadLeadRecords($)
    if (typeof recs === 'string') return { no: 'store-unreadable', why: c.LEAD_RECORDS_UNREADABLE }
    for (const s of recs) {
      for (const rec of s.store.leads) {
        if (rec.sid === undefined || rec.conductorSid !== sid || !c.SID_RE.test(rec.sid) || rec.sid === sid || leads.some((x) => x.sid === rec.sid)) continue
        const st = await boundState($, { key: s.key, repo: s.store.repo, rec }).catch(() => 'error' as const)
        if (st === 'error') return { no: 'store-unreadable', why: c.LEAD_RECORDS_UNREADABLE }
        if (st === 'bound') leads.push({ name: rec.name, sid: rec.sid, repo: s.store.repo })
      }
    }
  }
  const inLanes = base.lanes.filter((l) => {
    if (!laneOk(l)) return false
    if (level === 'lead') return c.inReach(base.g, l)
    const lead = c.laneLeadSid(l)
    return lead !== undefined && leads.some((x) => x.sid === lead)
  })
  const covered = inLanes.map((l) => ({ name: l.name, sid: l.sid as string }))
  if (covered.length > g.GO_COVERED_MAX || leads.length > g.GO_LEADS_MAX) return { no: 'too-many' }
  const opened = await $.clock.now()
  const ends = opened + hours * c.HOUR_MS
  const make = (id: string, nonce: string, at: number): g.Go => {
    const body = { id, at, ends, text: text as string, covered, nonce }
    return level === 'lead' ? { ...body, v: 1, by: { level, sid, name, repo } } : { ...body, v: 2, by: { level, sid, name, repo }, leads }
  }
  // The sessions of the go must fit one go file: checked before the person is asked, on the file as it will be written. A file of the right size that still
  // does not read back as a go (a name or a path outside its bounds) is refused as one that cannot be saved.
  const trial = g.goFileText(make(ZERO_ID, '0'.repeat(32), opened))
  if (!g.goFileFits(trial)) return { no: 'too-big' }
  if (g.parseGo(trial) === undefined) return { no: 'go-write' }
  // Old files go first, so the count is of the ones still kept; a folder that is not there yet holds none.
  const files = await goPrune($, p, opened)
  if (files !== undefined && files >= g.GO_SCAN_MAX) return { no: 'full' }
  // Another dialog of this session is open: busy, and no slot of the hour is used.
  if (dialogOpen.has(sid)) return { no: 'busy' }
  if (capped) {
    const times = goAsked.get(sid) ?? []
    if (!c.noticeAllowed(times, opened, g.GO_REQUESTS_PER_HOUR)) return { no: 'rate' }
    goAsked.set(sid, c.pushRecent(times, opened))
  }
  const asked = await goAsk($, sid, g.goQuestion({ name, lanes: covered.length, ends: when(ends), text: text as string, author, ...(level === 'conductor' ? { leads: leads.length } : {}) }))
  if (asked === 'busy') return { no: 'busy' }
  if (asked === 'timed-out') return { no: 'timed-out' }
  if (asked !== 'yes') return { no: 'cancelled' }
  if (!held()) return { no: 'grant-changed' }
  const at = await $.clock.now()
  if (at >= ends) return { no: 'timed-out' }
  await run($, [MKDIR, '-p', '-m', '700', p.root, goDir(p)])
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, goDir(p), p.uid))) return { no: 'go-write' }
  const kept = await goPrune($, p, at)
  if (kept === undefined || kept >= g.GO_SCAN_MAX) return { no: 'go-write' }
  const go = make(await promptNewId($), (await promptNewId($)).replace(/-/g, ''), at)
  const body = g.goFileText(go)
  if (g.parseGo(body) === undefined) return { no: 'go-write' }
  const hash = await sha($, body)
  if (!(await ledgerAdd($, { kind: 'go-grant', id: go.id, by: sid, tier: level, hash, end: new Date(ends).toISOString(), repo, ...(go.by.name !== '' ? { lane: go.by.name } : {}) }))) return { no: 'ledger-write' }
  if ((await promptLinkOnce($, `${goDir(p)}/${go.id}.json`, body)) !== 'ok') {
    await ledgerAdd($, { kind: 'go-end', id: go.id, code: 'void' })
    return { no: 'go-write' }
  }
  // The grant may have gone while the row and the file were written: such a go is ended at once.
  if (!held()) {
    await ledgerAdd($, { kind: 'go-end', id: go.id, code: 'void' })
    return { no: 'grant-changed' }
  }
  watchOf(sid, at)
  await logq($, sid, 'go-given', g.goShort(go.id))
  return { go, ends: when(ends) }
}

const refusal = (r: { no: string; why?: string }): string => `${r.no}: ${r.why ?? g.GO_REFUSE[r.no] ?? r.no}`

// go_request: the main agent of a lead or a conductor asks the person for a go. The tool only opens the dialog; its text is the tier's, and the end is always the default.
export async function goRequestCall($: any, e: any) {
  const sid = await $.session.id()
  ensureTimer($)
  const no = async (r: { no: string; why?: string }) => {
    await log($, sid, 'refused', `go-${r.no}`)
    return { deny: `go_request refused: ${refusal(r)}` }
  }
  if ((e as { agentId?: string }).agentId !== undefined) return no({ no: 'subagent' })
  // Inside an unattended window the person is away: the dialog would only wait in this session's panel, so none is opened.
  if (await unattendedHeld($)) return no({ no: 'unattended' })
  const r = await goGive($, sid, (e as { text?: unknown }).text, g.GO_DEFAULT_HOURS, 'tier', true)
  if ('go' in r) return { result: g.goGivenText(r.go, r.ends) }
  // The person's own answer, or none: a result, not a refusal of the call.
  if (r.no === 'cancelled' || r.no === 'timed-out') {
    await log($, sid, 'refused', `go-${r.no}`)
    return { result: `No go was given: ${g.GO_REFUSE[r.no]}` }
  }
  return no(r)
}

// go_status: the goes that cover the calling session, read fresh. The first read of a go by a session writes its `go-read` row before the go is reported; a row
// that cannot be written leaves that go unreported, and the result says so when no other go covers the session. The session a go was given in reads it with no row.
// Under a conductor's go the lead records are read too: when they cannot be, the links they would show cover nobody, and the result says so when no go is left.
export async function goStatusCall($: any, _e: any) {
  const sid = await $.session.id()
  // The manager is not in the chain, whatever a go once listed. A conductor reads only the goes given in its own session: no other go covers it.
  const level = grantOf(sid)?.level
  if (level === 'manager') return { result: g.goNoneText() }
  const found = await goesLive($)
  if ('no' in found) return { result: g.goNoneText(found.no === 'guard' ? `Callboard reports no go while the protected-paths guard is missing: ${found.why}. Tell the person.` : 'The go records could not be read. Tell the person.') }
  if (found.length === 0) return { result: g.goNoneText() }
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { result: g.goNoneText('The lane records could not be read. Tell the person.') }
  const mine: g.Go[] = []
  let unrecorded = 0
  let unread = false
  const box: RecBox = {}
  const cands = leadCands(sid, lanes)
  for (const f of found) {
    if (level === 'conductor' && f.go.by.sid !== sid) continue
    const o = f.go.by.sid === sid ? undefined : await ownedFor($, f.go, cands, box)
    const cover = g.goCovers(f.go, sid, lanes, o?.owned)
    if (cover === undefined) {
      unread ||= o?.unread === true
      continue
    }
    if (cover !== 'grantor' && !f.rows.some((r) => r.kind === 'go-read' && r.by === sid)) {
      // The reader's name for the row: its lane record's, or for a lead the name the go holds or its lead record carries.
      const lane = lanes.find((l) => l.sid === sid)?.name ?? (f.go.v === 2 ? f.go.leads.find((x) => x.sid === sid)?.name : undefined) ?? o?.names.get(sid)
      if (!(await ledgerAdd($, { kind: 'go-read', id: f.go.id, by: sid, code: cover, ...(lane !== undefined ? { lane } : {}) }))) {
        unrecorded++
        continue
      }
      await logq($, sid, 'go-read', g.goShort(f.go.id))
    }
    mine.push(f.go)
  }
  if (mine.length === 0 && unrecorded > 0) {
    await logq($, sid, 'error', 'go-read-unrecorded')
    return { result: g.goNoneText(g.GO_UNCONFIRMED) }
  }
  if (mine.length === 0 && unread) return { result: g.goNoneText('The lead records could not be read. Tell the person.') }
  return { result: g.goStatusText(mine) }
}

// The end of a lane_create result (no lane session yet: a live go that reaches this lead's lanes, its own or its conductor's, will cover the lane it opens) and of
// a lane_start result (laneSid: the lane's session, covered or not). Anything that cannot be read is "no go".
export async function goTailFor($: any, sid: string, laneSid?: string): Promise<string> {
  try {
    const found = await goesLive($)
    if ('no' in found || found.length === 0) return g.goTail(undefined)
    const lanes = laneSid === undefined ? [] : await loadLanes($)
    if (typeof lanes === 'string') return g.goTail(undefined)
    const box: RecBox = {}
    const hits: Found[] = []
    for (const f of found) {
      const o = await ownedFor($, f.go, laneSid === undefined ? [sid] : leadCands(laneSid, lanes), box)
      if (laneSid === undefined ? g.goReachesLead(f.go, sid, o.owned) : g.goCovers(f.go, laneSid, lanes, o.owned) !== undefined) hits.push(f)
    }
    const hit = hits.sort((a, b) => b.go.ends - a.go.ends)[0]
    return g.goTail(hit?.go, hit ? when(hit.go.ends) : undefined)
  } catch {
    return g.goTail(undefined)
  }
}

// The end of a lead_open result: whether a live go of the opening conductor (sid) covers the new lead (leadSid: its session), read from the records as go_status
// will read them. A go of this conductor that is live and does not reach the lead is told apart from no go: asking for another would not reach it either.
export async function goLeadTailFor($: any, sid: string, leadSid: string): Promise<string> {
  try {
    const found = await goesLive($)
    if ('no' in found) return g.goLeadTail(undefined)
    const box: RecBox = {}
    const hits: Found[] = []
    const own = found.filter((f) => f.go.v === 2 && f.go.by.sid === sid)
    for (const f of own) if (g.goReachesLead(f.go, leadSid, (await ownedFor($, f.go, [leadSid], box)).owned)) hits.push(f)
    const hit = hits.sort((a, b) => b.go.ends - a.go.ends)[0]
    if (!hit && own.length > 0) return g.GO_LEAD_TAIL_UNBOUND
    return g.goLeadTail(hit?.go, hit ? when(hit.go.ends) : undefined)
  } catch {
    return g.goLeadTail(undefined)
  }
}

// A lead or a conductor that stops being one (/callboard off, also of a grant that is only saved; a grant taken back; a lead grant moved to another folder; a
// saved conductor grant that is invalid, belongs to another folder, is refused for good at a restart, or whose restore the person cancels) ends the goes it
// gave: one `go-end` row each. Its panel closing, parking or crashing ends none, and neither does a restore that waits for the person's answer.
// Rows that could not be written, or goes that could not be read, are told to the person, who can end them with /callboard go off.
// One run per session at a time: a second call while the first is writing joins it, so a go gets one row.
// only: end just the goes the session gave at that level (a conductor grant that does not come back, in a session that may be a lead by now).
const grantorOffRuns = new Map<string, Promise<void>>()
export function goGrantorOff($: any, sid: string, only?: 'lead' | 'conductor'): Promise<void> {
  const key = `${sid} ${only ?? ''}`
  const running = grantorOffRuns.get(key)
  if (running) return running
  const p = grantorOffRun($, sid, only).finally(() => grantorOffRuns.delete(key))
  grantorOffRuns.set(key, p)
  return p
}
async function grantorOffRun($: any, sid: string, only?: 'lead' | 'conductor'): Promise<void> {
  if (only === undefined) goWatch.delete(sid)
  const found = await goesLive($, { guard: false })
  let failed = 'no' in found || found.missed > 0
  if (!('no' in found)) {
    for (const f of found) {
      if (f.go.by.sid !== sid || (only !== undefined && f.go.by.level !== only)) continue
      if (await ledgerAdd($, { kind: 'go-end', id: f.go.id, code: 'grantor-off', by: sid })) await logq($, sid, 'go-ended', g.goShort(f.go.id))
      else failed = true
    }
  }
  if (failed) {
    await logq($, sid, 'error', 'go-end-failed')
    toast($, g.GO_END_FAILED_TOAST)
  }
}

// /callboard go, the person's own command (their prompt or the phone): the list, off (it ends one go or all of them, from any session) and the dialog (in a
// lead's or conductor's session, with the text they typed).
export async function goCommand($: any, sid: string, code: c.OriginCode, op: g.GoOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: g.GO_USAGE }
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `go-not-person:${code}`)
    return { text: g.GO_NOT_PERSON }
  }
  if (op === 'list') {
    const found = await goesLive($)
    // The never-list is printed whatever the records say: the dialog points the person here for it.
    if ('no' in found) return { text: `${found.no === 'guard' ? `No go counts while the protected-paths guard is missing: ${found.why}.` : 'The go records could not be read.'}\n\n${g.GO_NEVER_LINE}` }
    return { text: g.goListText(found.map((f) => f.go), when) }
  }
  if ('off' in op) {
    const found = await goesLive($, { guard: false })
    if ('no' in found) return { text: 'The go records could not be read. Nothing changed.' }
    const hit = found.filter((f) => op.off === undefined || g.goShort(f.go.id) === op.off)
    const missed = found.missed > 0 ? ` ${g.goMissedText(found.missed)}` : ''
    if (hit.length === 0) return { text: `${g.GO_OFF_NONE}${missed}` }
    const ended: string[] = []
    for (const f of hit) if (await ledgerAdd($, { kind: 'go-end', id: f.go.id, code: 'off', by: sid })) ended.push(f.go.id)
    await logq($, sid, 'go-off', String(ended.length))
    if (ended.length < hit.length) return { text: `${ended.length === 0 ? '' : `${g.goOffText(ended)} `}The ledger did not answer for ${hit.length - ended.length} go${hit.length - ended.length === 1 ? '' : 'es'}: still live. Run /callboard go off again.${missed}` }
    return { text: `${g.goOffText(ended)}${missed}` }
  }
  const r = await goGive($, sid, op.give, op.hours, 'person', false)
  if ('go' in r) return { text: g.goGivenText(r.go, r.ends, true) }
  await logq($, sid, 'refused', `go-${r.no}`)
  return { text: `No go was given: ${refusal(r)}` }
}

// ---- the giver's watch: a toast the first time a lane or a lead opened after the click reads the go ----
const GO_WATCH_MS = 60_000
function watchOf(sid: string, now: number) {
  const w = goWatch.get(sid) ?? { since: now, at: undefined, told: new Map<string, Set<string>>() }
  goWatch.set(sid, w)
  return w
}
// Only a lead and a conductor have a watch: the tick asks this first, so no other session's tick reads the clock for it.
export const goWatchOn = (sid: string): boolean => {
  const level = grantOf(sid)?.level
  return level === 'lead' || level === 'conductor'
}
// Once a minute, in a lead or a conductor.
export function goWatchDue(sid: string, now: number): boolean {
  return goWatchOn(sid) && c.dueEvery(goWatch.get(sid)?.at, now, GO_WATCH_MS)
}
// The `go-read` rows of this session's live goes: a session the go did not hold at the click (code later), read since the watch began and not yet told, gets one toast.
export async function goWatchTick($: any, sid: string): Promise<void> {
  const now = await $.clock.now()
  const w = watchOf(sid, now)
  w.at = now
  const found = await goesLive($, { guard: false })
  if ('no' in found) return
  const live = new Set<string>()
  for (const f of found) {
    if (f.go.by.sid !== sid) continue
    live.add(f.go.id)
    const seen = w.told.get(f.go.id) ?? new Set<string>()
    w.told.set(f.go.id, seen)
    for (const r of f.rows) {
      if (r.kind !== 'go-read' || typeof r.by !== 'string' || seen.has(r.by)) continue
      seen.add(r.by)
      if (r.code === 'later' && Date.parse(r.t) >= w.since) toast($, g.goReadToast(r.lane, f.go.id))
    }
  }
  for (const id of [...w.told.keys()]) if (!live.has(id)) w.told.delete(id)
}
