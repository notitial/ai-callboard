// The go: what a go file holds, what text a go may carry, and whom it covers. Pure. Trust rules held here: a go covers only its giver and the sessions under the
// giver now, until its end; a go file is written only by the go dialog's click or his typed `go` (the adapters), or moved to its giver's successor by a handover, so this file only reads one.
import type { Go, Sid, View } from './model.ts'
import { ancestors } from './model.ts'

export const GO_HOURS = 24
const GO_TEXT_MAX = 300
const GO_TEXT_LINES = 3
// A control character other than newline, a format or private-use or unassigned character, a line or paragraph separator: what a person cannot see in the dialog.
const HIDDEN_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}\u115f\u1160\u3164\uffa0]/u
// A line that starts like the fence go_status puts around the text.
const FENCE_RE = /^\s*(<<<|>>>)/m

// The text a go may carry: 1 to 3 non-empty lines, at most 300 bytes, no space at its ends, nothing hidden, no fence.
export function goTextOk(text: unknown): text is string {
  if (typeof text !== 'string' || text !== text.trim() || text === '') return false
  const lines = text.split('\n')
  return new TextEncoder().encode(text).length <= GO_TEXT_MAX && lines.length <= GO_TEXT_LINES && lines.every((l) => l.trim() !== '') && !HIDDEN_RE.test(text) && !FENCE_RE.test(text)
}
// A go file read leniently: anything that is not a go, or whose text no go may carry, is no go.
export function parseGo(raw: unknown): Go | undefined {
  const g = raw as Partial<Go> | null
  if (g === null || typeof g !== 'object' || typeof g.id !== 'string' || typeof g.giver !== 'string' || !Number.isFinite(g.end) || !goTextOk(g.text)) return undefined
  return { id: g.id, giver: g.giver, text: g.text, end: g.end as number }
}
// The giver is the reader or above it now, and the go has not ended; an end further off than GO_HOURS is no go. A giver that is gone is nobody's ancestor, so its go covers no one meanwhile.
export const covers = (g: Go, reader: Sid, v: View, now: number): boolean => now < g.end && g.end - now <= GO_HOURS * 3_600_000 && (g.giver === reader || ancestors(v, reader).includes(g.giver))

// `/callboard go TEXT` and `/callboard go off [ID]`.
export function goCommand(args: string): { op: 'give'; text: string } | { op: 'off'; id?: string } | 'bad' {
  const text = args.trim()
  const off = /^off(?:\s+(\S+))?$/.exec(text)
  if (off) return off[1] === undefined ? { op: 'off' } : { op: 'off', id: off[1] }
  // `go Off`, `go off all` and the like read as an attempt to end a go: they are refused, not recorded as a new go.
  return goTextOk(text) && !/^off(\s|$)/i.test(text) ? { op: 'give', text } : 'bad'
}
