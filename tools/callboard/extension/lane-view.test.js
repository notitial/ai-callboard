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
const build = (over = {}) => buildEntries({ table: {}, rows: [], now: NOW, alive: () => true, ...over })

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

test('buildEntries: the lead is the row under; a row under an unknown session is a top entry', () => {
  const table = { [sid(1)]: { name: 'LEAD', folder: '/w/a' }, [sid(2)]: { name: 'LAB', folder: '/w/a', under: sid(1) }, [sid(3)]: { name: 'LOOSE', folder: '/w/a', under: sid(99) } }
  const got = build({ table })
  assert.deepEqual(got.map((e) => [e.name, e.folder, e.lead]), [['LAB', '/w/a', 'LEAD'], ['LEAD', '/w/a', undefined], ['LOOSE', '/w/a', undefined]])
})

test('buildEntries: a row under itself, or with a text time, still shows', () => {
  const table = { [sid(1)]: { name: 'LEAD', folder: '/w/a' }, [sid(5)]: { name: 'SELF', folder: '/w/a', under: sid(5) }, [sid(6)]: { name: 'TXT', folder: '/w/a', goneAt: 'soon', parked: 'x' } }
  const got = build({ table })
  assert.deepEqual(got.map((e) => [e.name, e.state, e.lead, e.age]), [['LEAD', 'closed', undefined, undefined], ['SELF', 'closed', undefined, undefined], ['TXT', 'closed', undefined, undefined]])
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

const custom = (t) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: sid(1) })
const generated = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: sid(1) })
const turn = (n = 1) => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(n) } })

test('recentChats: the folder\'s titled .jsonl files, newest first, capped; other names and untitled chats are skipped', async () => {
  const files = [1, 2, 3, 4].map((n) => [`${sid(n)}.jsonl`, `${turn()}\n${custom(`Title ${n}`)}\n`, NOW - n * 1000])
  files.push(['notes.txt', 'x'], ['not-a-session.jsonl', custom('x')], [`${sid(9)}.json`, custom('x')], [`${sid(7)}.jsonl`, `${turn()}\n`, NOW])
  const root = projects('/Users/x/my repo', files)
  const got = await recentChats(root, '/Users/x/my repo', 3)
  assert.deepEqual(got.map((c) => [c.sid, c.title]), [[sid(1), 'Title 1'], [sid(2), 'Title 2'], [sid(3), 'Title 3']])
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'sid', 'title'])
  assert.deepEqual(await recentChats(root, '/Users/x/other'), [])
  assert.deepEqual(await recentChats(root, `/${'a'.repeat(250)}`), [])
})

test('recentChats: the title is the last rename, else the last generated one, found at the end or the start of a long transcript; a missing or odd one lists nothing', async () => {
  const filler = `${turn(70000)}\n`
  const root = projects('/w/a', [
    [`${sid(1)}.jsonl`, `${generated('Made up')}\n${custom('Old')}\n${turn()}\n${custom('  Kept\n   name ')}\n${generated('Newer made up')}\n`, NOW - 1 * MIN],
    [`${sid(2)}.jsonl`, `${generated('Only generated')}\n${turn()}\n`, NOW - 2 * MIN],
    [`${sid(3)}.jsonl`, `${custom('At the start')}\n${filler}${filler}`, NOW - 3 * MIN],
    [`${sid(4)}.jsonl`, `${filler}${filler}${custom('At the end')}\n`, NOW - 4 * MIN],
    [`${sid(5)}.jsonl`, `${filler}${custom('Lost in the middle')}\n${filler}${filler}`, NOW - 5 * MIN],
    [`${sid(6)}.jsonl`, `{"type": "custom-title", "customTitle": "Spaced", "sessionId": "x"}\n${turn()}\n`, NOW - 6 * MIN],
    [`${sid(7)}.jsonl`, `${custom('   ')}\n${custom(5)}\n{"type":"custom-title","customTitle":"cut\n`, NOW - 7 * MIN],
    [`${sid(8)}.jsonl`, custom('x'.repeat(300)), NOW - 8 * MIN],
  ])
  const got = await recentChats(root, '/w/a')
  assert.deepEqual(got.map((c) => c.title), ['Kept name', 'Only generated', 'At the start', 'At the end', 'Spaced', 'x'.repeat(100)])
})

// A fake VS Code: the tree view's provider, the command it registered and the warnings are kept for the test.
function world({ table = {}, rows = [], folders = ['/w/a'], files = [], reopen = async () => sid(0) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-view-'))
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(table))
  const projectsDir = projects('/w/a', files)
  const w = { provider: undefined, ids: [], commands: new Map(), warnings: [], fires: 0, reopens: [], rows, time: NOW, disposed: 0 }
  const vscode = {
    EventEmitter: class { constructor() { this.event = (fn) => { this.fn = fn; return { dispose() {} } } } fire(x) { w.fires++; this.fn?.(x) } dispose() {} },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState } },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color } },
    ThemeColor: class { constructor(id) { this.id = id } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      createTreeView: (id, o) => { w.ids.push(id); w.provider = o.treeDataProvider; return { dispose() { w.disposed++ } } },
      showWarningMessage: (m) => w.warnings.push(m),
    },
    commands: { registerCommand: (id, fn) => { w.commands.set(id, fn); return { dispose() {} } } },
  }
  const lanesApi = { reopen: async (s, o) => { w.reopens.push([s, o]); return reopen(s, o) } }
  w.view = createLaneView({ vscode, registry: { list: async () => w.rows }, lanes: lanesApi, tablePath: path.join(dir, 'sessions.json'), projectsDir, workspaceFolders: () => folders, alive: () => true, now: () => w.time })
  w.items = async (node) => (await w.provider.getChildren(node)).map((n) => ({ n, item: w.provider.getTreeItem(n) }))
  return w
}

test('the view groups a lane under its lead and shows folder, state and the lead and path in the tooltip', async () => {
  const w = world({
    table: { [sid(1)]: { name: 'LEAD', folder: '/w/a' }, [sid(2)]: { name: 'LAB', folder: '/w/b', under: sid(1), parked: NOW - 4 * MIN }, [sid(3)]: { name: 'RUN', folder: '/w/a', under: sid(1) } },
    rows: [reg(1, { status: 'waiting', waitingFor: 'x' }), reg(3, { status: 'busy' })],
    folders: ['/w/a', '/w/b'],
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

test('recent chats: a group per folder with a titled conversation, shown by its title and age, newest first; an untitled chat or one of a gone session is not listed', async () => {
  const w = world({
    table: { [sid(1)]: { name: 'LAB', folder: '/w/a' }, [sid(4)]: { name: 'portent-web-6b', folder: '/w/a', goneAt: NOW - 3600000 } },
    rows: [reg(2, { name: 'from-registry', nameSource: 'derived' })],
    files: [
      [`${sid(1)}.jsonl`, `${custom('First chat')}\n`, NOW - 1 * MIN],
      [`${sid(2)}.jsonl`, `${generated('Second chat')}\n`, NOW - 2 * MIN],
      [`${sid(3)}.jsonl`, `${turn()}\n`, NOW - 3 * 3600000],
      [`${sid(4)}.jsonl`, `${turn()}\n`, NOW - 4 * 3600000],
    ],
    folders: ['/w/a', '/w/empty'],
  })
  const top = await w.items()
  const group = top.find((x) => x.n.kind === 'group')
  assert.equal(group.item.label, 'Recent chats: a')
  assert.deepEqual(top.filter((x) => x.n.kind === 'group').length, 1, 'a folder with no conversation has no group')
  const chats = await w.items(group.n)
  assert.deepEqual(chats.map((x) => [x.item.label, x.item.description, x.item.command.arguments]), [
    ['First chat', '1m', [sid(1), '/w/a']],
    ['Second chat', '2m', [sid(2), '/w/a']],
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

test('a registry read that is not complete leaves the list as it was', async () => {
  const w = world({ table: { [sid(1)]: { name: 'LAB', folder: '/w/a' } }, rows: [reg(1, { status: 'idle' })] })
  assert.equal((await w.items())[0].item.description, 'a · live')
  w.rows = Object.defineProperty([], 'complete', { value: false })
  await w.view.refresh()
  assert.equal((await w.items())[0].item.description, 'a · live')
  w.rows = []
  await w.view.refresh()
  assert.equal((await w.items())[0].item.description, 'a · closed')
  w.view.dispose()
})

test('one tree in two places: the Session Manager view and the Explorer view, as package.json declares them; a waiting session is the live dot in orange', async () => {
  const w = world({ table: { [sid(1)]: { name: 'W', folder: '/w/a' }, [sid(2)]: { name: 'L', folder: '/w/a' } }, rows: [reg(1, { waitingFor: 'approve a tool' }), reg(2, { status: 'idle' })] })
  const views = require('./package.json').contributes.views
  assert.deepEqual(w.ids.sort(), [...views['claude-sessions-sidebar'], ...views.explorer].map((v) => v.id).sort())
  assert.equal(views.explorer[0].when, `!${views['claude-sessions-sidebar'][0].when}`)
  assert.deepEqual([...views['claude-sessions-sidebar'], ...views.explorer].map((v) => v.visibility), ['collapsed', 'collapsed'])
  const icons = (await w.items()).map((x) => [x.item.label, x.item.iconPath.id, x.item.iconPath.color?.id])
  assert.deepEqual(icons, [['L', 'circle-filled', undefined], ['W', 'circle-filled', 'charts.orange']])
  w.view.dispose()
  assert.equal(w.disposed, 2)
})

test('only the sessions of this window\'s folders are listed; a lane of a lead in another folder sits at the top', async () => {
  const w = world({ table: { [sid(1)]: { name: 'LEAD', folder: '/w/b' }, [sid(2)]: { name: 'HERE', folder: '/w/a', under: sid(1) }, [sid(3)]: { name: 'THERE', folder: '/w/b', under: sid(1) }, [sid(4)]: { name: 'SUB', folder: '/w/a/sub' } } })
  assert.deepEqual((await w.items()).map((x) => [x.item.label, x.n.kids.length]), [['HERE', 0]])
  w.view.dispose()
})

test('a broken table whose leads point at each other shows every session once, at the top, and its lane below it', async () => {
  const w = world({ table: { [sid(1)]: { name: 'A', folder: '/w/a', under: sid(2) }, [sid(2)]: { name: 'B', folder: '/w/a', under: sid(1) }, [sid(3)]: { name: 'C', folder: '/w/a', under: sid(1) } } })
  const top = await w.items()
  assert.deepEqual(top.map((x) => x.item.label), ['A', 'B'])
  assert.deepEqual((await w.items(top[0].n)).map((x) => x.item.label), ['C'])
  assert.deepEqual(await w.items(top[1].n), [])
  w.view.dispose()
})
