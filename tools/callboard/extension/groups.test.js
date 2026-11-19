'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createGroups, groupsFor, COMMAND } = require('./groups.js')

const S = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const A = '/w/a'
const B = '/w/b'
const row = (n, cwd, extra = {}) => ({ sessionId: S(n), cwd, entrypoint: 'claude-vscode', ...extra })

// A fake VS Code and state: `commands` are the ids that exist, `calls` records every assign, `failing` makes the command throw.
function world({ commands = [COMMAND], rows = [], lanes = [], leads = [], folders = [A], done = [], failing = false, failOn = 0, failSid, refuse = [], loadError = false, alive = () => true } = {}) {
  const w = { calls: [], store: { done: [...done] }, updates: 0, listed: 0, looked: 0 }
  const vscode = {
    commands: {
      getCommands: async () => { w.looked++; return commands },
      executeCommand: async (cmd, ...args) => {
        assert.equal(cmd, COMMAND)
        if (failing || args[0] === failSid || w.calls.length + 1 === failOn) throw new Error('boom')
        w.calls.push(args)
        return !refuse.includes(args[0])
      },
    },
  }
  const state = { get: (k, d) => (k === 'callboard.groups.done' ? w.store.done : d), update: async (k, v) => { assert.equal(k, 'callboard.groups.done'); w.store.done = v; w.updates++ } }
  const registry = { list: async () => { w.listed++; return rows } }
  w.groups = createGroups({ vscode, registry, state, loadLanes: async () => { if (loadError) throw new Error('bad store'); return lanes }, loadLeads: async () => leads, workspaceFolders: () => folders, alive })
  return w
}

test('groupsFor: a lane to Lanes, a lead to Lead, a lead\'s conductor to Conductor; one group per session, records without a sid skipped', () => {
  const m = groupsFor([{ name: 'L1', sid: S(1) }, { name: 'L2' }], [{ name: 'LEAD', sid: S(2), conductorSid: S(3) }, { name: 'NEW', conductorSid: S(3) }])
  assert.deepEqual([...m], [[S(2), 'Lead'], [S(1), 'Lanes'], [S(3), 'Conductor']])
  assert.deepEqual([...groupsFor([{ sid: S(1) }], [{ sid: S(1), conductorSid: S(1) }])], [[S(1), 'Lead']], 'the first role wins')
})

test('the tick assigns each live session in the window to its group, once, and remembers it', async () => {
  const w = world({
    rows: [row(1, A), row(2, `${A}/sub`), row(3, A)],
    lanes: [{ sid: S(1) }],
    leads: [{ sid: S(2), conductorSid: S(3) }],
  })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(2), 'Lead'], [S(1), 'Lanes'], [S(3), 'Conductor']])
  assert.deepEqual(w.store.done.sort(), [S(1), S(2), S(3)].sort())
  await w.groups.tick()
  assert.equal(w.calls.length, 3, 'a second tick calls nothing more')
  assert.equal(w.listed, 1, 'and does not even read the registry')
})

test('a session outside the window, with no registry row, or with a dead process is left for later and not marked done', async () => {
  const w = world({
    rows: [row(1, B), row(2, A, { pid: 99 }), row(4, '/w/ab')],
    lanes: [{ sid: S(1) }, { sid: S(2) }, { sid: S(3) }, { sid: S(4) }],
    alive: () => false,
  })
  await w.groups.tick()
  assert.deepEqual(w.calls, [])
  assert.deepEqual(w.store.done, [])
})

test('a patched window with several folders serves a session in any of them', async () => {
  const w = world({ rows: [row(1, B)], lanes: [{ sid: S(1) }], folders: [A, B] })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Lanes']])
})

test('without the command (an unpatched Claude Code) nothing is read, called or stored', async () => {
  const w = world({ commands: ['other'], rows: [row(1, A)], lanes: [{ sid: S(1) }] })
  await w.groups.tick()
  assert.deepEqual([w.calls, w.listed, w.updates], [[], 0, 0])
})

test('a session already done is not called again, so one the person moved out of its group stays out', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }, { sid: S(2) }], done: [S(1)] })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(2), 'Lanes']])
})

test('a failing command is silent, marks nothing and is tried again at the next tick', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }], failing: true })
  await assert.doesNotReject(w.groups.tick())
  assert.deepEqual(w.store.done, [])
})

test('a session that always fails does not hold up the ones behind it, and is tried again at the next tick', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }, { sid: S(2) }], failSid: S(1) })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(2), 'Lanes']])
  assert.deepEqual(w.store.done, [S(2)])
  await w.groups.tick()
  assert.equal(w.listed, 2, 'the failed one is still to do')
})

test('a session the command refused (false: archived, or the list limits) is not marked done and is tried again', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }, { sid: S(2) }], refuse: [S(1)] })
  await w.groups.tick()
  assert.deepEqual(w.store.done, [S(2)])
  await w.groups.tick()
  assert.equal(w.calls.length, 3, 'the refused one is asked again')
})

test('an unreadable store is silent', async () => {
  const w = world({ loadError: true })
  await assert.doesNotReject(w.groups.tick())
  assert.deepEqual([w.calls, w.updates], [[], 0])
})

test('a tick that overlaps another is skipped', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }] })
  await Promise.all([w.groups.tick(), w.groups.tick()])
  assert.equal(w.calls.length, 1)
  assert.equal(w.listed, 1)
})

test('only sessions the stores still name stay in the done list, and an unchanged list is not written again', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }], done: [S(7), S(1)] })
  await w.groups.tick()
  assert.deepEqual(w.store.done, [S(1)])
  assert.equal(w.updates, 1)
  await w.groups.tick()
  assert.equal(w.updates, 1)
})

test('once the command is seen it is not looked up again', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }] })
  await w.groups.tick()
  await w.groups.tick()
  assert.equal(w.looked, 1)
})
