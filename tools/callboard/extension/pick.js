'use strict'
// The tick list for `/callboard conductor`: the repos a conductor may open leads in, chosen by the person in VS Code's own multi-select list, which no session can
// press. The plugin asks for it through the window's spool (spool-v2.js, `pick`) when the person types the command, and saves what comes back as if they had typed
// the paths, after its own checks.
// What the list offers, in this order, each once and by its real path, never the conductor's own folder:
//   1. the repos already saved for the conductor's folder that still exist, ticked;
//   2. the window's other folders: ticked when nothing is saved yet, unticked otherwise;
//   3. the git repos beside the conductor's folder, unticked: the direct children of its real path's parent that are real directories (a link is skipped) and hold
//      a `.git` entry.
// So it works in a window with one folder, before any workspace exists. At most SHOWN_MAX rows are shown and PICK_MAX may be ticked. The list closes itself after
// PICK_MS, a little under the plugin's own wait, so a click that comes later saves nothing. Escape, or Enter with nothing ticked, picks nothing.
const fsp = require('node:fs/promises')
const path = require('node:path')

const SHOWN_MAX = 100
const PICK_MAX = 32
const PICK_MS = 80_000
const CODES = ['cancelled', 'timeout', 'no-folders', 'too-many']

const real = (p) => fsp.realpath(p).catch(() => undefined)

// The git repos beside `own` (a real path), sorted by name. An unreadable parent has none.
async function siblings(own) {
  const parent = path.dirname(own)
  const entries = await fsp.readdir(parent, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    // A directory entry is read without following it, so a link to a folder elsewhere is not a directory here.
    if (out.length >= SHOWN_MAX) break
    if (!e.isDirectory()) continue
    const p = path.join(parent, e.name)
    if (p !== own && (await fsp.lstat(path.join(p, '.git')).then(() => true, () => false))) out.push(p)
  }
  return out
}

// The rows of the list for the conductor in `folder`: { folder, picked, inWindow }.
async function rowsFor(folder, windowFolders, ticked) {
  const own = await real(folder)
  if (own === undefined) return []
  const resolved = async (list) => (await Promise.all(list.map(real))).filter((p) => p !== undefined && p !== own)
  const [saved, inWindow] = [await resolved(ticked), await resolved(windowFolders)]
  const rows = new Map()
  const add = (p, picked) => rows.has(p) || rows.set(p, { folder: p, picked, inWindow: inWindow.includes(p) })
  for (const p of saved) add(p, true)
  for (const p of inWindow) add(p, saved.length === 0)
  for (const p of await siblings(own)) add(p, false)
  return [...rows.values()].slice(0, SHOWN_MAX)
}

// Shows the list and resolves the folders ticked. Rejects with one of CODES as its message when nothing was picked.
function createPick({ vscode, windowFolders, ms = PICK_MS }) {
  return async function pick(folder, ticked) {
    // The time limit runs from here, so it covers the reading of the folders too: a folder that never answers (a stuck mount) ends as `timeout`.
    const cts = new vscode.CancellationTokenSource()
    let late = false
    let timer
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => {
        late = true
        cts.cancel()
        resolve(undefined)
      }, ms)
    })
    let got
    try {
      const rows = await Promise.race([rowsFor(folder, windowFolders(), ticked), limit])
      if (rows === undefined) throw new Error('timeout')
      if (rows.length === 0) throw new Error('no-folders')
      const items = rows.map((r) => ({ label: path.basename(r.folder), description: r.inWindow ? `${r.folder} (in this window)` : r.folder, picked: r.picked, folder: r.folder }))
      got = await vscode.window.showQuickPick(items, { canPickMany: true, ignoreFocusOut: true, title: `Callboard: repos for the conductor in ${path.basename(folder)}`, placeHolder: `Tick the repos to open leads in (at most ${PICK_MAX}), then press Enter. Escape changes nothing.` }, cts.token)
    } finally {
      clearTimeout(timer)
      cts.dispose()
    }
    if (late) throw new Error('timeout')
    if (!Array.isArray(got) || got.length === 0) throw new Error('cancelled')
    if (got.length > PICK_MAX) throw new Error('too-many')
    return got.map((i) => i.folder)
  }
}

module.exports = { createPick, rowsFor, siblings, CODES, PICK_MAX, PICK_MS, SHOWN_MAX }
