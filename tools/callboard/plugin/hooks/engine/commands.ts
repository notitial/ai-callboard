// `/callboard`, `/rest`, `/unattended`, the typeahead and the prompt composer. Trust rules held here: the one origin check is planCommand's, fed by originOf, and only his typed turn passes
// it for a form that widens what a session may do (lead, conductor, off, on, go, go off, unattended on and off, config changes, remote); a write that does not land is said, never reported as done; a path a
// lead is given is resolved to its real path; the table is written under its lock.
import type { Row, Sid, View } from '../core/model.ts'
import { PERSON, capability, children, descendants, isConductor, isMinted, isOff, keysNamed, nameOf, parent, refusal } from '../core/model.ts'
import type { Cmd, Origin } from '../core/commands.ts'
import { configNext, parsePreset, planCommand } from '../core/commands.ts'
import { GO_HOURS, covers } from '../core/go.ts'
import { dropHandover, groupOf, recordHandover } from '../core/handover.ts'
import { CONDUCTOR_REPOS_MAX, PICK_WAIT_S, childState } from '../core/lifecycle.ts'
import type { StatusRow } from '../core/msg.ts'
import { isLane, remoteRefusal, remoteWish } from '../core/remote.ts'
import { T } from '../texts.ts'
import type { LaneRow } from '../ui.ts'
import { RULES_CAP, lanesTable, printed, stamp, statusPage } from '../ui.ts'
import { spool, spoolSend } from './cue.ts'
import { home, locked, newId, readText, run, windowNow } from './io.ts'
import { mem } from './mem.ts'
import { setRemote } from './remote.ts'
import { cfgNow, conductorRepos, getView, listGoes, readRules, rmGo, saveConductorRepos, updateHandovers, updateTable, writeConfig, writeGo, writeWindow } from './store.ts'
import { restSet, say } from './tools-any.ts'
import { giveParentTools } from './tick.ts'
import { usageRead } from './usage.ts'

const TYPED_ORIGINS = ['composer', 'bridge']
// The forms whose saved change owes the session a notice turn. Off is not among them: an off session is sent nothing.
const CHANGES: string[] = ['lead', 'lead-off', 'conductor', 'on', 'go', 'go-off', 'unattended']
// The window's own reasons for a tick list that picked nothing; each has its text (texts.ts), any other code is the bare failure.
const PICK_CODES = ['cancelled', 'timeout', 'no-folders', 'too-many', 'busy']
// A command is typed when the engine stamped its origin as one of his own typed turns; any other origin, or none, is not.
export const originOf = (e: any): Origin => (TYPED_ORIGINS.includes(e?.origin?.kind) ? 'typed' : 'other')
const person = (v: View, s: Sid | 'unknown' | null): string | null => (s === null ? null : s === 'unknown' ? 'unknown' : s === PERSON ? PERSON : nameOf(v, s))
const statusRole = (v: View, s: Sid): 'manager' | 'lead' | 'conductor' | 'lane' | 'session' => {
  const c = capability(v, s)
  const p = parent(v, s)
  return c === 'manager' ? 'manager' : c === 'lead' ? (isConductor(v, s) ? 'conductor' : 'lead') : p !== PERSON && p !== 'unknown' && capability(v, p) === 'lead' ? 'lane' : 'session'
}
const helpRow = (k: string): string => (T as Record<string, (p: unknown) => string>)[k]!({})
const help = (): string => [T['help.head']({}), ...Object.keys(T).filter((k) => k.startsWith('help.') && k !== 'help.head').map((k) => helpRow(k))].join('\n')

// ---- the lane list: this session's children, or everything under the manager or a conductor; the usage figures are the files' ----
export async function laneRows($: any, v: View, me: Sid): Promise<LaneRow[]> {
  const now = await $.clock.now()
  const under = capability(v, me) === 'manager' || isConductor(v, me) ? descendants(v, me) : children(v, me)
  return Promise.all(
    under.map(async (k) => {
      const u = await usageRead($, k, now)
      const reg = v.rows === 'unknown' ? undefined : v.rows.get(k)
      const folder = reg?.folder ?? v.table[k]?.folder ?? ''
      // A lead its folder's preset named reads as the preset's command.
      const preset = capability(v, k) === 'lead' && !isConductor(v, k) && folder !== '' ? parsePreset(await readText($, `${folder}/.claude/callboard-lead.json`, 2048)) : undefined
      return { sid: k, name: nameOf(v, k), role: isConductor(v, k) ? 'conductor' : capability(v, k), ...(preset?.name === nameOf(v, k) ? { label: preset.command } : {}), state: childState(v, k, mem.signed.set.has(k), now), parentSid: parent(v, k) === 'unknown' ? null : parent(v, k), folder, context: u?.tokens, fiveHour: u?.fiveHour, sevenDay: u?.sevenDay, cost: u?.cost, readAgeMin: u === undefined ? undefined : (now - u.at) / 60_000 }
    }),
  )
}

// This session's real folder and the real paths of what it was given (`~` is the person's home); undefined when one does not resolve.
// At most `max` paths are taken: 16 typed ones, or the saved list's own limit for the window's tick list.
export async function realPaths($: any, paths: string[], max = 16): Promise<string[] | undefined> {
  const h = await home($)
  const folder = (await $.session.root().catch(() => undefined)) as string | undefined
  const out: string[] = []
  for (const p of folder === undefined || h === undefined ? [] : [folder, ...paths].slice(0, max + 1)) {
    const r = await run($, ['/bin/realpath', '--', p.startsWith('~/') ? `${h}${p.slice(1)}` : p]).catch(() => undefined)
    const real = r?.stdout.trim()
    if (r?.exitCode !== 0 || real === undefined || !real.startsWith('/')) return undefined
    if (!out.includes(real)) out.push(real)
  }
  return out.length > 0 ? out : undefined
}
function setRow($: any, v: View, me: Sid, folder: string, f: (r: Row) => Row): Promise<boolean> {
  return updateTable($, (t) => ({ ...t, [me]: f(t[me] ?? { name: nameOf(v, me), folder }) }))
}

export async function perform($: any, cmd: Cmd, me: Sid, v: View, now: number, savedOk: () => void): Promise<string> {
  const fail = (detail: string) => say(refusal('refuse', 'bad-input', { tool: 'callboard', target: cmd.op, detail }))
  const saved = (ok: boolean, text: string, what: string) => (ok ? (savedOk(), text) : say(refusal('refuse', 'not-saved', { tool: 'callboard', target: cmd.op, detail: what })))
  const folder = v.rows === 'unknown' ? undefined : v.rows.get(me)?.folder
  const w = await windowNow($)
  switch (cmd.op) {
    case 'status': {
      const goes = (await listGoes($)).filter((g) => covers(g, me, v, now)).length
      const rows: StatusRow[] = [{ field: 'role', value: statusRole(v, me) }, { field: 'parent', value: person(v, parent(v, me)) }, { field: 'manager', value: person(v, v.manager) }, { field: 'off', value: isOff(v, me) }, { field: 'keepalive', value: (await cfgNow($)).keepalive }, { field: 'unattended', value: w.state === 'on' ? Math.max(1, Math.ceil((w.window.end - now) / 60_000)) : null }, { field: 'goes', value: goes }, ...(mem.taken.size === 0 ? [] : [{ field: 'taken' as const, value: [...mem.taken] }])]
      // A lane that gave up on its Remote Control wish says so; a wish changed since is not the one it gave up on.
      if (mem.remote?.stopped !== undefined && isLane(v, me) && mem.remote.wish === remoteWish(v.table[me]!).on) rows.push({ field: 'remote', value: { on: mem.remote.wish, code: mem.remote.stopped } })
      return statusPage(rows)
    }
    case 'lanes': return lanesTable(await laneRows($, v, me))
    case 'help': return help()
    case 'remote': {
      const keys = keysNamed(v, cmd.name)
      const no = keys.length !== 1 ? (keys.length === 0 ? 'no-such-lane' : 'ambiguous') : remoteRefusal(v, keys[0]!)
      if (no !== undefined) return say(refusal('refuse', no, { tool: 'callboard', target: cmd.name }))
      return saved(await setRemote($, keys[0]!, cmd.on), T['cmd.remote']({ name: cmd.name, on: cmd.on }), 'lane')
    }
    case 'rest': return saved(await restSet($, me, 'command'), T['cmd.rest']({}), 'rest')
    case 'lead': {
      const [own, ...repos] = (await realPaths($, cmd.paths)) ?? []
      if (own === undefined) return fail('path')
      const ok = await setRow($, v, me, own, (r) => ({ ...r, folder: own, lead: { repos: [...new Set([...(r.lead?.repos ?? []), ...repos])] } }))
      if (ok) await giveParentTools($, await getView($, true), me)
      return saved(ok, T['cmd.lead']({ repos }), 'lane')
    }
    case 'conductor': {
      const [own, ...typed] = (await realPaths($, cmd.paths)) ?? []
      if (own === undefined) return fail('path')
      // Only the saved list goes: this session's role and repos stay until `lead off`, and it owes no notice turn.
      if (cmd.reset === true) return (await saveConductorRepos($, own, [])) ? T['cmd.conductorReset']({}) : say(refusal('refuse', 'not-saved', { tool: 'callboard', target: cmd.op, detail: 'repos' }))
      // Paths typed now replace the list saved for this folder; none typed reuses it.
      if (cmd.paths.length > 0 && typed.length === 0) return fail('own-folder')
      const kept = await conductorRepos($, own)
      let chosen = typed
      // `pick`, or nothing typed and nothing saved: the window that holds this folder shows its tick list, and what he ticks there is taken as if he had typed it.
      if (cmd.pick === true || (typed.length === 0 && kept.length === 0)) {
        const root = (await $.session.root().catch(() => undefined)) as string | undefined
        const a = root === undefined ? undefined : await spool($, { op: 'pick', folder: root, ticked: kept }, me, PICK_WAIT_S)
        if (a === undefined) return fail('pick-no-window')
        if (!a.ok) return fail(PICK_CODES.includes(a.code) ? `pick-${a.code}` : 'pick-failed')
        const real = await realPaths($, a.folders ?? [], CONDUCTOR_REPOS_MAX)
        if (real === undefined) return fail('path')
        chosen = real.slice(1)
        if (chosen.length === 0) return fail('pick-failed')
      }
      const repos = chosen.length > 0 ? chosen : kept
      if (chosen.length > 0 && !(await saveConductorRepos($, own, chosen))) return saved(false, '', 'repos')
      const ok = await setRow($, v, me, own, (r) => ({ ...r, folder: own, lead: { repos, conductor: true } }))
      if (ok) await giveParentTools($, await getView($, true), me)
      return saved(ok, T['cmd.conductor']({ repos }), chosen.length > 0 ? 'repos-row' : 'lane')
    }
    case 'handover':
      if (isOff(v, me)) return say(refusal('refuse', 'is-off', { tool: 'callboard', target: 'handover' }))
      mem.owed.push(T['cmd.handover']({}))
      return T['cmd.handover']({})
    // The person's own typed step. The record that makes the panels extension archive the session once its process is gone goes first, then the row, then the panel's close and the
    // session's own stop; a write that does not land is said and undone, so nothing is left half-done. A session with a row under it, live or parked, is refused.
    case 'archive': {
      const own = v.rows === 'unknown' ? undefined : v.rows.get(me)
      if (own === undefined || !Number.isInteger(own.pid) || own.pid < 2) return say(refusal('refuse', 'unknown-liveness', { tool: 'callboard', target: cmd.op }))
      const group = groupOf(v, me)
      const kids = children(v, me).map((k) => nameOf(v, k))
      const no = group === undefined ? 'archive-tier' : kids.length > 0 ? 'archive-children' : !own.name ? 'archive-name' : undefined
      if (group === undefined || !own.name || no !== undefined) return say(refusal('refuse', 'bad-input', { tool: 'callboard', target: kids.length > 8 ? `${kids.slice(0, 8).join(', ')} and ${kids.length - 8} more` : kids.join(', '), detail: no }))
      const base = nameOf(v, me)
      if (!(await updateHandovers($, (h) => recordHandover(h, base, h[base]?.n ?? 0, { sid: me, group, folder: own.folder, at: now, archive: true })))) return say(refusal('refuse', 'not-saved', { tool: 'callboard', target: cmd.op, detail: 'archive' }))
      if (!(await updateTable($, (t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== me))))) {
        await updateHandovers($, (h) => dropHandover(h, me))
        return say(refusal('refuse', 'not-saved', { tool: 'callboard', target: cmd.op, detail: 'lane' }))
      }
      await spoolSend($, { op: 'close', sid: me, pid: own.pid, name: own.name, folder: own.folder })
      // The session ends itself: no wait for its row to go, which a stop of its own process cannot see.
      return T['cmd.archive']({ ok: (await run($, ['/bin/kill', '-TERM', String(own.pid)])).exitCode === 0 })
    }
    case 'lead-off': return saved(await setRow($, v, me, folder ?? '', ({ lead: _, ...r }) => r), T['cmd.leadOff']({}), 'lane')
    case 'off': return saved(await setRow($, v, me, folder ?? '', (r) => ({ ...r, off: true })), T['cmd.off']({}), 'lane')
    case 'on': return saved(await setRow($, v, me, folder ?? '', ({ off: _, ...r }) => r), T['cmd.on']({}), 'lane')
    case 'go': {
      const g = { id: newId(), giver: me, text: cmd.text, end: now + GO_HOURS * 3_600_000 }
      return saved(await writeGo($, g), T['cmd.go']({ id: g.id, end: stamp(g.end) }), 'go')
    }
    case 'go-off': {
      const live = (await listGoes($)).filter((g) => now < g.end && (cmd.id === undefined || g.id === cmd.id))
      await locked($, 'goes', () => Promise.all(live.map((g) => rmGo($, g.id))))
      const left = (await listGoes($)).filter((g) => live.some((l) => l.id === g.id)).length
      return saved(left === 0, T['cmd.goOff']({ n: live.length }), 'go-off')
    }
    case 'unattended': {
      if (cmd.span.op === 'state') return w.state === 'unknown' ? say(refusal('refuse', 'unknown-liveness', { tool: 'callboard', target: 'unattended' })) : w.state === 'on' ? T['cmd.unattendedOn']({ end: stamp(w.window.end) }) : T['cmd.unattendedOff']({})
      if (cmd.span.op === 'off') return saved(await writeWindow($, null), T['cmd.unattendedOff']({}), 'window')
      return saved(await writeWindow($, { start: now, end: cmd.span.end, readAt: now }), T['cmd.unattendedOn']({ end: stamp(cmd.span.end) }), 'window')
    }
    case 'config': {
      mem.cfg = undefined
      const cur = await cfgNow($)
      if (cmd.config === 'show') return T['cmd.config']({ cfg: cur })
      const next = configNext(cur, cmd.config)
      if (next === undefined) return fail('idle-over-working')
      const text = cmd.config === 'reset' ? T['cmd.configReset']({}) : T['cmd.configSet']({ key: cmd.config.key, value: String(cmd.config.value) })
      return saved(await writeConfig($, next), text, 'config')
    }
  }
}
// Asks the window that serves this session's folder to pin the active tab, if it is a Claude panel; send and forget, and an optional add-on: a failure here never changes the command's answer.
export async function pinOwn($: any, me: Sid): Promise<void> {
  try {
    const v = await getView($, true)
    const folder = v.rows === 'unknown' ? undefined : v.rows.get(me)?.folder
    if (folder !== undefined) await spoolSend($, { op: 'pin', sid: me, folder })
  } catch {}
}
export async function commandRun($: any, e: any) {
  const now = await $.clock.now()
  const plan = planCommand(typeof e?.args === 'string' ? e.args : '', originOf(e), now)
  if (plan.act === 'refuse') return { text: say(plan) }
  let ok = false
  const me = (await $.session.id()) as Sid
  const text = await perform($, plan.cmd, me, await getView($, true), now, () => void (ok = true))
  // His typed step that saved a change of this session's role, goes or window gives it a turn, so he need not type "done". A read or a failed write sends nothing.
  if (ok && originOf(e) === 'typed' && CHANGES.includes(plan.cmd.op)) mem.owed.push(T['cmd.told']({ result: text }))
  // A typed `lead` or `conductor` that saved pins this session's tab; the registry row's folder is read after the save.
  if (ok && originOf(e) === 'typed' && (plan.cmd.op === 'lead' || plan.cmd.op === 'conductor')) await pinOwn($, me)
  return { text }
}

// A run of one of callboard's own command names, as the form `args` says (the typed words, when none): a name another source held at the session start (io.ts, registerFree) is
// that source's to answer, so its run passes on as typed.
export function commandHeard($: any, e: any, next: any, args?: string) {
  return mem.taken.has(e?.command) ? next(e) : commandRun($, args === undefined ? e : { ...e, args })
}

// ---- the typeahead and the briefing ----
// The first word after `/callboard `: the commands that start with what is typed.
export async function commandComplete(_$: any, e: { text: string; start: number; token: string }, next: any) {
  const base = await next(e)
  const words = e.text.slice(0, e.start) === '/callboard ' ? Object.keys(T).filter((k) => k.startsWith('help.') && !/^help\.(head|lead-off|go-off)$/.test(k)).map((k) => k.slice(5)) : []
  const rows = words.filter((w) => w.startsWith(e.token.toLowerCase())).map((w) => ({ text: w, label: w, description: helpRow(`help.${w}`) }))
  return { suggestions: [...base.suggestions, ...rows] }
}
// The briefing for the session's role, one session-scope section; decided before `next` runs, so a throw after it can never call next twice. A request that does not offer the compaction tool
// (a subagent with a narrow tool list) or that is a teammate's gets none.
export async function promptCompose($: any, e: any, next: any) {
  let body: string | undefined
  try {
    const me = (await $.session.id()) as Sid
    const v = await getView($)
    const cap = capability(v, me)
    const up = parent(v, me)
    if (!e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes('mcp__callboard__request_compact') && !isOff(v, me)) {
      const name = nameOf(v, me)
      if (cap === 'manager') {
        const rules = printed((await readRules($)) ?? '', RULES_CAP)
        body = T['brief.manager']({ name, rules: rules.text.replace(/^(\s*)\[(callboard|compact-cue)\]/gim, '$1[ $2]'), rulesCut: rules.cut })
      } else if (cap === 'lead') {
        const row = v.table[me]!
        // A minted lead's conductor, while it is the parent: the lead asks it for a go and for answers.
        const conductor = isMinted(v, me) && up !== PERSON && up !== 'unknown' && isConductor(v, up) ? nameOf(v, up) : undefined
        body = [T['brief.parent']({ name, sid: me, repos: [row.folder, ...row.lead!.repos], ...(conductor === undefined ? {} : { conductor }) }), ...(isConductor(v, me) ? [T['brief.conductor']({ repos: row.lead!.repos })] : [])].join('\n')
      } else if (up !== PERSON && up !== 'unknown') body = T['brief.child']({ name, sid: me, parent: nameOf(v, up), lead: capability(v, up) === 'lead' })
    }
  } catch {}
  const out = await next(e)
  return body === undefined || !Array.isArray(out?.sections) ? out : { ...out, sections: [...out.sections.filter((s: { id: string }) => s.id !== 'callboard:brief'), { id: 'callboard:brief', text: T['note.frame']({ body }), scope: 'session' }] }
}
