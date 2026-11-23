import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REMOTE_GAP_MS, REMOTE_TRIES, isLane, procKey, remoteDue, remoteFailed, remoteMemo, remoteRefusal, remoteWish } from './remote.ts'
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

test('a row with no wish wants off and is not met; a wish is its own value and its mark', () => {
  const row = { name: 'x', folder: '/w' }
  assert.deepEqual(remoteWish(row), { on: false, at: 0 })
  assert.deepEqual(remoteWish({ ...row, remote: { on: true, at: 7 } }), { on: true, at: 7 })
  assert.deepEqual(remoteWish({ ...row, remote: { on: true, met: '10@Tue' } }), { on: true, at: 0, met: '10@Tue' })
  assert.deepEqual(remoteWish({ ...row, remote: { on: false, at: 7, met: '10@Tue' } }), { on: false, at: 7, met: '10@Tue' })
})

test('a process is named by its pid and start time', () => {
  assert.equal(procKey({ pid: 10, procStart: 'Tue Oct 27 20:37:50 2026' }), '10@Tue Oct 27 20:37:50 2026')
})

test('a changed wish, or one set again, starts the counts again; an unchanged one keeps them', () => {
  const m: RemoteMemo = { wish: false, id: 4, tries: 3, at: NOW }
  assert.equal(remoteMemo(m, false, 4), m)
  assert.deepEqual(remoteMemo(m, true, 4), { wish: true, id: 4, tries: 0, at: 0 })
  assert.deepEqual(remoteMemo(m, false, 5), { wish: false, id: 5, tries: 0, at: 0 })
  assert.deepEqual(remoteMemo(undefined, false, 0), { wish: false, id: 0, tries: 0, at: 0 })
})

test('an ask is due once the pause is over, and never after the asking ended', () => {
  const m: RemoteMemo = { wish: false, id: 0, tries: 1, at: NOW }
  assert.equal(remoteDue(m, NOW + REMOTE_GAP_MS - 1), false)
  assert.equal(remoteDue(m, NOW + REMOTE_GAP_MS), true)
  assert.equal(remoteDue({ ...m, stopped: 'busy' }, NOW + 10 * REMOTE_GAP_MS), false)
})

test('a failed ask: a window without the patch ends the asking, any other code ends it after REMOTE_TRIES', () => {
  let m: RemoteMemo = { wish: true, id: 0, tries: 2, at: 0 }
  assert.deepEqual(remoteFailed(m, 'patch-missing', NOW), { wish: true, id: 0, tries: 3, at: NOW, stopped: 'patch-missing' })
  m = { wish: true, id: 0, tries: 0, at: 0 }
  for (let i = 1; i < REMOTE_TRIES; i++) {
    m = remoteFailed(m, 'no-channel', NOW)
    assert.equal(m.stopped, undefined, `try ${i}`)
  }
  assert.equal(remoteFailed(m, 'no-channel', NOW).stopped, 'no-channel')
})
