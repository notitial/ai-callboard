#!/usr/bin/env node
// callboard prompt-audit [--since DATE] [--root DIR] [--records DIR] [--goes DIR] [--json]
// Read-only audit of prompt answering (ADR 0004, "Rollout, off switch and audit"; ADR 0011 for what raised an ask): one table of every request, the anomalies
// that must stay empty, what is deliberately not an anomaly, and wait counts. Nothing here writes: it never creates, edits,
// renames, removes or touches a file, and it follows no symlink inside the folders it reads. Convenience only: every real
// limit lives in the mod. Exit 0: no anomalies. 1: anomalies. 2: usage error, an unreadable root, or a ledger file that could
// not be read (an audit that missed a ledger file proves nothing, so it never exits 0), a ledger row of a kind it does not know, or the mod's definitions not loading.
// It imports the row kinds, the forged-drop codes, the sources of an ask, the id shape and a conductor's hourly open backstop from the mod's own sources (mod/hooks/prompts.ts, core.ts), so it
// runs from this checkout and needs node 22.18 or later.
//
// The ledger rows it reads (prompts.ts, LedgerRow): { t, kind, code?, id?, lane?, repo?, tool?, pattern?, hash?, tier?, why?, nonce?, opt?, lh?, dialog?, end?, raised? }.
//   requested  id, nonce, lane, repo, tool, pattern, hash, tier, raised?     the hook asked a tier. raised: what raised the ask (mode | rule | guard | hook |
//              setting | plugin | ceiling; anything else is an anomaly)
//   answered   id, nonce (the requested row's), code allow|deny, by (the answering lead's session id), tier, why, lane, repo, tool, pattern, hash
//              a tier decided (written by prompt_answer)
//   returned   id, code allow|deny, by, tuid (the tool_use_id of the call), tier, why (+ the request's fields)  the hook gave the decision
//              back; carries no nonce. An older ledger's returned rows have no tuid and no by.
//   superseded | expired-denied | off | abandoned <code>   each ends a request (abandoned: session-gone, swept, hook-failed, no-tier, expired)
//   dropped <code>   a decision the hook refused or could not read
//   relayed    id, code (the relaying tier's level), short (the first 8 hex of the id), by (its session id)   a tier took the request to the person: the top tier,
//              or the tier in whose session the person typed /callboard here
//   relay-lost id?, code (not-asked | gone | ...), short, by, tier   the relay did not reach the person; the request is open to the tiers again
//   relay-left id, short, by, tier   the person dismissed or answered something else; relay-late short, by, code (closed | decided)   an answer after the request ended
//   relay-closed id, short, by, tier   the mod withdrew the tier's relay question: its request had closed elsewhere while the question was open
//   deny-unclear   a deny whose reason the cleaner-command rule found too vague to judge
//   lead-offer hash, repo, lane, nonce, by   a conductor's lead_open wrote an offer (hash: the repo's sha-256); lead-offer-void hash, nonce, code   it ended with no grant
//   lead-grant hash, repo, lane, nonce, by, target   the new panel (target) made itself a lead from that offer; written before the grant, so a failure after it is followed by a lead-offer-void of the nonce
//   lead-owner code (made | joined | left | off), hash, repo, lane (the lead's name then, for reading only), target (the lead's session id), by (the conductor's session id; made, joined), was (the conductor it left; left, off), nonce (made)   a lead's conductor changed (ADR 0007); written before the record changes
//   lead-resume hash, repo, lane (the lead's name), by, target (the lead's session id), tier (conductor | manager), dialog (yes | none)   a lead tool sent a
//              resume cue; written before the cue, so a row with no cue after it is a refused or failed send
//   lead-stop  the lead-resume fields (target absent for a record no session carried) and code (park | unpark | retire | terminate | remove)   a lead tool parked,
//              reopened, retired, force-stopped or removed a lead; written before the action
//   go-grant   id (the go's), by (the session it was given in), tier, hash (the SHA-256 of the go file's bytes), end (when it ends), repo, lane (the giver's name then)
//              the person clicked Give go in the mod's own dialog (ADR 0009); written before the go file
//   go-end     id, code (off | expired | grantor-off | void), by?   a go ended: the person's /callboard go off, its end time, its lead losing the grant, or a file that could not be written
//   go-read    id, by (the reading session), code (listed | later), lane?   a covered session read the go from go_status for the first time; written before the go is reported
// The go files (--goes, default the go folder beside the prompts folder; read only, each file whole) are checked against the go-grant rows (rule j), and each go is
// listed with its text and the sessions that read it.
//   pr-watch   code (new | renew | expired | lost | merged | closed), lane, target (owner/repo#number)   a lane's PR tracking began, was renewed or ended (ADR 0010)
//   pr-notice  code (the note's kind), tier (the level of the session told), lane?, target? (owner/repo#number)   one PR note was delivered; no request of its own
// The lead records (--records, default the lead-records folder beside the prompts folder; read only, each file whole) are checked against the lead-owner rows (rule i).
//   answered / returned rows of a question's answer carry code: "answer", opt (the chosen option's index, as a string) and lh (the first 16 hex of SHA-256(id + "\n" + label), the label redacted
//              and trimmed); the labels themselves are in prompts/questions-YYYY-MM.jsonl, { t, id, lane, repo, tier, by, header, question, options, label, via? }
//   answered / returned rows of the person's own answer carry via: "person", short and by = the relaying tier's session id (no prompt_answer call exists for them)
//   here-on    by (the session the person typed /callboard here in), tier (its level), end (when it ends), lane? (its name)   relays for requests in that session's
//              reach land there from now on; written before the store key
//   here-off   code (off | grant-off | void), by, was? (the session that was here)   it ended: /callboard here off, that session's grant ending, or a key that could not be written
//   dialog, not-judgeable, no-tier, escalated, answering-on, answering-off, here-on, here-off   no request of their own
//
// It reads the ledger and the files beside it (questions, request files, lead records, go files), never a session's transcript. So two things are outside what it
// sees: a hook decision that reached a session with no ledger row, and an answered row written by hand together with its decision file.
import { openSync, closeSync, readSync, fstatSync, lstatSync, readdirSync, realpathSync, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

// The mod's own definitions. A load that fails (an older node, the script copied out of its checkout, a renamed export) ends the run with exit 2, never 1.
let ID_RE, OPENS_PER_CONDUCTOR_HOUR, ROW_KINDS, DROP_FORGED, RAISED_BY
try {
  ;({ SID_RE: ID_RE, OPENS_PER_CONDUCTOR_HOUR } = await import('./mod/hooks/core.ts'))
  ;({ ROW_KINDS, DROP_FORGED, RAISED: RAISED_BY } = await import('./mod/hooks/prompts.ts'))
  if (!(ID_RE instanceof RegExp) || !Number.isInteger(OPENS_PER_CONDUCTOR_HOUR) || !Array.isArray(ROW_KINDS) || !Array.isArray(DROP_FORGED) || !Array.isArray(RAISED_BY)) throw new Error('an export is missing')
} catch (e) {
  console.error(`prompt audit: cannot load the mod's definitions from mod/hooks beside this script (node 22.18 or later is needed): ${String(e?.message ?? e).slice(0, 300)}`)
  process.exit(2)
}

export const LEDGER_MAX_BYTES = 16 * 1024 * 1024
const LEDGER_LINE_MAX = 64 * 1024
// A request whose hook ended without a row is closed by the mod's tick within seconds; a request with no ending row and no request file after this long is a fault.
const CLOSE_GRACE_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const LIST_MAX = 200
const QUESTION_TOOL = 'AskUserQuestion'
const QUESTION_DAYS = 90

const KINDS = new Set(ROW_KINDS)
const FIELDS = ['code', 'id', 'lane', 'repo', 'tool', 'pattern', 'hash', 'tier', 'why', 'nonce', 'tuid', 'by', 'via', 'short', 'opt', 'lh', 'target', 'was', 'dialog', 'end', 'raised']
// Where the audit puts each kind of row: `request` a row of a request (grouped by the request id it carries), `end` a row that ends a request, `go` a row of a go
// (its id is the go's, no request's), `other` a row of no request (the switch, the lead rows, the PR rows). A kind the mod writes that has no place here makes
// every run incomplete (UNPLACED), so a new kind cannot be read as something it is not.
export const KIND_CLASS = {
  requested: 'request', answered: 'request', escalated: 'request', dropped: 'request', relayed: 'request', 'relay-lost': 'request', 'relay-left': 'request', 'relay-late': 'request',
  'relay-closed': 'request', 'deny-unclear': 'request', dialog: 'request', 'not-judgeable': 'request', 'no-tier': 'request',
  returned: 'end', superseded: 'end', 'expired-denied': 'end', off: 'end', abandoned: 'end',
  'go-grant': 'go', 'go-end': 'go', 'go-read': 'go',
  'answering-on': 'other', 'answering-off': 'other', 'lead-offer': 'other', 'lead-offer-void': 'other', 'lead-grant': 'other', 'lead-owner': 'other', 'lead-resume': 'other', 'lead-stop': 'other',
  'pr-watch': 'other', 'pr-notice': 'other', 'here-on': 'other', 'here-off': 'other',
}
const UNPLACED = ROW_KINDS.filter((k) => !Object.hasOwn(KIND_CLASS, k))
const ofClass = (c) => new Set(ROW_KINDS.filter((k) => KIND_CLASS[k] === c))
const GO_KINDS = ofClass('go')
const ENDS = ofClass('end')
// A `dropped` row with one of these codes is a decision the hook refused as forged or wrong: an anomaly. The others are ordinary.
const DROP_ANOMALY = new Set(DROP_FORGED)
// What may raise an ask (the mod's RAISED). A requested row that names anything else was not written by the hook.
const RAISED = new Set(RAISED_BY)

class AuditError extends Error {}

// ---- bounded, symlink-refusing reads ----
function codeErr(code, path) {
  const e = new AuditError(`${code}: ${path}`)
  e.code = code
  return e
}
// Reads a regular file line by line through O_NOFOLLOW and an fstat of the open descriptor. A line over maxLine is skipped and counted, never buffered whole.
// Throws AuditError('symlink' | 'not-a-file' | 'too-large' | ...) with a short code in .code.
export function eachLine(path, { maxLine, maxFileBytes }, onLine) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    throw codeErr(e.code === 'ELOOP' ? 'symlink' : e.code === 'ENOENT' ? 'missing' : 'unreadable', path)
  }
  const stats = { skippedLong: 0 }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw codeErr('not-a-file', path)
    if (maxFileBytes !== undefined && st.size > maxFileBytes) throw codeErr('too-large', path)
    const buf = Buffer.allocUnsafe(64 * 1024)
    let parts = []
    let len = 0
    let skipping = false
    const flush = () => {
      if (skipping) stats.skippedLong++
      else if (len > 0) onLine(Buffer.concat(parts, len).toString('utf8'))
      parts = []
      len = 0
      skipping = false
    }
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const chunk = buf.subarray(0, n)
      let from = 0
      while (from < n) {
        const nl = chunk.indexOf(10, from)
        const end = nl === -1 ? n : nl
        if (!skipping) {
          len += end - from
          if (len > maxLine) {
            skipping = true
            parts = []
            len = 0
          } else parts.push(Buffer.from(chunk.subarray(from, end)))
        }
        if (nl === -1) break
        flush()
        from = nl + 1
      }
    }
    flush()
  } finally {
    closeSync(fd)
  }
  return stats
}

// A directory listing that never follows a link: entries with their kind from lstat semantics (withFileTypes uses d_type).
function list(dir) {
  return readdirSync(dir, { withFileTypes: true })
}

// ---- the ledger ----
// A line as a JSON object, or undefined when it is no JSON or no plain object (an array is not one).
function parseObj(line) {
  let j
  try {
    j = JSON.parse(line)
  } catch {
    return undefined
  }
  return j && typeof j === 'object' && !Array.isArray(j) ? j : undefined
}

function parseRow(line) {
  const j = parseObj(line)
  if (!j || typeof j.kind !== 'string' || !KINDS.has(j.kind)) return undefined
  const ms = typeof j.t === 'string' ? Date.parse(j.t) : NaN
  if (!Number.isFinite(ms)) return undefined
  const r = { t: j.t, ms, kind: j.kind }
  for (const f of FIELDS) {
    if (j[f] === undefined) continue
    if (typeof j[f] !== 'string') return undefined
    r[f] = j[f].slice(0, 500)
  }
  if (r.id !== undefined && !ID_RE.test(r.id)) return undefined
  return r
}

// The monthly files `<prefix>-YYYY-MM.jsonl` of a folder, in name order, each line handed to onLine(line, fileName). A symlink or a non-file is a problem and is not read;
// so is a file that cannot be read (its lines up to that point were handed over). Returns the files read and the lines skipped for length in them.
function eachMonthFile(root, entries, prefix, problems, onLine) {
  let files = 0
  let skippedLong = 0
  const name = new RegExp(`^${prefix}-\\d{4}-\\d{2}\\.jsonl$`)
  for (const d of entries.filter((x) => name.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!d.isFile()) {
      problems.push(`${d.name}: ${d.isSymbolicLink() ? 'a symlink' : 'not a regular file'}, not read`)
      continue
    }
    try {
      const s = eachLine(join(root, d.name), { maxLine: LEDGER_LINE_MAX, maxFileBytes: LEDGER_MAX_BYTES }, (line) => onLine(line, d.name))
      skippedLong += s.skippedLong
      files++
    } catch (e) {
      problems.push(e instanceof AuditError ? `${d.name}: ${e.code}, not read` : `${d.name}: ${e.message}`)
    }
  }
  return { files, skippedLong }
}

function readLedger(root, entries, since, problems, notes) {
  const rows = []
  let garbage = 0
  // Rows of a kind the mod's list does not hold (written by another version of the mod), by kind: not read, and reported.
  const unknown = new Map()
  const { files, skippedLong } = eachMonthFile(root, entries, 'ledger', problems, (line, file) => {
    if (line.trim() === '') return
    const j = parseObj(line)
    if (j?.kind === 'floor') return // a row of the removed floor judge: not a row now, and not damage
    if (typeof j?.kind === 'string' && !KINDS.has(j.kind)) {
      const ms = typeof j.t === 'string' ? Date.parse(j.t) : NaN
      if (since === undefined || !Number.isFinite(ms) || ms >= since) {
        const k = j.kind.slice(0, 40)
        unknown.set(k, (unknown.get(k) ?? 0) + 1)
      }
      return
    }
    const r = parseRow(line)
    if (r) rows.push({ ...r, seq: rows.length, file })
    else garbage++
  })
  garbage += skippedLong
  if (garbage > 0) notes.push(`${garbage} ledger line(s) were not valid rows and were ignored`)
  if (unknown.size > 0) problems.push(`ledger: ${[...unknown.values()].reduce((a, b) => a + b, 0)} row(s) of a kind the audit does not know were not read (${[...unknown.entries()].sort().slice(0, 20).map(([k, n]) => `${k} ${n}`).join(', ')})`)
  rows.sort((a, b) => a.ms - b.ms || a.seq - b.seq)
  return { rows, garbage, files }
}

// One row of a questions file: { t, id, lane, repo, tier, by, header, question, options, label, via? }. Every string is cut; a row that is no JSON object is undefined.
function parseQuestionRow(line) {
  const j = parseObj(line)
  if (!j) return undefined
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
  const ms = typeof j.t === 'string' ? Date.parse(j.t) : NaN
  return {
    t: str(j.t, 40),
    ms,
    id: typeof j.id === 'string' && ID_RE.test(j.id) ? j.id : undefined,
    lane: str(j.lane, 200),
    tier: str(j.tier, 40),
    by: str(j.by, 100),
    via: str(j.via, 20),
    header: str(j.header, 200),
    question: str(j.question, 4096),
    options: Array.isArray(j.options) ? j.options.filter((o) => typeof o === 'string').slice(0, 4).map((o) => o.slice(0, 200)) : [],
    label: str(j.label, 500),
  }
}

// `byId` indexes every parsed row by request id, with no cap and no --since cut, for the joins; `rows` (raw, cut) and `list` (parsed) keep the listing's own cap and the --since cut.
function readQuestions(root, entries, since, problems, now) {
  const out = { files: 0, count: 0, rows: [], list: [], unreadable: 0, old: 0, byId: new Map() }
  out.files = eachMonthFile(root, entries, 'questions', problems, (line) => {
    if (line.trim() === '') return
    const q = parseQuestionRow(line)
    const ms = q?.ms
    if (q?.id !== undefined) out.byId.set(q.id, q)
    if (q && Number.isFinite(ms) && now - ms > QUESTION_DAYS * DAY_MS) out.old++
    if (since !== undefined && Number.isFinite(ms) && ms < since) return
    out.count++
    if (out.rows.length < LIST_MAX) out.rows.push(line.length > 200 ? `${line.slice(0, 200)}...` : line)
    if (!q) out.unreadable++
    else if (out.list.length < LIST_MAX) out.list.push(q)
  }).files
  return out
}

// ---- stats ----
export function percentile(sorted, p) {
  if (sorted.length === 0) return undefined
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
function waitStats(values) {
  const s = [...values].sort((a, b) => a - b)
  return { n: s.length, median: percentile(s, 50), p90: percentile(s, 90) }
}

// ---- the audit ----
// What the rules share: the grouped rows and the lists they add to. Built once in audit().
// (ctx: { rows, groups, qById, inRange, flag, notes, problems, now, onOff, table, waits, lostRaces, abandoned, dropsFine })

// The relayed row of g before ms that the request was still with the person after (no relay-lost row between it and ms), or undefined.
const withPerson = (g, ms) => {
  const rel = g.relayed.find((x) => x.ms < ms)
  return rel && !g.relayLost.some((l) => l.ms > rel.ms && l.ms <= ms) ? rel : undefined
}

// The row that names the request: its requested row, else its last answered row, its returned row or its first row.
const metaOf = (g) => g.requested[0] ?? g.answered[g.answered.length - 1] ?? g.returned[0] ?? g.rows[0]

// One request's line of the table, and its wait.
function tableRow(g, { table, waits }) {
  const req = g.requested[0]
  const ret = g.returned[0]
  const ans = g.answered[g.answered.length - 1]
  const esc = g.escalated[g.escalated.length - 1]
  const first = g.rows[0]
  const meta = metaOf(g)
  const end = ret ?? g.ends.find((r) => r.kind !== 'abandoned') ?? g.ends[g.ends.length - 1]
  const outcome = end ? (end.kind === 'abandoned' ? `abandoned ${end.code ?? ''}`.trim() : end.kind) : 'open'
  const decision = ret ? (ret.code ?? '-') : ans ? `answered:${ans.code ?? '-'}` : esc ? 'escalated' : '-'
  const age = ret && req ? (ret.ms - req.ms) / 1000 : undefined
  table.push({
    t: (req ?? first).t,
    id: g.id,
    lane: meta.lane ?? '',
    tool: meta.tool ?? '',
    pattern: meta.pattern ?? '',
    hash8: (meta.hash ?? '').slice(0, 8),
    tier: ret?.tier ?? ans?.tier ?? req?.tier ?? esc?.tier ?? '',
    decision,
    why: ret?.why ?? ans?.why ?? esc?.why ?? '',
    age,
    outcome,
  })
  if (age !== undefined && age >= 0) waits.push({ tier: ret.tier ?? req.tier ?? '', tool: meta.tool ?? '', age })
}

// a. a decision with no log row, and decisions the hook refused as forged.
function ruleDecisions(g, { flag }) {
  const req = g.requested[0]
  const ret = g.returned[0]
  if (g.requested.length > 1 && new Set(g.requested.map((r) => r.nonce)).size > 1) flag('a', 'requested-twice', `request ${g.id} has ${g.requested.length} requested rows with different nonces`, { id: g.id })
  if (ret && g.answered.length === 0) flag('a', 'returned-without-answered', `request ${g.id} was returned (${ret.code ?? '?'}) with no answered row`, { id: g.id, t: ret.t })
  if (ret && g.answered.length > 0 && g.answered[0].ms > ret.ms) flag('a', 'answered-after-returned', `request ${g.id}: the answered row (${g.answered[0].t}) is later than the returned row (${ret.t})`, { id: g.id, t: ret.t })
  // What the hook returned must be what the tier answered: the same decision, by the same lead (each checked only when both rows carry it).
  if (ret && g.answered.length > 0) {
    const before = g.answered.filter((r) => r.ms <= ret.ms)
    const pool = before.length > 0 ? before : g.answered
    const ref = pool[pool.length - 1]
    if (ret.code !== undefined && ref.code !== undefined && ret.code !== ref.code) flag('a', 'returned-differs-from-answered', `request ${g.id}: returned ${ret.code} but the answered row says ${ref.code}`, { id: g.id, t: ret.t })
    else if (ret.by !== undefined && ref.by !== undefined && ret.by !== ref.by) flag('a', 'returned-differs-from-answered', `request ${g.id}: the returned row's author differs from the answered row's`, { id: g.id, t: ret.t })
    // A returned question answer must carry the option and label hash of the answer (both rows carry both).
    if (ret.code === 'answer' && ref.code === 'answer' && (ret.opt !== ref.opt || ret.lh !== ref.lh)) flag('q', 'q-returned-differs', `request ${g.id}: the returned answer's option or label hash differs from the answered row's`, { id: g.id, t: ret.t })
  }
  // What raised the ask is one of the known sources (a row with none is an older one).
  if (req && req.raised !== undefined && !RAISED.has(req.raised)) flag('a', 'raised-unknown', `request ${g.id}: the requested row names an unknown source of the ask (${String(req.raised).slice(0, 40)})`, { id: g.id, t: req.t })
  for (const a of g.answered) {
    if (!req) flag('a', 'answered-without-requested', `request ${g.id} has an answered row and no requested row`, { id: g.id, t: a.t })
    else if (a.nonce !== req.nonce) flag('a', 'answered-nonce-mismatch', `request ${g.id}: the answered row's nonce differs from the requested row's`, { id: g.id, t: a.t })
  }
  for (const d of g.dropped) {
    if (DROP_ANOMALY.has(d.code)) flag('a', `dropped-${d.code}`, `request ${g.id}: the hook refused a decision (${d.code})`, { id: g.id, t: d.t })
  }
}

function ruleQuestions(g, { flag, onOff }) {
  const req = g.requested[0]
  // Questions. The tool is the request's own (the first row that names one when the requested row is missing); `answer` belongs to an AskUserQuestion only, and a question is never decided allow or deny.
  const qTool = req?.tool ?? g.rows.find((r) => r.tool !== undefined)?.tool
  for (const r of g.rows) {
    const decided = r.kind === 'answered' || r.kind === 'returned'
    if (decided && r.code === 'answer' && qTool !== QUESTION_TOOL) flag('q', 'q-answer-not-question', `request ${g.id} (${qTool ?? 'tool unknown'}): the ${r.kind} row (${r.t}) is an answer, but the request is not an ${QUESTION_TOOL}`, { id: g.id, t: r.t })
    if (qTool === QUESTION_TOOL && ((decided && (r.code === 'allow' || r.code === 'deny')) || r.kind === 'expired-denied')) flag('q', 'q-decided-question', `request ${g.id}: an ${r.kind} row (${r.t}${r.code ? `, ${r.code}` : ''}) decides a question with allow or deny; a question is only ever answered`, { id: g.id, t: r.t })
  }
  // A question's request needs an `answering-on` row with code asks still in force: a later plain `answering-on` (a value written without the questions scope) or any `answering-off` ends it; `/callboard escalation` writes the plain row and then the asks row.
  if (req && qTool === QUESTION_TOOL) {
    let asksOn = false
    for (const r of onOff) {
      if (r.ms > req.ms) break
      asksOn = r.kind === 'answering-on' && r.code === 'asks'
    }
    if (!asksOn) flag('q', 'q-no-asks-on', `request ${g.id} (a question) was asked with no answering-on row (code asks) still in force`, { id: g.id, t: req.t })
  }
}

function ruleTiers(g, { flag }) {
  // Tiers. A tier that passed the request up (an `escalated` row, code = its level) does not answer it afterwards; a request taken to the person (`relayed`) is decided by the person, and
  // an agent's answer after it counts only if a relay-lost row came first (the relay never reached the person, so the tiers had it again).
  for (const a of g.answered) {
    if (a.via === 'person') continue
    const passed = g.escalated.find((e) => e.code !== undefined && e.code === a.tier && e.ms < a.ms)
    if (passed) flag('a', 'answered-after-own-pass-up', `request ${g.id}: tier ${a.tier} answered at ${a.t} after it had passed the request up at ${passed.t}`, { id: g.id, t: a.t })
    const rel = withPerson(g, a.ms)
    if (rel) flag('a', 'answered-while-relayed', `request ${g.id}: an agent answered at ${a.t} while the request was with the person (relayed at ${rel.t}, no relay-lost row)`, { id: g.id, t: a.t })
  }
  for (const r of g.ends.filter((x) => x.kind === 'returned')) {
    if (r.via === 'person') continue
    const rel = withPerson(g, r.ms)
    if (rel) flag('a', 'returned-while-relayed', `request ${g.id}: a decision not the person's was returned at ${r.t} while the request was with the person (relayed at ${rel.t}, no relay-lost row)`, { id: g.id, t: r.t })
  }
}

// The person's own answer (via person) needs a relayed row of the same tier session and the request's own short id before it. The short id is the request's first
// eight characters, never the row's say-so.
function rulePersonAnswers(g, { flag }) {
  const short = g.id.slice(0, 8)
  for (const a of g.answered) {
    if (a.via !== 'person' || a.by === undefined) continue
    if (a.short !== undefined && a.short !== short) flag('a', 'person-answer-short-mismatch', `request ${g.id}: the answered row (${a.t}) carries the short id ${a.short}, not the request's ${short}`, { id: g.id, t: a.t })
    if (!g.relayed.some((x) => x.ms <= a.ms && x.by === a.by && (x.short ?? short) === short)) flag('a', 'person-answer-without-relayed-row', `request ${g.id}: the answered row (${a.t}) is the person's, but no relayed row of tier session ${a.by} with that short id came before it`, { id: g.id, t: a.t })
  }
}

// b. a request nothing ended, older than 24 h.
function ruleUnended(g, { flag, now }) {
  const req = g.requested[0]
  if (req && g.ends.length === 0 && now - req.ms > DAY_MS) flag('b', 'request-unended', `request ${g.id} (${req.tool ?? '?'}) has no ending row after ${Math.floor((now - req.ms) / 3600000)} h`, { id: g.id, t: req.t })
}

// The two benign shapes, and the ordinary `dropped` rows.
function noteBenign(g, { abandoned, lostRaces, dropsFine }) {
  const ret = g.returned[0]
  const meta = metaOf(g)
  for (const r of g.ends.filter((x) => x.kind === 'abandoned')) abandoned.push({ id: g.id, t: r.t, code: r.code ?? '', tool: meta.tool ?? '' })
  if (ret && g.ends.some((r) => r.kind === 'superseded')) lostRaces.push({ id: g.id, t: ret.t, detail: 'a returned row and a superseded row for one request' })
  for (const d of g.dropped) if (!DROP_ANOMALY.has(d.code)) dropsFine.push({ id: g.id, t: d.t, code: d.code ?? '' })
}

// g. lead grants (ADR 0006): a lead-grant needs a lead-offer row of the same repo hash and nonce written by the same session; at most OPENS_PER_CONDUCTOR_HOUR grants by one conductor in an hour (a grant
// followed by a void of its nonce does not count); and a grant with a void of its nonce is a grant that was told to have failed, which is listed so a person looks at it.
function ruleLeadGrants({ rows, flag, inRange }) {
  const grants = rows.filter((r) => r.kind === 'lead-grant' && inRange(r.ms))
  const voided = (g) => rows.some((r) => r.kind === 'lead-offer-void' && r.nonce === g.nonce && r.hash === g.hash)
  for (const g of grants) {
    if (!rows.some((r) => r.kind === 'lead-offer' && r.nonce === g.nonce && r.hash === g.hash && r.by === g.by && r.ms <= g.ms)) flag('g', 'lead-grant-without-offer', `the lead-grant of ${g.lane ?? '?'} (${g.t}) has no earlier lead-offer row of the same repo and nonce by session ${g.by ?? '?'}`, { t: g.t })
    if (voided(g)) flag('g', 'lead-grant-voided', `the lead-grant of ${g.lane ?? '?'} (${g.t}) has a lead-offer-void row of the same nonce: the panel was told the grant failed`, { t: g.t })
  }
  const live = grants.filter((g) => !voided(g)).sort((a, b) => a.ms - b.ms)
  for (let i = 1; i < live.length; i++) {
    const inHour = live.slice(0, i + 1).filter((x) => x.by === live[i].by && live[i].ms - x.ms < 3_600_000)
    if (inHour.length > OPENS_PER_CONDUCTOR_HOUR) flag('g', 'lead-grants-over-backstop', `${inHour.length} lead-grants by one conductor within an hour, over the ${OPENS_PER_CONDUCTOR_HOUR} it may open: the latest is ${live[i].lane ?? '?'} (${live[i].t}) by session ${live[i].by ?? '?'}`, { t: live[i].t })
  }
}

// h. lead owners (ADR 0007): a `made` lead-owner row needs a lead-grant row of the same repo hash, nonce, conductor (`by`) and lead (`target`); and a lead (`target`) of a repo (`hash`) is given
// a conductor (a `made` or `joined` row) only when it has none: an earlier made or joined row with no `left` or `off` row of that lead and repo after it is an owner changed
// without a leave, which assign-only forbids. A lead is told by its session id, never its name, so a rename (which writes no row) raises no flag.
function ruleLeadOwners({ rows, flag, inRange }) {
  const owners = rows.filter((r) => r.kind === 'lead-owner' && inRange(r.ms)).sort((a, b) => a.ms - b.ms)
  for (const o of owners) {
    if (o.code === 'made' && !rows.some((r) => r.kind === 'lead-grant' && r.nonce === o.nonce && r.hash === o.hash && r.by === o.by && r.target === o.target && r.ms <= o.ms)) flag('h', 'lead-owner-made-without-grant', `the lead-owner made row of ${o.lane ?? '?'} (${o.t}) has no earlier lead-grant row of the same repo, nonce, conductor and lead ${o.by ?? '?'}`, { t: o.t })
  }
  const all = rows.filter((r) => r.kind === 'lead-owner').sort((a, b) => a.ms - b.ms)
  for (const o of owners) {
    if (o.code !== 'made' && o.code !== 'joined') continue
    const mine = all.filter((x) => x.hash === o.hash && x.target === o.target && x.ms < o.ms)
    const last = mine.reverse().find((x) => x.code === 'made' || x.code === 'joined' || x.code === 'left' || x.code === 'off')
    if (last && (last.code === 'made' || last.code === 'joined')) flag('h', 'lead-owner-twice', `lead ${o.lane ?? '?'} (${o.t}) was given a conductor again with no leave since ${last.t}`, { t: o.t })
  }
}

// e. a request must be raised while answering is on: the latest answering-on or answering-off row at its time says on (not the first answering-on row ever written, which a later off outlives).
// An answering-off with code asks only turned the questions off (an earlier mod wrote it); permission answering stayed on.
// The hook reads the switch once at its start and writes the requested row after slower steps, so an off typed in between reads on, off, requested, and the waiting hook then
// closes the request with an `off` row. That is no defect: the request was raised under on. It is not flagged when the off row is at most OFF_RACE_MS before the requested row and
// the request's own last row is an `off` row.
function ruleAnsweringOn({ groups, onOff, flag }) {
  const OFF_RACE_MS = 120_000
  const offRace = (g, req, off) => req.ms - off.ms <= OFF_RACE_MS && g.rows[g.rows.length - 1]?.kind === 'off'
  const permOnOff = onOff.filter((r) => !(r.kind === 'answering-off' && r.code === 'asks'))
  for (const g of groups) {
    const req = g.requested[0]
    if (!req) continue
    let state
    for (const r of permOnOff) {
      // Rows are in (ms, seq) order: a row written in the same millisecond but after the request's does not count for it.
      if (r.ms > req.ms || (r.ms === req.ms && r.seq > req.seq)) break
      state = r
    }
    if (!state) flag('e', 'requested-before-answering-on', `request ${g.id} was asked with no answering-on row before it`, { id: g.id, t: req.t })
    else if (state.kind === 'answering-off' && !offRace(g, req, state)) flag('e', 'requested-while-answering-off', `request ${g.id} was asked while answering was off (the latest answering row before it is an answering-off at ${state.t})`, { id: g.id, t: req.t })
  }
}

// f. request files older than 24 h, by age only (the live-session test is not applied here).
function ruleStaleRequestFiles({ flag, now }, rootReal, entries) {
  let requestFiles = 0
  const requestIds = new Set()
  let sessionDirs = 0
  let unlisted = 0
  for (const d of entries) {
    if (!d.isDirectory() || !ID_RE.test(d.name)) continue
    sessionDirs++
    let inner
    try {
      inner = list(join(rootReal, d.name))
    } catch {
      unlisted++
      continue
    }
    for (const f of inner) {
      if (!f.isFile() || !/^[0-9a-f-]{36}\.request\.json$/.test(f.name)) continue
      let st
      try {
        st = lstatSync(join(rootReal, d.name, f.name))
      } catch {
        continue
      }
      requestFiles++
      requestIds.add(f.name.slice(0, 36))
      if (st.isFile() && now - st.mtimeMs > DAY_MS) flag('f', 'stale-request-file', `${d.name}/${f.name} is ${Math.floor((now - st.mtimeMs) / 3600000)} h old`, { id: f.name.slice(0, 36) })
    }
  }
  return { requestFiles, requestIds, sessionDirs, unlisted }
}

// b2. a request with no ending row whose request file is gone: the hook (or a sweep) removed the files without a closing row. The mod writes the row first and keeps the
// files until it has, so this is a fault. Only judged when the folder holds session folders at all: a copy of the ledger alone shows no files, and absence says nothing there.
// A folder that could not be listed hides its request files: the check is not run then, and the run says so.
function ruleClosedWithoutRow({ groups, flag, table, problems, now }, { requestIds, sessionDirs, unlisted }) {
  if (unlisted > 0) problems.push(`${unlisted} session folder(s) under the prompts folder could not be listed; requests closed without a row were not checked`)
  if (sessionDirs > 0 && unlisted === 0) {
    for (const g of groups) {
      const req = g.requested[0]
      if (req && g.ends.length === 0 && !requestIds.has(g.id) && now - req.ms > CLOSE_GRACE_MS && now - req.ms <= DAY_MS) {
        flag('b', 'request-closed-without-row', `request ${g.id} (${req.tool ?? '?'}) has no ending row and no request file ${Math.floor((now - req.ms) / 60000)} min on`, { id: g.id, t: req.t })
        const row = table.find((t) => t.id === g.id)
        if (row && row.outcome === 'open') row.outcome = 'closed-no-row'
      }
    }
  }
}

// A note (not an anomaly): the tiers' own allows of asks that a hook, a setting, a plugin or a ceiling raised (ADR 0011), by what raised them, and their
// answers to a question behind one. A person's answer through a relay is not counted.
function noteRaised({ groups, notes }) {
  const by = {}
  for (const g of groups) {
    const raised = g.requested[0]?.raised
    const ret = g.returned[0]
    if ((ret?.code !== 'allow' && ret?.code !== 'answer') || ret.via === 'person' || !['hook', 'setting', 'plugin', 'ceiling'].includes(raised)) continue
    by[raised] = (by[raised] ?? 0) + 1
  }
  if (Object.keys(by).length > 0) notes.push(`agents' allows and answers of asks raised by a hook, setting, plugin or ceiling: ${Object.entries(by).sort().map(([c, n]) => `${c} ${n}`).join(', ')}`)
}

// Question notes (not anomalies).
function noteQuestions({ groups, rows, notes, inRange, qById }, questions) {
  const noQuestionRow = groups.filter((g) => g.returned[0]?.code === 'answer' && !qById.has(g.id)).length
  if (noQuestionRow > 0) notes.push(`${noQuestionRow} returned question answer(s) have no questions row (a failed write, or the row was pruned)`)
  if (questions.old > 0) notes.push(`${questions.old} questions row(s) are older than ${QUESTION_DAYS} days (the prune is behind)`)
  const notJudged = {}
  for (const r of rows) if (r.kind === 'not-judgeable' && /^question(-|$)/.test(r.code ?? '') && inRange(r.ms)) notJudged[r.code] = (notJudged[r.code] ?? 0) + 1
  if (Object.keys(notJudged).length > 0) notes.push(`not-judgeable question rows by code: ${Object.entries(notJudged).sort().map(([c, n]) => `${c} ${n}`).join(', ')}`)
}

function buildCounts({ rows, inRange, table, waits }) {
  // Counts.
  const group = (key) => {
    const m = new Map()
    for (const t of table) {
      const k = t[key] || '(none)'
      if (!m.has(k)) m.set(k, { requests: 0, outcomes: {} })
      const e = m.get(k)
      e.requests++
      const o = t.outcome.split(' ')[0]
      e.outcomes[o] = (e.outcomes[o] ?? 0) + 1
    }
    const out = {}
    for (const [k, e] of [...m.entries()].sort()) {
      const w = waits.filter((x) => (x[key] || '(none)') === k).map((x) => x.age)
      out[k] = { ...e, wait: waitStats(w) }
    }
    return out
  }
  const kinds = {}
  for (const r of rows) if (inRange(r.ms)) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
  return { byTier: group('tier'), byTool: group('tool'), rowsByKind: kinds, wait: waitStats(waits.map((w) => w.age)) }
}

function buildRelay({ rows, groups, inRange, qById }) {
  // The tier rows that are not anomalies, counted by kind (and by code where one is recorded): what happened to the requests that went to the person, and the cleaner-command denies.
  const relayCounts = {}
  for (const k of ['relayed', 'relay-lost', 'relay-left', 'relay-late', 'relay-closed', 'expired-denied', 'deny-unclear']) {
    const mine = rows.filter((r) => r.kind === k && inRange(r.ms))
    const codes = {}
    // A relay-left and a relay-closed row name the tier that asked in `tier` (they carry no code); the other kinds keep their code.
    for (const r of mine) {
      const key = (k === 'relay-left' || k === 'relay-closed' ? r.tier : r.code) ?? '(none)'
      codes[key] = (codes[key] ?? 0) + 1
    }
    relayCounts[k] = { n: mine.length, codes }
  }
  // Each relayed request with its tool and pattern and, when the lane asked a question, the lane's own question from the questions file. The tier's wording to the
  // person is in the tier's transcript, which the audit does not read.
  const relayedList = []
  for (const g of groups) {
    for (const r of g.relayed) {
      if (!inRange(r.ms) || relayedList.length >= LIST_MAX) continue
      const req = g.requested[0] ?? g.rows[0]
      const lq = qById.get(g.id)
      relayedList.push({ id: g.id, t: r.t, tier: r.code ?? '', tool: req.tool ?? '', pattern: req.pattern ?? '', laneQuestion: lq ? { header: lq.header, question: lq.question.slice(0, 400), options: lq.options } : undefined })
    }
  }
  const personAnswers = rows.filter((r) => r.kind === 'answered' && r.via === 'person' && inRange(r.ms)).length
  relayCounts.personAnswers = { n: personAnswers, codes: {} }
  return { relayCounts, relayedList }
}

// i. lead tools and lead stops (ADR 0007). A conductor's lead-resume or lead-stop row needs that conductor to own the lead then: the newest lead-owner row of the
// same repo hash and lead (target) at or before it is a made or joined row by that conductor. A lead-stop row with no target (a record no session
// carried) is not judged for its owner. A force stop always asks the person, and so does every call of the manager: such a row whose dialog is not yes is
// flagged. Each lead record that names a session must have, as the newest lead-owner row of its repo hash and that session, a made or joined row by
// its conductor; the name is not compared, so a rename (which writes no row) raises no flag, and a record with no session is skipped.
const OWNER_CODES = new Set(['made', 'joined'])
function ownerRowAt(rows, hash, target, ms) {
  let last
  for (const r of rows) if (r.kind === 'lead-owner' && r.hash === hash && r.target === target && r.ms <= ms && (!last || r.ms >= last.ms)) last = r
  return last
}
function ruleLeadStops({ rows, flag, inRange }) {
  for (const r of rows) {
    if ((r.kind !== 'lead-stop' && r.kind !== 'lead-resume') || !inRange(r.ms)) continue
    const what = `${r.kind}${r.code !== undefined ? ` ${r.code}` : ''} row of ${r.lane ?? '?'} (${r.t})`
    if (r.tier === 'conductor' && r.target !== undefined) {
      const o = ownerRowAt(rows, r.hash, r.target, r.ms)
      if (!o || !OWNER_CODES.has(o.code) || o.by !== r.by) flag('i', `${r.kind}-not-owner`, `the ${what} by conductor ${r.by ?? '?'}: the lead's newest lead-owner row before it does not give it that conductor`, { t: r.t })
    }
    if (((r.kind === 'lead-stop' && r.code === 'terminate') || r.tier === 'manager') && r.dialog !== 'yes') flag('i', `${r.kind}-no-dialog`, `the ${what} by ${r.tier ?? '?'} ${r.by ?? '?'} has no yes from the person's dialog`, { t: r.t })
  }
}
function ruleLeadOwnerLogged({ rows, flag }, recs) {
  if (!recs) return
  for (const { key, leads } of recs) {
    for (const l of leads) {
      if (typeof l.sid !== 'string') continue
      const o = ownerRowAt(rows, key, l.sid, Infinity)
      if (!o || !OWNER_CODES.has(o.code) || o.by !== l.conductorSid) flag('i', 'lead-owner-unlogged', `lead record ${l.name} (repo ${key.slice(0, 8)}, session ${l.sid}) names conductor ${l.conductorSid} with no lead-owner row giving it that conductor`)
    }
  }
}

// The lead record files of a folder, read only: each <sha-256>.json a regular file (no link followed), at most RECORD_MAX_BYTES, parsed whole; a file that cannot be
// read or parsed is a problem. undefined: the folder is not there or not a folder: rule i's record check is then not run, and the summary line says so (a
// folder named with --records is a problem as well).
const RECORD_MAX_BYTES = 64 * 1024
const RECORD_FILES_MAX = 1000
function readLeadRecords(dir, explicit, problems) {
  let real
  let entries
  try {
    real = realpathSync(dir)
    if (!lstatSync(real).isDirectory()) throw new Error('not a directory')
    entries = list(real)
  } catch {
    if (explicit) problems.push(`--records ${dir}: not a readable folder; the lead records were not checked`)
    return undefined
  }
  const out = []
  for (const d of entries.filter((x) => /^[0-9a-f]{64}\.json$/.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, RECORD_FILES_MAX)) {
    if (!d.isFile()) {
      problems.push(`lead records: ${d.name}: ${d.isSymbolicLink() ? 'a symlink' : 'not a regular file'}, not read`)
      continue
    }
    let text = ''
    try {
      eachLine(join(real, d.name), { maxLine: RECORD_MAX_BYTES, maxFileBytes: RECORD_MAX_BYTES }, (line) => (text += line))
    } catch (e) {
      problems.push(`lead records: ${d.name}: ${e instanceof AuditError ? e.code : e.message}, not read`)
      continue
    }
    const j = parseObj(text)
    const leads = Array.isArray(j?.leads) ? j.leads : undefined
    if (!leads || !leads.every((l) => l && typeof l === 'object' && typeof l.name === 'string' && typeof l.conductorSid === 'string' && (l.sid === undefined || typeof l.sid === 'string'))) {
      problems.push(`lead records: ${d.name}: not a lead record file, not read`)
      continue
    }
    out.push({ key: d.name.slice(0, -5), leads })
  }
  return out
}

// j. the go (ADR 0009). A go counts only while its file and its go-grant row agree. A go file with no go-grant row carrying its session and the hash of its bytes was not written by
// the person's click (go-file-no-row). A go-grant row whose end is still ahead, with no go-end row and no file, is a go the ledger says is live and no session can
// read (go-row-no-file). Each go of the range is listed with the text the person approved (from its file, while that is kept) and the sessions that read it.
const GO_FILE_MAX_BYTES = 8192
const GO_FILES_MAX = 1000
// The go files of a folder, read only: each <id>.json a regular file (no link followed), at most GO_FILE_MAX_BYTES, read whole. undefined: the folder is not a
// readable folder, and rule j is then not run (a problem when it was named with --goes, or when it is there and cannot be read). A missing folder is no go files.
function readGoFiles(dir, explicit, problems) {
  let real
  let entries
  try {
    real = realpathSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT' && !explicit) return []
    problems.push(`${explicit ? '--goes ' : ''}${dir}: not a readable folder; the goes were not checked`)
    return undefined
  }
  try {
    if (!lstatSync(real).isDirectory()) throw new Error('not a directory')
    entries = list(real)
  } catch {
    problems.push(`${explicit ? '--goes ' : ''}${dir}: not a readable folder; the goes were not checked`)
    return undefined
  }
  const out = []
  const named = entries.filter((x) => x.name.endsWith('.json') && ID_RE.test(x.name.slice(0, -5))).sort((a, b) => (a.name < b.name ? -1 : 1))
  if (named.length > GO_FILES_MAX) problems.push(`goes: ${named.length} go files, only the first ${GO_FILES_MAX} were read`)
  for (const d of named.slice(0, GO_FILES_MAX)) {
    const id = d.name.slice(0, -5)
    if (!d.isFile()) {
      problems.push(`goes: ${d.name}: ${d.isSymbolicLink() ? 'a symlink' : 'not a regular file'}, not read`)
      continue
    }
    try {
      const path = join(real, d.name)
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let buf
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.size > GO_FILE_MAX_BYTES) throw new AuditError('too large or not a file')
        buf = Buffer.alloc(st.size)
        let got = 0
        while (got < st.size) {
          const n = readSync(fd, buf, got, st.size - got, got)
          if (n === 0) break
          got += n
        }
        buf = buf.subarray(0, got)
      } finally {
        closeSync(fd)
      }
      const j = parseObj(buf.toString('utf8'))
      out.push({ id, hash: createHash('sha256').update(buf).digest('hex'), by: typeof j?.by?.sid === 'string' ? j.by.sid : undefined, text: j && j.id === id && typeof j.text === 'string' ? j.text : undefined })
    } catch (e) {
      problems.push(`goes: ${d.name}: ${e instanceof AuditError ? e.message : (e.code ?? e.message)}, not read`)
    }
  }
  return out
}
function ruleGoes({ rows, flag, inRange, now }, files) {
  const grants = rows.filter((r) => r.kind === 'go-grant' && r.id !== undefined)
  const list = []
  if (files) {
    for (const f of files) {
      if (!grants.some((r) => r.id === f.id && r.hash === f.hash && r.by === f.by)) flag('j', 'go-file-no-row', `go file ${f.id}.json has no go-grant row carrying its session and the hash of its bytes: no click of the person wrote it`)
    }
  }
  for (const r of grants) {
    const end = rows.find((x) => x.kind === 'go-end' && x.id === r.id)
    const endMs = r.end !== undefined ? Date.parse(r.end) : NaN
    const file = files?.find((f) => f.id === r.id)
    if (files && !file && !end && Number.isFinite(endMs) && endMs > now) flag('j', 'go-row-no-file', `the go-grant row of go ${r.id.slice(0, 8)} (${r.t}) ends ${r.end}, has no go-end row and no go file: no session can read it`, { t: r.t })
    if (!inRange(r.ms)) continue
    const readers = rows.filter((x) => x.kind === 'go-read' && x.id === r.id).map((x) => ({ t: x.t, by: x.by ?? '', lane: x.lane ?? '', code: x.code ?? '' }))
    list.push({ id: r.id, t: r.t, by: r.by ?? '', lane: r.lane ?? '', repo: r.repo ?? '', end: r.end ?? '', state: end ? `ended (${end.code ?? '?'}, ${end.t})` : Number.isFinite(endMs) && endMs <= now ? 'ended (end time)' : 'live', text: file?.text ?? null, readers: readers.slice(0, LIST_MAX) })
  }
  return list.slice(0, LIST_MAX)
}

export function audit({ root, since, now = Date.now(), records, recordsExplicit = false, goes, goesExplicit = false }) {
  const problems = []
  const notes = []
  let rootReal
  try {
    rootReal = realpathSync(root)
    if (!lstatSync(rootReal).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new AuditError(`cannot read the prompts folder: ${root}`)
  }
  let entries
  try {
    entries = list(rootReal)
  } catch (e) {
    throw new AuditError(`cannot list the prompts folder: ${e.code ?? e.message}`)
  }
  if (UNPLACED.length > 0) problems.push(`the mod writes row kind(s) the audit has no place for: ${UNPLACED.join(', ')}`)
  const { rows, files: ledgerFiles } = readLedger(rootReal, entries, since, problems, notes)
  const questions = readQuestions(rootReal, entries, since, problems, now)
  const qById = questions.byId
  const inRange = (ms) => since === undefined || ms >= since

  // Group by request id.
  const byId = new Map()
  for (const r of rows) {
    if (r.id === undefined || GO_KINDS.has(r.kind)) continue
    let g = byId.get(r.id)
    if (!g) byId.set(r.id, (g = { id: r.id, rows: [], requested: [], answered: [], escalated: [], returned: [], dropped: [], relayed: [], relayLost: [], ends: [] }))
    g.rows.push(r)
    if (r.kind === 'requested') g.requested.push(r)
    else if (r.kind === 'answered') g.answered.push(r)
    else if (r.kind === 'escalated') g.escalated.push(r)
    else if (r.kind === 'returned') g.returned.push(r)
    else if (r.kind === 'dropped') g.dropped.push(r)
    else if (r.kind === 'relayed') g.relayed.push(r)
    else if (r.kind === 'relay-lost') g.relayLost.push(r)
    if (ENDS.has(r.kind)) g.ends.push(r)
  }
  const groups = [...byId.values()].filter((g) => inRange(g.rows[0].ms))
  const anomalies = []
  const flag = (rule, code, detail, extra = {}) => anomalies.push({ rule, code, detail, ...extra })
  const lostRaces = []
  const abandoned = []
  const dropsFine = []
  const table = []
  const waits = []

  const onOff = rows.filter((r) => r.kind === 'answering-on' || r.kind === 'answering-off')
  const ctx = { rows, groups, qById, inRange, flag, notes, problems, now, onOff, table, waits, lostRaces, abandoned, dropsFine }
  for (const g of groups) {
    tableRow(g, ctx)
    ruleDecisions(g, ctx)
    ruleQuestions(g, ctx)
    ruleTiers(g, ctx)
    rulePersonAnswers(g, ctx)
    ruleUnended(g, ctx)
    noteBenign(g, ctx)
  }
  // `abandoned` rows that carry no id (a hook that failed before it had one) are counted, not listed per request.
  const abandonedNoId = rows.filter((r) => r.kind === 'abandoned' && r.id === undefined && inRange(r.ms))
  for (const r of abandonedNoId) abandoned.push({ id: '', t: r.t, code: r.code ?? '', tool: r.tool ?? '' })

  ruleLeadGrants(ctx)
  ruleLeadOwners(ctx)
  ruleAnsweringOn(ctx)
  const files = ruleStaleRequestFiles(ctx, rootReal, entries)
  ruleClosedWithoutRow(ctx, files)
  ruleLeadStops(ctx)
  const recs = readLeadRecords(records ?? join(rootReal, '..', 'lead-records'), recordsExplicit, problems)
  ruleLeadOwnerLogged(ctx, recs)
  const goFiles = readGoFiles(goes ?? join(rootReal, '..', 'go'), goesExplicit, problems)
  const goList = ruleGoes(ctx, goFiles)
  noteQuestions(ctx, questions)
  noteRaised(ctx)
  anomalies.sort((x, y) => (x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0))

  const { relayCounts, relayedList } = buildRelay(ctx)

  return {
    root: rootReal,
    since: since === undefined ? null : new Date(since).toISOString(),
    scanned: { ledgerFiles, rows: rows.length, requests: table.length, requestFiles: files.requestFiles, leadRecordFiles: recs ? recs.length : null, goFiles: goFiles ? goFiles.length : null },
    table,
    goes: goList,
    anomalies,
    notAnomalies: {
      lostRaces: lostRaces.slice(0, LIST_MAX),
      abandoned: abandoned.slice(0, LIST_MAX),
      dropped: dropsFine.slice(0, LIST_MAX),
      relay: relayCounts,
      relayedRequests: relayedList,
    },
    counts: buildCounts(ctx),
    questions: { files: questions.files, count: questions.count, rows: questions.rows, list: questions.list, unreadable: questions.unreadable },
    problems,
    notes,
  }
}

// ---- output ----
// C0 and C1 controls, DEL, the line and paragraph separators and the bidi controls, shown as \uXXXX so the text stays readable and inert.
const CONTROLS_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const escapeControls = (s) => String(s).replace(CONTROLS_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}~` : s)
const sec = (v) => (v === undefined ? '-' : v < 100 ? v.toFixed(1) : Math.round(v).toString())
function pad(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd())
}
export function render(rep) {
  const out = []
  out.push(`prompt audit: ${rep.root}${rep.since ? `, since ${rep.since}` : ''}`)
  const s = rep.scanned
  out.push(`ledger files ${s.ledgerFiles}, rows ${s.rows}, requests ${s.requests}; request files ${s.requestFiles}; ${s.leadRecordFiles === null ? 'lead records not checked (no folder)' : `lead record files ${s.leadRecordFiles}`}`)
  out.push('', 'REQUESTS')
  if (rep.table.length === 0) out.push('(none)')
  else {
    const head = ['time', 'lane', 'tool', 'pattern', 'hash8', 'tier', 'decision', 'why', 'age s', 'outcome']
    out.push(...pad([head, ...rep.table.map((t) => [t.t.replace(/\.\d+Z$/, 'Z'), cut(t.lane, 14), cut(t.tool, 28), cut(t.pattern, 28), t.hash8, t.tier, t.decision, cut(t.why.replace(/\s+/g, ' '), 40), sec(t.age), t.outcome])]))
  }
  if (rep.goes.length > 0) {
    out.push('', `GOES (the text the person approved, and the sessions that read it)${s.goFiles === null ? '; the go files were not read' : ''}`)
    for (const x of rep.goes) {
      out.push(`  ${x.t.replace(/\.\d+Z$/, 'Z')} ${x.id.slice(0, 8)} given in ${x.lane || '?'} (${x.by || '?'}), repo ${x.repo || '?'}, ends ${x.end || '?'}: ${x.state}`)
      out.push(`    text: ${x.text === null ? '(no go file)' : cut(x.text.replace(/\s+/g, ' '), 1600)}`)
      out.push(`    read by: ${x.readers.length === 0 ? '(none)' : x.readers.map((r) => `${r.lane || '?'} (${r.by}, ${r.code})`).join(', ')}`)
    }
  }
  out.push('', 'ANOMALIES (must be empty)')
  // "none" is said only when nothing was missed: a skipped file or an unread folder makes the audit incomplete, and it must say so here.
  if (rep.problems.length > 0) out.push(`INCOMPLETE: ${rep.problems.length} problem(s), the audit did not see everything`)
  else if (rep.anomalies.length === 0) out.push('none')
  for (const a of rep.anomalies) out.push(`${a.rule} ${a.code}: ${a.detail}`)
  const n = rep.notAnomalies
  out.push('', 'NOT ANOMALIES')
  out.push(`lost races: ${n.lostRaces.length}`)
  for (const r of n.lostRaces) out.push(`  ${r.t} ${r.id} ${r.detail}`)
  out.push(`abandoned: ${n.abandoned.length}`)
  const byCode = {}
  for (const r of n.abandoned) byCode[r.code || '(none)'] = (byCode[r.code || '(none)'] ?? 0) + 1
  for (const [c, k] of Object.entries(byCode).sort()) out.push(`  ${c}: ${k}`)
  out.push(`dropped, ordinary: ${n.dropped.length}`)
  const dc = {}
  for (const r of n.dropped) dc[r.code || '(none)'] = (dc[r.code || '(none)'] ?? 0) + 1
  for (const [c, k] of Object.entries(dc).sort()) out.push(`  ${c}: ${k}`)
  for (const [k, v] of Object.entries(n.relay)) out.push(`${k === 'personAnswers' ? 'answered by the person (relay)' : k}: ${v.n}${Object.keys(v.codes).length > 0 ? ` (${Object.entries(v.codes).sort().map(([c, m]) => `${c} ${m}`).join(', ')})` : ''}`)
  if (n.relayedRequests.length > 0) {
    out.push('', 'RELAYED (each request taken to the person; a lane\'s question is shown as the lane asked it)')
    for (const r of n.relayedRequests) {
      out.push(`  ${r.t} ${r.id.slice(0, 8)} ${r.tier} ${r.tool} ${r.pattern}`)
      if (r.laneQuestion) out.push(`    the lane asked: ${r.laneQuestion.header ? `[${r.laneQuestion.header}] ` : ''}${r.laneQuestion.question.replace(/\s+/g, ' ')}${r.laneQuestion.options.length > 0 ? ` (options: ${r.laneQuestion.options.join(' | ')})` : ''}`)
    }
  }
  out.push('', 'COUNTS (wait = seconds from request to decision, returned rows)')
  const c = rep.counts
  out.push(`all: n ${c.wait.n}, median ${sec(c.wait.median)}, p90 ${sec(c.wait.p90)}`)
  for (const [title, m] of [['tier', c.byTier], ['tool', c.byTool]]) {
    const rows = [[title, 'requests', 'outcomes', 'n', 'median', 'p90']]
    for (const [k, e] of Object.entries(m)) rows.push([cut(k, 40), String(e.requests), Object.entries(e.outcomes).map(([o, v]) => `${o} ${v}`).join(', '), String(e.wait.n), sec(e.wait.median), sec(e.wait.p90)])
    if (rows.length > 1) out.push(...pad(rows))
  }
  out.push(`rows by kind: ${Object.entries(c.rowsByKind).sort().map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`)
  if (rep.questions.files > 0 || rep.questions.count > 0) {
    out.push('', `QUESTIONS: ${rep.questions.count} row(s) in ${rep.questions.files} file(s)`)
    if (rep.questions.list.length > 0) {
      const head = ['time', 'lane', 'tier', 'header', 'question', 'label']
      out.push(...pad([head, ...rep.questions.list.map((q) => [q.t.replace(/\.\d+Z$/, 'Z'), cut(q.lane, 14), q.via === 'person' ? `person via ${q.tier}` : q.tier, cut(q.header, 20), cut(q.question.replace(/\s+/g, ' '), 200), cut(q.label.replace(/\s+/g, ' '), 60)])]).map((l) => `  ${l}`))
    }
    if (rep.questions.unreadable > 0) out.push(`  (${rep.questions.unreadable} row(s) were not valid JSON objects)`)
  }
  if (rep.problems.length > 0) out.push('', 'PROBLEMS (the audit is incomplete)', ...rep.problems.map((p) => `  ${p}`))
  if (rep.notes.length > 0) out.push('', 'NOTES', ...rep.notes.map((p) => `  ${p}`))
  // Every line is escaped as a whole, so no value from a ledger row, a file name or a path can carry a control character.
  return `${out.map(escapeControls).join('\n')}\n`
}

// ---- command line ----
const USAGE = 'usage: prompt-audit.mjs [--since DATE] [--root DIR] [--records DIR] [--goes DIR] [--json]'
function parseArgs(argv, env = process.env) {
  const cfg = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude')
  const o = { root: join(cfg, 'callboard', 'prompts'), since: undefined, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new AuditError(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--json') o.json = true
    else if (a === '--root') o.root = val()
    else if (a === '--records') {
      o.records = val()
      o.recordsExplicit = true
    }
    else if (a === '--goes') {
      o.goes = val()
      o.goesExplicit = true
    }
    else if (a === '--since') {
      const v = val()
      const ms = Date.parse(v)
      if (!Number.isFinite(ms)) throw new AuditError(`bad --since date: ${v}`)
      o.since = ms
    } else throw new AuditError(`unknown argument: ${a}`)
  }
  return o
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const o = parseArgs(process.argv.slice(2))
    const rep = audit(o)
    process.stdout.write(o.json ? `${JSON.stringify(rep, null, 2)}\n` : render(rep))
    process.exitCode = rep.anomalies.length > 0 ? 1 : rep.problems.length > 0 ? 2 : 0
  } catch (e) {
    if (!(e instanceof AuditError)) throw e
    console.error(`prompt audit: ${escapeControls(e.message)}`)
    console.error(USAGE)
    process.exitCode = 2
  }
}
