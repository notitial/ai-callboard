import type { WhyCode } from './core.ts'
import type { LedgerRow } from './prompts.ts'

// Why a waiting prompt is not being answered: the pure decision behind a check-in's reason (the engine reads the ledger and the switch, engine/answer-tiers.ts).
// Only what was observed counts. The session's own hook writes a row for what it did with an ask, so the latest row since the wait began is its reason; no row
// at all is said as that and nothing more. A row of a kind this file does not map gives no reason, and the check-in then keeps its fixed tail.

// The rows of a wait are read from this long before the registry's status time: both clocks are one machine's, and the hook writes after the dialog is up. The
// margin is small so that the previous prompt's rows are not read as this one's.
export const WHY_ROW_MARGIN_MS = 10_000
// A prompt younger than this (counted from the registry's status time) may still be in the hook's pre-row stages; it is not called a wait with no record.
export const WHY_NO_RECORD_AFTER_MS = 3 * 60_000

// The hook's own code for a `not-judgeable` row, as a reason. `question-*` codes are a question that stays the person's.
const NOT_JUDGEABLE: Record<string, WhyCode> = { 'not-ask': 'not-ask', 'no-check': 'no-check' }
// The kinds the hook writes for an ask or that end one; any other row of the lane (a subagent's denial, a notice cap, a resume) says nothing of this wait and is skipped.
const ASK_KINDS: ReadonlySet<string> = new Set(['requested', 'escalated', 'relayed', 'no-tier', 'abandoned', 'not-judgeable', 'answered', 'returned', 'dropped', 'expired-denied', 'superseded', 'relay-lost', 'relay-closed', 'relay-left', 'relay-late'])
function ofRow(r: LedgerRow): WhyCode | undefined {
  switch (r.kind) {
    case 'no-tier':
      return 'no-tier'
    case 'abandoned':
      return r.code === 'no-tier' ? 'no-tier' : r.code === 'hook-failed' ? 'hook-failed' : undefined
    case 'not-judgeable':
      return typeof r.code === 'string' && r.code.startsWith('question-') ? 'question' : typeof r.code === 'string' && Object.prototype.hasOwnProperty.call(NOT_JUDGEABLE, r.code) ? NOT_JUDGEABLE[r.code] : undefined
    case 'requested':
    case 'escalated':
      return 'other-tier'
    case 'relayed':
      return 'with-person'
    default:
      return undefined
  }
}

// rows: the ledger rows of this lane in this repo (the caller matches them), any order. at: the registry's status time of the wait, in ms. now: the present.
// The reason is the latest row since `at - WHY_ROW_MARGIN_MS`; undefined when that row is of an unmapped kind. With no row in the window: `no-record`, once the wait is
// WHY_NO_RECORD_AFTER_MS old. rows that cannot be read are the caller's `undefined`, not an empty list.
export function whyOfRows(rows: readonly LedgerRow[], at: number, now: number): WhyCode | undefined {
  const from = at - WHY_ROW_MARGIN_MS
  let last: { t: number; r: LedgerRow } | undefined
  for (const r of rows) {
    const t = Date.parse(r.t)
    if (!Number.isFinite(t) || t < from || t > now + WHY_ROW_MARGIN_MS || !ASK_KINDS.has(r.kind)) continue
    if (!last || t >= last.t) last = { t, r }
  }
  if (last) return ofRow(last.r)
  return now - at >= WHY_NO_RECORD_AFTER_MS ? 'no-record' : undefined
}

// What the checking tier itself reads of the switch, used only when the hook left no row: the person's stored off, the default blocked by the guard, a scope that
// names none of the item's names. A store that does not answer, or an invalid stored value, is not certain and gives nothing.
export type SwitchView = { storedOff: boolean; guard: boolean; scope?: string }
export function whyOfSwitch(v: SwitchView, names: readonly string[]): WhyCode | undefined {
  if (v.storedOff) return 'stored-off'
  if (v.guard) return 'guard'
  if (v.scope !== undefined && v.scope !== 'all' && !names.includes(v.scope)) return 'scope'
  return undefined
}

// The whole decision for one waiting prompt. offFile: the OFF file exists (machine-wide). rows: undefined when the ledger could not be read.
export function whyOf(o: { offFile: boolean; rows: readonly LedgerRow[] | undefined; at: number; now: number; view: SwitchView | undefined; names: readonly string[] }): WhyCode | undefined {
  if (o.offFile) return 'off-file'
  if (o.rows === undefined) return undefined
  const fromRows = whyOfRows(o.rows, o.at, o.now)
  if (fromRows !== 'no-record') return fromRows
  const fromSwitch = o.view ? whyOfSwitch(o.view, o.names) : undefined
  return fromSwitch ?? 'no-record'
}
