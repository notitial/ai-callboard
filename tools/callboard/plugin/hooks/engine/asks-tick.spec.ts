import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN, T0, as, peer, tiers } from '../../test/fake.ts'
import type { Ask } from '../core/model.ts'
import { readAskLog, readAsks, writeAsk } from './store.ts'
import { sessionStart } from './tick.ts'

const noop = Object.assign(async () => ({}), { signal: undefined })
const mk = (id: string, asker: string, beat: number): Ask => ({ id, asker, t0: beat, awake: 0, window: null, personOnly: false, tool: 'Bash', raisedBy: 'unknown', input: '{}', cut: false, beat })

test('the sweep: a dead asker\'s ask is removed and logged; a stale beat of a live asker that still waits is told once; one whose row no longer waits is removed', async () => {
  const f = tiers()
  const lead = peer(f, 'sid-lead')
  f.seed({ sid: 'sid-gone', pid: 14, name: 'gone', kind: 'interactive', status: 'busy' })
  await as(() => sessionStart(lead.$, {}, noop))
  const old = T0 - 5 * MIN
  await writeAsk(f.$, mk('aa11bb22cc', 'sid-dead', T0))
  await writeAsk(f.$, mk('bb11cc22dd', 'sid-me', old))
  await writeAsk(f.$, mk('cc11dd22ee', 'sid-gone', old))
  await writeAsk(f.$, mk('dd11ee22ff', 'sid-me', T0 + 2 * MIN))
  f.h.now += 2 * MIN
  await as(async () => void (await lead.h.every!()))
  assert.deepEqual((await readAsks(f.$)).asks.map((a) => a.id).sort(), ['bb11cc22dd', 'dd11ee22ff'])
  assert.deepEqual((await readAskLog(f.$, 0))!.filter((r) => r.ev === 'swept').map((r) => [r.ev, r.ask]).sort(), [['swept', 'aa11bb22cc'], ['swept', 'cc11dd22ee']])
  assert.equal(lead.h.toasts.filter((t) => /no process to answer/.test(t)).length, 1)
  f.h.now += 40_000
  await as(async () => void (await lead.h.every!()))
  assert.equal(lead.h.toasts.filter((t) => /no process to answer/.test(t)).length, 1)
})
