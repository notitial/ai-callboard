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
// A lane that is retired is archived, through the patch's `callboard archive sessions`, so the sidebar keeps only the lanes that run or sit parked. Retired is read,
// not stored: the lane had a table row and a live process in this window, and now has neither. Only such a lane is ever named, so a lane retired before the
// extension saw it, a parked lane (its row stays), a live one (its process stays), a lead and the manager are never archived. The lane must be gone on two clean
// ticks in a row, and a tick whose reads are in doubt names no one. The plugin drops a row on a retire, 24 hours after a lane died without one, and 28 days after
// a park, so a lane in the last two cases is archived once its row is dropped: it is no longer parked or reachable by then.
const fs = require('node:fs')
const { pidAlive } = require('./reserved.js')
const { procStateWith } = require('./proc.js')

const COMMAND = 'callboard file session'
const DONE_KEY = 'callboard.groups.done'
const SEEN_KEY = 'callboard.groups.seen'
const ARCHIVE = 'callboard archive sessions'
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

// The session table as the plugin wrote it: an object keyed by session id; null for a missing file (the plugin's empty table, which files the manager but
// proves no lane retired). A file that does not parse throws, so the tick waits for a clean read instead of reading every lane as retired.
async function readSessionTable(file) {
  let text
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  const j = JSON.parse(text)
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('the session table is not an object')
  return j
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
  let canArchive = false
  let pending = new Set()
  const procState = procStateWith({ alive, startOf })
  const inWindow = (cwd) => typeof cwd === 'string' && workspaceFolders().some((f) => cwd === f || cwd.startsWith(`${f}/`))

  async function tick() {
    if (busy) return
    busy = true
    // A tick that stops early (doubt in a read, an error) leaves no lane pending: a lane must be gone on two clean ticks in a row.
    const prior = pending
    pending = new Set()
    try {
      // Once the command has been seen it is not looked up again: a call to one that went away throws and is caught below.
      if (!present) {
        const all = await vscode.commands.getCommands(true)
        present = all.includes(COMMAND)
        canArchive = all.includes(ARCHIVE)
      }
      if (!present) return
      const [loaded, list, name] = await Promise.all([loadTable(), registry.list(), managerName()])
      const table = loaded ?? {}
      // A read with doubt in it could miss the oldest manager and file another session as it: wait for a clean one.
      if (list.complete === false) return
      const manager = await managerOf(list, table, name, procState)
      if (manager === 'unknown') return
      const rows = list.filter((r) => !Number.isInteger(r.pid) || alive(r.pid))
      const want = groupsFor(table, manager)
      const was = state.get(DONE_KEY, {})
      // A stored value that is not a plain object (such as a list) is no record: every session is filed once more.
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
      if (canArchive && loaded) await archiveRetired({ want, table, rows, prior })
    } catch {
      // Grouping is a convenience: an unreadable table or registry is tried again at the next tick, silently.
    } finally {
      busy = false
    }
  }

  // The lanes this window has seen run (a table row and a live process in the window) are remembered; one that has neither now is retired, and goes after a second
  // tick that finds it so. Only a lane remembered is ever named, and one kept by any table row or live process (the manager has one) is not.
  async function archiveRetired({ want, table, rows, prior }) {
    const stored = state.get(SEEN_KEY, [])
    const seen = new Set(Array.isArray(stored) ? stored.filter((sid) => typeof sid === 'string') : [])
    const was = JSON.stringify([...seen])
    for (const [sid, group] of want) if (group === 'Lanes' && rows.some((r) => r.sessionId === sid && inWindow(r.cwd))) seen.add(sid)
    const here = (sid) => Object.hasOwn(table, sid) || rows.some((r) => r.sessionId === sid)
    const gone = [...seen].filter((sid) => !here(sid))
    const due = gone.filter((sid) => prior.has(sid))
    pending = new Set(gone)
    if (due.length) {
      try {
        await vscode.commands.executeCommand(ARCHIVE, 'Lanes', due)
        for (const sid of due) seen.delete(sid)
      } catch {
        // The command failed: the lanes stay remembered and are named again at the next tick.
      }
    }
    if (JSON.stringify([...seen]) !== was) await state.update(SEEN_KEY, [...seen])
  }

  return { tick, TICK_MS }
}

module.exports = { createGroups, groupsFor, managerOf, readManagerName, readSessionTable, COMMAND, ARCHIVE, ORDER }
