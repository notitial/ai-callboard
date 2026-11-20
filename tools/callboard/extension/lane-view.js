'use strict'
// "Callboard Lanes", a tree that lists the callboard sessions the records know in this window's workspace folders, whether or not their panel is open, grouped
// under the lead that owns them, and below them each workspace folder's saved Claude conversations. It sits in Claude Code's Session Manager when that list is
// on, else in the Explorer (package.json: one view id each, the same tree). A click reopens the session in its own folder through lanes.reopen. Sources: the plugin's session table (v2/sessions.json) and the live
// registry rows, and for the conversations only the file names and times under <claude dir>/projects/<folder>: no transcript is opened.
// VS Code access is injected, so the view can be tested with fakes.
const fs = require('node:fs')
const path = require('node:path')
const { SID_RE, pidAlive } = require('./reserved.js')

const REFRESH_MS = 3000
const CHATS_MS = 30000
const CHATS_MAX = 15
const GONE_MS = 7 * 86400000
const NAME_LIMIT = 200
const STAT_BATCH = 64
const OPEN = 'callboardPanels.openLane'
const VIEWS = ['callboardLanes', 'callboardLanesSidebar']
const ICON = { live: 'circle-filled', working: 'sync~spin', waiting: 'circle-filled', parked: 'debug-pause', closed: 'circle-outline', gone: 'circle-slash' }
const COLOR = { waiting: 'charts.orange' }

const finite = (x) => (Number.isFinite(x) ? x : undefined)
const ago = (ms) => (ms < 60000 ? 'now' : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : ms < 86400000 ? `${Math.floor(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`)

// The session table as the plugin wrote it: an object keyed by session id. No file, or one that does not parse, is no table.
async function readTable(file) {
  try {
    const j = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

// One entry per known session, name order: the table's rows (a row marked off is not callboard's), each joined with
// its live registry row. State: waiting or working or live while a process answers, else gone, parked, or closed. A session gone for a week is left out.
function buildEntries({ table, rows, now, alive = pidAlive }) {
  const known = new Map()
  for (const [sid, r] of Object.entries(table)) {
    if (SID_RE.test(sid) && r && typeof r.name === 'string' && typeof r.folder === 'string' && r.off !== true) known.set(sid, { sid, name: r.name, folder: r.folder, under: r.under, parked: finite(r.parked), goneAt: finite(r.goneAt) })
  }
  const live = new Map(rows.filter((r) => r && typeof r.sessionId === 'string' && (!Number.isInteger(r.pid) || alive(r.pid))).map((r) => [r.sessionId, r]))
  const out = []
  for (const e of known.values()) {
    const reg = live.get(e.sid)
    const leadSid = e.under !== e.sid && known.has(e.under) ? e.under : undefined
    const state = reg ? (reg.waitingFor ? 'waiting' : reg.status === 'busy' ? 'working' : 'live') : e.goneAt ? 'gone' : e.parked ? 'parked' : 'closed'
    const at = reg ? (reg.statusAt ?? reg.startedAt) : (e.goneAt ?? e.parked)
    if (state === 'gone' && now - e.goneAt > GONE_MS) continue
    out.push({ sid: e.sid, name: e.name, folder: e.folder, state, lead: leadSid && known.get(leadSid).name, leadSid, age: Number.isFinite(at) ? ago(Math.max(0, now - at)) : undefined })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// The saved conversations of a folder, newest first: the directory Claude Code keeps them in is the folder with every character that is not a letter or digit
// made "-". A name the host would shorten and hash (over 200 characters) is not matched.
async function recentChats(projectsDir, folder, max = CHATS_MAX) {
  const key = folder.replace(/[^a-zA-Z0-9]/g, '-')
  if (key.length > NAME_LIMIT) return []
  const dir = path.join(projectsDir, key)
  const out = []
  const names = (await fs.promises.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl') && SID_RE.test(n.slice(0, -6)))
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(names.slice(i, i + STAT_BATCH).map((n) => fs.promises.stat(path.join(dir, n)).then((st) => (st.isFile() ? { sid: n.slice(0, -6), at: st.mtimeMs } : undefined), () => undefined)))
    out.push(...batch.filter(Boolean))
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max)
}

function createLaneView({ vscode, registry, lanes, tablePath, projectsDir, workspaceFolders, alive = pidAlive, now = Date.now }) {
  const changed = new vscode.EventEmitter()
  const kinds = vscode.TreeItemCollapsibleState
  let roots = []
  let seen = ''
  let running
  let chatsAt = -Infinity
  let chats = new Map()

  async function once() {
    const rows = await registry.list()
    // A read that could not see every row would show live sessions as closed for one tick; the last list stays.
    if (rows.complete === false) return
    // Only what a click here can open: the sessions of this window's served folders (lanes.reopen refuses any other).
    const served = workspaceFolders()
    const entries = buildEntries({ table: await readTable(tablePath), rows, now: now(), alive }).filter((e) => served.includes(e.folder))
    const names = new Map(rows.filter((r) => typeof r.name === 'string').map((r) => [r.sessionId, r.name]))
    for (const e of entries) names.set(e.sid, e.name)
    const nodes = new Map(entries.map((e) => [e.sid, { kind: 'lane', ...e, kids: [] }]))
    const top = []
    // A lead chain that comes back to the node (a broken table) puts it at the top, so every node is shown once.
    const cyclic = (n) => {
      const seen = new Set([n.sid])
      let p = n.leadSid
      while (p !== undefined && !seen.has(p)) p = (seen.add(p), nodes.get(p)?.leadSid)
      return p === n.sid
    }
    for (const n of nodes.values()) (cyclic(n) ? top : (nodes.get(n.leadSid)?.kids ?? top)).push(n)
    if (now() - chatsAt >= CHATS_MS) {
      chats = new Map(await Promise.all(workspaceFolders().map(async (f) => [f, await recentChats(projectsDir, f)])))
      chatsAt = now()
    }
    const groups = [...chats].filter(([, list]) => list.length).map(([folder, list]) => ({
      kind: 'group', folder, kids: list.map((c) => ({ kind: 'chat', sid: c.sid, folder, name: names.get(c.sid), age: ago(Math.max(0, now() - c.at)) })),
    }))
    roots = [...top, ...groups]
    const sig = JSON.stringify(roots)
    if (sig !== seen) {
      seen = sig
      changed.fire(undefined)
    }
  }

  const refresh = () => (running ??= once().catch(() => undefined).finally(() => { running = undefined }))
  const first = refresh()

  const open = async (sid, folder) => {
    try {
      await lanes.reopen(sid, { folder })
    } catch (err) {
      vscode.window.showWarningMessage(`Callboard: could not open that session: ${err && err.message ? err.message : err}`)
    }
  }

  const provider = {
    onDidChangeTreeData: changed.event,
    async getChildren(node) {
      await first
      return node ? node.kids : roots
    },
    getTreeItem(node) {
      const base = path.basename(node.folder)
      if (node.kind === 'group') {
        const item = new vscode.TreeItem(`Recent chats: ${base}`, kinds.Collapsed)
        item.id = `group:${node.folder}`
        item.iconPath = new vscode.ThemeIcon('history')
        item.tooltip = node.folder
        return item
      }
      const chat = node.kind === 'chat'
      const item = new vscode.TreeItem(node.name || node.sid.slice(0, 8), node.kids?.length ? kinds.Expanded : kinds.None)
      item.id = chat ? `chat:${node.folder}:${node.sid}` : `lane:${node.sid}`
      item.description = chat ? node.age : `${base} · ${node.state}`
      item.iconPath = chat ? new vscode.ThemeIcon('comment') : new vscode.ThemeIcon(ICON[node.state], COLOR[node.state] && new vscode.ThemeColor(COLOR[node.state]))
      item.tooltip = [node.name ?? node.sid, chat ? undefined : node.state, node.lead && `lead ${node.lead}`, node.folder, node.age && `last activity ${node.age}${node.age === 'now' ? '' : ' ago'}`].filter(Boolean).join('\n')
      item.command = { command: OPEN, title: 'Open', arguments: [node.sid, node.folder] }
      return item
    },
  }

  const views = VIEWS.map((id) => vscode.window.createTreeView(id, { treeDataProvider: provider }))
  const subs = [...views, vscode.commands.registerCommand(OPEN, open), changed]
  for (const view of views) if (view.onDidChangeVisibility) subs.push(view.onDidChangeVisibility(() => void refresh()))
  // A collapsed or hidden view is not read.
  const timer = setInterval(() => (views.every((v) => v.visible === false) ? undefined : void refresh()), REFRESH_MS)
  timer.unref?.()
  return { refresh, dispose: () => { clearInterval(timer); for (const s of subs) s.dispose() } }
}

module.exports = { createLaneView, buildEntries, recentChats, readTable }
