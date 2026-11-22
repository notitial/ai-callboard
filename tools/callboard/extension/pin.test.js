'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPin } = require('./pin.js')

const fake = (activeTab) => {
  const calls = []
  return { calls, vscode: { window: { tabGroups: { activeTabGroup: { activeTab } } }, commands: { executeCommand: async (...a) => void calls.push(a) } } }
}

test('the active tab is pinned when it is a Claude panel', async () => {
  const f = fake({ input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } })
  await createPin({ vscode: f.vscode })()
  assert.deepEqual(f.calls, [['workbench.action.pinEditor']])
})

test('a text editor, another webview or no tab is not pinned', async () => {
  for (const tab of [{ input: { uri: 'file:///a.txt' } }, { input: { viewType: 'mainThreadWebview-markdown.preview' } }, { input: undefined }, undefined]) {
    const f = fake(tab)
    await createPin({ vscode: f.vscode })()
    assert.deepEqual(f.calls, [], JSON.stringify(tab))
  }
})
