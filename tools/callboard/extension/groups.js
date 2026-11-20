'use strict'
// Puts a lead's, and a lane's session in the Claude sidebar's Session Manager group of that name (Lead, Lanes), through the
// command `callboard assign group` that the optional fourth piece of patch-claude.py adds to the Claude Code extension. The command creates a missing group,
// matches names in any letter case and leaves a session that already sits in a group where it is. Without the patch the command does not exist and this does nothing.
// The roles come from the plugin's session table (a row with `lead` is a lead, one `under` a lead a lane), so a lead made or joined and a lane opened or adopted are all covered by one tick. A session is handled in the window whose folders hold its registry row (Claude keeps its groups per window, under the window's first
// folder), once: the done list is this window's own state, so a session the person later moves out of its group is not put back. The command answers false for a
// session it refused (an archived one, or the list limits): that one is not marked done and is tried again.
const { pidAlive } = require('./reserved.js')

const COMMAND = 'callboard assign group'
const DONE_KEY = 'callboard.groups.done'
const TICK_MS = 10000

// session id -> group name, from the table's rows: a row with `lead` is a Lead, one `under` a lead a Lanes. A row marked off is not callboard's.
function groupsFor(table = {}) {
  const out = new Map()
  for (const [sid, r] of Object.entries(table)) if (r && r.off !== true && (r.lead || r.under)) out.set(sid, r.lead ? 'Lead' : 'Lanes')
  return out
}

function createGroups({ vscode, registry, state, loadTable, workspaceFolders, alive = pidAlive }) {
  let busy = false
  let present = false
  const inWindow = (cwd) => typeof cwd === 'string' && workspaceFolders().some((f) => cwd === f || cwd.startsWith(`${f}/`))

  async function tick() {
    if (busy) return
    busy = true
    try {
      // Once the command has been seen it is not looked up again: a call to one that went away throws and is caught below.
      if (!present) present = (await vscode.commands.getCommands(true)).includes(COMMAND)
      if (!present) return
      const want = groupsFor(await loadTable())
      const was = state.get(DONE_KEY, [])
      const done = new Set(was)
      const todo = [...want].filter(([sid]) => !done.has(sid))
      if (todo.length) {
        const rows = (await registry.list()).filter((r) => inWindow(r.cwd) && (!Number.isInteger(r.pid) || alive(r.pid)))
        for (const [sid, group] of todo) {
          if (!rows.some((r) => r.sessionId === sid)) continue
          try {
            if ((await vscode.commands.executeCommand(COMMAND, sid, group)) !== false) done.add(sid)
          } catch {
            // One session that fails does not stop the others; it is tried again at the next tick.
          }
        }
      }
      // Only sessions the table still names are remembered, so the list cannot outgrow them.
      const keep = [...done].filter((sid) => want.has(sid))
      if (keep.length !== was.length || keep.some((sid, i) => sid !== was[i])) await state.update(DONE_KEY, keep)
    } catch {
      // Grouping is a convenience: an unreadable table or registry is tried again at the next tick, silently.
    } finally {
      busy = false
    }
  }

  return { tick, TICK_MS }
}

module.exports = { createGroups, groupsFor, COMMAND }
