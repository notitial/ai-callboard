'use strict'
// Files callboard's sessions in the Claude sidebar's Session Manager groups by tier (Manager, Conductor, Lead, Lanes), through the command
// `callboard file session` that the optional group piece of patch-claude.py adds to the Claude Code extension. The command creates a missing group, matches
// names in any letter case, moves the session out of any other group, and keeps these groups first, in tier order. Without the patch the command does not exist
// and this does nothing.
// The tiers come from the plugin's own records: the manager is the oldest running session named in the manager-name file (the plugin's rule, core/model.ts), a
// conductor is a table row whose `lead` the person's `/callboard conductor` flagged, any other `lead` row is a lead, one `under` a lead a lane. A session is
// handled in the window whose folders hold its registry row (Claude keeps its groups per window, under the window's first folder). The group each session was
// filed in is kept where Claude keeps the groups themselves, in the extension's global state under the window's first folder, so the record and the groups
// belong to the same account and window: a session is filed again only when its tier's group differs from that one, so a session the person moves by hand stays
// moved until its tier changes. The command answers false for a session it refused (an archived one, or the list limits): that one is tried again.
// A lane that is retired is archived, through the patch's `callboard archive sessions`, so the sidebar keeps only the lanes that run or sit parked. Retired is read,
// not stored: the lane had a table row and a live process in this window, and now has neither. Only such a lane is ever named, so a lane retired before the
// extension saw it, a parked lane (its row stays), a live one (its process stays) and the manager are never archived. The lane must be gone on two clean
// ticks in a row, and a tick whose reads are in doubt names no one. The plugin drops a row on a retire, 24 hours after a lane died without one, and 28 days after
// a park, so a lane in the last two cases is archived once its row is dropped: it is no longer parked or reachable by then.
// A lead a conductor made is archived the same way when it is retired: one whose row shows it closed or parked on any tick of this window is forgotten, so it
// stays listed for the person to reopen, also after the plugin drops its row. The window has to tick at least once while the row shows that: a lead closed while
// no window on its folder ran until its row was dropped (24 hours, or 28 days parked) reads as retired. A lead the person typed and a conductor are never archived. A retired session is filed in its tier's group before it is archived,
// since the archive command takes only a session that sits there.
// A session that handed itself over to a clear one (`/callboard handover`) is archived the same way whatever its tier (the typed lead, a conductor and the manager too): the plugin's
// `handovers.json` names each old session with its group and folder. A session that archives itself (`/callboard archive`) is recorded there too, marked `archive`, and is
// archived without the undo wait. The ids archived are kept, so a session is never archived twice.
// A session that still has a table row but no tier (`lead off` on a typed lead, or `off`) is taken out of the group it was filed in, through the patch's `callboard unfile session`,
// and only out of that one, so a session the person moved by hand stays where it is. The record keeps it until the command answers true. `/callboard on` or `lead` files it again.
const fs = require('node:fs')
const { pidAlive } = require('./reserved.js')
const { procStateWith } = require('./proc.js')

const COMMAND = 'callboard file session'
const DONE_KEY = 'callboard.groups.done'
const SEEN_KEY = 'callboard.groups.seen'
const HANDED_KEY = 'callboard.groups.handed'
const ARCHIVE = 'callboard archive sessions'
const UNFILE = 'callboard unfile session'
const TICK_MS = 10000
// A handover can still be undone for this long after it started (the plugin's own marker window).
const UNDO_MS = 120000
const ORDER = ['Manager', 'Conductor', 'Lead', 'Lanes']
// The groups a retired session is archived from, each with the record of its sessions seen running.
const SEEN_KEYS = { Lanes: SEEN_KEY, Lead: 'callboard.groups.seenLeads' }

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
  return readObject(file, 'session table')
}
async function readObject(file, what) {
  let text
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  const j = JSON.parse(text)
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`the ${what} is not an object`)
  return j
}

// The plugin's handover record: the old sessions of each name with their group and folder. null for a missing file; a file that does not parse throws, so the tick waits.
async function readHandovers(file) {
  const j = await readObject(file, 'handover record')
  return j && Object.values(j).flatMap((e) => (Array.isArray(e?.old) ? e.old : [])).filter((o) => typeof o?.sid === 'string' && ORDER.includes(o.group) && typeof o.folder === 'string' && Number.isFinite(o.at))
}

// session id -> group name: the manager first, then the table's rows. A row marked off is not callboard's; a loose row is not filed.
function groupsFor(table, manager) {
  const out = new Map(manager ? [[manager, 'Manager']] : [])
  for (const [sid, r] of Object.entries(table)) {
    if (!r || r.off === true || out.has(sid)) continue
    const group = r.lead ? (r.lead.conductor === true && r.lead.minted !== true ? 'Conductor' : 'Lead') : r.under ? 'Lanes' : undefined
    if (group) out.set(sid, group)
  }
  return out
}

function createGroups({ vscode, registry, state, loadTable, loadHandovers = async () => null, managerName, workspaceFolders, alive = pidAlive, startOf }) {
  let busy = false
  let present = false
  let canArchive = false
  let canUnfile = false
  let pending = new Set()
  const procState = procStateWith({ alive, startOf })
  // Claude keys its groups by the window's first folder; the records here are keyed the same way.
  const keyOf = (key) => `${key}:${workspaceFolders()[0] ?? ''}`
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
        canUnfile = all.includes(UNFILE)
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
      const was = state.get(keyOf(DONE_KEY), {})
      const filed = { ...was }
      for (const [sid, group] of want) {
        if (filed[sid] === group || !rows.some((r) => r.sessionId === sid && inWindow(r.cwd))) continue
        try {
          if ((await vscode.commands.executeCommand(COMMAND, sid, group, ORDER)) !== false) filed[sid] = group
        } catch {
          // One session that fails does not stop the others; it is tried again at the next tick.
        }
      }
      // A session with a row and no tier is taken out of its group; it stays in the record until that has worked.
      // A manager that is closed is in no tier but is not off: it stays filed, so that it is not filed again when it is resumed.
      const leaving = new Set()
      const managed = [...want.values()].includes('Manager')
      for (const [sid, group] of Object.entries(filed)) {
        if (!canUnfile || want.has(sid) || !Object.hasOwn(table, sid) || (group === 'Manager' && !managed && table[sid]?.off !== true)) continue
        try {
          if ((await vscode.commands.executeCommand(UNFILE, sid, group)) === true) {
            delete filed[sid]
            continue
          }
        } catch {
          // The session is taken out again at the next tick.
        }
        leaving.add(sid)
      }
      // Only sessions still in a tier (or still to be taken out of one) are remembered, so the record cannot outgrow them. The manager is in a tier only while it
      // runs, so while no manager runs its entry is kept: a manager closed and resumed is not filed again.
      const keep = Object.fromEntries(Object.entries(filed).filter(([sid, group]) => want.has(sid) || leaving.has(sid) || (!managed && group === 'Manager')))
      if (JSON.stringify(keep) !== JSON.stringify(was)) await state.update(keyOf(DONE_KEY), keep)
      if (canArchive && loaded) await archiveRetired({ want, table, rows, prior })
      if (canArchive && loaded) await archiveHanded({ table, rows, prior })
    } catch {
      // Grouping is a convenience: an unreadable table or registry is tried again at the next tick, silently.
    } finally {
      busy = false
    }
  }

  // The lanes and the conductor-made leads this window has seen run (a table row and a live process in the window) are remembered, each group in its own list;
  // one that has neither now is retired, and goes after a second tick that finds it so. Only a session remembered is ever named, and one kept by any table row or
  // live process (the manager has one) is not. A lead is forgotten as soon as its row shows it closed (`goneAt`) or parked, so only one whose row went while it
  // still ran is archived.
  async function archiveRetired({ want, table, rows, prior }) {
    const here = (sid) => Object.hasOwn(table, sid) || rows.some((r) => r.sessionId === sid)
    const next = new Set()
    for (const [group, key] of Object.entries(SEEN_KEYS)) {
      const stored = state.get(keyOf(key), [])
      const seen = new Set(Array.isArray(stored) ? stored.filter((sid) => typeof sid === 'string') : [])
      const was = JSON.stringify([...seen])
      for (const [sid, g] of want) {
        if (g !== group) continue
        const row = table[sid]
        if (group === 'Lead' && (row.lead.minted !== true || row.goneAt !== undefined || row.parked !== undefined)) seen.delete(sid)
        else if (rows.some((r) => r.sessionId === sid && inWindow(r.cwd))) seen.add(sid)
      }
      const gone = [...seen].filter((sid) => !here(sid))
      for (const sid of gone) next.add(sid)
      const due = gone.filter((sid) => prior.has(sid))
      if (due.length) {
        try {
          // The archive command takes only a session that sits in the group, so each is filed there first. One the file command refuses (archived already, or
          // the list limits) cannot be archived and is forgotten; any other stays remembered until the archive command names it as done.
          for (const sid of due) if ((await vscode.commands.executeCommand(COMMAND, sid, group, ORDER)) === false) seen.delete(sid)
          const filed = due.filter((sid) => seen.has(sid))
          const done = filed.length ? await vscode.commands.executeCommand(ARCHIVE, group, filed) : []
          for (const sid of Array.isArray(done) ? done : []) seen.delete(sid)
        } catch {
          // A command failed: the sessions stay remembered and are named again at the next tick.
        }
      }
      if (JSON.stringify([...seen]) !== was) await state.update(keyOf(key), [...seen])
    }
    pending = next
  }

  // The old sessions of a handover or an archive in this window with neither a table row nor a live process, gone on two clean ticks (a handover also past its undo wait), are filed in their group and archived. One the file
  // command refuses is forgotten, as is one the archive command names; any other is named again at the next tick. The record keeps only ids the handover file still lists.
  async function archiveHanded({ table, rows, prior }) {
    const olds = await loadHandovers()
    if (olds === null) return
    const stored = state.get(keyOf(HANDED_KEY), [])
    const done = new Set(Array.isArray(stored) ? stored.filter((sid) => typeof sid === 'string') : [])
    const was = JSON.stringify([...done])
    const gone = olds.filter((o) => !done.has(o.sid) && (o.archive === true || Date.now() - o.at > UNDO_MS) && inWindow(o.folder) && !Object.hasOwn(table, o.sid) && !rows.some((r) => r.sessionId === o.sid))
    for (const o of gone.filter((x) => prior.has(x.sid))) {
      try {
        if ((await vscode.commands.executeCommand(COMMAND, o.sid, o.group, ORDER)) === false) done.add(o.sid)
        else if ((await vscode.commands.executeCommand(ARCHIVE, o.group, [o.sid]))?.includes?.(o.sid)) done.add(o.sid)
      } catch {
        // A command failed: the session is named again at the next tick.
      }
    }
    for (const o of gone) pending.add(o.sid)
    const keep = [...done].filter((sid) => olds.some((o) => o.sid === sid))
    if (JSON.stringify(keep) !== was) await state.update(keyOf(HANDED_KEY), keep)
  }

  return { tick, TICK_MS }
}

module.exports = { createGroups, groupsFor, managerOf, readHandovers, readManagerName, readSessionTable, COMMAND, ARCHIVE, UNFILE }
