'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLaneView, buildEntries, recentChats, readTable } = require('./lane-view.js')

const sid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW = 1_000_000_000_000
const MIN = 60000
const reg = (n, extra = {}) => ({ sessionId: sid(n), cwd: '/w/a', pid: 100 + n, startedAt: NOW - 5 * MIN, ...extra })
const build = (over = {}) => buildEntries({ table: {}, lanes: [], rows: [], now: NOW, alive: () => true, ...over })

test('buildEntries: state is waiting, working or live while a process answers, else gone, parked or closed', () => {
  const table = {
    [sid(1)]: { name: 'W', folder: '/w/a' },
    [sid(2)]: { name: 'B', folder: '/w/a' },
    [sid(3)]: { name: 'I', folder: '/w/a' },
    [sid(4)]: { name: 'P', folder: '/w/a', parked: NOW - 2 * MIN },
    [sid(5)]: { name: 'C', folder: '/w/a' },
    [sid(6)]: { name: 'G', folder: '/w/a', goneAt: NOW - 3600000 },
    [sid(7)]: { name: 'PL', folder: '/w/a', parked: NOW - 2 * MIN },
  }
  const rows = [reg(1, { status: 'waiting', waitingFor: 'approve a tool' }), reg(2, { status: 'busy' }), reg(3, { status: 'idle', statusAt: NOW - 90 * MIN }), reg(7, { status: 'idle' })]
  const got = Object.fromEntries(build({ table, rows }).map((e) => [e.name, [e.state, e.age]]))
  assert.deepEqual(got, { W: ['waiting', '5m'], B: ['working', '5m'], I: ['live', '1h'], P: ['parked', '2m'], C: ['closed', undefined], G: ['gone', '1h'], PL: ['live', '5m'] })
})

test('buildEntries: a dead process is not live, and a row marked off, a bad key or a week-old gone row is left out', () => {
  const table = {
    [sid(1)]: { name: 'A', folder: '/w/a' },
    [sid(2)]: { name: 'OFF', folder: '/w/a', off: true },
    'new:X': { name: 'X', folder: '/w/a' },
    [sid(3)]: { name: 'OLD', folder: '/w/a', goneAt: NOW - 8 * 86400000 },
    [sid(4)]: { name: 'NOFOLDER' },
  }
  const got = build({ table, rows: [reg(1)], alive: () => false })
  assert.deepEqual(got.map((e) => [e.name, e.state]), [['A', 'closed']])
})

test('buildEntries: the table wins over a lane store, a store lane without a session id is skipped, the lead is the row under', () => {
  const table = { [sid(1)]: { name: 'LEAD', folder: '/w/a' }, [sid(2)]: { name: 'LAB', folder: '/w/a', under: sid(1) }, [sid(3)]: { name: 'LOOSE', folder: '/w/a', under: sid(99) } }
  const lanes = [{ name: 'LAB-OLD', folder: '/w/z', sid: sid(2) }, { name: 'STORED', folder: '/w/b', sid: sid(4) }, { name: 'NEVER', folder: '/w/b' }]
  const got = build({ table, lanes })
  assert.deepEqual(got.map((e) => [e.name, e.folder, e.lead]), [['LAB', '/w/a', 'LEAD'], ['LEAD', '/w/a', undefined], ['LOOSE', '/w/a', undefined], ['STORED', '/w/b', undefined]])
})

test('readTable: no file or a bad file is an empty table', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-view-'))
  assert.deepEqual(await readTable(path.join(dir, 'none.json')), {})
  fs.writeFileSync(path.join(dir, 'bad.json'), '[1')
  assert.deepEqual(await readTable(path.join(dir, 'bad.json')), {})
  fs.writeFileSync(path.join(dir, 'list.json'), '[]')
  assert.deepEqual(await readTable(path.join(dir, 'list.json')), {})
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ [sid(1)]: { name: 'A', folder: '/w/a' } }))
  assert.deepEqual(Object.keys(await readTable(path.join(dir, 'ok.json'))), [sid(1)])
})

function projects(folder, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-projects-'))
  const dir = path.join(root, folder.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text, mtime] of files) {
    fs.writeFileSync(path.join(dir, name), text)
    if (mtime) fs.utimesSync(path.join(dir, name), mtime / 1000, mtime / 1000)
  }
  return root
}

test('recentChats: the folder\'s .jsonl files by name and time, newest first, capped; other names are skipped and no content is read', async () => {
  const files = [1, 2, 3, 4].map((n) => [`${sid(n)}.jsonl`, 'SECRET CONTENT', NOW - n * 1000])
  files.push(['notes.txt', 'x'], ['not-a-session.jsonl', 'x'], [`${sid(9)}.json`, 'x'])
  const root = projects('/Users/x/my repo', files)
  const got = await recentChats(root, '/Users/x/my repo', 3)
  assert.deepEqual(got.map((c) => c.sid), [sid(1), sid(2), sid(3)])
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'sid'])
  assert.deepEqual(await recentChats(root, '/Users/x/other'), [])
  assert.deepEqual(await recentChats(root, `/${'a'.repeat(250)}`), [])
})

// A fake VS Code: the tree view's provider, the command it registered and the warnings are kept for the test.
function world({ table = {}, lanes = [], rows = [], folders = ['/w/a'], files = [], reopen = async () => sid(0) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-view-'))
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(table))
  const projectsDir = projects('/w/a', files)
  const w = { provider: undefined, commands: new Map(), warnings: [], fires: 0, reopens: [], rows, time: NOW, disposed: 0 }
  const vscode = {
    EventEmitter: class { constructor() { this.event = (fn) => { this.fn = fn; return { dispose() {} } } } fire(x) { w.fires++; this.fn?.(x) } dispose() {} },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState } },
    ThemeIcon: class { constructor(id) { this.id = id } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      createTreeView: (id, o) => { assert.equal(id, 'callboardLanes'); w.provider = o.treeDataProvider; return { dispose() { w.disposed++ } } },
      showWarningMessage: (m) => w.warnings.push(m),
    },
    commands: { registerCommand: (id, fn) => { w.commands.set(id, fn); return { dispose() {} } } },
  }
  const lanesApi = { reopen: async (s, o) => { w.reopens.push([s, o]); return reopen(s, o) } }
  w.view = createLaneView({ vscode, registry: { list: async () => w.rows }, lanes: lanesApi, loadLanes: async () => lanes, tablePath: path.join(dir, 'sessions.json'), projectsDir, workspaceFolders: () => folders, alive: () => true, now: () => w.time })
  w.items = async (node) => (await w.provider.getChildren(node)).map((n) => ({ n, item: w.provider.getTreeItem(n) }))
  return w
}

test('the view groups a lane under its lead and shows folder, state and the lead and path in the tooltip', async () => {
  const w = world({
    table: { [sid(1)]: { name: 'LEAD', folder: '/w/a' }, [sid(2)]: { name: 'LAB', folder: '/w/b', under: sid(1), parked: NOW - 4 * MIN }, [sid(3)]: { name: 'RUN', folder: '/w/a', under: sid(1) } },
    rows: [reg(1, { status: 'waiting', waitingFor: 'x' }), reg(3, { status: 'busy' })],
  })
  const top = await w.items()
  assert.deepEqual(top.map((x) => [x.item.label, x.item.description]), [['LEAD', 'a · waiting']])
  assert.equal(top[0].item.collapsibleState, 2)
  const kids = await w.items(top[0].n)
  assert.deepEqual(kids.map((x) => [x.item.label, x.item.description, x.item.iconPath.id]), [['LAB', 'b · parked', 'debug-pause'], ['RUN', 'a · working', 'sync~spin']])
  assert.equal(kids[0].item.tooltip, 'LAB\nparked\nlead LEAD\n/w/b\nlast activity 4m ago')
  assert.deepEqual(kids[0].item.command, { command: 'callboardPanels.openLane', title: 'Open', arguments: [sid(2), '/w/b'] })
  w.view.dispose()
})

test('a click reopens the session in its own folder; a refusal is shown with its text', async () => {
  const w = world({ table: { [sid(2)]: { name: 'LAB', folder: '/w/b', parked: NOW } }, reopen: async () => { throw new Error('folder is not the first workspace folder of this window; editor.open opens there') } })
  await w.commands.get('callboardPanels.openLane')(sid(2), '/w/b')
  assert.deepEqual(w.reopens, [[sid(2), { folder: '/w/b' }]])
  assert.match(w.warnings[0], /folder is not the first workspace folder of this window/)
  w.view.dispose()
})

test('recent chats: a group per folder with a conversation, named from a known session else by id and age, newest first', async () => {
  const w = world({
    table: { [sid(1)]: { name: 'LAB', folder: '/w/a' } },
    rows: [reg(2, { name: 'from-registry' })],
    files: [[`${sid(1)}.jsonl`, 'x', NOW - 1 * MIN], [`${sid(2)}.jsonl`, 'x', NOW - 2 * MIN], [`${sid(3)}.jsonl`, 'x', NOW - 3 * 3600000]],
    folders: ['/w/a', '/w/empty'],
  })
  const top = await w.items()
  const group = top.find((x) => x.n.kind === 'group')
  assert.equal(group.item.label, 'Recent chats: a')
  assert.deepEqual(top.filter((x) => x.n.kind === 'group').length, 1, 'a folder with no conversation has no group')
  const chats = await w.items(group.n)
  assert.deepEqual(chats.map((x) => [x.item.label, x.item.description, x.item.command.arguments]), [
    ['LAB', '1m', [sid(1), '/w/a']],
    ['from-registry', '2m', [sid(2), '/w/a']],
    ['00000003', '3h', [sid(3), '/w/a']],
  ])
  w.view.dispose()
})

test('the tree is told only when what it shows changed', async () => {
  const w = world({ table: { [sid(1)]: { name: 'LAB', folder: '/w/a' } }, rows: [reg(1, { status: 'idle' })] })
  await w.provider.getChildren()
  const base = w.fires
  await w.view.refresh()
  assert.equal(w.fires, base, 'same data, no change')
  w.rows = [reg(1, { status: 'busy' })]
  await w.view.refresh()
  assert.equal(w.fires, base + 1)
  w.view.dispose()
})
