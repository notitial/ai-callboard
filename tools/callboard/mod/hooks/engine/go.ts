// The go (ADR 0009): the mod's own dialog in a lead's session, the go file and its ledger rows, go_request, go_status and /callboard go.
// Trust rules held here: only the person's click in the mod's dialog writes a go, and no tool lets an agent write or end one; a go counts only while its file and
// its `go-grant` row agree, it has no `go-end` row and its end has not come; a reader is covered by its own session id, checked fresh on every read, and never
// while the protected-paths guard is missing; each row is written before the effect it records.
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import * as g from '../go.ts'
import { dialogOpen, goAsked, goWatch } from '../mem.ts'
import { sha, where, statR, dirOk, readSmallR, run, MKDIR, rmF, log, logq, toast, withTimeout } from './base.ts'
import { loadLanes } from './store.ts'
import { grantOf } from './grants.ts'
import { epochOf } from './levels.ts'
import { leadCore } from './lanes.ts'
import { ensureTimer } from './tick.ts'
import { ledgerAdd, ledgerRowsFor, promptNewId, guardCheck } from './answer-hook.ts'
import { promptLinkOnce } from './answer-tiers.ts'

type Found = { go: g.Go; rows: pr.LedgerRow[] }
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
async function goesLive($: any, opts: { guard?: boolean } = {}): Promise<Found[] | { no: 'guard'; why: string } | { no: 'unreadable' }> {
  const p = await where($)
  if (!p) return { no: 'unreadable' }
  if (opts.guard !== false) {
    const missing = await guardCheck($)
    if (missing !== undefined) return { no: 'guard', why: pr.GUARD_WHY[missing] }
  }
  const names = await goNames($, p)
  if (names === 'absent') return []
  if (names === 'unreadable') return { no: 'unreadable' }
  const all = new Set(names.map((n) => n.name))
  const out: Found[] = []
  for (const name of [...all].filter((n) => g.GO_NAME_RE.test(n)).sort().slice(0, g.GO_SCAN_MAX)) {
    const r = await readSmallR($, `${goDir(p)}/${name}`, p.uid, g.GO_FILE_MAX)
    if (r.state !== 'ok') continue
    const go = g.parseGo(r.text)
    if (!go || `${go.id}.json` !== name) continue
    const now = await $.clock.now()
    if (now >= go.ends) {
      if (!all.has(`${go.id}.ended`) && (await promptLinkOnce($, `${goDir(p)}/${go.id}.ended`, 'expired\n')) === 'ok') await ledgerAdd($, { kind: 'go-end', id: go.id, code: 'expired' })
      continue
    }
    const rows = await ledgerRowsFor($, p, `"id":"${go.id}"`)
    if (rows === 'unreadable') return { no: 'unreadable' }
    const hash = await sha($, r.text).catch(() => '')
    if (g.goState(go, hash, rows, now) === 'live') out.push({ go, rows: rows.filter((x) => x.id === go.id) })
  }
  return out
}

// Go files (and their marks) whose go ended more than GO_KEEP_MS ago are removed, at each new go; the number left, or undefined when the folder cannot be listed.
async function goPrune($: any, p: Paths, now: number): Promise<number | undefined> {
  const names = await goNames($, p)
  if (names === 'absent' || names === 'unreadable') return undefined
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

type Given = { go: g.Go; ends: string } | { no: string; why?: string }
// One go, from the checks to the file: the session is a lead; the text passes; the guard holds; the lanes the dialog lists are the ones the lane tools resolve
// as this lead's now, by the session id each record carries; the person clicks Give go; the session is still the same lead; then the `go-grant` row with the
// hash of the file's bytes, then the file (created only if absent). A file that cannot be written gets a `go-end` row (void), so the row never stands alone.
// capped: a go_request call, counted against the hourly cap once it reaches the dialog.
async function goGive($: any, sid: string, text: unknown, hours: number, author: 'tier' | 'person', capped: boolean): Promise<Given> {
  const level = grantOf(sid)?.level
  if (level !== 'lead') return { no: level === 'manager' ? 'manager' : level === 'conductor' ? 'conductor' : 'not-lead' }
  if (g.goTextNo(text) !== undefined) return { no: 'bad-text' }
  const missing = await guardCheck($)
  if (missing !== undefined) return { no: 'guard', why: `${g.GO_REFUSE.guard}: ${pr.GUARD_WHY[missing]}.` }
  const base = await leadCore($, sid)
  if ('err' in base) return { no: 'store-unreadable', why: base.err[1] }
  if (base.g.level !== 'lead') return { no: 'not-lead' }
  const epoch = epochOf(sid)
  const repo = base.g.pins[0]
  const p = await where($)
  if (!p || typeof repo !== 'string') return { no: 'go-write' }
  const covered = base.lanes.flatMap((l) => (c.inReach(base.g, l) && typeof l.sid === 'string' && c.SID_RE.test(l.sid) && l.sid !== sid ? [{ name: l.name, sid: l.sid }] : []))
  if (covered.length > g.GO_COVERED_MAX) return { no: 'too-many' }
  const opened = await $.clock.now()
  if (capped) {
    const times = goAsked.get(sid) ?? []
    if (!c.noticeAllowed(times, opened, g.GO_REQUESTS_PER_HOUR)) return { no: 'rate' }
    goAsked.set(sid, c.pushRecent(times, opened))
  }
  const ends = opened + hours * c.HOUR_MS
  const asked = await goAsk($, sid, g.goQuestion({ name: base.g.name, covered: covered.map((x) => x.name), ends: when(ends), text: text as string, author }))
  if (asked === 'busy') return { no: 'busy' }
  if (asked === 'timed-out') return { no: 'timed-out' }
  if (asked !== 'yes') return { no: 'cancelled' }
  if (grantOf(sid)?.level !== 'lead' || epochOf(sid) !== epoch) return { no: 'grant-changed' }
  const at = await $.clock.now()
  if (at >= ends) return { no: 'timed-out' }
  await run($, [MKDIR, '-p', '-m', '700', p.root, goDir(p)])
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, goDir(p), p.uid))) return { no: 'go-write' }
  const kept = await goPrune($, p, at)
  if (kept === undefined || kept >= g.GO_SCAN_MAX) return { no: 'go-write' }
  const go: g.Go = { v: 1, id: await promptNewId($), by: { level: 'lead', sid, name: base.g.name, repo }, at, ends, text: text as string, covered, nonce: (await promptNewId($)).replace(/-/g, '') }
  const body = g.goFileText(go)
  if (g.parseGo(body) === undefined) return { no: 'go-write' }
  const hash = await sha($, body)
  if (!(await ledgerAdd($, { kind: 'go-grant', id: go.id, by: sid, tier: 'lead', hash, end: new Date(ends).toISOString(), repo, ...(go.by.name !== '' ? { lane: go.by.name } : {}) }))) return { no: 'ledger-write' }
  if ((await promptLinkOnce($, `${goDir(p)}/${go.id}.json`, body)) !== 'ok') {
    await ledgerAdd($, { kind: 'go-end', id: go.id, code: 'void' })
    return { no: 'go-write' }
  }
  watchOf(sid, at)
  await logq($, sid, 'go-given', g.goShort(go.id))
  return { go, ends: when(ends) }
}

const refusal = (r: { no: string; why?: string }): string => `${r.no}: ${r.why ?? g.GO_REFUSE[r.no] ?? r.no}`

// go_request: the main agent of a lead asks the person for a go. The tool only opens the dialog; its text is the lead's, and the end is always the default.
export async function goRequestCall($: any, e: any) {
  const sid = await $.session.id()
  ensureTimer($)
  const no = async (r: { no: string; why?: string }) => {
    await log($, sid, 'refused', `go-${r.no}`)
    return { deny: `go_request refused: ${refusal(r)}` }
  }
  if ((e as { agentId?: string }).agentId !== undefined) return no({ no: 'subagent' })
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
// that cannot be written leaves that go unreported. The session a go was given in reads it with no row.
export async function goStatusCall($: any, _e: any) {
  const sid = await $.session.id()
  const found = await goesLive($)
  if ('no' in found) return { result: g.goNoneText(found.no === 'guard' ? `Callboard reports no go while the protected-paths guard is missing: ${found.why}. Tell the person.` : 'The go records could not be read. Tell the person.') }
  if (found.length === 0) return { result: g.goNoneText() }
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { result: g.goNoneText('The lane records could not be read. Tell the person.') }
  const mine: g.Go[] = []
  for (const f of found) {
    const cover = g.goCovers(f.go, sid, lanes)
    if (cover === undefined) continue
    if (cover !== 'grantor' && !f.rows.some((r) => r.kind === 'go-read' && r.by === sid)) {
      const lane = lanes.find((l) => l.sid === sid)?.name
      if (!(await ledgerAdd($, { kind: 'go-read', id: f.go.id, by: sid, code: cover, ...(lane !== undefined ? { lane } : {}) }))) continue
      await logq($, sid, 'go-read', g.goShort(f.go.id))
    }
    mine.push(f.go)
  }
  return { result: g.goStatusText(mine) }
}

// The end of a lane_create result (no lane session yet: a live go this lead gave will cover the lane it opens) and of a lane_start result (laneSid: the lane's
// session, covered or not). Anything that cannot be read is "no go".
export async function goTailFor($: any, sid: string, laneSid?: string): Promise<string> {
  try {
    const found = await goesLive($)
    if ('no' in found || found.length === 0) return g.goTail(undefined)
    const lanes = laneSid === undefined ? [] : await loadLanes($)
    if (typeof lanes === 'string') return g.goTail(undefined)
    const hit = found.filter((f) => (laneSid === undefined ? f.go.by.sid === sid : g.goCovers(f.go, laneSid, lanes) !== undefined)).sort((a, b) => b.go.ends - a.go.ends)[0]
    return g.goTail(hit?.go, hit ? when(hit.go.ends) : undefined)
  } catch {
    return g.goTail(undefined)
  }
}

// A lead that stops being one (/callboard off, a grant taken back) ends the goes it gave: one `go-end` row each. Its panel closing, parking or crashing ends none.
export async function goGrantorOff($: any, sid: string): Promise<void> {
  const found = await goesLive($, { guard: false })
  if ('no' in found) return
  for (const f of found) if (f.go.by.sid === sid && (await ledgerAdd($, { kind: 'go-end', id: f.go.id, code: 'grantor-off', by: sid }))) await logq($, sid, 'go-ended', g.goShort(f.go.id))
}

// /callboard go: the list (any origin, read-only), off (the person's own; it only narrows, and ends one go or all of them, from any session) and the dialog
// (the person's own, in a lead's session, with the text they typed).
export async function goCommand($: any, sid: string, code: c.OriginCode, op: g.GoOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: g.GO_USAGE }
  if (op === 'list') {
    const found = await goesLive($)
    if ('no' in found) return { text: found.no === 'guard' ? `No go counts while the protected-paths guard is missing: ${found.why}.` : 'The go records could not be read.' }
    return { text: g.goListText(found.map((f) => f.go), when) }
  }
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `go-not-person:${code}`)
    return { text: g.GO_NOT_PERSON }
  }
  if ('off' in op) {
    const found = await goesLive($, { guard: false })
    if ('no' in found) return { text: 'The go records could not be read. Nothing changed.' }
    const hit = found.filter((f) => op.off === undefined || g.goShort(f.go.id) === op.off)
    if (hit.length === 0) return { text: g.GO_OFF_NONE }
    const ended: string[] = []
    for (const f of hit) if (await ledgerAdd($, { kind: 'go-end', id: f.go.id, code: 'off', by: sid })) ended.push(f.go.id)
    await logq($, sid, 'go-off', String(ended.length))
    if (ended.length < hit.length) return { text: `${ended.length === 0 ? '' : `${g.goOffText(ended)} `}The ledger did not answer for ${hit.length - ended.length} go${hit.length - ended.length === 1 ? '' : 'es'}: still live. Run /callboard go off again.` }
    return { text: g.goOffText(ended) }
  }
  const r = await goGive($, sid, op.give, op.hours, 'person', false)
  if ('go' in r) return { text: g.goGivenText(r.go, r.ends) }
  await logq($, sid, 'refused', `go-${r.no}`)
  return { text: `No go was given: ${refusal(r)}` }
}

// ---- the giver's watch: a toast the first time a lane opened after the click reads the go ----
const GO_WATCH_MS = 60_000
function watchOf(sid: string, now: number) {
  const w = goWatch.get(sid) ?? { since: now, at: undefined, told: new Map<string, Set<string>>() }
  goWatch.set(sid, w)
  return w
}
// Once a minute, in a lead.
export function goWatchDue(sid: string, now: number): boolean {
  return grantOf(sid)?.level === 'lead' && c.dueEvery(goWatch.get(sid)?.at, now, GO_WATCH_MS)
}
// The `go-read` rows of this lead's live goes: a session the dialog did not list (code later), read since the watch began and not yet told, gets one toast.
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
