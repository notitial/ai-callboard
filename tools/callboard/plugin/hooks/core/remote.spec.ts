import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REMOTE_GAP_MS, REMOTE_TRIES, isLane, remoteAnswered, remoteDue, remoteMemo, remoteRefusal } from './remote.ts'
import type { RemoteMemo } from './remote.ts'
import { liveView } from './model.ts'
import type { Table } from './model.ts'
import { MANAGER, NOW, reg } from '../../test/gen.ts'

const table: Table = {
  lead: { name: 'lead', folder: '/w/a', lead: { repos: [] } },
  lane: { name: 'lane', folder: '/w/a', under: 'lead' },
  off: { name: 'off', folder: '/w/a', under: 'lead', off: true },
  top: { name: 'top', folder: '/w/a' },
}
const v = liveView([reg('mgr', MANAGER), reg('lead', 'lead'), reg('lane', 'lane')], table, MANAGER)

test('only a lane carries the wish: not a lead, the manager, an off session, a row nothing is above or no row at all', () => {
  assert.equal(remoteRefusal(v, 'lane'), undefined)
  assert.deepEqual(['lead', 'off', 'top', 'gone', 'mgr'].map((k) => remoteRefusal(v, k)), ['is-lead', 'is-off', 'no-such-lane', 'no-such-lane', 'no-such-lane'])
  const withManagerRow = liveView([reg('mgr', MANAGER)], { mgr: { name: MANAGER, folder: '/w/m', under: 'lead' } }, MANAGER)
  assert.equal(remoteRefusal(withManagerRow, 'mgr'), 'is-manager')
  assert.equal(isLane(v, 'lane'), true)
  assert.equal(isLane(v, 'lead'), false)
})

test('a changed wish starts the counts again; an unchanged one keeps them', () => {
  const m: RemoteMemo = { wish: false, tries: 3, at: NOW }
  assert.equal(remoteMemo(m, false), m)
  assert.deepEqual(remoteMemo(m, true), { wish: true, tries: 0, at: 0 })
  assert.deepEqual(remoteMemo(undefined, false), { wish: false, tries: 0, at: 0 })
})

test('an ask is due once the pause is over, and never after the asking ended', () => {
  const m: RemoteMemo = { wish: false, tries: 1, at: NOW }
  assert.equal(remoteDue(m, NOW + REMOTE_GAP_MS - 1), false)
  assert.equal(remoteDue(m, NOW + REMOTE_GAP_MS), true)
  assert.equal(remoteDue({ ...m, stopped: 'busy' }, NOW + 10 * REMOTE_GAP_MS), false)
})

test('an answer: ok counts no failure, a window without the patch ends the asking, any other code ends it after REMOTE_TRIES', () => {
  let m: RemoteMemo = { wish: true, tries: 2, at: 0 }
  assert.deepEqual(remoteAnswered(m, 'ok', NOW), { wish: true, tries: 0, at: NOW })
  assert.deepEqual(remoteAnswered(m, 'patch-missing', NOW), { wish: true, tries: 3, at: NOW, stopped: 'patch-missing' })
  m = { wish: true, tries: 0, at: 0 }
  for (let i = 1; i < REMOTE_TRIES; i++) {
    m = remoteAnswered(m, 'no-channel', NOW)
    assert.equal(m.stopped, undefined, `try ${i}`)
  }
  assert.equal(remoteAnswered(m, 'no-channel', NOW).stopped, 'no-channel')
})
