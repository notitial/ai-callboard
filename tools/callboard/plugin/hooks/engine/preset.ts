// A folder's lead preset: the command it declares in .claude/callboard-lead.json, registered at the session start. His typed run of it makes this session a lead as `/callboard lead` does,
// under the preset's name; the name, model and effort follow on the next quiet tick, and the notice turn after them names each step that did not land. Trust rules held here: only his typed turn
// runs it (planCommand's origin check, the one `/callboard lead` has); the name is checked free before anything is saved; a command that is a built-in, or another source's, is not registered.
import type { Cmd, Preset } from '../core/commands.ts'
import { parsePreset, planCommand } from '../core/commands.ts'
import type { Sid, View } from '../core/model.ts'
import { isOff, nameRefusal, refusal } from '../core/model.ts'
import { PRESET_TAIL, T } from '../texts.ts'
import { modelHeld, ran } from './cue.ts'
import { originOf, perform, realPaths } from './commands.ts'
import { readText } from './io.ts'
import { mem } from './mem.ts'
import { getView, updateTable } from './store.ts'
import { say } from './tools-any.ts'

// Read this folder's preset and register its command; nothing is registered for a missing or bad file, or when the command's name is already taken by anything but this
// preset's own earlier registration (a reload, even after the file was edited), which is told by the tail of its description.
export async function presetRegister($: any): Promise<void> {
  mem.preset = undefined
  const root = await $.session.root().catch(() => undefined)
  const p = typeof root === 'string' ? parsePreset(await readText($, `${root}/.claude/callboard-lead.json`, 2048)) : undefined
  if (p === undefined) return
  const description = T['cmd.presetHelp'](p)
  const listed: { name: string; source: string; description?: string }[] = await $.command.list().catch(() => [{ name: p.command, source: 'builtin' }])
  if (listed.some((c) => c.name === p.command && !(c.source === 'plugin' && c.description?.endsWith(PRESET_TAIL)))) return
  await $.command.register({ name: p.command, description })
  mem.preset = p
}

// The command's run: every other command passes on, and a failure of the run itself is answered here, so `next` is called at most once.
export async function presetRun($: any, e: any, next: any) {
  const p = mem.preset
  if (p === undefined || e?.command !== p.command) return next(e)
  try {
    return await runPreset($, e, p)
  } catch {
    return { text: 'Callboard hit an error. Run /callboard status.' }
  }
}
// The rows of this preset's own ended leads: another typed lead in this session's folder that holds the preset's name and has no live session. Its name is free to take, and its row goes
// when the new one is saved (a typed lead's row is never expired). A live holder, a lane, a conductor, a minted lead and a row of another folder are not in it.
async function ended($: any, v: View, me: Sid, p: Preset): Promise<Sid[]> {
  const own = v.rows === 'unknown' ? undefined : (await realPaths($, v, me, []))?.[0]
  if (v.rows === 'unknown' || own === undefined) return []
  return Object.entries(v.table).filter(([k, r]) => k !== me && r.name === p.name && r.folder === own && r.lead && !r.lead.minted && !r.lead.conductor && !v.rows.has(k)).map(([k]) => k)
}
// The name check with the preset's own ended leads left out.
const nameFree = (v: View, p: Preset, me: Sid, gone: Sid[]) => nameRefusal({ ...v, table: Object.fromEntries(Object.entries(v.table).filter(([k]) => !gone.includes(k))) }, p.name, me)
async function runPreset($: any, e: any, p: Preset): Promise<{ text: string }> {
  const now = await $.clock.now()
  const plan = planCommand('lead', originOf(e), now)
  if (plan.act === 'refuse') return { text: say(plan) }
  const me = (await $.session.id()) as Sid
  const v = await getView($, true)
  const gone = await ended($, v, me, p)
  const code = nameFree(v, p, me, gone)
  if (code !== undefined) return { text: say(refusal('refuse', code, { tool: p.command, target: p.name })) }
  let ok = false
  const cmd: Cmd = { op: 'lead', paths: [], preset: p }
  const result = await perform($, cmd, me, v, now, () => void (ok = true))
  if (ok) {
    mem.presetRun = { preset: p, result }
    if (gone.length > 0) await updateTable($, (t) => Object.fromEntries(Object.entries(t).filter(([k, r]) => !(gone.includes(k) && r.name === p.name))))
  }
  return { text: result }
}

// On a quiet tick after a typed run: the steps, once; a step that fails is named in the notice, never repeated.
export async function presetTick($: any, me: Sid, v: View): Promise<void> {
  const r = mem.presetRun
  if (r === undefined) return
  mem.presetRun = undefined
  if (isOff(v, me)) return
  const { command, name, model, effort } = r.preset
  const failed: string[] = []
  // The name was checked at the typed run and may have been taken since: it is checked again on a fresh view, and a rename that would double a name is not run.
  const now = await getView($, true)
  const had = (now.rows === 'unknown' ? undefined : now.rows.get(me))?.name === name
  if (!had && (nameFree(now, r.preset, me, await ended($, now, me, r.preset)) !== undefined || !(await ran($, 'rename', name, 10_000)))) failed.push('name')
  if (!(await ran($, 'model', model, 5_000)) || !(await modelHeld($, model))) failed.push('model')
  if (!(await ran($, 'effort', effort, 5_000))) failed.push('effort')
  mem.owed.push(T['cmd.toldPreset']({ command, result: r.result, failed }))
}
