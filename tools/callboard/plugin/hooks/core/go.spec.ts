import { test } from 'node:test'
import assert from 'node:assert/strict'
import { covers, goCommand, goTextOk, parseGo } from './go.ts'
import { ancestors, liveView } from './model.ts'
import type { Go, Table } from './model.ts'
import { MANAGER, NOW, forAll, pick, reg } from './gen.spec.ts'

test('a go covers only its giver and the sessions under the giver now, until its end', () => {
  forAll(400, (r, w) => {
    const g: Go = { id: 'g', giver: pick(r, w.sids), text: 'build it', end: NOW + (r() < 0.2 ? -1 : 3_600_000) }
    for (const reader of w.sids) {
      if (!covers(g, reader, w.v, NOW)) continue
      assert.ok(NOW < g.end)
      assert.ok(reader === g.giver || ancestors(w.v, reader).includes(g.giver), `${reader} covered by a go of ${g.giver}`)
    }
  })
  // A go given in the manager covers every session under it; one given in a lead does not cover the lead's sibling or its manager.
  const M = 'sid-manager'
  const table: Table = { 'sid-a': { name: 'A', folder: '/', lead: { repos: [] } }, 'sid-l1': { name: 'L1', folder: '/', under: 'sid-a' } }
  const v = liveView([reg(M, MANAGER), reg('sid-a', 'A'), reg('sid-l1', 'L1'), reg('sid-loose', 'x')], table, MANAGER)
  const inManager: Go = { id: 'g', giver: M, text: 't', end: NOW + 1 }
  assert.ok(['sid-a', 'sid-l1', 'sid-loose'].every((s) => covers(inManager, s, v, NOW)))
  const inLead: Go = { ...inManager, giver: 'sid-a' }
  assert.ok(covers(inLead, 'sid-l1', v, NOW) && !covers(inLead, 'sid-loose', v, NOW) && !covers(inLead, M, v, NOW))
  // The lead gone: its go covers nobody under it meanwhile.
  assert.ok(!covers(inLead, 'sid-l1', liveView([reg(M, MANAGER), reg('sid-l1', 'L1')], table, MANAGER), NOW))
})

test('a go\'s text: one to three plain lines the person can read, nothing hidden and no fence; a file that is not a go is no go', () => {
  assert.ok(goTextOk('Build steps 1 to 5.\nNo merge.'))
  for (const bad of ['', ' padded', 'a\n\nb', 'x'.repeat(301), 'a\nb\nc\nd', 'zero\u200bwidth', '>>> fence', 'tab\there', 7]) assert.ok(!goTextOk(bad), JSON.stringify(bad))
  assert.equal(parseGo({ id: 'g', giver: 's', text: 'ok', end: 'tomorrow' }), undefined)
  assert.equal(parseGo(null), undefined)
  assert.deepEqual(parseGo({ id: 'g', giver: 's', text: 'ok', end: 5, extra: 1 }), { id: 'g', giver: 's', text: 'ok', end: 5 })
  assert.deepEqual(goCommand(' off '), { op: 'off' })
  assert.deepEqual(goCommand('off abcd1234'), { op: 'off', id: 'abcd1234' })
  assert.deepEqual(goCommand('build the core'), { op: 'give', text: 'build the core' })
  assert.equal(goCommand('   '), 'bad')
})
