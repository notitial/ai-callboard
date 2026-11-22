'use strict'
// Brings Claude Code's Session Manager back as the side bar's view at window start. Claude Code shows that view only once it has activated, so when VS Code
// restores the side bar before that it falls back to the Explorer and nothing switches back. This waits for the Claude extension to activate, shows the view
// and puts the keyboard focus back in the editor, then does the same once more a moment later, in case the view was not yet shown when activation returned.
// Without the Claude extension, or when a command fails, nothing happens.
const VIEW = 'workbench.view.extension.claude-sessions-sidebar'
const FOCUS = 'workbench.action.focusActiveEditorGroup'
const AGAIN_MS = 2000

async function showClaudeView({ vscode, sleep }) {
  try {
    const claude = vscode.extensions.getExtension('anthropic.claude-code')
    if (!claude) return
    await claude.activate()
    for (const wait of [0, AGAIN_MS]) {
      if (wait) await sleep(wait)
      await vscode.commands.executeCommand(VIEW)
      await vscode.commands.executeCommand(FOCUS)
    }
  } catch {
    // the side bar stays as VS Code restored it
  }
}

module.exports = { showClaudeView, VIEW, FOCUS, AGAIN_MS }
