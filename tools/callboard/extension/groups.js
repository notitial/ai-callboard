'use strict'
// Files callboard's sessions in the Claude sidebar's Session Manager groups by tier (Manager, Conductor, Lead, Lanes), through the command
// `callboard file session` that the optional group piece of patch-claude.py adds to the Claude Code extension. The command creates a missing group, matches
// names in any letter case, moves the session out of any other group, and keeps these groups first, in tier order. Without the patch the command does not exist
// and this does nothing.
// The tiers come from the plugin's own records: the manager is the oldest running session named in the manager-name file (the plugin's rule, core/model.ts), a
// conductor is a table row whose `lead` the person's `/callboard conductor` flagged, any other `lead` row is a lead, one `under` a lead a lane. A session is
// handled in the window whose folders hold its registry row (Claude keeps its groups per window, under the window's first folder). The group each session was
// filed in is this window's own state: a session is filed again only when its tier's group differs from that one, so a session the person moves by hand stays
// moved until its tier changes. The command answers false for a session it refused (an archived one, or the list limits): that one is tried again.
const fs = require('node:fs')
const { pidAlive } = require('./reserved.js')
const { procStateWith } = require('./proc.js')

const COMMAND = 'callboard file session'
const DONE_KEY = 'callboard.groups.done'
const TICK_MS = 10000
const ORDER = ['Manager', 'Conductor', 'Lead', 'Lanes']

// The manager-name file's first line, or null for a missing or empty file. A file that is there but cannot be read throws, so the tick waits for a clean read
// instead of filing the manager as nobody, as the plugin's `unknown` does.
async function readManagerName(file) {
  try {
    return (await fs.promises.readFile(file, 'utf8')).split('\n', 1)[0].trim() || null
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

// The manager, as the plugin picks it: of the registry rows that carry the manager's name and whose table row is not off, the oldest whose process is proven
// to be the one that wrote the row (`state`: proc.js, so a dead row whose pid was reused is not taken). `unknown` when one of them can be neither proven nor
// ruled out, as the plugin's view is then unknown too.
async function managerOf(rows, table, name, state) {
  const start = (r) => (Number.isFinite(Date.parse(r.procStart)) ? Date.parse(r.procStart) : Infinity)
  const live = []
  for (const r of name ? rows.filter((x) => x.name === name && table[x.sessionId]?.off !== true) : []) {
    const s = await state(r.pid, r.procStart)
    if (s === 'maybe') return 'unknown'
    if (s === 'live') live.push(r)
  }
  return live.sort((a, b) => start(a) - start(b) || (a.sessionId < b.sessionId ? -1 : 1))[0]?.sessionId
}

// session id -> group name: the manager first, then the table's rows. A row marked off is not callboard's; a loose row is not filed.
function groupsFor(table = {}, manager) {
  const out = new Map(manager ? [[manager, 'Manager']] : [])
  for (const [sid, r] of Object.entries(table)) {
    if (!r || r.off === true || out.has(sid)) continue
    const group = r.lead ? (r.lead.conductor === true && r.lead.minted !== true ? 'Conductor' : 'Lead') : r.under ? 'Lanes' : undefined
    if (group) out.set(sid, group)
  }
  return out
}

function createGroups({ vscode, registry, state, loadTable, managerName, workspaceFolders, alive = pidAlive, startOf }) {
  let busy = false
  let present = false
  const procState = procStateWith({ alive, startOf })
  const inWindow = (cwd) => typeof cwd === 'string' && workspaceFolders().some((f) => cwd === f || cwd.startsWith(`${f}/`))

  async function tick() {
    if (busy) return
    busy = true
    try {
      // Once the command has been seen it is not looked up again: a call to one that went away throws and is caught below.
      if (!present) present = (await vscode.commands.getCommands(true)).includes(COMMAND)
      if (!present) return
      const [table, list, name] = await Promise.all([loadTable(), registry.list(), managerName()])
      // A read with doubt in it could miss the oldest manager and file another session as it: wait for a clean one.
      if (list.complete === false) return
      const manager = await managerOf(list, table, name, procState)
      if (manager === 'unknown') return
      const rows = list.filter((r) => !Number.isInteger(r.pid) || alive(r.pid))
      const want = groupsFor(table, manager)
      const was = state.get(DONE_KEY, {})
      // Anything but a plain object (the session list an older version kept) is no record: every session is filed once more.
      const filed = was && typeof was === 'object' && !Array.isArray(was) ? { ...was } : {}
      for (const [sid, group] of want) {
        if (filed[sid] === group || !rows.some((r) => r.sessionId === sid && inWindow(r.cwd))) continue
        try {
          if ((await vscode.commands.executeCommand(COMMAND, sid, group, ORDER)) !== false) filed[sid] = group
        } catch {
          // One session that fails does not stop the others; it is tried again at the next tick.
        }
      }
      // Only sessions still in a tier are remembered, so the record cannot outgrow them. The manager is in a tier only while it runs, so while no manager
      // runs its entry is kept: a manager closed and resumed is not filed again.
      const managed = [...want.values()].includes('Manager')
      const keep = Object.fromEntries(Object.entries(filed).filter(([sid, group]) => want.has(sid) || (!managed && group === 'Manager')))
      if (JSON.stringify(keep) !== JSON.stringify(was)) await state.update(DONE_KEY, keep)
    } catch {
      // Grouping is a convenience: an unreadable table or registry is tried again at the next tick, silently.
    } finally {
      busy = false
    }
  }

  return { tick, TICK_MS }
}

module.exports = { createGroups, groupsFor, managerOf, readManagerName, COMMAND, ORDER }
