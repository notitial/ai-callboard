// The lead records (ADR 0007): every read and write of ~/.claude/callboard/lead-records and of a lead's owner binding in $.store.
// Trust rules held here: a record file is read with the lane store's file checks and parsed all or nothing; a read that could not be made is a refusal code,
// never "no records"; a record counts for routing only while its lead is bound to it and its conductor passes the lead's conductor checks.
import * as c from '../core.ts'
import { where, statR, sha, real, gitRoot, logq } from './base.ts'
import { readStoreFile, editStore } from './store.ts'
import type { RegRow } from './store.ts'
import { conductorTrustedSid } from './grants.ts'

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
// (a force-stopped lead kept for its lanes) is bound only by the proof its force stop left (c.keptKey): the same repo, hash, conductor and name. A hash that
// could not be made is not a match.
export async function boundTo($: any, r: c.OwnerRec): Promise<boolean> {
  if (r.rec.sid === undefined) {
    const hash = await sha($, c.leadRecordText(r.repo, r.rec)).catch(() => '')
    if (!hash) return false
    const p = c.parseKeptProof(await (async () => $.store.get(c.keptKey(hash, r.rec.name)))().catch(() => undefined))
    return !!p && p.repo === r.repo && p.rec === hash && p.conductorSid === r.rec.conductorSid && p.name === r.rec.name
  }
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
