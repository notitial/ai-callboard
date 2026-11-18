import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as c from './core.ts'
import { WHY_NO_RECORD_AFTER_MS, WHY_ROW_MARGIN_MS, whyOf, whyOfRows, whyOfSwitch } from './checkin-why.ts'
import type { LedgerRow } from './prompts.ts'

const AT = Date.UTC(2026, 10, 18, 4, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const row = (over: Partial<LedgerRow>, dt = 1000): LedgerRow => ({ t: iso(AT + dt), kind: 'not-judgeable', lane: 'API', repo: '/Users/x/r', ...over }) as LedgerRow
const LATE = AT + 5 * 60_000

describe('whyOfRows: the hook\'s own latest row since the wait began', () => {
  test('maps the hook\'s codes to fixed reasons', () => {
    assert.equal(whyOfRows([row({ kind: 'no-tier' })], AT, LATE), 'no-tier')
    assert.equal(whyOfRows([row({ kind: 'abandoned', code: 'no-tier' })], AT, LATE), 'no-tier')
    assert.equal(whyOfRows([row({ kind: 'abandoned', code: 'hook-failed' })], AT, LATE), 'hook-failed')
    assert.equal(whyOfRows([row({ code: 'question-scope' })], AT, LATE), 'question')
    assert.equal(whyOfRows([row({ code: 'question-count' })], AT, LATE), 'question')
    assert.equal(whyOfRows([row({ code: 'not-ask' })], AT, LATE), 'not-ask')
    assert.equal(whyOfRows([row({ code: 'no-check' })], AT, LATE), 'no-check')
    assert.equal(whyOfRows([row({ kind: 'requested' })], AT, LATE), 'other-tier')
    assert.equal(whyOfRows([row({ kind: 'escalated' })], AT, LATE), 'other-tier')
    assert.equal(whyOfRows([row({ kind: 'relayed' })], AT, LATE), 'with-person')
  })
  test('the latest row wins, in any order', () => {
    const a = row({ kind: 'no-tier' }, 1000)
    const b = row({ kind: 'abandoned', code: 'hook-failed' }, 9000)
    assert.equal(whyOfRows([a, b], AT, LATE), 'hook-failed')
    assert.equal(whyOfRows([b, a], AT, LATE), 'hook-failed')
  })
  test('a row of a kind that is not mapped gives no reason, not "no record"', () => {
    assert.equal(whyOfRows([row({ kind: 'returned' })], AT, LATE), undefined)
    assert.equal(whyOfRows([row({ code: 'something-new' })], AT, LATE), undefined)
    assert.equal(whyOfRows([row({ kind: 'abandoned', code: 'other' })], AT, LATE), undefined)
  })
  test('a row of a kind that says nothing of an ask is skipped, so it neither hides an earlier reason nor stands for one', () => {
    assert.equal(whyOfRows([row({ kind: 'no-tier' }, 1000), row({ kind: 'dialog' }, 5000)], AT, LATE), 'no-tier')
    assert.equal(whyOfRows([row({ kind: 'dialog' })], AT, LATE), 'no-record')
  })
  test('rows older than the margin before the wait are the previous prompt\'s and do not count', () => {
    const prev = row({ kind: 'no-tier' }, -WHY_ROW_MARGIN_MS - 1)
    assert.equal(whyOfRows([prev], AT, LATE), 'no-record')
    const edge = row({ kind: 'no-tier' }, -WHY_ROW_MARGIN_MS)
    assert.equal(whyOfRows([edge], AT, LATE), 'no-tier')
  })
  test('two prompts in a row: a closing row of the first, newest, is no reason for the second', () => {
    const first = row({ kind: 'no-tier' }, -3000)
    const closed = row({ kind: 'returned' }, -1000)
    assert.equal(whyOfRows([first, closed], AT, LATE), undefined)
  })
  test('no row: "no record" only once the wait is old enough', () => {
    assert.equal(whyOfRows([], AT, AT + WHY_NO_RECORD_AFTER_MS - 1), undefined)
    assert.equal(whyOfRows([], AT, AT + WHY_NO_RECORD_AFTER_MS), 'no-record')
  })
  test('a row dated in the future (clock skew or a forged row) is ignored', () => {
    assert.equal(whyOfRows([row({ kind: 'relayed' }, 60 * 60_000)], AT, LATE), 'no-record')
    assert.equal(whyOfRows([row({ kind: 'no-tier' }, 1000), row({ kind: 'relayed' }, 60 * 60_000)], AT, LATE), 'no-tier')
  })
  test('a row with a bad time is ignored', () => {
    assert.equal(whyOfRows([row({ t: 'x', kind: 'no-tier' })], AT, LATE), 'no-record')
  })
})

describe('whyOfSwitch: the tier\'s own reading', () => {
  test('stored off, guard, and a scope that names none of the item\'s names', () => {
    assert.equal(whyOfSwitch({ storedOff: true, guard: false }, ['API']), 'stored-off')
    assert.equal(whyOfSwitch({ storedOff: false, guard: true }, ['API']), 'guard')
    assert.equal(whyOfSwitch({ storedOff: false, guard: false, scope: 'OTHER' }, ['API']), 'scope')
  })
  test('scope all, or naming the lane or its lead, or nothing known: no reason', () => {
    assert.equal(whyOfSwitch({ storedOff: false, guard: false, scope: 'all' }, ['API']), undefined)
    assert.equal(whyOfSwitch({ storedOff: false, guard: false, scope: 'API' }, ['API']), undefined)
    assert.equal(whyOfSwitch({ storedOff: false, guard: false }, ['API']), undefined)
  })
})

describe('whyOf: the whole decision', () => {
  const base = { offFile: false, at: AT, now: LATE, names: ['API'] as string[] }
  test('the OFF file wins, even with rows', () => {
    assert.equal(whyOf({ ...base, offFile: true, rows: [row({ kind: 'no-tier' })], view: undefined }), 'off-file')
  })
  test('a ledger that could not be read gives no reason', () => {
    assert.equal(whyOf({ ...base, rows: undefined, view: { storedOff: true, guard: false } }), undefined)
  })
  test('the hook\'s row beats the tier\'s reading of the switch', () => {
    assert.equal(whyOf({ ...base, rows: [row({ kind: 'no-tier' })], view: { storedOff: true, guard: false } }), 'no-tier')
  })
  test('no row: the tier\'s reading, else "no record"', () => {
    assert.equal(whyOf({ ...base, rows: [], view: { storedOff: false, guard: true } }), 'guard')
    assert.equal(whyOf({ ...base, rows: [], view: { storedOff: false, guard: false, scope: 'all' } }), 'no-record')
    assert.equal(whyOf({ ...base, rows: [], view: undefined }), 'no-record')
  })
  test('a wait that is too young says nothing, whatever the switch reads', () => {
    assert.equal(whyOf({ ...base, now: AT + 1000, rows: [], view: { storedOff: true, guard: false } }), undefined)
  })
})

describe('the check-in texts carry a reason', () => {
  const item = (lane: string, why?: c.WhyCode): c.AttentionItem => ({ lane, code: 'prompt', since: 1, ...(why ? { why } : {}) })
  test('every code has a fixed text, with no remedy and no command', () => {
    for (const [code, text] of Object.entries(c.WHY_TEXT)) {
      assert.ok(text.length > 0 && text.length < 140, code)
      assert.ok(!/\/callboard|approv|\bgo\b|allow|delete|remove|turn on|\brun\b/i.test(text), `${code}: ${text}`)
    }
  })
  test('a lane check-in lists the reason before the fixed tail; an item with none keeps only the tail', () => {
    const t = c.checkinText([item('API', 'no-tier'), item('WEB')]) as string
    assert.match(t, /\(waiting on a prompt for over 5 min\)/)
    assert.ok(t.includes(`What was seen at the last check: \`API\`: ${c.WHY_TEXT['no-tier']}.${c.CHECKIN_PROMPT_TAIL}`))
    assert.ok(!t.includes('`WEB`: ' + c.WHY_TEXT['no-tier']))
    const none = c.checkinText([item('WEB')]) as string
    assert.ok(none.includes(`each.${c.CHECKIN_PROMPT_TAIL}`) && !none.includes('What was seen'))
  })
  test('a lead check-in carries it too, and several reasons join with a semicolon', () => {
    const t = c.leadCheckinText([item('A', 'off-file'), item('B', 'no-record')]) as string
    assert.ok(t.includes(`What was seen at the last check: \`A\`: ${c.WHY_TEXT['off-file']}; \`B\`: ${c.WHY_TEXT['no-record']}.${c.CHECKIN_PROMPT_TAIL}`))
  })
  test('a reason on a gone or quiet item is not shown, and an unknown code is dropped', () => {
    const t = c.checkinText([{ lane: 'API', code: 'quiet', since: 1, why: 'no-tier' }, item('WEB', 'nonsense' as c.WhyCode)]) as string
    assert.ok(!t.includes('What was seen'))
  })
  test('the text still carries the sent note and no approval wording', () => {
    const t = c.checkinText([item('API', 'no-record')]) as string
    assert.ok(t.endsWith(c.SENT_NOTE))
  })
})
