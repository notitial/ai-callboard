// What the person and a parent session see: the status page, the lane table, prompt_list, the go list, the three dialogs and the refusal toast. Pure: every
// string comes from `T`. Trust rules held here: text a session wrote (an ask's input, a name, a folder) is escaped before it reaches a text (`<` and invisible characters
// become escapes, so nothing closes a frame, hides text or reorders it); an input whose printed form had to be cut is reported cut, so no session may allow it.
import { capBytes } from './core/asks.ts'
import type { Ask, Capability, Decision, Question, Sid, StopVerb } from './core/model.ts'
import type { RefuseCode, StatusRow, UiColumn, UiState } from './core/msg.ts'
import { esc, escBlock, escCell, T } from './texts.ts'

export const PRINT_CAP = 32 * 1024
const two = (n: number): string => String(n).padStart(2, '0')
// A time as the person reads it, with its date.
const clock = (t: number): string => `${two(new Date(t).getHours())}:${two(new Date(t).getMinutes())}`
export const stamp = (t: number): string => `${new Date(t).getFullYear()}-${two(new Date(t).getMonth() + 1)}-${two(new Date(t).getDate())} ${clock(t)}`
export const RULES_CAP = 8 * 1024
// What a pop-up is trusted to show whole: a longer input gets Deny only.
export const DIALOG_CAP = 4 * 1024
// The text as printed: escaped, then cut to `max` bytes. cut: what is shown is not the whole.
export const printed = (s: string, max: number): { text: string; cut: boolean } => capBytes(escBlock(s), max)

export const statusPage = (rows: readonly StatusRow[]): string => `${T['ui.status.head']({})}\n\n| | |\n|---|---|\n${rows.map((r) => T['ui.status.row'](r)).join('\n')}`

// ---- the lane table: /callboard lanes and lane_list ----
// sid and parentSid (a session id, PERSON, or null) order the table (see `tree`); the name is for display and is not unique. Neither is a column. The usage figures are the engine's own; a figure that is absent or not a number reads `-`.
export type LaneRow = { sid: Sid; name: string; role: Capability; state: UiState; parentSid: Sid | null; folder: string; context?: number; fiveHour?: number; sevenDay?: number; cost?: number; readAgeMin?: number }
const COLS: readonly UiColumn[] = ['name', 'role', 'state', 'folder', 'context', 'fiveHour', 'sevenDay', 'cost', 'read']
const line = (v: readonly string[]): string => `| ${v.map(escCell).join(' | ')} |`
const num = (n: number | undefined, f: (n: number) => string): string => (n !== undefined && Number.isFinite(n) ? f(n) : '-')

// The rows as a tree, joined by session id (two sessions can share a name): a row whose parent is not listed starts a branch, and each row's children follow it, one `↳` deeper. A glyph, not spaces, which a table collapses.
// Every row is placed once, so a parent that points back at its own child cannot loop; the rows of such a cycle come last.
function tree(rows: readonly LaneRow[]): { row: LaneRow; depth: number }[] {
  const out: { row: LaneRow; depth: number }[] = []
  const placed = new Set<LaneRow>()
  const place = (row: LaneRow, depth: number): void => {
    if (placed.has(row)) return
    placed.add(row)
    out.push({ row, depth })
    for (const c of rows) if (c.parentSid === row.sid) place(c, depth + 1)
  }
  for (const r of rows) if (!rows.some((p) => p.sid === r.parentSid)) place(r, 0)
  for (const r of rows) place(r, 0)
  return out
}
const folderName = (f: string): string => ((n) => (n === undefined ? '-' : `../${n}`))(f.split('/').filter((s) => s !== '').at(-1))

export function lanesTable(rows: readonly LaneRow[]): string {
  if (rows.length === 0) return T['ui.lanes.none']({})
  const cells = ({ row: r, depth }: { row: LaneRow; depth: number }): Record<UiColumn, string> => ({
    name: depth === 0 ? r.name : `${'↳'.repeat(depth)} ${r.name}`, role: T[`ui.role.${r.role}`](), state: T[`ui.state.${r.state}`](), folder: folderName(r.folder),
    context: num(r.context, (n) => `${Math.round(n / 1000)}k`), fiveHour: num(r.fiveHour, (n) => `${Math.round(n)}%`), sevenDay: num(r.sevenDay, (n) => `${Math.round(n)}%`),
    cost: num(r.cost, (n) => `$${n.toFixed(2)}`), read: num(r.readAgeMin, (n) => `${Math.round(n)}m`),
  })
  const body = tree(rows).map((r) => ((c) => line(COLS.map((k) => c[k])))(cells(r)))
  return [T['ui.lanes.head']({}), '', line(COLS.map((c) => T[`ui.col.${c}`]())), line(COLS.map(() => '---')), ...body, '', T['ui.usage.footnote']({})].join('\n')
}

// ---- prompt_list: the standing rules first, then the asks ----
// asker: the asker's name. cutIds: asks whose input had to be cut to print; the adapter stores that on the ask (`cut`), so `decide` refuses an allow of it.
export type AskView = { ask: Ask; asker: string; ageMin: number; yours: boolean }
export function promptList(rules: string | null | undefined, asks: readonly AskView[]): { text: string; cutIds: string[] } {
  const r = rules === null || rules === undefined ? undefined : printed(rules, RULES_CAP)
  const cutIds: string[] = []
  const blocks = asks.map(({ ask: a, asker, ageMin, yours }) => {
    const p = printed(a.input, PRINT_CAP)
    if (p.cut && !a.cut) cutIds.push(a.id)
    return T['ui.ask']({ id: a.id, asker, tool: a.tool, ageMin, raisedBy: a.raisedBy, yours, input: p.text, cut: a.cut || p.cut, question: a.question })
  })
  const head = rules === undefined ? [] : [r === undefined ? T['ui.rules.none']({}) : T['ui.rules']({ rules: r.text, cut: r.cut })]
  return { text: [...head, ...(blocks.length > 0 ? blocks : [T['ui.asks.none']({})])].join('\n\n'), cutIds }
}

// ---- the lists for the person ----
// giver: a name; end: a time as the person reads it.
export function goList(goes: readonly { id: string; giver: string; text: string; end: string }[]): string {
  return goes.length === 0 ? `${T['ui.goes.head']({})}\n${T['ui.goes.none']({})}` : [T['ui.goes.head']({}), ...goes.map((g) => T['ui.goes.row'](g)), '', T['go.neverCovers']({})].join('\n')
}

// ---- the dialogs: a header, a question and buttons. The adapter maps a click by its label; only a dialog that offers Allow can allow, and anything else is a deny ----
export type DialogSpec = { header: string; question: string; options: { label: string }[] }
const yesNo = (): { label: string }[] => [{ label: T['dialog.yes']({}) }, { label: T['dialog.no']({}) }]
export const goDialog = (giver: string, text: string, end: string): DialogSpec => ({ header: T['dialog.go.header']({}), question: T['dialog.go.question']({ giver, text, end }), options: yesNo() })
export const stopDialog = (name: string, verb: StopVerb): DialogSpec => ({ header: T['dialog.stop.header']({}), question: T['dialog.stop.question']({ name, verb }), options: yesNo() })
// The relay pop-up: an input not shown whole (cut, or too large to print) gets Deny only, as `decide` refuses its allow. `cut` is that finding: the adapter stores it on the
// ask, as it stores promptList's cutIds, so no other path allows the input. A question not shown whole comes here with `cut` set; a whole one is mirrored (mirrorOf).
export function relayDialog(asker: string, tool: string, input: string, cut: boolean): DialogSpec & { cut: boolean } {
  const p = printed(input, DIALOG_CAP)
  const whole = !cut && !p.cut
  return {
    header: T['dialog.relay.header']({}),
    question: T['dialog.relay.question']({ asker, tool, input: p.text, cut: !whole }),
    options: [...(whole ? [{ label: T['dialog.allow']({}) }] : []), { label: T['dialog.deny']({}) }],
    cut: !whole,
  }
}

// The manager's note, the first of two pop-ups for a tool ask it escalated: the note under its label (escaped and fenced like the input), with Allow, Show the command (the second
// pop-up, relayDialog) and Deny. Allow is offered only where the whole command can be shown, as in relayDialog. A note is at most 300 characters, so its escaped text fits the cap.
export function relayNote(asker: string, tool: string, note: string, input: string): DialogSpec {
  const whole = !printed(input, DIALOG_CAP).cut
  return { header: T['dialog.relay.header']({}), question: T['dialog.relay.note']({ asker, tool, note: printed(note, DIALOG_CAP).text }), options: [...(whole ? [{ label: T['dialog.allow']({}) }] : []), { label: T['dialog.show']({}) }, { label: T['dialog.deny']({}) }] }
}

// ---- what the relay puts to the person: the input of an AskUserQuestion it calls in the manager's session (engine/relay.ts) ----
export type AskQuestion = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: false }
const HEADER_MAX = 12
// A pop-up as one question. The tool takes 2 to 4 options, so a lone Deny gets Leave it beside it, which writes nothing.
export function askOf(spec: DialogSpec): AskQuestion[] {
  const options = spec.options.length < 2 ? [...spec.options, { label: T['dialog.leave']({}) }] : spec.options
  return [{ question: spec.question, header: spec.header, options: options.map((o) => ({ label: o.label, description: '' })), multiSelect: false }]
}
// The asker's own questions in one dialog, as the asker saw them: each question opens with the asker's name, and every text is escaped. A text whose escaped form is past what a
// pop-up shows whole makes it undefined, and the ask then gets relayDialog's Deny only. The answer maps back by position, so the escaped labels need not match the asker's; it
// is read by label and by question, so escaped labels of one question, or questions, that come out the same make it undefined too.
export function mirrorOf(asker: string, qs: readonly Question[]): AskQuestion[] | undefined {
  if (qs.some((q) => [q.header, q.question, ...q.options.flatMap((o) => [o.label, o.description ?? ''])].some((s) => printed(s, DIALOG_CAP).cut))) return undefined
  const sent = qs.map((q): AskQuestion => ({ question: T['dialog.relay.asks']({ asker, question: q.question }), header: esc(q.header).slice(0, HEADER_MAX), options: q.options.map((o) => ({ label: esc(o.label), description: esc(o.description ?? '') })), multiSelect: false }))
  const distinct = (xs: string[]) => new Set(xs).size === xs.length
  return distinct(sent.map((q) => q.question)) && sent.every((q) => distinct(q.options.map((o) => o.label))) ? sent : undefined
}

// ---- the toast ----
// A refusal's toast; any other decision has none.
export function refusalToast(d: Decision): string | undefined {
  return d.msg.startsWith('refuse.') ? T['toast.refused']({ tool: (d.p as { tool: string }).tool, code: d.msg.slice(7) as RefuseCode }) : undefined
}
