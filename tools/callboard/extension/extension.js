'use strict'
const vscode = require('vscode')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildId } = require('./build.js')
const { createLanes } = require('./lanes.js')
const { createSpool } = require('./spool-v2.js')
const { createPick } = require('./pick.js')
const { createRegistry } = require('./registry.js')
const { claudePatched } = require('./claude-patch.js')
const { createFolderBadge } = require('./folder-badge.js')
const { createRunBlock } = require('./run-block.js')
const { createGroups, readManagerName, readSessionTable } = require('./groups.js')
const { showClaudeView } = require('./claude-view.js')

const CLAUDE = path.join(os.homedir(), '.claude')
const SESSIONS = path.join(CLAUDE, 'sessions')

const registry = createRegistry(SESSIONS)

// Long enough for a slow panel and for its session id to settle (lanes.js).
const SPOOL_OPEN_MS = 20000

// claude-vscode.editor.open opens the panel in the window's first folder, so without the cwd patch a lane is only this window's when its folder is that one.
const primaryFolder = () => (vscode.workspace.workspaceFolders || []).slice(0, 1).map((f) => f.uri.fsPath)
// Once the Claude extension carries the cwd patch (tools/callboard/patch-claude.py) the command takes the folder, and every folder of the window is served.
const allFolders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)

function activate(context) {
  // The version is fixed, so the build (the checkout's commit) tells a window that has loaded a pull from one that has not: Output > Callboard Panels.
  // A diagnostic line must never stop the extension from starting.
  let log
  try {
    log = vscode.window.createOutputChannel('Callboard Panels')
    context.subscriptions.push(log)
    log.appendLine(`callboard panels ${context.extension.packageJSON.version}, build ${buildId(fs.realpathSync(__dirname))}`)
  } catch {
    // no build line
  }
  // Read once, as the Claude extension is: a patch applied or undone takes effect in both at the next window reload.
  const patched = claudePatched(vscode.extensions)
  const windowFolders = patched ? allFolders : primaryFolder
  try {
    log.appendLine(`claude cwd patch: ${patched ? 'present, every workspace folder is served' : 'absent, only the first workspace folder is served'}`)
  } catch {
    // no output channel or line
  }
  const lanes = createLanes({ vscode, registry, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    workspaceFolders: windowFolders, passCwd: patched,
  })
  // The conductor's tick list offers every folder of the window, patched or not: it only saves a list, and a lead is opened later through `windowFolders`.
  const pick = createPick({ vscode, windowFolders: allFolders })
  context.subscriptions.push(createSpool({ dir: path.join(CLAUDE, 'callboard', 'v2', 'open'), lanes, workspaceFolders: windowFolders, timeoutMs: SPOOL_OPEN_MS, pick }).start())
  try {
    context.subscriptions.push(createFolderBadge({ vscode, registry }))
  } catch {
    // no folder item
  }
  try {
    // The Run button the Claude patch adds to shell code blocks calls this; it always asks in a modal first (run-block.js).
    const runBlock = createRunBlock({ vscode, spawn: require('node:child_process').spawn })
    context.subscriptions.push(vscode.commands.registerCommand('callboard run block', (arg) => runBlock.run(arg)), runBlock)
  } catch {
    // no run command
  }
  const tablePath = path.join(CLAUDE, 'callboard', 'v2', 'sessions.json')
  const sweep = setInterval(() => lanes.sweep().catch(() => undefined), 2000)
  context.subscriptions.push({ dispose: () => clearInterval(sweep) })
  const groups = createGroups({ vscode, registry, state: context.globalState, workspaceFolders: windowFolders,
    loadTable: () => readSessionTable(tablePath), managerName: () => readManagerName(path.join(CLAUDE, 'callboard', 'manager-name')),
  })
  const groupTick = setInterval(() => groups.tick(), groups.TICK_MS)
  context.subscriptions.push({ dispose: () => clearInterval(groupTick) })
  void showClaudeView({ vscode, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
}

module.exports = { activate, deactivate() {} }
