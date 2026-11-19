import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WINDOW_MAX_MS, WINDOW_MIN_MS, parseSpan, readWindow, returnList } from './unattended.ts'
import type { AskLogRow, WindowReading } from './model.ts'
import { NOW } from './gen.spec.ts'

test('the span: Nm, Nh and HH:MM, between 30 minutes and 14 hours from now; anything else is refused', () => {
  assert.deepEqual(parseSpan('', NOW), { op: 'state' })
  assert.deepEqual(parseSpan('off', NOW), { op: 'off' })
  assert.deepEqual(parseSpan('8h', NOW), { op: 'on', end: NOW + 8 * 3_600_000 })
  assert.deepEqual(parseSpan('90m', NOW), { op: 'on', end: NOW + 90 * 60_000 })
  assert.deepEqual(parseSpan('1.5 h', NOW), { op: 'on', end: NOW + 90 * 60_000 })
  assert.equal(parseSpan('29m', NOW).op, 'short')
  assert.equal(parseSpan('15h', NOW).op, 'long')
  for (const bad of ['8', 'tomorrow', '25:00', 'on', '-1h']) assert.deepEqual(parseSpan(bad, NOW), { op: 'bad' })
  // HH:MM is the next such local time, from a pinned local 22:00.
  const ten = new Date(NOW)
  ten.setHours(22, 0, 0, 0)
  const t = ten.getTime()
  const local = (h: number, m: number, day = 0) => new Date(ten.getFullYear(), ten.getMonth(), ten.getDate() + day, h, m).getTime()
  assert.deepEqual(parseSpan('23:30', t), { op: 'on', end: local(23, 30) })
  assert.deepEqual(parseSpan('06:15', t), { op: 'on', end: local(6, 15, 1) })
  assert.deepEqual(parseSpan('22:10', t), { op: 'short', earliest: t + WINDOW_MIN_MS })
  assert.deepEqual(parseSpan('21:00', t), { op: 'long', latest: t + WINDOW_MAX_MS })
})

test('the window file: on only inside its span; no file is off; a failed read keeps the last good reading until it ends, and with none is unknown', () => {
  const w = { start: NOW - 1000, end: NOW + 3_600_000, readAt: 0 }
  const on: WindowReading = { state: 'on', window: w }
  assert.deepEqual(readWindow(w, NOW), on)
  assert.deepEqual(readWindow(w, w.end), { state: 'off' })
  assert.deepEqual(readWindow(undefined, NOW), { state: 'off' })
  assert.deepEqual(readWindow('unreadable', NOW), { state: 'unknown' })
  assert.deepEqual(readWindow({ start: NOW, end: NOW + 20 * 3_600_000 }, NOW), { state: 'unknown' })
  assert.deepEqual(readWindow('unreadable', NOW, on), on)
  assert.deepEqual(readWindow('unreadable', w.end, on), { state: 'off' })
  assert.deepEqual(readWindow(null, NOW, { state: 'off' }), { state: 'off' })
})

test('the list for his return: what nobody decided and what a session decided, inside the window only', () => {
  const w = { start: NOW, end: NOW + 3_600_000, readAt: 0 }
  const row = (t: number, ev: AskLogRow['ev']): AskLogRow => ({ t, ev, ask: `${ev}-${t}`, asker: 's' })
  const log = [row(NOW - 1, 'expired'), row(NOW + 1, 'expired'), row(NOW + 2, 'left-for-person'), row(NOW + 3, 'answered'), row(NOW + 4, 'raised'), row(w.end + 1, 'expired')]
  const l = returnList(log, w)
  assert.deepEqual(l.open.map((r) => r.t), [NOW + 1, NOW + 2])
  assert.deepEqual(l.decided.map((r) => r.t), [NOW + 3])
})
