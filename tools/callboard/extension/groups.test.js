'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createGroups, groupsFor, managerOf, readManagerName, readSessionTable, COMMAND, ARCHIVE, ORDER } = require('./groups.js')

const S = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const A = '/w/a'
const B = '/w/b'
const row = (n, cwd, extra = {}) => ({ sessionId: S(n), cwd, entrypoint: 'claude-vscode', ...extra })

// A fake VS Code and state: `commands` are the ids that exist, `calls` records every call's session and group (the order argument is checked on each),
// `failing` makes the command throw. `leads` and `lanes` are sessions with a table row of that role (a lead with `lead`, a lane `under` S(99)); `table` adds
// rows as they are. `done` is the stored record; `manager` the manager-name file's line (an Error: a file that cannot be read); `incomplete` marks the registry read as one with doubt in it.
// `startOf` is `ps`: by default each pid starts when its row says, so a row whose pid answers is its own process.
// `seen` is the stored record of lanes seen running, `seenLeads` that of conductor-made leads; `archived` records every call of the archive command (group, ids), which `archiveFails` makes throw; it answers the ids it was given, or what `archiveAnswers` says.
function world({ commands = [COMMAND], rows = [], lanes = [], leads = [], table: extra = {}, folders = [A], done = {}, seen = [], seenLeads = [], manager = null, incomplete = false, failing = false, failOn = 0, failSid, refuse = [], loadError = false, missingTable = false, archiveFails = false, archiveAnswers, alive = () => true, startOf = async (pid) => rows.find((r) => r.pid === pid)?.procStart } = {}) {
  const table = { ...Object.fromEntries(lanes.map((l) => [l.sid, { name: 'L', folder: A, under: S(99) }])), ...Object.fromEntries(leads.map((l) => [l.sid, { name: 'D', folder: A, lead: { repos: [] } }])), ...extra }
  const w = { calls: [], archived: [], store: { done, seen, seenLeads }, keys: new Set(), updates: 0, listed: 0, looked: 0, table }
  const vscode = {
    commands: {
      getCommands: async () => { w.looked++; return commands },
      executeCommand: async (cmd, sid, group, order) => {
        if (cmd === ARCHIVE) {
          if (archiveFails) throw new Error('boom')
          w.archived.push([sid, group])
          return archiveAnswers ? archiveAnswers(group) : group
        }
        assert.equal(cmd, COMMAND)
        assert.deepEqual(order, ['Manager', 'Conductor', 'Lead', 'Lanes'])
        if (failing || sid === failSid || w.calls.length + 1 === failOn) throw new Error('boom')
        w.calls.push([sid, group])
        return !refuse.includes(sid)
      },
    },
  }
  const keys = { 'callboard.groups.done': 'done', 'callboard.groups.seen': 'seen', 'callboard.groups.seenLeads': 'seenLeads' }
  // The records are keyed by the window's first folder. Another key throws inside the tick, which is silent, so that tick files and stores nothing; `keys` holds the keys used.
  const part = (k) => { const at = k.lastIndexOf(':'); assert.equal(k.slice(at + 1), folders[0] ?? ''); assert.ok(keys[k.slice(0, at)], k); w.keys.add(k); return keys[k.slice(0, at)] }
  const state = { get: (k) => w.store[part(k)], update: async (k, v) => { w.store[part(k)] = v; if (part(k) === 'done') w.updates++ } }
  const registry = { list: async () => { w.listed++; return Object.defineProperty([...rows], 'complete', { value: !incomplete }) } }
  w.groups = createGroups({ vscode, registry, state, loadTable: async () => { if (loadError || w.doubt) throw new Error('bad table'); return missingTable ? null : table }, managerName: async () => { if (manager instanceof Error) throw manager; return manager }, workspaceFolders: () => folders, alive, startOf })
  return w
}
// A session carrying the manager's name, with a pid and a start time.
const boss = (n, procStart = '2026-11-21T09:00:00Z', extra = {}) => row(n, A, { name: 'BOSS', pid: 100 + n, procStart, ...extra })

test('groupsFor: the manager, a conductor, a lead (a minted one too) and a lane each to their group; a loose, off or empty row is not filed', () => {
  const m = groupsFor({ [S(1)]: { lead: {} }, [S(2)]: { under: S(1) }, [S(3)]: {}, [S(4)]: { under: S(1), off: true }, [S(5)]: null, [S(6)]: { lead: { conductor: true } }, [S(7)]: { lead: { conductor: true, minted: true }, under: S(6) } }, S(8))
  assert.deepEqual([...m], [[S(8), 'Manager'], [S(1), 'Lead'], [S(2), 'Lanes'], [S(6), 'Conductor'], [S(7), 'Lead']])
  assert.deepEqual([...groupsFor({ [S(1)]: { lead: {}, under: S(2) } })], [[S(1), 'Lead']], 'one group per session, the lead role first')
  assert.deepEqual([...groupsFor({ [S(1)]: { lead: { conductor: true } } }, S(1))], [[S(1), 'Manager']], 'the manager wins over its row')
  assert.deepEqual([...groupsFor()], [])
  assert.deepEqual(ORDER, ['Manager', 'Conductor', 'Lead', 'Lanes'])
})

test('managerOf: the oldest proven row with the name, not one whose row is off or whose process is dead; unknown when one cannot be told; none without a name', async () => {
  const live = async () => 'live'
  const rows = [boss(1, '2026-11-21T10:00:00Z'), { ...boss(2, '2026-11-21T09:00:00Z'), cwd: B }, row(3, A, { name: 'OTHER', pid: 103, procStart: '2026-11-21T08:00:00Z' })]
  assert.equal(await managerOf(rows, {}, 'BOSS', live), S(2), 'the oldest, in any window')
  assert.equal(await managerOf(rows, { [S(2)]: { off: true } }, 'BOSS', live), S(1))
  assert.equal(await managerOf(rows, {}, 'BOSS', async (pid) => (pid === 102 ? 'dead' : 'live')), S(1), 'a dead row (its pid gone or reused) is not the manager')
  assert.equal(await managerOf(rows, {}, 'BOSS', async (pid) => (pid === 101 ? 'maybe' : 'live')), 'unknown', 'one row that cannot be told makes the manager unknown')
  assert.equal(await managerOf(rows, {}, null, live), undefined)
  assert.equal(await managerOf(rows, {}, 'NOBODY', live), undefined)
  assert.equal(await managerOf([boss(4, null), boss(1, '2026-11-21T10:00:00Z')], {}, 'BOSS', live), S(1), 'a row with no start time is the youngest')
})

test('readManagerName: the first line trimmed; null for a missing or empty file; a file that cannot be read throws', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'))
  try {
    fs.writeFileSync(path.join(d, 'n'), '  BOSS  \nsecond\n')
    fs.writeFileSync(path.join(d, 'e'), '\n')
    assert.equal(await readManagerName(path.join(d, 'n')), 'BOSS')
    assert.equal(await readManagerName(path.join(d, 'e')), null)
    assert.equal(await readManagerName(path.join(d, 'missing')), null)
    await assert.rejects(readManagerName(d), 'a folder is no read: the tick waits')
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

test('the tick files each live session in the window in its group, once, and remembers the group', async () => {
  const w = world({
    rows: [row(1, A), row(2, `${A}/sub`), boss(3)],
    lanes: [{ sid: S(1) }],
    leads: [{ sid: S(2) }],
    manager: 'BOSS',
  })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(3), 'Manager'], [S(1), 'Lanes'], [S(2), 'Lead']])
  assert.deepEqual(w.store.done, { [S(3)]: 'Manager', [S(1)]: 'Lanes', [S(2)]: 'Lead' })
  await w.groups.tick()
  assert.equal(w.calls.length, 3, 'a second tick calls nothing more')
})

test('a session whose tier changes is filed again in its new group', async () => {
  const table = { [S(1)]: { name: 'C', folder: A, lead: { repos: [] } } }
  const w = world({ rows: [row(1, A)], table })
  await w.groups.tick()
  table[S(1)].lead.conductor = true
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Lead'], [S(1), 'Conductor']])
  assert.deepEqual(w.store.done, { [S(1)]: 'Conductor' })
})

test('a stored list is no record: every session is filed once more, then remembered', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }], table: { [S(2)]: { name: 'C', folder: A, lead: { repos: [], conductor: true } } }, done: [S(1), S(2)] })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Lanes'], [S(2), 'Conductor']])
  assert.deepEqual(w.store.done, { [S(1)]: 'Lanes', [S(2)]: 'Conductor' })
})

test('a session outside the window, with no registry row, or with a dead process is left for later and not remembered', async () => {
  const w = world({
    rows: [row(1, B), row(2, A, { pid: 99 }), row(4, '/w/ab')],
    lanes: [{ sid: S(1) }, { sid: S(2) }, { sid: S(3) }, { sid: S(4) }],
    alive: () => false,
  })
  await w.groups.tick()
  assert.deepEqual(w.calls, [])
  assert.deepEqual(w.store.done, {})
})

test('a dead process carrying the manager name is not the manager', async () => {
  const w = world({ rows: [row(1, A, { name: 'BOSS', pid: 7, procStart: '2026-11-21T08:00:00Z' }), row(2, A, { name: 'BOSS', pid: 8, procStart: '2026-11-21T09:00:00Z' })], manager: 'BOSS', alive: (pid) => pid === 8 })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(2), 'Manager']])
  const rows = [boss(1, '2026-11-21T08:00:00Z'), boss(2, '2026-11-21T09:00:00Z')]
  const reused = world({ rows, manager: 'BOSS', startOf: async (pid) => (pid === 101 ? 'Sat Nov 21 11:00:00 2026' : rows[1].procStart) })
  await reused.groups.tick()
  assert.deepEqual(reused.calls, [[S(2), 'Manager']], 'an older row whose pid another process took is dead too')
})

test('a manager-named row whose process cannot be told files nothing that tick, as the plugin then knows no manager', async () => {
  const w = world({ rows: [boss(1), row(2, A)], lanes: [{ sid: S(2) }], manager: 'BOSS', startOf: async () => undefined })
  await w.groups.tick()
  assert.deepEqual([w.calls, w.updates], [[], 0])
})

test('a manager closed and resumed with the same session id is not filed again, so a hand move stays', async () => {
  const rows = [boss(1), row(2, A)]
  const w = world({ rows, lanes: [{ sid: S(2) }], manager: 'BOSS' })
  await w.groups.tick()
  const up = rows.shift()
  await w.groups.tick()
  assert.deepEqual(w.store.done, { [S(1)]: 'Manager', [S(2)]: 'Lanes' }, 'its entry is kept while no manager runs')
  rows.unshift(up)
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Manager'], [S(2), 'Lanes']])
  rows.splice(0, 1, boss(3))
  await w.groups.tick()
  assert.deepEqual(w.store.done, { [S(3)]: 'Manager', [S(2)]: 'Lanes' }, 'a new manager running drops the old entry')
})

test('a registry read with doubt in it, or a manager-name file that cannot be read, files nothing', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }], incomplete: true })
  await w.groups.tick()
  assert.deepEqual([w.calls, w.updates], [[], 0])
  const m = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }], manager: new Error('EACCES') })
  await assert.doesNotReject(m.groups.tick())
  assert.deepEqual([m.calls, m.updates], [[], 0])
})

test('a patched window with several folders serves a session in any of them', async () => {
  const w = world({ rows: [row(1, B)], lanes: [{ sid: S(1) }], folders: [A, B] })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Lanes']])
})

test('the records are kept under the window\'s first folder, as Claude keeps its groups', async () => {
  const w = world({ commands: [COMMAND, ARCHIVE], rows: [row(1, A)], lanes: [{ sid: S(1) }], folders: [B, A] })
  await w.groups.tick()
  assert.deepEqual([...w.keys].sort(), [`callboard.groups.done:${B}`, `callboard.groups.seen:${B}`, `callboard.groups.seenLeads:${B}`])
  assert.deepEqual([w.store.done, w.store.seen], [{ [S(1)]: 'Lanes' }, [S(1)]])
})

test('without the command (an unpatched Claude Code, or one with only `callboard assign group`) nothing is read, called or stored', async () => {
  const w = world({ commands: ['other', 'callboard assign group'], rows: [row(1, A)], lanes: [{ sid: S(1) }] })
  await w.groups.tick()
  assert.deepEqual([w.calls, w.listed, w.updates], [[], 0, 0])
})

test('a session already filed in its group is not called again, so one the person moved by hand stays moved', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }, { sid: S(2) }], done: { [S(1)]: 'Lanes' } })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(2), 'Lanes']])
})

test('a failing command is silent, remembers nothing and is tried again at the next tick', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }], failing: true })
  await assert.doesNotReject(w.groups.tick())
  assert.deepEqual(w.store.done, {})
})

test('a session that always fails does not hold up the ones behind it, and is tried again at the next tick', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }, { sid: S(2) }], failSid: S(1) })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(2), 'Lanes']])
  assert.deepEqual(w.store.done, { [S(2)]: 'Lanes' })
  await w.groups.tick()
  assert.equal(w.calls.length, 1, 'the filed one is not called again')
  assert.equal(w.store.done[S(1)], undefined, 'the failed one is still to do')
})

test('a session the command refused (false: archived, or the list limits) is not remembered and is tried again', async () => {
  const w = world({ rows: [row(1, A), row(2, A)], lanes: [{ sid: S(1) }, { sid: S(2) }], refuse: [S(1)] })
  await w.groups.tick()
  assert.deepEqual(w.store.done, { [S(2)]: 'Lanes' })
  await w.groups.tick()
  assert.equal(w.calls.length, 3, 'the refused one is asked again')
})

test('an unreadable table is silent', async () => {
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

test('only sessions still in a tier stay in the record, and an unchanged record is not written again', async () => {
  const w = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }], done: { [S(7)]: 'Lead', [S(1)]: 'Lanes' } })
  await w.groups.tick()
  assert.deepEqual(w.store.done, { [S(1)]: 'Lanes' })
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

test('under the plugin the session table decides: a loose or off row is not filed; a new: row is named by groupsFor and left to the registry check in the tick', async () => {
  const table = { [S(1)]: { name: 'CHIEF', folder: A, lead: { repos: [] } }, [S(2)]: { name: 'LAB', folder: A, under: S(1) }, [S(3)]: { name: 'LOOSE', folder: A }, [S(4)]: { name: 'OFF', folder: A, under: S(1), off: true }, 'new:X': { name: 'X', folder: A, under: S(1) } }
  assert.deepEqual([...groupsFor(table)], [[S(1), 'Lead'], [S(2), 'Lanes'], ['new:X', 'Lanes']])
  const w = world({ rows: [1, 2, 3, 4].map((n) => row(n, A)), table })
  await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Lead'], [S(2), 'Lanes']])
})

// The archive command, as the patch registers it. A lane is archived only after the extension saw it with a table row and a live process in this window and
// then saw it with neither, on two ticks in a row.
const ARCH = [COMMAND, ARCHIVE]
const retire = (w, rows, sid) => {
  delete w.table[sid]
  rows.splice(0, rows.length, ...rows.filter((r) => r.sessionId !== sid))
}

test('a lane seen running and then retired (no row, no process) is archived on the second tick, once, and forgotten', async () => {
  const rows = [row(1, A), row(2, A)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }, { sid: S(2) }] })
  await w.groups.tick()
  assert.deepEqual([w.archived, w.store.seen], [[], [S(1), S(2)]], 'seen, nothing retired')
  retire(w, rows, S(1))
  await w.groups.tick()
  assert.deepEqual(w.archived, [], 'gone on one tick only')
  await w.groups.tick()
  assert.deepEqual([w.archived, w.store.seen], [[['Lanes', [S(1)]]], [S(2)]], 'only the retired lane, only the Lanes group')
  await w.groups.tick()
  assert.equal(w.archived.length, 1, 'named once')
})

test('a lane retired before the extension saw it is never archived, however long it stays in the Lanes group', async () => {
  const w = world({ commands: ARCH, rows: [row(2, A)], lanes: [{ sid: S(2) }], done: { [S(1)]: 'Lanes', [S(2)]: 'Lanes' } })
  for (let i = 0; i < 4; i++) await w.groups.tick()
  assert.deepEqual([w.archived, w.store.seen], [[], [S(2)]], 'S(1) has a filed record but was never seen with a row and a process')
})

test('a parked lane, a live lane, a lane with an off row, a lead and the manager are never archived', async () => {
  const rows = [row(1, A), row(2, A), row(3, A), boss(4)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }, { sid: S(2) }, { sid: S(3) }], manager: 'BOSS', seen: [S(4)] })
  await w.groups.tick()
  assert.deepEqual(w.store.seen.sort(), [S(1), S(2), S(3), S(4)].sort(), 'the three lanes are seen; the manager was stored as if it were')
  w.table[S(1)].parked = Date.now()
  delete w.table[S(2)]
  w.table[S(3)].off = true
  rows.splice(0, rows.length, ...rows.filter((r) => r.sessionId !== S(1) && r.sessionId !== S(3)))
  for (let i = 0; i < 4; i++) await w.groups.tick()
  assert.deepEqual(w.archived, [], 'S(1) parked (row, no process), S(2) running with no row (process), S(3) off (row), the manager (process)')
})

test('a lane that comes back before the second tick is not archived, and needs two fresh ticks to go', async () => {
  const rows = [row(1, A)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }] })
  await w.groups.tick()
  retire(w, rows, S(1))
  await w.groups.tick()
  w.table[S(1)] = { name: 'L', folder: A, under: S(99) }
  await w.groups.tick()
  delete w.table[S(1)]
  await w.groups.tick()
  assert.deepEqual(w.archived, [], 'back on the second tick: the count starts again')
  await w.groups.tick()
  assert.deepEqual(w.archived, [['Lanes', [S(1)]]])
})

test('a tick with doubt in its reads names no one: unreadable table, incomplete registry, a manager that cannot be told', async () => {
  for (const doubt of [{ loadError: true }, { incomplete: true }, { manager: 'BOSS', startOf: async () => undefined, rows: [boss(5)] }]) {
    const rows = doubt.rows ?? []
    const w = world({ commands: ARCH, ...doubt, rows, seen: [S(1)] })
    for (let i = 0; i < 3; i++) await w.groups.tick()
    assert.deepEqual([w.archived, w.store.seen], [[], [S(1)]], JSON.stringify(Object.keys(doubt)))
  }
})

test('a lane running outside this window is not seen, so it is never archived from here', async () => {
  const rows = [row(1, B)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }] })
  await w.groups.tick()
  retire(w, rows, S(1))
  for (let i = 0; i < 3; i++) await w.groups.tick()
  assert.deepEqual([w.archived, w.store.seen], [[], []])
})

test('a dead process is gone: a lane whose row stays is kept, one whose row went too is archived', async () => {
  let up = true
  const rows = [row(1, A, { pid: 11 }), row(2, A, { pid: 12 })]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }, { sid: S(2) }], alive: () => up, startOf: async () => undefined })
  await w.groups.tick()
  up = false
  delete w.table[S(2)]
  for (let i = 0; i < 3; i++) await w.groups.tick()
  assert.deepEqual(w.archived, [['Lanes', [S(2)]]], 'S(1) is parked or closed (row), S(2) has no row and no process')
})

test('a failing archive command keeps the lane remembered and names it again; a command that is missing does nothing and stores nothing', async () => {
  const rows = [row(1, A)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }], archiveFails: true })
  await w.groups.tick()
  retire(w, rows, S(1))
  for (let i = 0; i < 3; i++) await assert.doesNotReject(w.groups.tick())
  assert.deepEqual([w.archived, w.store.seen], [[], [S(1)]])
  const none = world({ rows: [row(1, A)], lanes: [{ sid: S(1) }] })
  await none.groups.tick()
  assert.deepEqual([none.archived, none.store.seen], [[], []], 'the file command alone: lanes are not even noted')
})

test('a stored record that is not a list is no record', async () => {
  const w = world({ commands: ARCH, rows: [row(1, A)], lanes: [{ sid: S(1) }], seen: { [S(9)]: 1 } })
  await w.groups.tick()
  assert.deepEqual(w.store.seen, [S(1)])
})

const LEADS = () => ({ [S(1)]: { name: 'D', folder: A, lead: { repos: [] } }, [S(2)]: { name: 'M', folder: A, lead: { repos: [], minted: true }, under: S(3) }, [S(3)]: { name: 'C', folder: A, lead: { repos: [], conductor: true } } })

test('a lead a conductor made, seen running and then retired, is archived from the Lead group; a lead the person typed and a conductor never are', async () => {
  const rows = [row(1, A), row(2, A), row(3, A)]
  const w = world({ commands: ARCH, rows, table: LEADS() })
  await w.groups.tick()
  assert.deepEqual([w.store.seen, w.store.seenLeads], [[], [S(2)]], 'only the conductor-made lead is remembered')
  for (const sid of [S(1), S(2), S(3)]) retire(w, rows, sid)
  for (let i = 0; i < 4; i++) await w.groups.tick()
  assert.deepEqual([w.archived, w.store.seenLeads], [[['Lead', [S(2)]]], []])
})

test('a conductor-made lead that is closed or parked is forgotten, so it stays listed when the plugin drops its row later', async () => {
  for (const mark of ['goneAt', 'parked']) {
    const rows = [row(2, A), row(3, A)]
    const w = world({ commands: ARCH, rows, table: LEADS() })
    await w.groups.tick()
    assert.deepEqual(w.store.seenLeads, [S(2)])
    // Closed: the process is gone and the row stays, first unmarked, then marked by the plugin.
    rows.splice(0, 1)
    await w.groups.tick()
    assert.deepEqual(w.store.seenLeads, [S(2)], 'a row with no mark yet is a retire under way or a close not yet read')
    w.table[S(2)][mark] = 1
    await w.groups.tick()
    assert.deepEqual(w.store.seenLeads, [], mark)
    delete w.table[S(2)]
    for (let i = 0; i < 4; i++) await w.groups.tick()
    assert.deepEqual(w.archived, [], mark)
  }
})

test('a retired session is filed in its group before it is archived, and is forgotten only when the archive command names it or the file command refuses it', async () => {
  const rows = [row(1, A), row(2, A)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }, { sid: S(2) }], done: { [S(1)]: 'Lanes', [S(2)]: 'Lanes' }, archiveAnswers: () => [] })
  await w.groups.tick()
  assert.deepEqual(w.calls, [], 'both were filed before')
  retire(w, rows, S(1))
  for (let i = 0; i < 3; i++) await w.groups.tick()
  assert.deepEqual(w.calls, [[S(1), 'Lanes'], [S(1), 'Lanes']], 'filed again on each tick that names it')
  assert.deepEqual([w.archived, w.store.seen], [[['Lanes', [S(1)]], ['Lanes', [S(1)]]], [S(1), S(2)]], 'not named as archived: remembered and tried again')
  // The file command refuses it (archived by hand, or the list limits): it cannot be archived, so it is forgotten and the archive command is not called for it.
  const xrows = [row(1, A)]
  const x = world({ commands: ARCH, rows: xrows, lanes: [{ sid: S(1) }], done: { [S(1)]: 'Lanes' }, refuse: [S(1)] })
  await x.groups.tick()
  assert.deepEqual(x.store.seen, [S(1)])
  retire(x, xrows, S(1))
  for (let i = 0; i < 3; i++) await x.groups.tick()
  assert.deepEqual([x.calls, x.archived, x.store.seen], [[[S(1), 'Lanes']], [], []])
})

test('a missing table (a fresh install) still files the manager but archives nothing', async () => {
  const w = world({ commands: ARCH, rows: [boss(1)], manager: 'BOSS', seen: [S(2)], missingTable: true })
  for (let i = 0; i < 3; i++) await w.groups.tick()
  assert.deepEqual([w.calls, w.archived], [[[S(1), 'Manager']], []])
})

test('a tick that stops early between two clean ticks restarts the count: gone, doubt, gone does not archive', async () => {
  const rows = [row(1, A)]
  const w = world({ commands: ARCH, rows, lanes: [{ sid: S(1) }] })
  await w.groups.tick()
  retire(w, rows, S(1))
  await w.groups.tick()
  w.doubt = true
  await w.groups.tick()
  w.doubt = false
  await w.groups.tick()
  assert.deepEqual(w.archived, [])
  await w.groups.tick()
  assert.deepEqual(w.archived, [['Lanes', [S(1)]]])
})

test('readSessionTable: the table as an object, null for a missing file; an unparsable or non-object file throws, so a tick waits and never reads lanes as retired', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'))
  try {
    fs.writeFileSync(path.join(d, 'ok'), '{"a":{}}')
    fs.writeFileSync(path.join(d, 'bad'), '{"a":')
    fs.writeFileSync(path.join(d, 'list'), '[]')
    assert.deepEqual(await readSessionTable(path.join(d, 'ok')), { a: {} })
    assert.equal(await readSessionTable(path.join(d, 'missing')), null)
    for (const f of ['bad', 'list']) await assert.rejects(readSessionTable(path.join(d, f)), f)
    await assert.rejects(readSessionTable(d), 'a folder is no read')
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})
