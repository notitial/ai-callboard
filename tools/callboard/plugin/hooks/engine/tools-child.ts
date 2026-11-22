// The child tools: one cue path (rename, start, resume), one stop body (park, retire, terminate), create, open, unpark, adopt, list. Trust rules held here: every body re-checks at call time
// (the tools stay registered after `lead off`): the main agent only, a fresh reading of the machine, the lead capability or the manager; a lane is named by `lane` and a name more than one
// session carries is refused, never guessed; the core's gates (`verbPlan`, `mayCreate`, `mayAdopt`) decide, and a stop is decided again after the person's dialog and just before the signal;
// a force stop of a live lane always opens the person's dialog (a row no live session carries is removed with none); a reply that makes or takes a lane names its lead.
import type { Decision, LaneEffort, LaneModel, Row, Sid, StopVerb, View } from '../core/model.ts'
import { LANE_EFFORTS, LANE_MODELS, MAX_LIVE_CHILDREN, capRefusal, capability, keysNamed, liveChildren, liveness, mayActOn, mayAdopt, mayCreate, nameOf, parent, refusal } from '../core/model.ts'
import type { CueVerb } from '../core/model.ts'
import { NEW_KEY, reportPath, verbPlan } from '../core/lifecycle.ts'
import { remoteRefusal } from '../core/remote.ts'
import type { Verb } from '../core/lifecycle.ts'
import { cueReply } from '../core/lifecycle.ts'
import type { RefuseCode } from '../core/msg.ts'
import { T } from '../texts.ts'
import { lanesTable, stopDialog } from '../ui.ts'
import { laneRows } from './commands.ts'
import { sendCue, spool, spoolSend } from './cue.ts'
import { log, pause, personDialog, plainPath, run, windowNow, writeFile } from './io.ts'
import { setRemote } from './remote.ts'
import { getView, updateTable } from './store.ts'
import { signedNow } from './upkeep.ts'
import { deny, isSub, say } from './tools-any.ts'

const BRIEF_MAX = 16_384
const STOP_WAIT_S = 10

// ---- the gate and the target ----
type Ctx = { me: Sid; v: View }
async function gate($: any, e: any, tool: string): Promise<Ctx | { deny: string }> {
  const no = (code: RefuseCode) => deny(refusal('refuse', code, { tool, ...(code === 'bad-input' ? { detail: 'subagent' } : {}) }))
  if (isSub(e)) return no('bad-input')
  const me = (await $.session.id()) as Sid
  const v = await getView($, true)
  return v.rows === 'unknown' ? no('unknown-liveness') : capability(v, me) === 'none' ? no('no-capability') : { me, v }
}
// The one session of this name among the live ones and the table's rows.
function target(v: View, tool: string, lane: unknown): { key: Sid } | { deny: string } {
  const name = typeof lane === 'string' ? lane : ''
  const keys = keysNamed(v, name)
  return keys.length === 1 ? { key: keys[0]! } : deny(refusal('refuse', keys.length === 0 ? 'no-such-lane' : 'ambiguous', { tool, target: name }))
}
async function planOf($: any, verb: Verb, v: View, me: Sid, key: Sid, name?: string) {
  return verbPlan(verb, v, me, key, { signed: verb === 'retire' && (await signedNow($, key, v.table[key])), win: await windowNow($), now: await $.clock.now(), name })
}
async function gated($: any, e: any, tool: string) {
  const g = await gate($, e, tool)
  if ('deny' in g) return g
  const t = target(g.v, tool, e.lane)
  return 'deny' in t ? t : { ...g, key: t.key }
}

// ---- cue: rename, start, resume ----
export async function cueVerbCall($: any, e: any, _next: any, verb: CueVerb) {
  const tool = `lane_${verb}`
  const g = await gated($, e, tool)
  if ('deny' in g) return g
  const { me, v, key } = g
  const plan = await planOf($, verb, v, me, key, typeof e.name === 'string' ? e.name : undefined)
  if (plan.act !== 'cue') return deny(plan)
  const name = verb === 'rename' ? e.name : nameOf(v, key)
  if (verb === 'start' && v.table[key]?.brief === undefined) return deny(refusal('refuse', 'bad-input', { tool, target: name, detail: 'no-brief' }))
  const out = cueReply((await sendCue($, me, key, verb, name, await $.clock.now())) ?? { id: '', outcome: 'refused', code: 'no-answer' }, verb, nameOf(v, key))
  return out.act === 'done' ? { result: say(out) } : deny(out)
}

// ---- stop: park, retire, terminate ----
// The TERM signal, then the wait for the registry row to go.
async function signal($: any, pid: number, sid: Sid): Promise<'done' | 'alive' | 'failed'> {
  if (!Number.isInteger(pid) || pid < 2 || (await run($, ['/bin/kill', '-TERM', String(pid)])).exitCode !== 0) return 'failed'
  for (let i = 0; i < STOP_WAIT_S; i++) {
    await pause($, 1000)
    const r = (await getView($, true)).rows
    if (r !== 'unknown' && !r.has(sid)) return 'done'
  }
  return 'alive'
}
async function markParked($: any, key: Sid, on: boolean) {
  const now = await $.clock.now()
  return updateTable($, (t) => (t[key] === undefined ? t : { ...t, [key]: { ...t[key]!, parked: on ? now : undefined } }))
}
function dropRow($: any, key: Sid) {
  return updateTable($, (t) => (t[key]?.lead === undefined || t[key]!.lead!.minted ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== key)) : t))
}
export async function stopVerbCall($: any, e: any, _next: any, verb: StopVerb) {
  const tool = `lane_${verb}`
  const g = await gated($, e, tool)
  if ('deny' in g) return g
  const { me, key } = g
  let v = g.v
  let plan = await planOf($, verb, v, me, key)
  const name = nameOf(v, key)
  if (plan.act === 'refuse') return deny(plan)
  if (plan.dialog) {
    const a = await personDialog($, stopDialog(name))
    if (!('label' in a) || a.label !== T['dialog.yes']({})) {
      const why = 'no' in a ? a.no : undefined
      return deny(refusal('refuse', why === 'unattended' ? 'unattended' : why === 'busy' ? 'dialog-open' : 'stop-declined', { tool, target: name }))
    }
    v = await getView($, true)
    plan = await planOf($, verb, v, me, key)
  }
  if (plan.act !== 'stop' && plan.act !== 'remove') return deny(plan)
  const reg = plan.act === 'stop' && v.rows !== 'unknown' ? v.rows.get(key) : undefined
  if (verb === 'park' && reg !== undefined && (v.table[key] === undefined || !(await markParked($, key, true)))) return deny(refusal('refuse', v.table[key] === undefined ? 'no-such-lane' : 'table-unwritten', { tool, target: name }))
  const outcome = reg === undefined ? 'done' : await signal($, reg.pid, key)
  if (outcome === 'failed') {
    if (verb === 'park') await markParked($, key, false)
    return deny(refusal('refuse', 'signal-failed', { tool, target: name }))
  }
  if (reg !== undefined) await spoolSend($, { op: 'close', sid: key, pid: reg.pid, name, folder: reg.folder })
  if (outcome === 'done' && verb !== 'park' && !(await dropRow($, key))) return deny(refusal('refuse', 'table-unwritten', { tool, target: name }))
  return { result: say({ msg: 'lane.stopped', p: { verb, name, outcome, ...(reg === undefined ? {} : { pid: reg.pid }) } }) }
}

// ---- open and unpark: a panel for a lane that has none ----
// An unbound row opens a new panel; a row with no live session reopens its conversation. A parked row goes by the core's own plan.
function openPlan(v: View, me: Sid, key: Sid, tool: string): Decision<'reopen' | 'refuse'> {
  const row = v.table[key]
  const no = (code: RefuseCode) => refusal('refuse', code, { tool, target: nameOf(v, key) })
  const l = key.startsWith(NEW_KEY) ? 'no' : liveness(v, key)
  const bad = row === undefined ? 'no-such-lane' : row.off ? 'is-off' : !mayActOn(v, me, key) ? 'not-a-parent' : l === 'unknown' ? 'unknown-liveness' : l === 'yes' ? 'has-live-session' : capRefusal(v, parent(v, key))
  return bad === undefined ? { act: 'reopen', msg: 'lane.opened', p: { name: nameOf(v, key), sid: key } } : no(bad)
}
// The row moves to the session the window answered with; a session that already has a row is never overwritten, and a failed write is tried once more.
async function bind($: any, key: Sid, sid: Sid): Promise<boolean> {
  let clash = false
  for (let i = 0; i < 2 && !clash; i++) {
    const done = await updateTable($, (t) => (t[key] === undefined || (sid !== key && (clash = t[sid] !== undefined)) ? t : { ...Object.fromEntries(Object.entries(t).filter(([k]) => k !== key)), [sid]: { ...t[key]!, parked: undefined } }))
    if (done) return !clash
  }
  return false
}
async function bringUp($: any, e: any, tool: 'lane_open' | 'lane_unpark') {
  const g = await gated($, e, tool)
  if ('deny' in g) return g
  const { me, v, key } = g
  const row = v.table[key]
  const plan = tool === 'lane_unpark' || row?.parked !== undefined ? await planOf($, 'unpark', v, me, key) : openPlan(v, me, key, tool)
  if (plan.act !== 'reopen') return deny(plan)
  const name = nameOf(v, key)
  const fresh = key.startsWith(NEW_KEY)
  const r = await spool($, fresh ? { op: 'open', folder: row!.folder } : { op: 'reopen', sid: key, folder: row!.folder }, me)
  if (r?.ok === false) return deny(refusal('refuse', 'window-refused', { tool, target: name, detail: r.code }))
  const sid = r?.ok !== true ? undefined : fresh ? r.sid : r.sid === undefined || r.sid === key ? key : undefined
  if (sid === undefined) return { deny: say({ msg: 'lane.notOpened', p: { name } }) }
  return !(await bind($, key, sid)) ? deny(refusal('refuse', 'table-unwritten', { tool, target: name, detail: sid })) : { result: say({ msg: tool === 'lane_open' ? 'lane.opened' : 'lane.unparked', p: { name, sid } }) }
}
export async function laneOpenCall($: any, e: any, _next: any) {
  return bringUp($, e, 'lane_open')
}
export async function laneUnparkCall($: any, e: any, _next: any) {
  return bringUp($, e, 'lane_unpark')
}

// ---- create, adopt, list ----
async function real($: any, p: string): Promise<string | undefined> {
  const r = p.startsWith('/') ? await run($, ['/bin/realpath', '--', p]).catch(() => undefined) : undefined
  return r?.exitCode === 0 && r.stdout.trim().startsWith('/') ? r.stdout.trim() : undefined
}
export async function laneCreateCall($: any, e: any, _next: any) {
  const tool = 'lane_create'
  const g = await gate($, e, tool)
  if ('deny' in g) return g
  const { me, v } = g
  const [name, text, want] = [e.name, e.brief, e.folder].map((x) => (typeof x === 'string' ? x : ''))
  const bad = (detail: string) => deny(refusal('refuse', 'bad-input', { tool, target: name, detail }))
  if (text.length < 1 || text.length > BRIEF_MAX) return bad('brief')
  const model = (e.model ?? 'sonnet') as LaneModel
  if (!LANE_MODELS.includes(model)) return bad('model')
  const effort = e.effort as LaneEffort | undefined
  if (effort !== undefined && !LANE_EFFORTS.includes(effort)) return bad('effort')
  const role = e.role ?? 'lane'
  if (role !== 'lane' && role !== 'lead') return bad('role')
  const folder = await real($, want)
  if (folder === undefined) return bad('folder')
  const no = mayCreate(v, me, name, folder, role)
  if (no !== undefined) return deny(refusal('refuse', no, { tool, target: name }))
  const pending = Object.entries(v.table).filter(([k, r]) => k.startsWith(NEW_KEY) && r.under === me).length
  if (liveChildren(v, me) + pending >= MAX_LIVE_CHILDREN) return deny(refusal('refuse', 'cap', { tool, target: name }))
  const [dir, key] = [`${folder}/.archive/${name}`, `${NEW_KEY}${name}`]
  const brief = `${dir}/BRIEF.md`
  let taken = false
  const row: Row = { name, folder, report: reportPath(folder, name), under: me, brief, model, ...(effort === undefined ? {} : { effort }), ...(role === 'lead' ? { lead: { repos: [], minted: true as const } } : {}) }
  const written = await updateTable($, (t) => ((taken = Object.values(t).some((r) => r.name === name || r.brief === brief || r.report === row.report)) ? t : { ...t, [key]: row }))
  if (taken || !written) return deny(refusal('refuse', taken ? 'name-taken' : 'table-unwritten', { tool, target: name }))
  const linked = !(await plainPath($, `${folder}/.archive`)) || !(await plainPath($, dir))
  const why = linked ? 'link' : !(await writeFile($, brief, T['lane.brief']({ name, lead: nameOf(v, me), text }))) ? 'unwritten' : undefined
  if (why !== undefined) {
    await dropRow($, key)
    return bad(why)
  }
  await log($, me, role === 'lead' ? 'lead-created' : 'lane-created', name)
  return { result: say({ msg: 'lane.created', p: { name, folder, lead: nameOf(v, me), ...(role === 'lead' ? { role } : {}) } }) }
}
export async function laneAdoptCall($: any, e: any, _next: any) {
  const tool = 'lane_adopt'
  const g = await gate($, e, tool)
  if ('deny' in g) return g
  const { me, v } = g
  const name = typeof e.name === 'string' ? e.name : ''
  const a = mayAdopt(v, me, name)
  if ('no' in a) return deny(refusal('refuse', a.no, { tool, target: name }))
  const folder = v.rows === 'unknown' ? '' : v.rows.get(a.ok)!.folder
  const before = v.table[a.ok]?.under
  const written = await updateTable($, (t) => {
    const r = t[a.ok]
    return r?.under !== before || r?.off || r?.lead !== undefined ? t : { ...t, [a.ok]: { ...r, name, folder, report: r?.report ?? reportPath(folder, name), under: me } }
  })
  if (!written || (await getView($, true)).table[a.ok]?.under !== me) return deny(refusal('refuse', 'not-loose', { tool, target: name }))
  await log($, me, 'lane-adopted', name)
  return { result: say({ msg: 'lane.adopted', p: { name, lead: nameOf(v, me) } }) }
}
// A lead's wish for one of its own lanes (the manager's for any lane under it): the row's `remote`, which the lane's own tick makes its panel match.
export async function laneRemoteCall($: any, e: any, _next: any) {
  const tool = 'lane_remote'
  const g = await gated($, e, tool)
  if ('deny' in g) return g
  const { me, v, key } = g
  const name = nameOf(v, key)
  if (typeof e.on !== 'boolean') return deny(refusal('refuse', 'bad-input', { tool, target: name, detail: 'on' }))
  const no = !mayActOn(v, me, key) ? 'not-a-parent' : remoteRefusal(v, key)
  if (no !== undefined) return deny(refusal('refuse', no, { tool, target: name }))
  if (!(await setRemote($, key, e.on))) return deny(refusal('refuse', 'table-unwritten', { tool, target: name }))
  await log($, me, 'lane-remote', `${name}:${e.on ? 'on' : 'off'}`)
  return { result: say({ msg: 'lane.remote', p: { name, on: e.on } }) }
}
export async function laneListCall($: any, e: any, _next: any) {
  const g = await gate($, e, 'lane_list')
  return 'deny' in g ? g : { result: lanesTable(await laneRows($, g.v, g.me)) }
}
