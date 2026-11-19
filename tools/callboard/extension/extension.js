'use strict'
const vscode = require('vscode')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildId } = require('./build.js')
const { createLanes } = require('./lanes.js')
const { createSpool, allLanes, allLeads } = require('./spool.js')
const { createSpool: createWindowSpool } = require('./spool-v2.js')
const { createRegistry } = require('./registry.js')
const { pidAlive } = require('./reserved.js')
const { claudePatched } = require('./claude-patch.js')
const { createFolderBadge } = require('./folder-badge.js')
const { createGroups } = require('./groups.js')
const { createLaneView, readTable } = require('./lane-view.js')

const CLAUDE = path.join(os.homedir(), '.claude')
const SESSIONS = path.join(CLAUDE, 'sessions')

const registry = createRegistry(SESSIONS)

// Shorter than the lead's 45 s wait for lane_open, which also covers the spool's 1 s scan and the lead's 0.5 s poll. Long enough for a slow panel and for
// its session id to settle (lanes.js).
const SPOOL_OPEN_MS = 20000

// A lead's panel gets a longer wait than a lane's: an upper bound that gives a slow cold window room (a fast open still answers at once). Shorter than the mod's 70 s wait for it, which also covers one lane open queued ahead.
const LEAD_OPEN_MS = 45000

// claude-vscode.editor.open opens the panel in the window's first folder, so a lane is only this window's when its folder is that one.
const primaryFolder = () => (vscode.workspace.workspaceFolders || []).slice(0, 1).map((f) => f.uri.fsPath)
// Once the Claude extension carries the cwd patch (tools/callboard/patch-claude.py) the command takes the folder, and every folder of the window is served.
const allFolders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)

// A registry row of a session that runs in the repo or under it, and whose process still answers when the row names a pid.
const liveIn = (repo) => (x) => x && typeof x.cwd === 'string' && (x.cwd === repo || x.cwd.startsWith(`${repo}/`)) && (!Number.isInteger(x.pid) || pidAlive(x.pid))

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
  const loadLanes = () => allLanes({ storeDir: path.join(CLAUDE, 'callboard', 'lanes') })
  const spool = createSpool({
    dir: path.join(CLAUDE, 'callboard', 'open'),
    loadLanes,
    loadLeads: () => allLeads({ recordDir: path.join(CLAUDE, 'callboard', 'lead-records') }),
    openLane: (folder) => lanes.open(folder, { timeoutMs: SPOOL_OPEN_MS, refuseUnnamed: true }),
    openLead: (folder) => lanes.open(folder, { timeoutMs: LEAD_OPEN_MS, refuseUnnamed: true }),
    closeLane: ({ sid, pid, name }) => lanes.adopt(sid, { name, pid }),
    reopenLane: (sid) => lanes.reopen(sid, { timeoutMs: SPOOL_OPEN_MS }),
    workspaceFolders: primaryFolder,
    liveInRepo: async (repo) => (await registry.list()).filter(liveIn(repo)).length,
  })
  context.subscriptions.push(spool.start())
  context.subscriptions.push(createWindowSpool({ dir: path.join(CLAUDE, 'callboard', 'v2', 'open'), lanes, workspaceFolders: windowFolders, timeoutMs: SPOOL_OPEN_MS }).start())
  try {
    context.subscriptions.push(createFolderBadge({ vscode, registry }))
  } catch {
    // no folder item
  }
  const tablePath = path.join(CLAUDE, 'callboard', 'v2', 'sessions.json')
  try {
    context.subscriptions.push(createLaneView({ vscode, registry, lanes, loadLanes, tablePath, projectsDir: path.join(CLAUDE, 'projects'), workspaceFolders: windowFolders }))
  } catch {
    // no lane list
  }
  const sweep = setInterval(() => lanes.sweep().catch(() => undefined), 2000)
  context.subscriptions.push({ dispose: () => clearInterval(sweep) })
  const groups = createGroups({ vscode, registry, state: context.workspaceState, workspaceFolders: windowFolders,
    loadLanes: () => allLanes({ storeDir: path.join(CLAUDE, 'callboard', 'lanes') }),
    loadLeads: () => allLeads({ recordDir: path.join(CLAUDE, 'callboard', 'lead-records') }),
    loadTable: () => readTable(tablePath),
  })
  const groupTick = setInterval(() => groups.tick(), groups.TICK_MS)
  context.subscriptions.push({ dispose: () => clearInterval(groupTick) })
}

module.exports = { activate, deactivate() {} }
