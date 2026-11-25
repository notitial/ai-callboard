import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HANDOVERS_MAX, dropHandover, groupOf, handOver, historicName, nextNumber, parseHandovers, parseMarker, recordHandover, recordRetired } from './handover.ts'
import type { Marker } from './handover.ts'
import { liveView } from './model.ts'
import type { Table } from './model.ts'
import { MANAGER, reg } from '../../test/gen.ts'

const marker: Marker = { old: 'sid-a', pid: 7, procStart: 'Tue Oct 27 20:37:50 2026', name: 'LEAD', historic: 'LEAD~1', file: '/Users/x/repo/.archive/n.md', continuation: 'go on', phase: 'clearing', at: 5, failed: [] }

test('a marker is read whole or not at all', () => {
  assert.deepEqual(parseMarker(JSON.parse(JSON.stringify(marker))), marker)
  assert.deepEqual(parseMarker({ ...marker, name: null, brief: 'b', failed: ['goes'] })?.brief, 'b')
  for (const bad of [null, [], 'x', { ...marker, pid: 1.5 }, { ...marker, phase: 'done' }, { ...marker, failed: [1] }, { ...marker, brief: 3 }, { ...marker, at: 'now' }, { ...marker, name: 5 }]) assert.equal(parseMarker(bad), undefined)
  assert.equal(parseMarker({ ...marker, failed: ['a', 'b', 'c', 'd', 'e'] })?.failed.length, 4)
})

test('the counter file reads whole; a number is one past every name already in use', () => {
  assert.equal(parseHandovers([]), undefined)
  assert.equal(parseHandovers({ A: { n: 'x', old: [] } }), undefined)
  assert.deepEqual(parseHandovers({ A: { n: 2, old: [{ sid: 's', group: 'Lead', folder: '/f', at: 1 }, { sid: 's', group: 'Nope', folder: '/f', at: 1 }] } }), { A: { n: 2, old: [{ sid: 's', group: 'Lead', folder: '/f', at: 1 }] } })
  assert.deepEqual(parseHandovers(JSON.parse('{"__proto__":{"n":1,"old":[]},"B":{"n":1,"old":[]}}')), { B: { n: 1, old: [] } })
  assert.equal(nextNumber({}, 'A', []), 1)
  assert.equal(nextNumber({ A: { n: 3, old: [] } }, 'A', [undefined, 'B~9']), 4)
  assert.equal(nextNumber({ A: { n: 1, old: [] } }, 'A', ['A~5', 'A~x', 'A']), 6)
  assert.equal(historicName('A', 6), 'A~6')
})

test('recording keeps the newest old sessions up to the cap; dropping removes one entry and keeps the number', () => {
  let h = recordHandover({}, 'A', 1, { sid: 's0', group: 'Lead', folder: '/f', at: 0 })
  for (let i = 1; i <= HANDOVERS_MAX; i++) h = recordHandover(h, 'A', i + 1, { sid: `s${i}`, group: 'Lead', folder: '/f', at: i })
  assert.equal(h.A.old.length, HANDOVERS_MAX)
  assert.ok(!h.A.old.some((o) => o.sid === 's0'))
  assert.equal(h.A.n, HANDOVERS_MAX + 1)
  const d = dropHandover(h, `s${HANDOVERS_MAX}`)
  assert.equal(d.A.old.length, HANDOVERS_MAX - 1)
  assert.equal(d.A.n, h.A.n)
  assert.deepEqual(recordHandover({}, 'B', 1, undefined), { B: { n: 1, old: [] } })
})

const lanes: Table = {
  'sid-a': { name: 'LEAD', folder: '/w/a', lead: { repos: ['/w/a'] }, parked: true, goneAt: 3 },
  'sid-l': { name: 'L1', folder: '/w/a', under: 'sid-a', brief: 'b' },
  'sid-n': { name: 'L2', folder: '/w/a', under: 'new:abc' },
  'sid-z': { name: 'Z', folder: '/w/z', under: 'sid-a' },
}

test('the row of the old id moves to the new id under the name; every child follows; the old key is gone', () => {
  const t = handOver(lanes, 'sid-a', 'sid-b', 'LEAD') as Table
  assert.deepEqual(Object.keys(t).sort(), ['sid-b', 'sid-l', 'sid-n', 'sid-z'])
  assert.deepEqual(t['sid-b'], { name: 'LEAD', folder: '/w/a', lead: { repos: ['/w/a'] } })
  assert.equal(t['sid-l'].under, 'sid-b')
  assert.equal(t['sid-z'].under, 'sid-b')
  assert.equal(t['sid-n'].under, 'new:abc')
  assert.equal(lanes['sid-l'].under, 'sid-a')
})

test('a lane handed over keeps its Remote Control mark: the process is the same', () => {
  const t: Table = { 'sid-l': { name: 'L1', folder: '/w/a', under: 'sid-a', remote: { on: true, at: 3, met: '7@Tue Oct 27 20:37:50 2026' } } }
  assert.deepEqual((handOver(t, 'sid-l', 'sid-m', 'L1') as Table)['sid-m'].remote, { on: true, at: 3, met: '7@Tue Oct 27 20:37:50 2026' })
})

test('a name Claude generated is not written; a loose session moves nothing; done already is the same table; both keys is a clash', () => {
  assert.equal((handOver(lanes, 'sid-a', 'sid-b', null) as Table)['sid-b'].name, 'LEAD')
  assert.deepEqual(handOver({ 'sid-q': { name: 'Q', folder: '/f' } }, 'sid-a', 'sid-b', 'A'), { 'sid-q': { name: 'Q', folder: '/f' } })
  const once = handOver(lanes, 'sid-a', 'sid-b', 'LEAD') as Table
  assert.deepEqual(handOver(once, 'sid-a', 'sid-b', 'LEAD'), once)
  assert.equal(handOver({ ...lanes, 'sid-b': { name: 'LEAD', folder: '/w/a' } }, 'sid-a', 'sid-b', 'LEAD'), 'clash')
})

test('a lane and its lead handed over, in either order, end on the same table', () => {
  const lead = (t: Table) => handOver(t, 'sid-a', 'sid-b', 'LEAD') as Table
  const lane = (t: Table) => handOver(t, 'sid-l', 'sid-m', 'L1') as Table
  assert.deepEqual(lane(lead(lanes)), lead(lane(lanes)))
  assert.equal(lane(lead(lanes))['sid-m'].under, 'sid-b')
})

test('a session\'s group is the one the extension files it in', () => {
  const t: Table = { ...lanes, 'sid-off': { name: 'O', folder: '/w', under: 'sid-a', off: true } }
  const v = liveView([reg('sid-m', MANAGER), reg('sid-a', 'LEAD'), reg('sid-l', 'L1'), reg('sid-q', 'Q'), reg('sid-off', 'O')], t, MANAGER)
  assert.equal(groupOf(v, 'sid-m'), 'Manager')
  assert.equal(groupOf(v, 'sid-a'), 'Lead')
  assert.equal(groupOf(v, 'sid-l'), 'Lanes')
  assert.equal(groupOf(v, 'sid-q'), 'Lanes', 'a loose session is recorded under the lanes\' group')
  assert.equal(groupOf(v, 'sid-off'), undefined)
})

test('rows that left the table are recorded as archive entries for lanes and minted leads only, each in its own group', () => {
  const t: Table = {
    L: { name: 'lead', folder: '/w/l', lead: { repos: [] } },
    A: { name: 'lane', folder: '/w/a', under: 'L' },
    M: { name: 'minted', folder: '/w/m', under: 'C', lead: { repos: [], minted: true } },
    C: { name: 'cond', folder: '/w/c', lead: { repos: [], conductor: true } },
    O: { name: 'off', folder: '/w/o', under: 'L', off: true },
    X: { name: 'loose', folder: '/w/x' },
    'new:N': { name: 'N', folder: '/w/n', under: 'L' },
  }
  const v = liveView([], t, null)
  assert.deepEqual(recordRetired({}, v, ['A', 'M', 'L', 'C', 'O', 'X', 'new:N', 'gone'], 5), {
    lane: { n: 0, old: [{ sid: 'A', group: 'Lanes', folder: '/w/a', at: 5, archive: true }] },
    minted: { n: 0, old: [{ sid: 'M', group: 'Lead', folder: '/w/m', at: 5, archive: true }] },
  })
  assert.equal(recordRetired({ lane: { n: 3, old: [] } }, v, ['A'], 5).lane!.n, 3, 'the number of a name stays')
})
