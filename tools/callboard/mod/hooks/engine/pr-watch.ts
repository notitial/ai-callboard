// PR notices (ADR 0010): the pr_watch tool, the one GitHub CLI call, the poll, the tracker and note files, and the delivery of the fixed notice.
// Trust rules held here: the CLI runs with no shell, at a fixed path, with an argv and an environment built by pr-watch.ts from checked values only, and its
// error output and thrown errors are never read into a log, a note or a result; the login stays inside the CLI. A tracker or a note read from disk passes the
// same checks as the tool's input before anything is built from it, and a folder is checked before a file in it is read or removed. A notice is fixed text
// and is never an approval.
import * as c from '../core.ts'
import * as pw from '../pr-watch.ts'
import {
  mem,
  grants,
  dialogUp,
  lastSubmitAt,
  laneBrief,
  prTrack,
  prLoaded,
  prChain,
  prPollAt,
  prBusy,
  prFails,
  prGone,
  prHeld,
  prPending,
  prSpoolAt,
  prDelivered,
  prWakes,
  prLooks,
  prLeadNotes,
  prColdTold,
  prCapLogged,
  prGh,
} from '../mem.ts'
import { where, facts, real, run, rmF, dirOk, log, logq, submitOwn, withTimeout, ACTION_TIMEOUT_MS, MKDIR, RMDIR } from './base.ts'
import { writeIn, readStoreFile, registryEntries, idleCheck, regOnce } from './store.ts'
import { ledgerAdd } from './answer-hook.ts'
import { personRow } from './compaction.ts'
import { ensureTimer } from './tick.ts'
import { getLane, getRequest, getNudgeDue, getTurnEnd } from '../state.ts'

type Paths = { uid: number; root: string }
type Owed = { file: string; note: pw.Note }
const GH_RECHECK_MS = 10 * 60_000
const SWEEP_MS = c.HOUR_MS

export async function prToolRegister($: any) {
  await $.tool.register({
    name: pw.PR_TOOL,
    description: pw.PR_TOOL_DESCRIPTION,
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
  })
}

// One writer of a tracker at a time inside this process: the tool call and the poll both change it. No call to GitHub is made under it but the first look
// of a new registration.
async function prLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = prChain.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  const tail = prev.then(() => mine)
  prChain.set(key, tail)
  await prev
  try {
    return await work()
  } finally {
    release()
    if (prChain.get(key) === tail) prChain.delete(key)
  }
}

// The CLI's real path: the first fixed path that resolves to a regular file owned by the person or root and not writable by group or other (Homebrew's is a
// link into its Cellar). Looked up again every 10 minutes; undefined: no CLI.
async function ghBin($: any, uid: number): Promise<string | undefined> {
  const now = await $.clock.now()
  if (!c.dueEvery(prGh.at, now, GH_RECHECK_MS)) return prGh.path
  let found: string | undefined
  for (const path of pw.GH_PATHS) {
    const r = await real($, path).catch(() => '')
    if (!r.startsWith('/')) continue
    const f = await facts($, r).catch(() => undefined)
    if (f && f.kind === 'file' && (f.uid === uid || f.uid === 0) && (f.mode & 0o022) === 0) {
      found = r
      break
    }
  }
  prGh.at = now
  prGh.path = found
  return found
}

// One call for the PRs of one repo. `fail` is a fixed code and means no observation: no CLI, a value outside the grammar, a spawn failure or timeout, a
// non-zero exit or a cut answer, an answer the parser refused. Only stdout is read, and only through parseAnswer; stderr and a thrown error are dropped unread.
type LookResult = { looks: Map<number, pw.Look> } | { fail: 'no-cli' | 'input' | 'spawn' | 'exit' | 'parse' }
async function ghLook($: any, p: Paths, owner: string, repo: string, numbers: number[]): Promise<LookResult> {
  const bin = await ghBin($, p.uid)
  if (bin === undefined) return { fail: 'no-cli' }
  const env = pw.ghEnv(p.root.slice(0, -'/.claude/callboard'.length))
  const argv = pw.ghArgv(bin, owner, repo, numbers)
  if (!argv || !env) return { fail: 'input' }
  try {
    const r = await $.process.run(argv, { timeoutMs: pw.GH_TIMEOUT_MS, env })
    if (r.exitCode !== 0 || r.isStdoutTruncated === true) return { fail: 'exit' }
    const looks = pw.parseAnswer(r.stdout, numbers)
    return looks ? { looks } : { fail: 'parse' }
  } catch {
    return { fail: 'spawn' }
  }
}

// The PR folder, and a session's folder of owed notes when `sub` names one: each made 0700 by name (mkdir -p would give a parent the default mode) and checked.
async function prDirs($: any, p: Paths, sub?: string): Promise<boolean> {
  const dirs = [p.root, `${p.root}/prs`, ...(sub === undefined ? [] : [`${p.root}/prs/notes`, `${p.root}/prs/notes/${sub}`])]
  await run($, [MKDIR, '-p', '-m', '700', ...dirs])
  for (const d of dirs) if (!(await dirOk($, d, p.uid))) return false
  return true
}

// A tracker file, read by session `me`. `unread`: the stat or the read itself failed, so nothing is known; `none`: no file, or one that fails a check
// (its kind, owner, mode, link count or size), which is removed and logged. A registration dated after now counts from now, so no tracker outlives
// PR_TRACK_MS on the strength of its own date.
type Loaded = { state: 'unread' } | { state: 'none' } | { state: 'ok'; text: string; t: pw.Tracker }
async function trackerRead($: any, p: Paths, me: string, sid: string): Promise<Loaded> {
  const path = `${p.root}/prs/${sid}.json`
  const f = await readStoreFile($, path, p.uid, pw.PR_TRACKER_MAX).catch(() => undefined)
  if (!f) return { state: 'unread' }
  if (f.state === 'bad') {
    const s = await facts($, path).catch(() => undefined)
    if (!s || (c.cueFileOk(s, p.uid) === undefined && s.size <= pw.PR_TRACKER_MAX)) return { state: 'unread' }
    await rmF($, path)
    await logq($, me, 'pr-tracker-dropped', 'check')
    return { state: 'none' }
  }
  const t = f.state === 'ok' ? pw.parseTracker(f.text, sid) : undefined
  if (!t) return { state: 'none' }
  const now = await $.clock.now()
  return { state: 'ok', text: f.text, t: t.prs.some((x) => x.at > now) ? { ...t, prs: t.prs.map((x) => (x.at > now ? { ...x, at: now } : x)) } : t }
}
// A tracker with no PR left is removed. false: it could not be written.
async function trackerWrite($: any, p: Paths, t: pw.Tracker): Promise<boolean> {
  if (t.prs.length === 0) {
    await rmF($, `${p.root}/prs/${t.sid}.json`)
    return true
  }
  if (!(await prDirs($, p))) return false
  return !('err' in (await writeIn($, 'prs', `${t.sid}.json`, pw.trackerText(t))))
}
// This session's own tracker: read from its file once per load of the mod, then kept in memory (this session is its only writer while it lives). A read that
// failed is tried again at the next call. 'unread': nothing is known yet.
async function ownTracker($: any, p: Paths, sid: string): Promise<pw.Tracker | undefined | 'unread'> {
  if (!prLoaded.has(sid)) {
    const r = await trackerRead($, p, sid, sid)
    if (r.state === 'unread') return 'unread'
    if (r.state === 'ok') prTrack.set(sid, r.t)
    prLoaded.add(sid)
  }
  return prTrack.get(sid)
}

// One note into the folder of the session it is owed to; it gives the note's file name. `full`: the folder already holds PR_NOTES_MAX, so the note is
// dropped for good and logged; `failed`: it could not be written, and may be tried again.
async function notePut($: any, p: Paths, me: string, target: string, note: pw.Note): Promise<{ file: string } | 'full' | 'failed'> {
  try {
    if (!c.SID_RE.test(target) || !(await prDirs($, p, target))) throw new Error('dir')
    const dir = `${p.root}/prs/notes/${target}`
    const have = ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).filter((f) => pw.NOTE_FILE_RE.test(f.name)).length
    if (have >= pw.PR_NOTES_MAX) {
      await logq($, me, 'pr-note-dropped', 'full')
      return 'full'
    }
    const file = pw.noteFile(await $.clock.now(), ++mem.seq)
    if ('err' in (await writeIn($, `prs/notes/${target}`, file, pw.noteText(note)))) throw new Error('write')
    return { file }
  } catch {
    await logq($, me, 'pr-note-dropped', 'write')
    return 'failed'
  }
}
// A note from a lane session to its lead, within the lane's hourly share of the lead's folder.
async function leadPut($: any, p: Paths, me: string, lead: string, note: pw.Note): Promise<void> {
  const now = await $.clock.now()
  const times = prLeadNotes.get(me) ?? []
  if (!c.noticeAllowed(times, now, pw.PR_LEAD_NOTES_PER_HOUR)) {
    await logq($, me, 'pr-note-dropped', 'lead-cap')
    return
  }
  prLeadNotes.set(me, c.pushRecent(times, now))
  await notePut($, p, me, lead, note)
}

const failKey = (sid: string, ref: pw.PrRef): string => `${sid} ${pw.refKey(ref)}`
async function watchRow($: any, code: string, lane: string, ref: pw.PrRef): Promise<boolean> {
  return ledgerAdd($, { kind: 'pr-watch', code, lane, target: pw.refText(ref) }).catch(() => false)
}

// One round over the PRs of a tracker, with no lock held: the PRs whose tracking ran out, then one call per repo and what each PR's change tells. `gone`:
// the tracker is a lane's that has no live session, polled by its lead (me), which gets every note with the lane's name; else the tracker is this session's
// own, and its lead gets a copy of the notes a lead is told. A PR moves on (a new fingerprint, or its end) only once its notes are written or dropped as
// full: a note that could not be written leaves the PR as it was, for the next round, and the notes of that PR already written in this round are taken
// back, so the next round tells each once. It gives the PRs after the round and how each one that ended did.
async function prRound($: any, p: Paths, me: string, t: pw.Tracker, gone: boolean): Promise<{ prs: pw.Tracked[]; ended: Map<string, string> }> {
  const now = await $.clock.now()
  const lane = gone ? t.lane : undefined
  let prs = t.prs
  const ended = new Map<string, string>()
  const told = async (note: pw.Note): Promise<boolean> => (await notePut($, p, me, me, note)) !== 'failed'
  const end = async (pr: pw.Tracked, code: string) => {
    prs = prs.filter((x) => x !== pr)
    ended.set(pw.refKey(pr), code)
    prFails.delete(failKey(t.sid, pr))
    await watchRow($, code, t.lane, pr)
  }
  for (const pr of t.prs) if (pw.trackExpired(pr, now) && (await told(pw.endNote('expired', pr, now, lane)))) await end(pr, 'expired')
  const missed: pw.Tracked[] = []
  let answered = false
  let fail: string | undefined
  for (const g of pw.byRepo(prs)) {
    const all = await ghLook($, p, g.owner, g.repo, g.prs.map((x) => x.number))
    // The CLI fails a whole call when one PR of it is gone: the PRs are then asked one by one, so one PR never hides the others. A call that never ran (no
    // CLI, a spawn failure or a timeout) is not repeated.
    const single = 'fail' in all && (all.fail === 'exit' || all.fail === 'parse') && g.prs.length > 1
    for (const pr of g.prs) {
      const r = single ? await ghLook($, p, pr.owner, pr.repo, [pr.number]) : all
      if ('fail' in r) fail ??= r.fail
      else answered = true
      const look = 'looks' in r ? r.looks.get(pr.number) : undefined
      if (!look) {
        missed.push(pr)
        continue
      }
      prFails.delete(failKey(t.sid, pr))
      const next = pw.seenOf(look, pr.seen)
      const { notes, ended: over } = pw.notesOf(pr, pr.seen, next, now, lane)
      const put: string[] = []
      let written = true
      for (const n of notes) {
        const w = await notePut($, p, me, me, n)
        if (w === 'failed') {
          written = false
          break
        }
        if (w !== 'full') put.push(`${p.root}/prs/notes/${me}/${w.file}`)
      }
      if (!written) {
        if (put.length > 0) await rmF($, put).catch(() => undefined)
        continue
      }
      if (!gone && t.lead !== undefined && t.lead !== me) for (const n of notes) if (pw.LEAD_KINDS.includes(n.kind)) await leadPut($, p, me, t.lead, { ...n, lane: t.lane })
      if (over) await end(pr, next.state)
      else if (!pw.sameSeen(pr.seen, next)) prs = prs.map((x) => (x === pr ? { ...pr, seen: next } : x))
    }
  }
  // Logged once while the same failure lasts (the log drops a repeated error line).
  if (fail !== undefined) await logq($, me, 'error', `pr-look-${fail}`)
  // A round in which GitHub answered for nothing (no CLI, no login, no network) is held against no PR: only a PR that stays unanswered while GitHub answers
  // is given up, after PR_FAILS_MAX such rounds in a row.
  if (answered) {
    for (const pr of missed) {
      const key = failKey(t.sid, pr)
      const n = (prFails.get(key) ?? 0) + 1
      if (n < pw.PR_FAILS_MAX) prFails.set(key, n)
      else if (await told(pw.endNote('lost', pr, now, lane))) await end(pr, 'lost')
    }
  }
  return { prs, ended }
}

// The trackers of lanes that are gone and name this lead: polled here until they end. The lane is its tracker's writer while it lives, so this lead takes
// over only after PR_GONE_LOOKS looks in a row found no live session for it, and before it writes the tracker back it reads the registry and the file once
// more: a lane that is live again, or a file that is gone or no longer the text this round began from, makes it write nothing. When one of those two reads
// fails, or the write does, the round's result is kept (prHeld) and the next look starts from it, so its notes are not written a second time. A tracker
// nobody polls is removed a day after it was last written, and once an hour the note folders of sessions that are gone lose their day-old files.
async function orphanRound($: any, p: Paths, me: string) {
  const dir = `${p.root}/prs`
  const files = ((await $.fs.list(dir).catch(() => [])) as { name: string; mtimeMs?: number }[]).flatMap((f) => {
    const sid = pw.TRACKER_FILE_RE.exec(f.name)?.[1]
    return sid !== undefined && sid !== me ? [{ sid, mtimeMs: f.mtimeMs }] : []
  })
  for (const sid of [...prGone.keys(), ...prHeld.keys()]) {
    if (files.some((f) => f.sid === sid)) continue
    prGone.delete(sid)
    prHeld.delete(sid)
  }
  const now = await $.clock.now()
  const sweep = c.dueEvery(prGh.sweptAt, now, SWEEP_MS)
  if (files.length === 0 && !sweep) return
  const live = await registryEntries($)
  if (!live || !(await dirOk($, dir, p.uid))) return
  const sids = new Set(live.map((r) => r.j.sessionId))
  for (const f of files) {
    if (!sids.has(f.sid)) continue
    prGone.delete(f.sid)
    prHeld.delete(f.sid)
  }
  for (const f of files.filter((x) => !sids.has(x.sid)).slice(0, pw.PR_ORPHANS_MAX)) {
    const r = await trackerRead($, p, me, f.sid)
    if (r.state === 'unread') continue
    if (r.state === 'none' || r.t.lead !== me) {
      if (typeof f.mtimeMs === 'number' && now - f.mtimeMs > pw.PR_KEEP_MS) await rmF($, `${dir}/${f.sid}.json`)
      continue
    }
    const looks = (prGone.get(f.sid) ?? 0) + 1
    prGone.set(f.sid, Math.min(looks, pw.PR_GONE_LOOKS))
    if (looks < pw.PR_GONE_LOOKS) continue
    const held = prHeld.get(f.sid)
    const base = held !== undefined && held.text === r.text ? { ...r.t, prs: held.prs as pw.Tracked[] } : r.t
    if (base === r.t) prHeld.delete(f.sid)
    await prLock(f.sid, async () => {
      const next = await prRound($, p, me, base, true)
      if (next.prs === r.t.prs) return
      const again = await trackerRead($, p, me, f.sid)
      const liveNow = await registryEntries($)
      if (liveNow?.some((x) => x.j.sessionId === f.sid) || again.state === 'none' || (again.state === 'ok' && again.text !== r.text)) {
        prGone.delete(f.sid)
        prHeld.delete(f.sid)
        return logq($, me, 'pr-orphan-yield')
      }
      if (again.state === 'ok' && liveNow && (await trackerWrite($, p, { ...r.t, prs: next.prs }))) return void prHeld.delete(f.sid)
      prHeld.set(f.sid, { text: r.text, prs: next.prs })
      await logq($, me, 'error', 'pr-tracker-write')
    })
  }
  if (!sweep) return
  prGh.sweptAt = now
  const notes = `${dir}/notes`
  if (!(await dirOk($, notes, p.uid))) return
  const folders = ((await $.fs.list(notes).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name) && d.name !== me && !sids.has(d.name))
  for (const d of folders.slice(0, pw.PR_ORPHANS_MAX)) {
    if (!(await dirOk($, `${notes}/${d.name}`, p.uid))) continue
    const old = ((await $.fs.list(`${notes}/${d.name}`).catch(() => [])) as { name: string; mtimeMs?: number }[]).filter((f) => pw.NOTE_FILE_RE.test(f.name) && typeof f.mtimeMs === 'number' && now - f.mtimeMs > pw.PR_KEEP_MS)
    if (old.length > 0) await rmF($, old.map((f) => `${notes}/${d.name}/${f.name}`))
    // Removes the folder only once it is empty.
    await run($, [RMDIR, '--', `${notes}/${d.name}`]).catch(() => undefined)
  }
}

// Whether the poll is due: every PR_POLL_MS, for a session that tracks something (or has not read its tracker file yet in this load) and for a lead,
// which looks for the trackers of its gone lanes. A session with nothing tracked that is no lead runs nothing.
export async function prPollDue($: any, sid: string): Promise<boolean> {
  if (prBusy.has(sid) || !c.dueEvery(prPollAt.get(sid), await $.clock.now(), pw.PR_POLL_MS)) return false
  return !prLoaded.has(sid) || (prTrack.get(sid)?.prs.length ?? 0) > 0 || grants.get(sid)?.level === 'lead'
}
// The round runs on the tracker as it was when the round began, with no lock held, so a pr_watch call never waits for GitHub; its outcome is then put into
// the tracker as it is by then (pw.mergeRound), under the lock, and the file is written only when something changed.
export async function prPollTick($: any, sid: string) {
  prPollAt.set(sid, await $.clock.now())
  const p = await where($)
  if (!p) return
  const snap = await prLock(sid, () => ownTracker($, p, sid))
  if (snap !== 'unread' && snap !== undefined && snap.prs.length > 0) {
    // The lane's lead as its briefing knows it now; one known earlier is kept.
    const known = laneBrief.get(sid)?.lead?.sid
    const lead = known !== undefined && known !== sid ? known : snap.lead
    const round = await prRound($, p, sid, lead === snap.lead ? snap : { ...snap, lead }, false)
    await prLock(sid, async () => {
      const cur = prTrack.get(sid) ?? snap
      const prs = pw.mergeRound(snap.prs, round.prs, round.ended, cur.prs)
      const same = lead === cur.lead && prs.length === cur.prs.length && prs.every((x, i) => x === cur.prs[i])
      if (same) return
      const next: pw.Tracker = { ...cur, ...(lead !== undefined ? { lead } : {}), prs }
      prTrack.set(sid, next)
      if (!(await trackerWrite($, p, next))) await logq($, sid, 'error', 'pr-tracker-write')
    })
  }
  if (grants.get(sid)?.level === 'lead') await orphanRound($, p, sid)
}

// The notes owed to this session, read from its folder every PR_SPOOL_MS. A file that fails a check is removed; one already delivered whose removal failed
// is removed now and never read again. A folder that fails its own check is left alone, with nothing read from it.
async function spoolLoad($: any, sid: string) {
  const now = await $.clock.now()
  if (!c.dueEvery(prSpoolAt.get(sid), now, pw.PR_SPOOL_MS)) return
  prSpoolAt.set(sid, now)
  const p = await where($)
  if (!p) return
  const dir = `${p.root}/prs/notes/${sid}`
  const names = ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name).filter((n) => pw.NOTE_FILE_RE.test(n)).sort().slice(0, pw.PR_NOTES_MAX)
  if (names.length > 0 && !(await dirOk($, dir, p.uid))) {
    prPending.delete(sid)
    return logq($, sid, 'error', 'pr-notes-dir')
  }
  const done = prDelivered.get(sid)
  for (const n of [...(done ?? [])]) if (!names.includes(n)) done!.delete(n)
  const kept = new Map((prPending.get(sid) ?? []).map((o) => [o.file, o]))
  const out: Owed[] = []
  for (const name of names) {
    if (done?.has(name)) {
      await rmF($, `${dir}/${name}`)
      continue
    }
    const had = kept.get(name)
    if (had) {
      out.push(had)
      continue
    }
    const f = await readStoreFile($, `${dir}/${name}`, p.uid, pw.PR_NOTE_MAX).catch(() => undefined)
    if (!f || f.state === 'absent') continue
    const note = f.state === 'ok' ? pw.parseNote(f.text) : undefined
    if (!note) {
      await rmF($, `${dir}/${name}`)
      await logq($, sid, 'pr-note-dropped', 'invalid')
      continue
    }
    out.push({ file: name, note })
  }
  // A claim made while the files were read took its notes: they are not owed again.
  const taken = prDelivered.get(sid)
  prPending.set(sid, out.filter((o) => !taken?.has(o.file)))
}

// Takes every owed note at once, with nothing awaited: the tick's submit and the tool-result hook can never both send one.
function prClaim(sid: string): { text: string; owed: Owed[] } | undefined {
  const owed = prPending.get(sid) ?? []
  if (owed.length === 0) return undefined
  prPending.delete(sid)
  const done = prDelivered.get(sid) ?? new Set<string>()
  for (const o of owed) done.add(o.file)
  prDelivered.set(sid, done)
  return { text: pw.noticeText(owed.map((o) => o.note)), owed }
}
function prUnclaim(sid: string, owed: Owed[]) {
  for (const o of owed) prDelivered.get(sid)?.delete(o.file)
  prPending.set(sid, [...owed, ...(prPending.get(sid) ?? [])])
}
// After a delivery: the files go, and each note gets its ledger row. Neither can undo the delivery.
async function prDone($: any, sid: string, owed: Owed[]) {
  const p = await where($)
  if (p) await rmF($, owed.map((o) => `${p.root}/prs/notes/${sid}/${o.file}`))
  const tier = grants.get(sid)?.level ?? 'lane'
  for (const { note } of owed) {
    const target = pw.ownerOk(note.owner) && pw.repoOk(note.repo) && pw.numberOk(note.number) ? pw.refText({ owner: note.owner, repo: note.repo, number: note.number }) : undefined
    await ledgerAdd($, { kind: 'pr-notice', code: note.kind, tier, ...(note.lane !== undefined ? { lane: note.lane } : {}), ...(target !== undefined ? { target } : {}) }).catch(() => false)
  }
}

// The notice in the middle of a turn: after a main-agent tool call the owed notes are returned as additionalContext, beside the tool's result. It reads no
// file (the tick keeps the list), and a compaction that is armed or waiting to resume would take the text with it, so the notes then stay owed.
export async function prMidTurn($: any, e: any): Promise<string | undefined> {
  if (typeof e?.agent_id === 'string' && e.agent_id !== '') return undefined
  const sid = await $.session.id()
  if (typeof sid !== 'string' || !c.SID_RE.test(sid) || (prPending.get(sid)?.length ?? 0) === 0) return undefined
  let got: ReturnType<typeof prClaim>
  try {
    if ((await getRequest($)).value != null) return undefined
    got = prClaim(sid)
  } catch {
    await logq($, sid, 'error', 'pr-mid-turn')
    return undefined
  }
  if (!got) return undefined
  await prDone($, sid, got.owed).catch(() => undefined)
  await logq($, sid, 'pr-notice', 'mid-turn')
  return got.text
}

// The owed notes of a session that is not woken: logged once per cold stretch, and a lane's lead is told once that the lane has notes waiting.
async function prCold($: any, sid: string, from: number | undefined, n: number) {
  const key = from ?? -1
  if (prColdTold.get(sid) === key) return
  prColdTold.set(sid, key)
  await logq($, sid, 'pr-notice-held', 'cold')
  const lane = (await getLane($)).value as { name?: unknown } | null | undefined
  const lead = laneBrief.get(sid)?.lead?.sid ?? prTrack.get(sid)?.lead
  const p = await where($)
  if (!p || !lane || typeof lane.name !== 'string' || !c.NAME_RE.test(lane.name) || lead === undefined || lead === sid) return
  await leadPut($, p, sid, lead, pw.waitingNote(lane.name, Math.min(n, pw.PR_NOTES_MAX), await $.clock.now()))
}

// The tick's step: the owed notes go out as one turn of the mod's own when the session is a person's interactive one, idle with an empty prompt box, with no
// dialog, compaction request or nudge pending, nothing else submitted in this tick, and its prompt cache hot: at most
// KEEPALIVE_COLD_MS since its last turn ended or its last prompt, and that time known. A cold session is not woken (prCold): its notes wait for its next
// turn. At most PR_WAKES_PER_HOUR wakes an hour. The notes are claimed before the submit, so a slow submit sends them once; only a submit that threw gives
// them back. A rest does not hold them: it stops pings, and a PR notice is news the session asked for.
export async function prNoticeTick($: any, sid: string, submitsAtStart: number) {
  await spoolLoad($, sid)
  const n = prPending.get(sid)?.length ?? 0
  if (n === 0 || dialogUp(sid) || mem.submits !== submitsAtStart) return
  if ((await getRequest($)).value != null || (await getNudgeDue($)).value != null) return
  const now = await $.clock.now()
  const turnEnd = (await getTurnEnd($)).value
  const reg = regOnce($)
  if (!(await personRow($, sid, reg))) return
  // The last read: the registry row and the prompt box, as they are just before the submit.
  if ((await idleCheck($, sid, reg)) !== undefined) return
  const from = typeof turnEnd === 'number' ? Math.max(turnEnd, lastSubmitAt.get(sid) ?? 0) : undefined
  if (from === undefined || now - from > c.KEEPALIVE_COLD_MS) return prCold($, sid, from, n)
  const times = prWakes.get(sid) ?? []
  if (!c.noticeAllowed(times, now, pw.PR_WAKES_PER_HOUR)) {
    if (prCapLogged.has(sid)) return
    prCapLogged.add(sid)
    return log($, sid, 'notice-capped', 'pr')
  }
  // Every read is behind us: nothing is awaited between this guard and the claim.
  if (dialogUp(sid) || mem.submits !== submitsAtStart) return
  const got = prClaim(sid)
  if (!got) return
  prCapLogged.delete(sid)
  prWakes.set(sid, c.pushRecent(times, now))
  const sent = await withTimeout($, submitOwn($, got.text).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'failed') {
    prUnclaim(sid, got.owed)
    return log($, sid, 'pr-notice-failed')
  }
  await prDone($, sid, got.owed).catch(() => undefined)
  await log($, sid, 'pr-notice', sent === 'ok' ? 'idle' : 'unconfirmed')
}

// pr_watch { owner, repo, number }: a bound lane's main agent adds one PR to its tracker, or renews one. A new PR gets its first look here, which only
// records the starting point; a renewal keeps what was last seen and runs nothing.
export async function prWatchCall($: any, e: any, next: any) {
  const sid = await $.session.id()
  ensureTimer($)
  const deny = async (code: keyof typeof pw.WATCH_DENY) => {
    await logq($, sid, 'refused', `pr-watch-${code}`)
    return { deny: pw.WATCH_DENY[code] }
  }
  if ((e as { agentId?: string }).agentId !== undefined) return deny('subagent')
  const bound = (await getLane($)).value as { name?: unknown } | null | undefined
  const lane = bound && typeof bound.name === 'string' && c.NAME_RE.test(bound.name) ? bound.name : undefined
  if (lane === undefined || typeof sid !== 'string' || !c.SID_RE.test(sid)) return deny('not-lane')
  const ref = pw.parseWatchInput(e)
  if (!ref) return deny('input')
  const p = await where($)
  if (!p) return deny('write')
  if ((await ghBin($, p.uid)) === undefined) return deny('no-cli')
  return prLock(sid, async () => {
    const now = await $.clock.now()
    const t = await ownTracker($, p, sid)
    // A tracker file that could not be read is never replaced by a new one.
    if (t === 'unread') return deny('write')
    const lead = laneBrief.get(sid)?.lead?.sid ?? t?.lead
    const base: pw.Tracker = { v: 1, sid, lane, ...(lead !== undefined && lead !== sid ? { lead } : {}), prs: t?.prs ?? [] }
    const had = base.prs.find((x) => pw.sameRef(x, ref))
    let prs: pw.Tracked[]
    if (had) prs = base.prs.map((x) => (x === had ? { ...x, at: now } : x))
    else {
      if (base.prs.length >= pw.PR_MAX) return deny('full')
      const looks = prLooks.get(sid) ?? []
      if (!c.noticeAllowed(looks, now, pw.PR_LOOKS_PER_HOUR)) return deny('too-many')
      prLooks.set(sid, c.pushRecent(looks, now))
      const r = await ghLook($, p, ref.owner, ref.repo, [ref.number])
      const look = 'looks' in r ? r.looks.get(ref.number) : undefined
      if (!look) return deny('no-answer')
      if (look.state !== 'open') return { result: pw.watchEnded(ref, look.state) } as never
      prs = [...base.prs, { ...ref, at: now, seen: pw.seenOf(look) }]
      // The first look was the poll of this moment: the next one is a full interval away.
      if (base.prs.length === 0) prPollAt.set(sid, now)
    }
    const nextT = { ...base, prs }
    if (!(await trackerWrite($, p, nextT))) return deny('write')
    prTrack.set(sid, nextT)
    await watchRow($, had ? 'renew' : 'new', lane, had ?? ref)
    await logq($, sid, 'pr-watch', had ? 'renew' : 'new')
    return { result: pw.watchOk(had ?? ref, had !== undefined) } as never
  })
}
