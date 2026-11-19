'use strict'
// Puts a lead's, a lane's and a conductor's session in the Claude sidebar's Session Manager group of that name (Lead, Lanes, Conductor), through the
// command `callboard assign group` that the optional second piece of patch-claude.py adds to the Claude Code extension. The command creates a missing group,
// matches names in any letter case and leaves a session that already sits in a group where it is. Without the patch the command does not exist and this does nothing.
// The roles come from the lane stores and lead records (the same loaders the spool uses), so a lead made, joined or adopted, and a lane opened or adopted, are
// all covered by one tick. A session is handled in the window whose folders hold its registry row (Claude's groups are kept per window), once: the done list
// lives in this extension's own state, so a session the person later moves out of its group is not put back.
const { pidAlive } = require('./reserved.js')

const COMMAND = 'callboard assign group'
const DONE_KEY = 'callboard.groups.done'
const DONE_MAX = 500
const TICK_MS = 10000

// session id -> group name. A session carries one role: a lead or lane record wins over being named as a conductor.
function groupsFor(lanes, leads) {
  const out = new Map()
  const add = (sid, group) => typeof sid === 'string' && !out.has(sid) && out.set(sid, group)
  for (const l of leads) add(l.sid, 'Lead')
  for (const l of lanes) add(l.sid, 'Lanes')
  for (const l of leads) add(l.conductorSid, 'Conductor')
  return out
}

function createGroups({ vscode, registry, state, loadLanes, loadLeads, workspaceFolders, alive = pidAlive }) {
  let busy = false
  const inWindow = (cwd) => typeof cwd === 'string' && workspaceFolders().some((f) => cwd === f || cwd.startsWith(`${f}/`))

  async function tick() {
    if (busy) return
    busy = true
    try {
      if (!(await vscode.commands.getCommands(true)).includes(COMMAND)) return
      const want = groupsFor(await loadLanes(), await loadLeads())
      const done = new Set(state.get(DONE_KEY, []))
      const todo = [...want].filter(([sid]) => !done.has(sid))
      if (!todo.length) return
      const rows = (await registry.list()).filter((r) => inWindow(r.cwd) && (!Number.isInteger(r.pid) || alive(r.pid)))
      try {
        for (const [sid, group] of todo) {
          if (!rows.some((r) => r.sessionId === sid)) continue
          await vscode.commands.executeCommand(COMMAND, sid, group)
          done.add(sid)
        }
      } finally {
        await state.update(DONE_KEY, [...done].slice(-DONE_MAX))
      }
    } catch {
      // Grouping is a convenience: a failed call or an unreadable store is tried again at the next tick, silently.
    } finally {
      busy = false
    }
  }

  return { tick, TICK_MS }
}

module.exports = { createGroups, groupsFor, COMMAND }
