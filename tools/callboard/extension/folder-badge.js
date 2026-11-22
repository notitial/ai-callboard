'use strict'
// A status bar item, on the right side of the status bar, that names the folder (the repo) of the Claude panel in front, in a window that has more than one folder. The panel's session is found
// by its session id, from the `callboard active session` command of the patched Claude extension (tools/callboard/patch-claude.py), else by its tab label: a Claude panel's tab carries the session's name (cut to 24 characters and "…" when it is longer than 25, as Claude Code does), which the
// registry row also holds (the sweep in lanes.js relies on it too). A tab that is not a Claude panel, a name no live session carries, or one that two live
// sessions in different folders carry, shows nothing rather than a guess.
// VS Code access is injected, so the item can be tested with fakes; nothing here touches the Claude extension.
const path = require('node:path')
const { pidAlive } = require('./reserved.js')

const REFRESH_MS = 3000
const SESSION_COMMAND = 'callboard active session'

// The folder of the one live panel session whose id is `sid`, else of the one whose name is `label` (or whose name the label shortens), or undefined.
function folderOf(label, rows, alive, sid) {
  const cut = typeof label === 'string' && label.endsWith('…') ? label.slice(0, -1) : undefined
  const named = (name) => name === label || (cut !== undefined && typeof name === 'string' && name.length > cut.length && name.startsWith(cut))
  const one = (same) => {
    const dirs = new Set(rows.filter((r) => r.entrypoint === 'claude-vscode' && same(r) && typeof r.cwd === 'string' && r.cwd.startsWith('/') && (!Number.isInteger(r.pid) || alive(r.pid))).map((r) => r.cwd))
    return dirs.size === 1 ? [...dirs][0] : undefined
  }
  return (typeof sid === 'string' ? one((r) => r.sessionId === sid) : undefined) ?? one((r) => named(r.name))
}

function createFolderBadge({ vscode, registry, alive = pidAlive }) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  item.name = 'Callboard: folder of this Claude panel'
  let running
  let again = false

  async function once() {
    try {
      const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab
      const claude = tab && /claude/i.test(String(tab.input && tab.input.viewType))
      const many = (vscode.workspace.workspaceFolders || []).length > 1
      const rows = claude && many ? await registry.list() : undefined
      // Without the patch's session command (or with no panel in front) the call fails or returns nothing, and the label decides.
      const sid = rows && (await Promise.resolve().then(() => vscode.commands.executeCommand(SESSION_COMMAND)).catch(() => undefined))
      const dir = rows && folderOf(tab.label, rows, alive, sid)
      if (dir === undefined) return item.hide()
      item.text = `$(folder) ${path.basename(dir)}`
      item.tooltip = `This Claude session runs in ${dir}`
      item.show()
    } catch {
      item.hide()
    }
  }

  // A change that comes while a read is under way runs one more read afterwards, so the item never keeps the answer for a tab that is no longer in front.
  function refresh() {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await once()
      } while (again)
    })().finally(() => { running = undefined })
    return running
  }

  const subs = [vscode.window.tabGroups.onDidChangeTabs(() => void refresh()), vscode.window.tabGroups.onDidChangeTabGroups(() => void refresh())]
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  void refresh()
  return { refresh, dispose: () => { clearInterval(timer); for (const s of subs) s.dispose(); item.dispose() } }
}

module.exports = { createFolderBadge, folderOf }
