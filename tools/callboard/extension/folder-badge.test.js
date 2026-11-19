'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createFolderBadge, folderOf } = require('./folder-badge.js')

const row = (name, cwd, extra = {}) => ({ sessionId: 'x', entrypoint: 'claude-vscode', name, cwd, pid: 10, ...extra })

test('folderOf: the folder of the one live panel session with that name', () => {
  assert.equal(folderOf('LAB', [row('LAB', '/w/a'), row('OTHER', '/w/b')], () => true), '/w/a')
  assert.equal(folderOf('LAB', [row('LAB', '/w/a', { pid: 1 }), row('LAB', '/w/a', { pid: 2 })], () => true), '/w/a', 'two rows, one folder')
})

test('folderOf: a label Claude Code cut to 24 characters and "…" finds the longer name; two folders for one cut label show nothing', () => {
  const long = 'a-session-name-longer-than-twenty-five'
  const label = `${long.slice(0, 24)}…`
  assert.equal(folderOf(label, [row(long, '/w/a'), row('other-name', '/w/b')], () => true), '/w/a')
  assert.equal(folderOf(label, [row(long, '/w/a', { pid: 1 }), row(`${long}-2`, '/w/b', { pid: 2 })], () => true), undefined, 'ambiguous: no guess')
})

test('folderOf: nothing when the name is unknown, dead, a terminal session, in two folders, or the cwd is not a path', () => {
  assert.equal(folderOf('LAB', [], () => true), undefined)
  assert.equal(folderOf('LAB', [row('LAB', '/w/a')], () => false), undefined, 'a dead process')
  assert.equal(folderOf('LAB', [row('LAB', '/w/a', { entrypoint: 'cli' })], () => true), undefined)
  assert.equal(folderOf('LAB', [row('LAB', '/w/a', { pid: 1 }), row('LAB', '/w/b', { pid: 2 })], () => true), undefined, 'ambiguous: no guess')
  assert.equal(folderOf('LAB', [row('LAB', 'relative'), row('LAB', undefined)], () => true), undefined)
})

function world({ tab, folders = ['/w/a', '/w/b'], list }) {
  const state = { tab, shown: false, hides: 0 }
  const item = { show() { state.shown = true }, hide() { state.shown = false; state.hides++ }, dispose() {} }
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem: () => item,
      tabGroups: {
        get activeTabGroup() { return { activeTab: state.tab } },
        onDidChangeTabs: () => ({ dispose() {} }),
        onDidChangeTabGroups: () => ({ dispose() {} }),
      },
    },
    workspace: { workspaceFolders: folders.map((f) => ({ uri: { fsPath: f } })) },
  }
  const badge = createFolderBadge({ vscode, registry: { list }, alive: () => true })
  return { badge, item, state }
}

const claudeTab = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } })

test('the item shows the folder name of the Claude panel in front, with the full path as the tooltip, and follows tab changes', async () => {
  const rows = [row('LAB', '/w/b/arkham'), row('OTHER', '/w/a')]
  const w = world({ tab: claudeTab('LAB'), list: async () => rows })
  await w.badge.refresh()
  assert.equal(w.item.text, '$(folder) arkham')
  assert.match(w.item.tooltip, /\/w\/b\/arkham/)
  assert.equal(w.state.shown, true)
  w.state.tab = claudeTab('OTHER')
  await w.badge.refresh()
  assert.equal(w.item.text, '$(folder) a')
  w.state.tab = { label: 'file.js', input: { viewType: undefined } }
  await w.badge.refresh()
  assert.equal(w.state.shown, false, 'not a Claude panel')
  w.badge.dispose()
})

test('a change that comes while a read is under way is read again: the item never keeps the answer for the tab that was in front before', async () => {
  const rows = [row('A', '/w/a'), row('B', '/w/b')]
  let release
  const w = world({ tab: claudeTab('A'), list: () => new Promise((r) => { release = () => r(rows) }) })
  const first = w.badge.refresh()
  w.state.tab = claudeTab('B')
  const second = w.badge.refresh()
  release()
  await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  release()
  await Promise.all([first, second])
  assert.equal(w.item.text, '$(folder) b')
  w.badge.dispose()
})

test('the item stays hidden in a one-folder window and for an unknown session; a registry that cannot be read hides it once and throws nothing', async () => {
  const one = world({ tab: claudeTab('LAB'), folders: ['/w/a'], list: async () => [row('LAB', '/w/a')] })
  await one.badge.refresh()
  assert.equal(one.state.shown, false)
  one.badge.dispose()
  const unknown = world({ tab: claudeTab('NOPE'), list: async () => [row('LAB', '/w/a')] })
  await unknown.badge.refresh()
  assert.equal(unknown.state.shown, false)
  unknown.badge.dispose()
  const broken = world({ tab: claudeTab('LAB'), list: async () => { throw new Error('boom') } })
  await broken.badge.refresh()
  assert.equal(broken.state.shown, false)
  assert.ok(broken.state.hides >= 1, 'the failure hid the item')
  broken.badge.dispose()
})
