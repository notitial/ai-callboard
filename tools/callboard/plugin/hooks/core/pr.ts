// PR notes: the pull request GitHub's answer describes, what changed since the last look, the notes that change makes, and the tracker file. Pure. Trust rules held here:
// the CLI's answer and the tracker are read field by field and an own-property check keeps a `__proto__` key out; only a repo, a number, a 7-character commit id, counts and
// a lane name reach a note, so a note holds no free text. Where a note goes is `prRoute` in notices.ts.
export const PR_POLL_MS = 120_000
export const PR_TRACK_MS = 20 * 60_000
export const PR_MAX = 8

export type PrRef = { owner: string; repo: string; number: number }
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPO_RE = /^(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/
const SHA_RE = /^[0-9a-f]{40}$/
// The input of pr_watch: the number may come as an integer or as its plain digits; a name outside GitHub's grammar is refused.
export function parseRef(i: unknown): PrRef | undefined {
  const o = (i ?? {}) as { owner?: unknown; repo?: unknown; number?: unknown }
  const n = typeof o.number === 'string' && /^[1-9][0-9]{0,6}$/.test(o.number) ? Number(o.number) : o.number
  return typeof o.owner === 'string' && OWNER_RE.test(o.owner) && typeof o.repo === 'string' && REPO_RE.test(o.repo) && typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9_999_999
    ? { owner: o.owner, repo: o.repo, number: n }
    : undefined
}
export const refText = (r: PrRef): string => `${r.owner}/${r.repo}#${r.number}`
// One spelling per PR, for a map key: GitHub's names do not tell case apart.
export const refKey = (r: PrRef): string => refText(r).toLowerCase()

// ---- the answer ----
export type Checks = 'none' | 'pending' | 'green' | 'failed'
export type PrState = 'open' | 'merged' | 'closed'
// What was last seen of a PR. mergeable: open, not a draft, no conflict, checks green or absent, no blocking review.
export type Seen = { sha: string; state: PrState; draft: boolean; checks: Checks; mergeable: boolean; reviews: number; comments: number; threads: number }
// A look at one PR, with `merge` unknown while GitHub is still working it out.
export type Look = Omit<Seen, 'mergeable'> & { merge: 'yes' | 'no' | 'unknown' }
// The fields the adapter asks GitHub for, one alias `p<number>` per PR; parseLook reads exactly these.
export const PR_FIELDS = 'state isDraft mergeable reviewDecision headRefOid reviews{totalCount} comments{totalCount} reviewThreads{totalCount} commits(last:1){nodes{commit{statusCheckRollup{state}}}}'
const own = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined)
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const total = (v: unknown): number => (count(own(v, 'totalCount')) ? (own(v, 'totalCount') as number) : 0)
const STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
const ROLLUP: Record<string, Checks> = { SUCCESS: 'green', FAILURE: 'failed', ERROR: 'failed', PENDING: 'pending', EXPECTED: 'pending' }
const word = (o: Record<string, string>, k: unknown): string | undefined => (typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : undefined)

// A node that has no valid commit id or state is not observed. Anything else it lacks reads as its quiet value; only a check rollup that is present and null means no checks,
// a rollup that is missing or has a state this reader does not know reads as pending: a field GitHub adds or renames never throws, and never reads as mergeable.
function parseLook(node: unknown): Look | undefined {
  const sha = own(node, 'headRefOid')
  const state = word(STATES, own(node, 'state')) as PrState | undefined
  if (typeof sha !== 'string' || !SHA_RE.test(sha) || state === undefined) return undefined
  const nodes = own(own(node, 'commits'), 'nodes')
  const rollup = Array.isArray(nodes) ? own(own(nodes[0], 'commit'), 'statusCheckRollup') : undefined
  const checks: Checks = rollup === null ? 'none' : ((word(ROLLUP, own(rollup, 'state')) as Checks | undefined) ?? 'pending')
  const draft = own(node, 'isDraft') !== false
  const decision = own(node, 'reviewDecision')
  const m = own(node, 'mergeable')
  const ok = state === 'open' && !draft && m === 'MERGEABLE' && (checks === 'green' || checks === 'none') && decision !== 'CHANGES_REQUESTED' && decision !== 'REVIEW_REQUIRED'
  return { sha, state, draft, checks, merge: m === 'MERGEABLE' || m === 'CONFLICTING' ? (ok ? 'yes' : 'no') : 'unknown', reviews: total(own(node, 'reviews')), comments: total(own(node, 'comments')), threads: total(own(node, 'reviewThreads')) }
}
// The CLI's stdout for the numbers asked. undefined: no observation at all (not JSON, no repository object). A PR whose node fails is left out: not observed this round.
export function parseAnswer(stdout: unknown, numbers: readonly number[]): Map<number, Look> | undefined {
  let repo: unknown
  try {
    repo = own(own(JSON.parse(String(stdout)), 'data'), 'repository')
  } catch {
    return undefined
  }
  if (typeof repo !== 'object' || repo === null) return undefined
  const out = new Map<number, Look>()
  for (const n of numbers) {
    const l = parseLook(own(repo, `p${n}`))
    if (l) out.set(n, l)
  }
  return out
}
// The fingerprint a look leaves. While GitHub has not worked out the merge state of the same commit, the last answer stands; a commit first seen with no check on it is not
// mergeable yet (right after a push the checks have not started).
export function seenOf(look: Look, prev?: Seen): Seen {
  const fresh = prev !== undefined && prev.sha !== look.sha && look.checks === 'none'
  const mergeable = look.merge === 'unknown' ? prev !== undefined && prev.sha === look.sha && prev.mergeable : look.merge === 'yes' && !fresh
  const { merge: _, ...rest } = look
  return { ...rest, mergeable }
}

// ---- notes ----
export type NoteKind = 'green' | 'failed' | 'activity' | 'mergeable' | 'merged' | 'closed' | 'expired' | 'lost'
const END: readonly NoteKind[] = ['merged', 'closed', 'expired', 'lost']
// `lane`: the registrant's name, set when the note goes to its parent, which is told whose PR it is.
export type PrNote = { kind: NoteKind; pr: string; at: number; sha?: string; reviews?: number; comments?: number; threads?: number; lane?: string }

// What changed between two fingerprints of one PR, as notes. A merge or a close is the only news of its round.
export function notesOf(ref: PrRef, prev: Seen, next: Seen, at: number, lane?: string): { notes: PrNote[]; ended: boolean } {
  const base = { pr: refText(ref), at, ...(lane === undefined ? {} : { lane }) }
  if (next.state !== 'open') return { notes: prev.state === next.state ? [] : [{ ...base, kind: next.state }], ended: true }
  const notes: PrNote[] = []
  const moved = next.sha !== prev.sha || next.checks !== prev.checks
  if (moved && (next.checks === 'green' || next.checks === 'failed')) notes.push({ ...base, kind: next.checks === 'green' ? 'green' : 'failed', sha: next.sha.slice(0, 7) })
  const [reviews, comments, threads] = [next.reviews - prev.reviews, next.comments - prev.comments, next.threads - prev.threads].map((d) => Math.max(0, d))
  if (reviews + comments + threads > 0) notes.push({ ...base, kind: 'activity', reviews, comments, threads })
  if (next.mergeable && !prev.mergeable) notes.push({ ...base, kind: 'mergeable' })
  return { notes, ended: false }
}
// The notes owed to one session in one turn: per PR, the newest check result, the activity counts added up, one `mergeable`; an end drops what came before it.
export function mergeNotes(ns: readonly PrNote[]): PrNote[] {
  const out = new Map<string, PrNote>()
  for (const n of [...ns].sort((a, b) => a.at - b.at)) {
    const base = `${n.pr}|${n.lane ?? ''}|`
    if (END.includes(n.kind)) for (const k of [...out.keys()]) if (k.startsWith(base)) out.delete(k)
    const key = base + (n.kind === 'green' || n.kind === 'failed' ? 'checks' : n.kind)
    if (n.kind === 'failed') out.delete(`${base}mergeable`)
    const prev = out.get(key)
    out.set(key, n.kind === 'activity' && prev ? { ...n, reviews: (prev.reviews ?? 0) + (n.reviews ?? 0), comments: (prev.comments ?? 0) + (n.comments ?? 0), threads: (prev.threads ?? 0) + (n.threads ?? 0) } : n)
  }
  return [...out.values()]
}

// ---- the tracker ----
// An entry whose stamp is more than PR_TRACK_MS from now, either way, is expired: a stamp from the future cannot keep a PR polled for good.
export type Tracked = PrRef & { at: number; seen: Seen }
export type Tracker = { sid: string; prs: Tracked[] }
export const trackExpired = (p: { at: number }, now: number): boolean => Math.abs(now - p.at) >= PR_TRACK_MS
const seenOk = (s: unknown): s is Seen =>
  SHA_RE.test(String(own(s, 'sha'))) && ['open', 'merged', 'closed'].includes(String(own(s, 'state'))) && ['none', 'pending', 'green', 'failed'].includes(String(own(s, 'checks'))) &&
  ['draft', 'mergeable'].every((k) => typeof own(s, k) === 'boolean') && ['reviews', 'comments', 'threads'].every((k) => count(own(s, k)))
// A tracker file of the session `sid`: a PR entry that fails is dropped, the rest kept. undefined: not a tracker of this session.
export function parseTracker(text: unknown, sid: string): Tracker | undefined {
  let j: unknown
  try {
    j = JSON.parse(String(text))
  } catch {
    return undefined
  }
  const list = own(j, 'prs')
  if (own(j, 'sid') !== sid || !Array.isArray(list)) return undefined
  const prs: Tracked[] = []
  for (const p of list.slice(0, PR_MAX)) {
    const ref = parseRef(p)
    const seen = own(p, 'seen')
    const at = own(p, 'at')
    if (ref && typeof at === 'number' && Number.isFinite(at) && seenOk(seen) && !prs.some((x) => refKey(x) === refKey(ref))) prs.push({ ...ref, at, seen })
  }
  return { sid, prs }
}
