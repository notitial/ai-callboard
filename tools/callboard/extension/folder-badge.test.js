'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createFolderBadge, folderOf } = require('./folder-badge.js')

const row = (name, cwd, extra = {}) => ({ sessionId: 'x', entrypoint: 'claude-vscode', name, cwd, pid: 10, ...extra })

test('folderOf: the folder of the one live panel session with that name', () => {
  assert.equal(folderOf('LAB', [row('LAB', '/w/a'), row('OTHER', '/w/b')], () => true), '/w/a')
  assert.equal(folderOf('LAB', [row('LAB', '/w/a', { pid: 1 }), row('LAB', '/w/a', { pid: 2 })], () => true), '/w/a', 'two rows, one folder')
})

test('folderOf: nothing when the name is unknown, dead, a terminal session, in two folders, or the cwd is not a path', () => {
  assert.equal(folderOf('LAB', [], () => true), undefined)
  assert.equal(folderOf('LAB', [row('LAB', '/w/a')], () => false), undefined, 'a dead process')
  assert.equal(folderOf('LAB', [row('LAB', '/w/a', { entrypoint: 'cli' })], () => true), undefined)
  assert.equal(folderOf('LAB', [row('LAB', '/w/a', { pid: 1 }), row('LAB', '/w/b', { pid: 2 })], () => true), undefined, 'ambiguous: no guess')
  assert.equal(folderOf('LAB', [row('LAB', 'relative'), row('LAB', undefined)], () => true), undefined)
})

function world({ tab, folders = ['/w/a', '/w/b'], rows = [] }) {
  const state = { tab, shown: false, listeners: [] }
  const item = { show() { state.shown = true }, hide() { state.shown = false }, dispose() {} }
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem: () => item,
      tabGroups: {
        get activeTabGroup() { return { activeTab: state.tab } },
        onDidChangeTabs: (f) => (state.listeners.push(f), { dispose() {} }),
        onDidChangeTabGroups: () => ({ dispose() {} }),
      },
    },
    workspace: { workspaceFolders: folders.map((f) => ({ uri: { fsPath: f } })) },
  }
  const badge = createFolderBadge({ vscode, registry: { list: async () => rows }, alive: () => true })
  return { badge, item, state }
}

const claudeTab = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } })

test('the item shows the folder name of the Claude panel in front, with the full path as the tooltip, and follows tab changes', async () => {
  const w = world({ tab: claudeTab('LAB'), rows: [row('LAB', '/w/b/arkham'), row('OTHER', '/w/a')] })
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

test('the item stays hidden in a one-folder window, for an unknown session, and when the registry cannot be read', async () => {
  const one = world({ tab: claudeTab('LAB'), folders: ['/w/a'], rows: [row('LAB', '/w/a')] })
  await one.badge.refresh()
  assert.equal(one.state.shown, false)
  one.badge.dispose()
  const unknown = world({ tab: claudeTab('NOPE'), rows: [row('LAB', '/w/a')] })
  await unknown.badge.refresh()
  assert.equal(unknown.state.shown, false)
  unknown.badge.dispose()
  const broken = world({ tab: claudeTab('LAB') })
  broken.badge.dispose()
  const vscode = { StatusBarAlignment: { Left: 1 }, window: { createStatusBarItem: () => broken.item, tabGroups: { activeTabGroup: { activeTab: claudeTab('LAB') }, onDidChangeTabs: () => ({ dispose() {} }), onDidChangeTabGroups: () => ({ dispose() {} }) } }, workspace: { workspaceFolders: [{ uri: { fsPath: '/a' } }, { uri: { fsPath: '/b' } }] } }
  const b = createFolderBadge({ vscode, registry: { list: async () => { throw new Error('boom') } } })
  await b.refresh()
  assert.equal(broken.state.shown, false)
  b.dispose()
})
