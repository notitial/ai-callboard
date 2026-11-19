// `/callboard`, `/rest`, `/unattended`, the typeahead and the prompt composer. Trust rules held here: the one origin check is planCommand's, fed by originOf, and only his typed turn passes
// it for a form that widens what a session may do (lead, off, on, go, go off, unattended on and off, config changes); a write that does not land is said, never reported as done; a path a
// lead is given is resolved to its real path; the table is written under its lock.
import type { Row, Sid, View } from '../core/model.ts'
import { PERSON, capability, children, descendants, isOff, nameOf, parent, refusal } from '../core/model.ts'
import type { Cmd, Origin } from '../core/commands.ts'
import { configNext, planCommand } from '../core/commands.ts'
import { GO_HOURS, covers } from '../core/go.ts'
import { childState } from '../core/lifecycle.ts'
import type { StatusRow } from '../core/msg.ts'
import { T } from '../texts.ts'
import type { LaneRow } from '../ui.ts'
import { RULES_CAP, lanesTable, printed, stamp, statusPage } from '../ui.ts'
import { home, newId, run, windowNow } from './io.ts'
import { mem } from './mem.ts'
import { cfgNow, getView, listGoes, readRules, rmGo, updateTable, writeConfig, writeGo, writeWindow } from './store.ts'
import { restSet, say } from './tools-any.ts'
import { giveParentTools } from './tick.ts'
import { usageRead } from './usage.ts'

const TYPED_ORIGINS = ['composer', 'bridge']
// The forms whose saved change owes the session a notice turn. Off is not among them: an off session is sent nothing.
const CHANGES: string[] = ['lead', 'lead-off', 'on', 'go', 'go-off', 'unattended']
// A command is typed when the engine stamped its origin as one of his own typed turns; any other origin, or none, is not.
const originOf = (e: any): Origin => (TYPED_ORIGINS.includes(e?.origin?.kind) ? 'typed' : 'other')
const person = (v: View, s: Sid | 'unknown' | null): string | null => (s === null ? null : s === 'unknown' ? 'unknown' : s === PERSON ? PERSON : nameOf(v, s))
const helpRow = (k: string): string => (T as Record<string, (p: unknown) => string>)[k]!({})
const help = (): string => [T['help.head']({}), ...Object.keys(T).filter((k) => k.startsWith('help.') && k !== 'help.head').map((k) => helpRow(k))].join('\n')

// ---- the lane list: this session's children, or the manager's descendants; the usage figures are the files' ----
export async function laneRows($: any, v: View, me: Sid): Promise<LaneRow[]> {
  const now = await $.clock.now()
  const under = capability(v, me) === 'manager' ? descendants(v, me) : children(v, me)
  return Promise.all(
    under.map(async (k) => {
      const u = await usageRead($, k, now)
      const reg = v.rows === 'unknown' ? undefined : v.rows.get(k)
      return { name: nameOf(v, k), role: capability(v, k), state: childState(v, k, mem.signed.set.has(k), now), parent: person(v, parent(v, k)) === 'unknown' ? null : person(v, parent(v, k)), folder: reg?.folder ?? v.table[k]?.folder ?? '', context: u?.tokens, fiveHour: u?.fiveHour, sevenDay: u?.sevenDay, cost: u?.cost, readAgeMin: u === undefined ? undefined : (now - u.at) / 60_000 }
    }),
  )
}

// This session's real folder and the real paths of what it was given (`~` is the person's home); undefined when one does not resolve.
async function realPaths($: any, v: View, me: Sid, paths: string[]): Promise<string[] | undefined> {
  const h = await home($)
  const folder = (await $.session.root().catch(() => undefined)) as string | undefined
  const out: string[] = []
  for (const p of folder === undefined || h === undefined ? [] : [folder, ...paths].slice(0, 17)) {
    const r = await run($, ['/bin/realpath', '--', p.startsWith('~/') ? `${h}${p.slice(1)}` : p]).catch(() => undefined)
    const real = r?.stdout.trim()
    if (r?.exitCode !== 0 || real === undefined || !real.startsWith('/')) return undefined
    if (!out.includes(real)) out.push(real)
  }
  return out.length > 0 ? out : undefined
}
function setRow($: any, v: View, me: Sid, folder: string, f: (r: Row) => Row): Promise<boolean> {
  return updateTable($, (t) => ({ ...t, [me]: f({ name: nameOf(v, me), folder, ...t[me] }) }))
}

async function perform($: any, cmd: Cmd, me: Sid, v: View, now: number, savedOk: () => void): Promise<string> {
  const fail = (detail: string) => say(refusal('refuse', 'bad-input', { tool: 'callboard', target: cmd.op, detail }))
  const saved = (ok: boolean, text: string) => (ok ? (savedOk(), text) : say(refusal('refuse', 'unknown-liveness', { tool: 'callboard', target: cmd.op })))
  const folder = v.rows === 'unknown' ? undefined : v.rows.get(me)?.folder
  const w = await windowNow($)
  switch (cmd.op) {
    case 'status': {
      const goes = (await listGoes($)).filter((g) => covers(g, me, v, now)).length
      const rows: StatusRow[] = [{ field: 'role', value: capability(v, me) }, { field: 'parent', value: person(v, parent(v, me)) }, { field: 'manager', value: person(v, v.manager) }, { field: 'off', value: isOff(v, me) }, { field: 'keepalive', value: (await cfgNow($)).keepalive }, { field: 'unattended', value: w.state === 'on' ? stamp(w.window.end) : null }, { field: 'goes', value: goes }]
      return statusPage(rows)
    }
    case 'lanes': return lanesTable(await laneRows($, v, me))
    case 'help': return help()
    case 'rest': return saved(await restSet($, me, 'command'), T['cmd.rest']({}))
    case 'lead': {
      const [own, ...repos] = (await realPaths($, v, me, cmd.paths)) ?? []
      if (own === undefined) return fail('path')
      const ok = await setRow($, v, me, own, (r) => ({ ...r, folder: own, lead: { repos: [...new Set([...(r.lead?.repos ?? []), ...repos])] } }))
      if (ok) await giveParentTools($, await getView($, true), me)
      return saved(ok, T['cmd.lead']({ repos }))
    }
    case 'lead-off': return saved(await setRow($, v, me, folder ?? '', ({ lead: _, ...r }) => r), T['cmd.leadOff']({}))
    case 'off': return saved(await setRow($, v, me, folder ?? '', (r) => ({ ...r, off: true })), T['cmd.off']({}))
    case 'on': return saved(await setRow($, v, me, folder ?? '', ({ off: _, ...r }) => r), T['cmd.on']({}))
    case 'go': {
      const g = { id: newId(), giver: me, text: cmd.text, end: now + GO_HOURS * 3_600_000 }
      return saved(await writeGo($, g), T['cmd.go']({ id: g.id, end: stamp(g.end) }))
    }
    case 'go-off': {
      const live = (await listGoes($)).filter((g) => now < g.end && (cmd.id === undefined || g.id === cmd.id))
      await Promise.all(live.map((g) => rmGo($, g.id)))
      const left = (await listGoes($)).filter((g) => live.some((l) => l.id === g.id)).length
      return saved(left === 0, T['cmd.goOff']({ n: live.length }))
    }
    case 'unattended': {
      if (cmd.span.op === 'state') return w.state === 'unknown' ? say(refusal('refuse', 'unknown-liveness', { tool: 'callboard', target: 'unattended' })) : w.state === 'on' ? T['cmd.unattendedOn']({ end: stamp(w.window.end) }) : T['cmd.unattendedOff']({})
      if (cmd.span.op === 'off') return saved(await writeWindow($, null), T['cmd.unattendedOff']({}))
      return saved(await writeWindow($, { start: now, end: cmd.span.end, readAt: now }), T['cmd.unattendedOn']({ end: stamp(cmd.span.end) }))
    }
    case 'config': {
      mem.cfg = undefined
      const cur = await cfgNow($)
      if (cmd.config === 'show') return T['cmd.config']({ cfg: cur })
      const next = configNext(cur, cmd.config)
      if (next === undefined) return fail('idle-over-working')
      const text = cmd.config === 'reset' ? T['cmd.configReset']({}) : T['cmd.configSet']({ key: cmd.config.key, value: String(cmd.config.value) })
      return saved(await writeConfig($, next), text)
    }
  }
}
export async function commandRun($: any, e: any) {
  const now = await $.clock.now()
  const plan = planCommand(typeof e?.args === 'string' ? e.args : '', originOf(e), now)
  if (plan.act === 'refuse') return { text: say(plan) }
  let ok = false
  const text = await perform($, plan.cmd, (await $.session.id()) as Sid, await getView($, true), now, () => void (ok = true))
  // His typed step that saved a change of this session's role, goes or window gives it a turn, so he need not type "done". A read or a failed write sends nothing.
  if (ok && originOf(e) === 'typed' && CHANGES.includes(plan.cmd.op)) mem.owed.push(T['cmd.told']({ result: text }))
  return { text }
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
      } else if (cap === 'lead') body = T['brief.parent']({ name, repos: [v.table[me]!.folder, ...v.table[me]!.lead!.repos] })
      else if (up !== PERSON && up !== 'unknown') body = T['brief.child']({ name, parent: nameOf(v, up) })
    }
  } catch {}
  const out = await next(e)
  return body === undefined || !Array.isArray(out?.sections) ? out : { ...out, sections: [...out.sections.filter((s: { id: string }) => s.id !== 'callboard:brief'), { id: 'callboard:brief', text: T['note.frame']({ body }), scope: 'session' }] }
}
