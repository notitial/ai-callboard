'use strict'
// The pin a typed `/callboard lead`, `/callboard conductor` or lead preset asks for (spool-v2.js, op `pin`): pins the active tab when it is a Claude panel and does nothing otherwise.
// VS Code cannot pin a named tab from an extension (`workbench.action.pinEditor` takes the active editor), so the tab in front at that moment is the one pinned; pinning a pinned tab is a no-op.
// VS Code access is injected, so it can be tested with a fake.
function createPin({ vscode }) {
  return async function pin() {
    const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab
    if (tab && /claude/i.test(String(tab.input && tab.input.viewType))) await vscode.commands.executeCommand('workbench.action.pinEditor')
  }
}

module.exports = { createPin }
