// pr_watch, the one GitHub call, the trackers and the notes. Trust rules held here: the CLI runs with no shell, at a fixed path, with an argv built from checked values and an
// environment that empties every variable that would change who it is or where it connects; only its stdout is read, within a size cap, and only through parseAnswer; one tracker file
// per session id; a note is kept only when the tracker that made it was written; a note goes where prRoute says, and a gone row routes none (its tracker is removed; an off row's is left).
import type { Sid, View } from '../core/model.ts'
import { capability, children, isOff, liveness, nameOf, refusal } from '../core/model.ts'
import { NEW_KEY } from '../core/lifecycle.ts'
import { prRoute } from '../core/notices.ts'
import type { Look, PrNote, PrRef, Tracked, Tracker } from '../core/pr.ts'
import { PR_FIELDS, PR_MAX, PR_POLL_MS, mergeNotes, notesOf, parseAnswer, parseRef, parseTracker, refKey, refText, seenOf, trackExpired } from '../core/pr.ts'
import { home, locked, log, path, readText, rm, run, writeFile } from './io.ts'
import { mem } from './mem.ts'
import { getView } from './store.ts'
import { deny, isSub, say } from './tools-any.ts'

const BINS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
const UNSET = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'GH_DEBUG', 'DEBUG', 'GODEBUG', 'GH_FORCE_TTY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
const STDOUT_MAX = 262_144
const LOST_AFTER = 5
const LOOKS_PER_HOUR = 30
const repoKey = (p: PrRef): string => `${p.owner}/${p.repo}`.toLowerCase()
export const prQuery = (numbers: number[]): string => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map((n) => `p${n}:pullRequest(number:${n}){${PR_FIELDS}}`).join(' ')}}}`
const byRepo = (prs: readonly Tracked[]): Tracked[][] => [...prs.reduce((m, p) => m.set(repoKey(p), [...(m.get(repoKey(p)) ?? []), p]), new Map<string, Tracked[]>()).values()]

// The first of the fixed paths that exists, looked up once a minute.
async function bin($: any): Promise<string | undefined> {
  const now = await $.clock.now()
  if (mem.prBin === undefined || now - mem.prBin.at > 60_000) {
    let found: string | undefined
    for (const b of BINS) if (found === undefined && (await $.fs.exists(b).catch(() => false))) found = b
    mem.prBin = { at: now, path: found }
  }
  return mem.prBin.path
}
// One call for the numbers of one repo. undefined: no observation (no CLI, a failed or cut call, an answer the parser refused).
async function look($: any, r: PrRef, numbers: number[]): Promise<Map<number, Look> | undefined> {
  const [b, h] = [await bin($), await home($)]
  if (b === undefined || h === undefined) return undefined
  const env = { HOME: h, ...Object.fromEntries(UNSET.map((k) => [k, ''])), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', LC_ALL: 'C' }
  const out = await run($, [b, 'api', 'graphql', '--hostname', 'github.com', '-f', `owner=${r.owner}`, '-f', `name=${r.repo}`, '-f', `query=${prQuery(numbers)}`], { timeoutMs: 20_000, env }).catch(() => undefined)
  return out === undefined || out.exitCode !== 0 || out.isStdoutTruncated === true || out.stdout.length > STDOUT_MAX ? undefined : parseAnswer(out.stdout, numbers)
}

// ---- the trackers ----
async function readTracker($: any, sid: Sid): Promise<Tracker | undefined> {
  const p = await path($, 'prs', `${sid}.json`)
  const t = p === undefined ? undefined : await readText($, p, 16_384)
  return t === undefined ? undefined : parseTracker(t, sid)
}
async function writeTracker($: any, t: Tracker): Promise<boolean> {
  const p = await path($, 'prs', `${t.sid}.json`)
  if (p === undefined) return false
  return t.prs.length === 0 ? (await rm($, [p]), true) : writeFile($, p, JSON.stringify(t))
}

// ---- the tool ----
export async function prWatchCall($: any, e: any, _next: any) {
  const sid = (await $.session.id()) as Sid
  const no = (detail: string) => deny(refusal('refuse', 'bad-input', { tool: 'pr_watch', detail }))
  const ref = parseRef(e)
  if (isSub(e)) return no('subagent')
  if (ref === undefined) return no('input')
  if (isOff(await getView($), sid)) return deny(refusal('refuse', 'is-off', { tool: 'pr_watch' }))
  const now = await $.clock.now()
  const has = (t?: Tracker) => t?.prs.find((p) => refKey(p) === refKey(ref))
  let first: Look | undefined
  if (has(await readTracker($, sid)) === undefined) {
    mem.prLooks = mem.prLooks.filter((t) => now - t < 3_600_000)
    if (mem.prLooks.length >= LOOKS_PER_HOUR) return no('too-many')
    mem.prLooks.push(now)
    first = (await look($, ref, [ref.number]))?.get(ref.number)
    if (first === undefined) return no('no-answer')
    if (first.state !== 'open') return { result: say({ msg: 'pr.note', p: { kind: first.state, pr: refText(ref) } }) }
  }
  const done = await locked($, `pr-${sid}`, async () => {
    const t = (await readTracker($, sid)) ?? { sid, prs: [] }
    const had = has(t)
    if (had === undefined && (first === undefined || t.prs.length >= PR_MAX)) return 'full'
    if (t.prs.length === 0) mem.prPollAt = now
    const prs = had === undefined ? [...t.prs, { ...ref, at: now, seen: seenOf(first!) }] : t.prs.map((p) => (p === had ? { ...p, at: now } : p))
    return (await writeTracker($, { sid, prs })) ? 'ok' : 'write'
  })
  if (done !== 'ok') return no(done ?? 'write')
  await log($, sid, 'pr-watch')
  return { result: say({ msg: 'pr.watching', p: { pr: refText(ref) } }) }
}

// ---- the poll ----
// One session's tracker: looked at with no lock held (a pr_watch call never waits for GitHub), then every entry still there is moved by what was seen.
async function round($: any, v: View, me: Sid, sid: Sid, now: number): Promise<void> {
  const to = prRoute(v, sid)
  const t = to === 'hold' ? undefined : await readTracker($, sid)
  if (t === undefined) return
  if (to !== me) return to === 'none' && !isOff(v, sid) ? void (await writeTracker($, { sid, prs: [] })) : undefined
  const lane = sid === me ? {} : { lane: nameOf(v, sid) }
  const looks = new Map<string, Look>()
  for (const g of byRepo(t.prs.filter((p) => !trackExpired(p, now)))) for (const [n, l] of (await look($, g[0]!, g.map((p) => p.number))) ?? []) looks.set(`${repoKey(g[0]!)}#${n}`, l)
  const notes: PrNote[] = []
  const ok = await locked($, `pr-${sid}`, async () => {
    const prs = ((await readTracker($, sid)) ?? t).prs.flatMap((p): Tracked[] => {
      const lost = `${sid}|${refKey(p)}`
      const l = looks.get(refKey(p))
      const end = (kind: 'expired' | 'lost'): Tracked[] => (notes.push({ kind, pr: refText(p), at: now, ...lane }), [])
      if (trackExpired(p, now)) return end('expired')
      if (l === undefined) return mem.prLost.set(lost, (mem.prLost.get(lost) ?? 0) + 1).get(lost)! >= LOST_AFTER ? end('lost') : [p]
      mem.prLost.delete(lost)
      const seen = seenOf(l, p.seen)
      const r = notesOf(p, p.seen, seen, now, 'lane' in lane ? lane.lane : undefined)
      notes.push(...r.notes)
      return r.ended ? [] : [{ ...p, seen }]
    })
    return writeTracker($, { sid, prs })
  })
  if (ok === true) mem.prNotes = [...mem.prNotes, ...notes].slice(-50)
}
// The trackers this session polls: its own, and those of its children that no live session carries (a lead's are polled for it, a manager's are only cleared).
export async function prTick($: any, me: Sid, v: View): Promise<void> {
  const now = await $.clock.now()
  if (now - mem.prPollAt < PR_POLL_MS) return
  mem.prPollAt = now
  const dead = capability(v, me) !== 'none' ? children(v, me).filter((c) => liveness(v, c) === 'no' && !c.startsWith(NEW_KEY)) : []
  for (const sid of [me, ...dead]) if (await $.fs.exists((await path($, 'prs', `${sid}.json`)) ?? '/').catch(() => false)) await round($, v, me, sid, now)
}
// The owed notes as one turn's text, claimed at once; `undo` puts them back when the turn could not be sent.
export function prClaim(): { text: string; undo: () => void } | undefined {
  const taken = mem.prNotes
  const notes = mergeNotes(taken)
  if (notes.length === 0) return undefined
  mem.prNotes = []
  return { text: say({ msg: 'pr.turn', p: { lines: notes.map(({ at: _, ...n }) => say({ msg: 'pr.note', p: n })) } }), undo: () => void (mem.prNotes = [...taken, ...mem.prNotes].slice(-50)) }
}
