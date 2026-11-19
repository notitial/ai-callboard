// What the person and a parent session see: the status page, the lane table, prompt_list, the unattended and go lists, the three dialogs and the refusal toast. Pure: every
// string comes from `T`. Trust rules held here: text a session wrote (an ask's input, a name, a folder) is escaped before it reaches a text (`<` and invisible characters
// become escapes, so nothing closes a frame, hides text or reorders it); an input whose printed form had to be cut is reported cut, so no session may allow it.
import { capBytes } from './core/asks.ts'
import type { Ask, AskLogRow, Capability, Decision, Sid, StopVerb } from './core/model.ts'
import { PERSON } from './core/model.ts'
import type { RefuseCode, StatusRow, UiColumn, UiState } from './core/msg.ts'
import { esc, escBlock, T } from './texts.ts'

export const PRINT_CAP = 32 * 1024
export const RULES_CAP = 8 * 1024
// The text as printed: escaped, then cut to `max` bytes. cut: what is shown is not the whole.
export const printed = (s: string, max: number): { text: string; cut: boolean } => capBytes(escBlock(s), max)

export const statusPage = (rows: readonly StatusRow[]): string => `${T['ui.status.head']({})}\n\n| | |\n|---|---|\n${rows.map((r) => T['ui.status.row'](r)).join('\n')}`

// ---- the lane table: /callboard lanes and lane_list ----
// parent: a name, PERSON, or null. The usage figures are the engine's own; a figure that is absent or not a number reads `-`.
export type LaneRow = { name: string; role: Capability; state: UiState; parent: string | null; folder: string; context?: number; fiveHour?: number; sevenDay?: number; cost?: number; readAgeMin?: number }
const COLS: readonly UiColumn[] = ['name', 'role', 'state', 'parent', 'folder', 'context', 'fiveHour', 'sevenDay', 'cost', 'read']
const cell = (s: string): string => esc(s).replace(/\|/g, '\\|')
const line = (v: readonly string[]): string => `| ${v.map(cell).join(' | ')} |`
const num = (n: number | undefined, f: (n: number) => string): string => (n !== undefined && Number.isFinite(n) ? f(n) : '-')

export function lanesTable(rows: readonly LaneRow[]): string {
  if (rows.length === 0) return T['ui.lanes.none']({})
  const cells = (r: LaneRow): Record<UiColumn, string> => ({
    name: r.name, role: T[`ui.role.${r.role}`](), state: T[`ui.state.${r.state}`](), folder: r.folder,
    parent: r.parent === null ? '-' : r.parent === PERSON ? T['ui.person']({}) : r.parent,
    context: num(r.context, (n) => `${Math.round(n / 1000)}k`), fiveHour: num(r.fiveHour, (n) => `${Math.round(n)}%`), sevenDay: num(r.sevenDay, (n) => `${Math.round(n)}%`),
    cost: num(r.cost, (n) => `$${n.toFixed(2)}`), read: num(r.readAgeMin, (n) => `${Math.round(n)}m`),
  })
  const body = rows.map((r) => ((c) => line(COLS.map((k) => c[k])))(cells(r)))
  return [T['ui.lanes.head']({}), '', line(COLS.map((c) => T[`ui.col.${c}`]())), line(COLS.map(() => '---')), ...body, '', T['ui.usage.footnote']({})].join('\n')
}

// ---- prompt_list: the standing rules first, then the asks ----
// asker: the asker's name. cutIds: asks whose input had to be cut to print; the adapter stores that on the ask (`cut`), so `decide` refuses an allow of it.
export type AskView = { ask: Ask; asker: string; ageMin: number; yours: boolean }
export function promptList(rules: string | null, asks: readonly AskView[]): { text: string; cutIds: string[] } {
  const r = rules === null ? undefined : printed(rules, RULES_CAP)
  const cutIds: string[] = []
  const blocks = asks.map(({ ask: a, asker, ageMin, yours }) => {
    const p = printed(a.input, PRINT_CAP)
    if (p.cut && !a.cut) cutIds.push(a.id)
    return T['ui.ask']({ id: a.id, asker, tool: a.tool, ageMin, raisedBy: a.raisedBy, yours, personOnly: a.personOnly, input: p.text, cut: a.cut || p.cut, question: a.question })
  })
  const head = r === undefined ? T['ui.rules.none']({}) : T['ui.rules']({ rules: r.text, cut: r.cut })
  return { text: [head, ...(blocks.length > 0 ? blocks : [T['ui.asks.none']({})])].join('\n\n'), cutIds }
}

// ---- the lists for the person ----
// The unattended list: `name` gives a session's name, `clock` a time as the person reads it.
export function unattendedList(end: string, list: { open: readonly AskLogRow[]; decided: readonly AskLogRow[] }, name: (s: Sid) => string, clock: (t: number) => string): string {
  const row = (r: AskLogRow): string => T['ui.unattended.row']({ time: clock(r.t), ev: r.ev, asker: name(r.asker), ask: r.ask, ...(r.by === undefined ? {} : { by: r.by === PERSON ? T['ui.person']({}) : name(r.by) }) })
  const part = (head: string, rows: readonly AskLogRow[]): string[] => (rows.length === 0 ? [] : [head, ...rows.map(row)])
  const body = [...part(T['ui.unattended.open']({}), list.open), ...part(T['ui.unattended.decided']({}), list.decided)]
  return [T['ui.unattended.head']({ end }), ...(body.length > 0 ? body : [T['ui.unattended.none']({})])].join('\n')
}
// giver: a name; end: a time as the person reads it.
export function goList(goes: readonly { id: string; giver: string; text: string; end: string }[]): string {
  return goes.length === 0 ? `${T['ui.goes.head']({})}\n${T['ui.goes.none']({})}` : [T['ui.goes.head']({}), ...goes.map((g) => T['ui.goes.row'](g)), '', T['go.neverCovers']({})].join('\n')
}

// ---- the dialogs: a header, a question and buttons; the first button is the one the person's click must choose to allow ----
export type DialogSpec = { header: string; question: string; options: { label: string }[] }
const yesNo = (): { label: string }[] => [{ label: T['dialog.yes']({}) }, { label: T['dialog.no']({}) }]
export const goDialog = (giver: string, text: string, end: string): DialogSpec => ({ header: T['dialog.go.header']({}), question: T['dialog.go.question']({ giver, text, end }), options: yesNo() })
export const stopDialog = (name: string, verb: StopVerb): DialogSpec => ({ header: T['dialog.stop.header']({}), question: T['dialog.stop.question']({ name, verb }), options: yesNo() })
// The relay pop-up: an input not shown whole (cut, or too large to print) gets Deny only, as `decide` refuses its allow.
export function relayDialog(asker: string, tool: string, input: string, cut: boolean): DialogSpec {
  const p = printed(input, PRINT_CAP)
  const whole = !cut && !p.cut
  return {
    header: T['dialog.relay.header']({ asker }),
    question: T['dialog.relay.question']({ asker, tool, input: p.text, cut: !whole }),
    options: [...(whole ? [{ label: T['dialog.allow']({}) }] : []), { label: T['dialog.deny']({}) }],
  }
}

// ---- the toast ----
// A refusal's toast; any other decision has none.
export function refusalToast(d: Decision): string | undefined {
  return d.msg.startsWith('refuse.') ? T['toast.refused']({ tool: (d.p as { tool: string }).tool, code: d.msg.slice(7) as RefuseCode }) : undefined
}
