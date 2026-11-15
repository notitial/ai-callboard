// The lead records (ADR 0007): every read and write of ~/.claude/callboard/lead-records and of a lead's owner binding in $.store.
// Trust rules held here: a record file is read with the lane store's file checks and parsed all or nothing; a read that could not be made is a refusal code,
// never "no records"; a record counts for routing only while its lead is bound to it and its conductor passes the lead's conductor checks.
import * as c from '../core.ts'
import { where, statR, sha, real, gitRoot, logq } from './base.ts'
import { readStoreFile, editStore, loadLanes, registryEntries } from './store.ts'
import type { RegRow } from './store.ts'
import { conductorTrustedSid, conductorsReaching, homeOf } from './grants.ts'
import { ledgerAdd } from './answer-hook.ts'
import { ownerLooked, ownerFlagged } from '../mem.ts'

export type LeadRecs = { key: string; store: c.LeadStore }[]

// The file name of a repo's record is the hash of its path; a path hashes the same every time, so it is kept (cleared whole when full).
const SHA_CACHE_MAX = 256
const shaCache = new Map<string, string>()
async function keyOf($: any, repo: string): Promise<string> {
  const had = shaCache.get(repo)
  if (had !== undefined) return had
  const key = await sha($, repo)
  if (shaCache.size >= SHA_CACHE_MAX) shaCache.clear()
  shaCache.set(repo, key)
  return key
}

// The records folder: its path and the user's facts, 'absent' when it (or the callboard folder) is not there yet, or a refusal code when it cannot be trusted.
async function recordsDir($: any): Promise<{ dir: string; uid: number; home: string } | 'absent' | string> {
  const p = await where($)
  if (!p) return 'no-paths'
  const dir = `${p.root}/${c.LEAD_RECORDS_DIR}`
  for (const d of [p.root, dir]) {
    const f = await statR($, d)
    if (f === 'absent') return 'absent'
    if (f === 'error' || f.kind !== 'dir' || f.uid !== p.uid || f.mode !== 0o700) return 'unsafe-dir'
  }
  return { dir, uid: p.uid, home: p.root.slice(0, -'/.claude/callboard'.length) }
}

// One record file, with the checks the lane stores get: a private file of the user's, parsed whole, named by the hash of its repo, whose repo is its own real
// path, not too broad and a git root. undefined: no such file. 'skip': a file that fails a check (logged; the other files still count).
async function readRecFile($: any, d: { dir: string; uid: number; home: string }, name: string): Promise<{ key: string; store: c.LeadStore } | 'skip' | undefined> {
  const cur = await readStoreFile($, `${d.dir}/${name}`, d.uid)
  if (cur.state === 'absent') return undefined
  const key = name.slice(0, -5)
  const parsed = cur.state === 'ok' ? c.parseLeadStore(cur.text) : undefined
  const ok = parsed?.ok && c.pinRefusal(parsed.store.repo, d.home) === undefined && (await keyOf($, parsed.store.repo)) === key && (await real($, parsed.store.repo)) === parsed.store.repo && (await gitRoot($, parsed.store.repo)) === 'yes'
  if (!parsed?.ok || !ok) {
    await logq($, await $.session.id().catch(() => ''), 'error', 'lead-record-skipped')
    return 'skip'
  }
  return { key, store: parsed.store }
}

// Every repo's lead records. A string is a refusal code: the folder is unsafe or could not be listed, which is "cannot read", not "no records"; a caller
// treats it as unknown (no owner is assumed either way). A single bad file is skipped and logged.
export async function loadLeadRecords($: any): Promise<LeadRecs | string> {
  try {
    const d = await recordsDir($)
    if (d === 'absent') return []
    if (typeof d === 'string') return d
    const files = ((await $.fs.list(d.dir)) as { name: string }[]).map((f) => f.name).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).sort().slice(0, c.STORE_MAX_FILES)
    const out: LeadRecs = []
    for (const n of files) {
      const r = await readRecFile($, d, n)
      if (r !== undefined && r !== 'skip') out.push(r)
    }
    return out
  } catch {
    return 'store-unreadable'
  }
}

// The same for one folder: only the files of the folder and of each folder above it (a nested repo's and an outer repo's), which is all ownerOf looks at.
export async function loadLeadRecordsFor($: any, folder: string): Promise<LeadRecs | string> {
  try {
    if (!c.isCleanAbs(folder)) return []
    const d = await recordsDir($)
    if (d === 'absent') return []
    if (typeof d === 'string') return d
    const out: LeadRecs = []
    // A folder fewer than three levels deep is too broad to be a repo with records (c.pinRefusal), so the walk up stops there.
    for (let at = folder; at.split('/').length > 3; at = at.slice(0, at.lastIndexOf('/'))) {
      const r = await readRecFile($, d, `${await keyOf($, at)}.json`)
      if (r !== undefined && r !== 'skip' && r.store.repo === at) out.push(r)
    }
    return out
  } catch {
    return 'store-unreadable'
  }
}

// One locked read-modify-write of a repo's record file (editStore in the records folder). fn gets the parsed store, or undefined when there is no file yet; a
// file that is there but cannot be trusted or parsed is refused (store-unreadable, or the parser's reason). The write counts only when the file holds exactly
// the text written. No callback may edit a lane store (see editStore).
export type LeadEdit = { no: string; why?: string } | { skip: true } | { store: c.LeadStore }
export function editLeadRecs($: any, key: string, fn: (store: c.LeadStore | undefined) => Promise<LeadEdit>, pre?: () => Promise<any>) {
  return editStore(
    $,
    key,
    async (cur) => {
      if (cur.state === 'bad') return { no: 'store-unreadable' }
      const parsed = cur.state === 'ok' ? c.parseLeadStore(cur.text) : undefined
      if (parsed && !parsed.ok) return { no: parsed.reason }
      const e = await fn(parsed?.ok ? parsed.store : undefined)
      if (!('store' in e)) return e
      const t = c.leadStoreText(e.store.repo, e.store.leads)
      if ('no' in t) return t
      return { text: t.text, landedText: (after) => after === t.text }
    },
    pre,
    c.LEAD_RECORDS_DIR,
  )
}

// Any session's owner binding (a lead's own, or another lead's as its conductor or the manager reads it); undefined when there is none or it does not parse.
export async function bindingOf($: any, leadSid: string): Promise<c.OwnerBinding | undefined> {
  const raw = await (async () => $.store.get(`${c.OWNER_PREFIX}${leadSid}`))().catch(() => undefined)
  return c.parseOwnerBinding(raw)
}

// Whether a record's lead is bound to it: the binding of the record's session names this repo, this record's hash and this conductor. A record with no session
// (a force-stopped lead kept for its lanes) needs no binding. A hash that could not be made is not a match.
export async function boundTo($: any, r: c.OwnerRec): Promise<boolean> {
  if (r.rec.sid === undefined) return true
  const b = await bindingOf($, r.rec.sid)
  if (!b || b.repo !== r.repo || b.conductorSid !== r.rec.conductorSid) return false
  return b.rec === (await sha($, c.leadRecordText(r.repo, r.rec)).catch(() => ''))
}

// The live owner of the lead that answers for a folder (c.ownerOf: by the lead's name, by its session id when `leadSid` is given, or the repo's only record for
// a lane that names no lead). Only when the record is found, its lead is bound to it, and its conductor is not `except` and passes the lead's conductor checks
// for the record's repo (presence, home, saved grant, list file). The lead itself need not be live. undefined for anything else, a read that failed included:
// a caller gives no conductor tier then. `recs`: records the caller already loaded (one load for several lookups).
export type Owner = { sid: string; name?: string; rec: c.OwnerRec }
export async function ownerLive($: any, live: RegRow[], except: string, folder: string, leadName: string | undefined, recs?: LeadRecs, leadSid?: string): Promise<Owner | undefined> {
  const stores = recs ?? (await loadLeadRecordsFor($, folder))
  if (typeof stores === 'string') return undefined
  const r = c.ownerOf(stores, folder, leadName, leadSid)
  if (!r || !(await boundTo($, r))) return undefined
  return trustedOwner($, live, except, r)
}

async function trustedOwner($: any, live: RegRow[], except: string, r: c.OwnerRec): Promise<Owner | undefined> {
  const sid = r.rec.conductorSid
  if (sid === except || !(await conductorTrustedSid($, live, except, r.repo, sid))) return undefined
  const name = c.laneLeadOf(live.map((x) => x.j), sid)?.name
  return { sid, ...(name ? { name } : {}), rec: r }
}

// A lead's own owner, from its binding: the record of the binding's repo whose session is this lead's must still hash to the binding ('record-changed' when
// there is no such record, or it names another conductor or hash), and the owner must pass the lead's conductor checks. undefined: no binding, or the owner is
// not live. 'store-unreadable': the records could not be read, which is neither.
export async function ownOwner($: any, sid: string, live: RegRow[]): Promise<Owner | 'record-changed' | 'store-unreadable' | undefined> {
  const b = await bindingOf($, sid)
  if (!b) return undefined
  const stores = await loadLeadRecordsFor($, b.repo)
  if (typeof stores === 'string') return 'store-unreadable'
  const s = stores.find((x) => x.store.repo === b.repo)
  const rec = s?.store.leads.find((l) => l.sid === sid)
  if (!s || !rec) return 'record-changed'
  const r = { key: s.key, repo: b.repo, rec }
  if (!(await boundTo($, r))) return 'record-changed'
  return trustedOwner($, live, sid, r)
}

// ---- the writers of ownership: the lead's own session only (the accept, the person's Join, leave and off, a rename) ----
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Gives a lead its conductor, once: the `lead-owner` ledger row, then the record under the record lock (with this session's id in that same write), then the
// binding last, so a half-done write is never obeyed (a record with no binding routes nothing). It only assigns: a lead that has a binding or a record is
// refused `already-owned`, and so is a name another record holds (`name-in-use`) and a 17th record (`lead-record-cap`). Those are checked before the ledger
// row and again under the lock. A write that fails after the row gets a closing `left` row, so the ledger never shows an owner the lead does not have.
export async function ownerWrite($: any, sid: string, a: { repo: string; name: string; how: 'made' | 'joined'; conductorSid: string; conductorName?: string; nonce?: string }): Promise<{ ok: true } | { no: string }> {
  const key = await keyOf($, a.repo).catch(() => undefined)
  if (!key) return { no: 'sha-failed' }
  const now = await $.clock.now()
  const rec: c.LeadRec = { name: a.name, createdAt: now, how: a.how, conductorSid: a.conductorSid, ...(a.conductorName !== undefined ? { conductorName: a.conductorName } : {}), ...(a.how === 'made' && a.nonce !== undefined ? { nonce: a.nonce } : {}), sid }
  const hash = await sha($, c.leadRecordText(a.repo, rec)).catch(() => undefined)
  if (!hash) return { no: 'sha-failed' }
  const refusal = (st: c.LeadStore | undefined): string | undefined => {
    if (st && st.repo !== a.repo) return 'store-repo'
    const leads = st?.leads ?? []
    if (leads.some((l) => l.sid === sid)) return 'already-owned'
    if (leads.some((l) => sameName(l.name, a.name))) return 'name-in-use'
    return leads.length >= c.LEAD_STORE_MAX ? 'lead-record-cap' : undefined
  }
  if (await bindingOf($, sid)) return { no: 'already-owned' }
  const seen = await loadLeadRecordsFor($, a.repo)
  if (typeof seen === 'string') return { no: seen }
  const before = refusal(seen.find((x) => x.store.repo === a.repo)?.store)
  if (before) return { no: before }
  const row = { kind: 'lead-owner' as const, hash: key, repo: a.repo, lane: a.name, target: sid }
  if (!(await ledgerAdd($, { ...row, code: a.how, by: a.conductorSid, ...(rec.nonce !== undefined ? { nonce: rec.nonce } : {}) }).catch(() => false))) return { no: 'ledger-write' }
  const undone = async (no: string): Promise<{ no: string }> => {
    await ledgerAdd($, { ...row, code: 'left', was: a.conductorSid }).catch(() => false)
    return { no }
  }
  const w = await editLeadRecs($, key, async (st) => {
    const no = refusal(st)
    return no ? { no } : { store: { repo: a.repo, leads: [...(st?.leads ?? []), rec] } }
  })
  if ('no' in w) {
    // The file was replaced but does not show the record: it may be there, with nothing bound to it. It is taken out again.
    if (w.wrote) await dropOwn($, key, sid)
    return undone(w.no)
  }
  const binding: c.OwnerBinding = { repo: a.repo, rec: hash, conductorSid: a.conductorSid, at: now }
  const set = await (async () => $.store.set(`${c.OWNER_PREFIX}${sid}`, binding))().then(() => true).catch(() => false)
  if (!set || !(await bindingOf($, sid))) {
    if ((await dropOwn($, key, sid)) !== undefined) await dropOwn($, key, sid)
    await logq($, sid, 'error', 'owner-binding-failed')
    return undone('store-write')
  }
  return { ok: true }
}

// Removes the record that names this session from one repo's file. undefined: it is gone (or was never there); else the code of the edit that failed.
async function dropOwn($: any, key: string, sid: string): Promise<string | undefined> {
  const w = await editLeadRecs($, key, async (st) => (st?.leads.some((l) => l.sid === sid) ? { store: { repo: st.repo, leads: st.leads.filter((l) => l.sid !== sid) } } : { skip: true })).catch(() => ({ no: 'store-write' }))
  return 'no' in w ? w.no : undefined
}

// Ends a lead's tie to its conductor (the person's `lead leave`, `/callboard off`, a lead grant that ends). The binding goes first, so nothing is obeyed from
// then on; then a `lead-owner` row (a failed ledger write is logged and does not block leaving); then every record that names this session, in any repo, so a
// record left by an earlier failed removal goes too. A record of the same name that names another session is left alone. had: there was a binding or a record.
// kept: a record could not be removed (the code); it stays an orphan that routes nothing until the next leave.
export async function ownerLeave($: any, sid: string, why: 'left' | 'off'): Promise<{ had: boolean; kept?: string }> {
  const b = await bindingOf($, sid)
  const hadKey = b !== undefined || (await (async () => $.store.get(`${c.OWNER_PREFIX}${sid}`))().catch(() => undefined)) !== undefined
  const all = await loadLeadRecords($)
  const mine = typeof all === 'string' ? [] : all.flatMap((s) => s.store.leads.filter((l) => l.sid === sid).map((rec) => ({ key: s.key, repo: s.store.repo, rec })))
  if (hadKey) await (async () => $.store.delete(`${c.OWNER_PREFIX}${sid}`))().catch(() => logq($, sid, 'error', 'owner-binding-kept'))
  if (!b && mine.length === 0) return { had: false, ...(typeof all === 'string' ? { kept: all } : {}) }
  let kept: string | undefined = typeof all === 'string' ? all : undefined
  const rows = mine.length > 0 ? mine.map((m) => ({ hash: m.key, repo: m.repo, lane: m.rec.name, was: m.rec.conductorSid })) : b ? [{ hash: await keyOf($, b.repo).catch(() => ''), repo: b.repo, was: b.conductorSid }] : []
  for (const r of rows) {
    if (!(await ledgerAdd($, { kind: 'lead-owner', code: why, target: sid, ...r }).catch(() => false))) await logq($, sid, 'error', 'owner-ledger-write')
  }
  for (const m of mine) kept = (await dropOwn($, m.key, sid)) ?? kept
  if (kept !== undefined) await logq($, sid, 'error', `owner-record-kept ${c.hasText(kept) ? kept : 'other'}`)
  ownerLooked.delete(sid)
  ownerFlagged.delete(sid)
  return { had: true, ...(kept !== undefined ? { kept } : {}) }
}

// The live conductors a lead of `repo` may be given to: each lists exactly that repo and passes the lead's conductor checks; no cap, since the person picks.
export async function joinCands($: any, live: RegRow[], sid: string, repo: string): Promise<{ sid: string; name?: string; home: string }[]> {
  return conductorsReaching($, live, sid, (r) => r === repo, undefined, { cap: false })
}

// Whether a name is held by a lane record, or by a lead record of any repo that does not name `sid` (with or without a session of its own: a record kept for
// its lanes keeps its name). A string that is not a boolean is a refusal code: a read that failed is "unknown", so the caller refuses.
export async function leadNameHeld($: any, sid: string, name: string, withLanes = true): Promise<boolean | string> {
  const recs = await loadLeadRecords($)
  if (typeof recs === 'string') return recs
  if (recs.some((s) => s.store.leads.some((l) => l.sid !== sid && sameName(l.name, name)))) return true
  if (!withLanes) return false
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return lanes
  return lanes.some((l) => sameName(l.name, name))
}

// A bound lead's look at its own record, at most once a minute: when the record of the binding's repo that names this session is missing or no longer hashes
// to the binding, `owner-record-changed` is logged once. It repairs nothing: ownOwner answers record-changed and the person leaves and joins again.
const OWNER_LOOK_MS = 60_000
export async function ownerTick($: any, sid: string): Promise<void> {
  const now = await $.clock.now()
  if (now - (ownerLooked.get(sid) ?? -OWNER_LOOK_MS) < OWNER_LOOK_MS) return
  ownerLooked.set(sid, now)
  const b = await bindingOf($, sid)
  if (!b) {
    ownerFlagged.delete(sid)
    return
  }
  const stores = await loadLeadRecordsFor($, b.repo)
  if (typeof stores === 'string') return
  const s = stores.find((x) => x.store.repo === b.repo)
  const rec = s?.store.leads.find((l) => l.sid === sid)
  if (s && rec && (await boundTo($, { key: s.key, repo: b.repo, rec }))) {
    ownerFlagged.delete(sid)
    return
  }
  if (ownerFlagged.has(sid)) return
  ownerFlagged.add(sid)
  await logq($, sid, 'error', 'owner-record-changed')
}

// A bound lead's new registry name moves into its record: one write under the record lock that sets the name on the record naming this session. The binding
// is neither read for its content nor written (the name is in neither the hash nor the binding), so a move that fails leaves the lead bound under its old name
// and the next look tries again. 'none': no binding, so there is nothing to move. A name a lane record or another lead record holds is refused `name-in-use`.
export async function ownerRename($: any, sid: string, cur: string): Promise<'moved' | 'none' | { no: string }> {
  const b = await bindingOf($, sid)
  if (!b) return 'none'
  const held = await leadNameHeld($, sid, cur)
  if (held !== false) return { no: held === true ? 'name-in-use' : held }
  const key = await keyOf($, b.repo).catch(() => undefined)
  if (!key) return { no: 'sha-failed' }
  const w = await editLeadRecs($, key, async (st) => {
    const own = st?.leads.find((l) => l.sid === sid)
    if (!st || !own) return { no: 'record-changed' }
    if (st.leads.some((l) => l.sid !== sid && sameName(l.name, cur))) return { no: 'name-in-use' }
    if (own.name === cur) return { skip: true }
    return { store: { repo: st.repo, leads: st.leads.map((l) => (l.sid === sid ? { ...l, name: cur } : l)) } }
  })
  return 'no' in w ? { no: w.no } : 'moved'
}

// A Join's plan from what is true now (c.joinPlan): the registry, the lead's usable name, the candidates, the records and the names in use. leadName and
// home come back with the plan so the caller can tell the person's dialog what it showed and compare it after the click.
export async function joinPlanNow($: any, sid: string, repo: string, want: string | undefined, pick: string | undefined): Promise<{ plan: c.JoinPlan; leadName?: string; home?: string }> {
  const live = await registryEntries($)
  if (!live) return { plan: { no: 'registry-unreadable' } }
  const leadName = c.leadNameOf(live.map((r) => r.j), sid)
  const recs = await loadLeadRecords($)
  if (typeof recs === 'string') return { plan: { no: recs } }
  const owned = (await bindingOf($, sid)) !== undefined || recs.some((s) => s.store.leads.some((l) => l.sid === sid))
  let nameClash = false
  if (leadName !== undefined && !owned) {
    const held = await leadNameHeld($, sid, leadName)
    if (typeof held === 'string') return { plan: { no: held } }
    nameClash = held
  }
  const cands = await joinCands($, live, sid, repo)
  const p = await where($)
  const plan = c.joinPlan({ leadName, want, pick, cands, owned, nameClash, recordCount: recs.find((s) => s.store.repo === repo)?.store.leads.length ?? 0 })
  return { plan, ...(leadName !== undefined ? { leadName } : {}), ...(p ? { home: homeOf(p) } : {}) }
}

// The Conductor row of /callboard status in a lead: its binding, and whether the conductor is live and passes the checks (c.ownerStatus).
export async function ownerStatusNow($: any, sid: string): Promise<string> {
  const b = await bindingOf($, sid)
  if (!b) return c.ownerStatus(undefined)
  const live = await registryEntries($)
  if (!live) return c.ownerStatus({ sid: b.conductorSid, gone: true })
  const o = await ownOwner($, sid, live)
  if (o === undefined) return c.ownerStatus({ sid: b.conductorSid, gone: true })
  return c.ownerStatus(typeof o === 'string' ? o : { ...(o.name ? { name: o.name } : {}), sid: o.sid, gone: false })
}

// Every lead record as the manager's table draws it, with whether its lead is bound to it. undefined: the records could not be read (the table then has no
// owner boxes, which is "unknown", not "no records").
export async function recordViews($: any): Promise<c.RecordView[] | undefined> {
  const all = await loadLeadRecords($)
  if (typeof all === 'string') return undefined
  const out: c.RecordView[] = []
  for (const s of all) for (const rec of s.store.leads) out.push({ repo: s.store.repo, rec, bound: await boundTo($, { key: s.key, repo: s.store.repo, rec }) })
  return out
}
