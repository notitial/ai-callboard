// The two files a parent and a child talk through (a cue to the child's own process, and the window's spool), and the child's side of a cue. Trust rules held here: a cue is acted on
// only when its sender is above the child now and it is fresh (`cueAnswer`), and is taken off the disk before it is acted on, so a failed act is never repeated; a busy child answers `held` and leaves the cue for its sender to take away; a doubtful
// registry read does nothing; the brief a `start` points at is the child's own row's, never the cue's; every file name is built from an id this file checks first.
// The spool: `open/<id>.req` is written as a dot-file and renamed, with a fresh random id, and the folder is named exactly as the lane's row holds it; the window that serves it answers
// `open/<id>.result` within its own 20 s, so the writer waits one budget (SPOOL_WAIT_S) and, with no answer, takes its own request back so a window that wakes later opens nothing.
// A `pick` is the one request that waits for the person: once a window has taken it, the window shows its tick list for up to 80 s and the writer waits PICK_WAIT_S; the answer's folders are checked here (absolute, plain, at most 32) before the caller resolves them.
// Bounds that hold for the same user (ADR 0002): the window opens only a folder of its own workspace, drops a request older than 60 s, reads plain files up to 40 000 bytes and takes one
// request at a time (a tick list is shown beside that); the plugin checks capability, allowlist, name and the cap of live children before it writes. No rate limit and no lane store are checked beyond that.
import type { Cue, CueResult, CueVerb, Sid, SpoolReply, SpoolRequest, View } from '../core/model.ts'
import { givenName, nameOf, nameRefusal } from '../core/model.ts'
import { CONDUCTOR_REPOS_MAX, CUE_WAIT_S, SPOOL_WAIT_S, cueAnswer, parseCue, parseResult } from '../core/lifecycle.ts'
import { T } from '../texts.ts'
import { ensureDir, log, path, pause, readText, rm, run, submitOwn, writeFile } from './io.ts'
import { mem } from './mem.ts'
import { idle } from './upkeep.ts'
import { getView, safeJson } from './store.ts'

const ID_RE = /^[a-z0-9]{8,40}$/
const rid = (): string => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 20)
const json = (t: string | undefined): unknown => (t === undefined ? undefined : safeJson(t))

// ---- the parent's side of a cue: write it, wait for the child's answer, take both files away. undefined: no answer in time ----
export async function sendCue($: any, from: Sid, child: Sid, verb: CueVerb, name: string, now: number): Promise<CueResult | undefined> {
  const id = rid()
  const [cp, rp] = [await path($, 'cue', `${child}.json`), await path($, 'result', `${id}.json`)]
  if (cp === undefined || rp === undefined || !(await writeFile($, cp, JSON.stringify({ id, verb, from, at: now, name } satisfies Cue)))) return undefined
  let r: CueResult | undefined
  for (let i = 0; i < CUE_WAIT_S && r === undefined && (await pause($, 1000)); i++) r = parseResult(json(await readText($, rp, 512)))
  await rm($, [cp, rp])
  return r
}

// ---- the child's side, every tick ----
// A slash command run in this session, bounded so a cue's answer still comes inside the parent's wait.
export function ran($: any, command: string, args: string, ms: number): Promise<boolean> {
  return Promise.race([Promise.resolve($.command.run({ command, args })).then(() => true, () => false), $.clock.sleep(ms).then(() => false)])
}
// /model can report a model it could not switch to without failing: the session's model, read back within 5 s, must name the alias ("claude-haiku-5-5").
export async function modelHeld($: any, alias: string): Promise<boolean> {
  return String(await Promise.race([Promise.resolve().then(() => $.session.model()), $.clock.sleep(5_000)]).catch(() => '')).toLowerCase().includes(alias)
}
// A lane whose panel still carries a name Claude generated takes its row's name at its first quiet tick, so it is named before lane_start. Once per process.
async function selfName($: any, me: Sid, v: View): Promise<void> {
  const own = v.rows === 'unknown' ? undefined : v.rows.get(me)
  const row = v.table[me]
  if (mem.selfNamed || row?.brief === undefined || own === undefined || givenName(own) !== undefined || own.name === row.name || nameRefusal(v, row.name, me) !== undefined || !(await idle($, me))) return
  mem.selfNamed = true
  await ran($, 'rename', row.name, 10_000)
}
// What the cue asks of this session: rename it, start it on its own row's brief (naming it first when its name differs, and on its row's model and effort), or resume it.
async function act($: any, me: Sid, v: View, cue: Cue): Promise<CueResult> {
  const refused = (code: string): CueResult => ({ id: cue.id, outcome: 'refused', code })
  const row = v.table[me]
  const own = v.rows === 'unknown' ? undefined : v.rows.get(me)
  if (cue.verb === 'resume') return (await submitOwn($, T['cue.resume']({ name: nameOf(v, me) })).then(() => true, () => false)) ? { id: cue.id, outcome: 'ok' } : refused('failed')
  const name = cue.name ?? ''
  if (nameRefusal(v, name, me) !== undefined) return refused('name')
  const brief = row?.brief
  if (cue.verb === 'start' && (brief === undefined || !brief.startsWith(`${row!.folder}/.archive/`) || brief.includes('..'))) return refused('no-brief')
  if (own?.name !== name && !(await ran($, 'rename', name, 10_000))) return refused('rename-failed')
  for (const k of ['model', 'effort'] as const) if (cue.verb === 'start' && row![k] !== undefined && !(await ran($, k, row![k]!, 5_000))) return refused(`${k}-failed`)
  if (cue.verb === 'start' && row!.model !== undefined && !(await modelHeld($, row!.model))) return refused('model-failed')
  if (cue.verb === 'start' && !(await submitOwn($, T['cue.start']({ name, brief: brief!, parent: nameOf(v, cue.from) })).then(() => true, () => false))) return refused('failed')
  return { id: cue.id, outcome: 'ok' }
}
export async function cueTick($: any, me: Sid, v: View, now: number): Promise<void> {
  if (v.rows === 'unknown') return
  const p = await path($, 'cue', `${me}.json`)
  // The self-rename runs only in a tick with no cue, so a cue's answer still comes inside the parent's wait; a start renames the lane itself.
  if (p === undefined || !(await $.fs.exists(p).catch(() => false))) return selfName($, me, v)
  const cue = parseCue(json(await readText($, p, 2048)))
  if (cue === undefined || !ID_RE.test(cue.id)) return void (await rm($, [p]))
  const fresh = await getView($, true)
  const answer = cueAnswer(fresh, me, cue, !(await idle($, me)), now)
  if (answer.outcome !== 'held') await rm($, [p])
  const result = answer.outcome === 'ok' ? await act($, me, fresh, cue) : answer
  const rp = await path($, 'result', `${cue.id}.json`)
  if (rp !== undefined) await writeFile($, rp, JSON.stringify(result))
  if (result.outcome !== 'held') await log($, me, 'cue', `${cue.verb}:${result.outcome}`)
}

// ---- the window's spool ----
const isSid = (x: unknown): x is Sid => typeof x === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(x)
// A picked folder is an absolute path with no control character, as a typed one is (core/commands.ts).
const isFolder = (x: unknown): x is string => typeof x === 'string' && x.length <= 1024 && /^\/[^\u0000-\u001f\u007f-\u009f]*$/.test(x)
function parseReply(raw: unknown): SpoolReply | undefined {
  const r = (raw ?? {}) as { ok?: unknown; sid?: unknown; code?: unknown; folders?: unknown }
  if (r.ok === true && r.folders !== undefined) return r.sid === undefined && Array.isArray(r.folders) && r.folders.length <= CONDUCTOR_REPOS_MAX && r.folders.every(isFolder) ? { ok: true, folders: r.folders } : undefined
  if (r.ok === true) return isSid(r.sid) ? { ok: true, sid: r.sid } : r.sid === undefined ? { ok: true } : undefined
  return r.ok === false && typeof r.code === 'string' && /^[a-z-]{1,24}$/.test(r.code) ? { ok: false, code: r.code } : undefined
}
// Writes one request and returns its id, or undefined when it could not be put in place.
export async function spoolSend($: any, req: SpoolRequest): Promise<string | undefined> {
  const dir = await path($, 'open')
  if (dir === undefined) return undefined
  const id = rid()
  const tmp = `${dir}/.${id}.tmp`
  try {
    await ensureDir($, dir)
    await $.fs.write(tmp, JSON.stringify(req))
    await run($, ['/bin/chmod', '600', tmp])
    if ((await run($, ['/bin/mv', '-f', '--', tmp, `${dir}/${id}.req`])).exitCode === 0) return id
  } catch {}
  await rm($, [tmp])
  return undefined
}
// A request and its answer. undefined: nothing came in SPOOL_WAIT_S seconds, and the request is taken back. An answer that is there and is not one is `bad-answer`
// at once. A pick waits for the person's click, so its caller gives `afterClaimS`: once a window has taken the request (its file is gone), the wait runs that many
// seconds from then; a request no window takes still ends at SPOOL_WAIT_S.
export async function spool($: any, req: SpoolRequest, who: Sid, afterClaimS?: number): Promise<SpoolReply | undefined> {
  const id = await spoolSend($, req)
  const dir = await path($, 'open')
  if (id === undefined || dir === undefined) return undefined
  let a: SpoolReply | undefined
  let claimed: number | undefined
  for (let i = 0; a === undefined && i < (claimed === undefined || afterClaimS === undefined ? SPOOL_WAIT_S : claimed + afterClaimS); i++) {
    const t = await readText($, `${dir}/${id}.result`, 40_000)
    if (t !== undefined) a = parseReply(json(t)) ?? { ok: false, code: 'bad-answer' }
    if (a === undefined && afterClaimS !== undefined && claimed === undefined && !(await $.fs.exists(`${dir}/${id}.req`).catch(() => true))) claimed = i
    if (a === undefined && !(await pause($, 1000))) break
  }
  await rm($, [`${dir}/${id}.req`, `${dir}/${id}.result`])
  await log($, who, 'spool', a === undefined ? 'no-answer' : a.ok ? req.op : a.code)
  return a
}
