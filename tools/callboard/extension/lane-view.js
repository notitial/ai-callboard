'use strict'
// "Callboard Lanes", a tree in the Explorer that lists every callboard session the records know, whether or not its panel is open, grouped under the lead that
// owns it, and below them each workspace folder's saved Claude conversations. A click reopens the session in its own folder through lanes.reopen, which keeps
// its own refusals (a folder this window does not serve). Sources: the plugin's session table (v2/sessions.json), the lane stores (allLanes) and the live
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
const OPEN = 'callboardPanels.openLane'
const ICON = { live: 'circle-filled', working: 'sync~spin', waiting: 'bell', parked: 'debug-pause', closed: 'circle-outline', gone: 'circle-slash' }

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

// One entry per known session, name order: the table's rows (a row marked off is not callboard's), then lane-store lanes the table does not hold, each joined with
// its live registry row. State: waiting or working or live while a process answers, else gone, parked, or closed. A session gone for a week is left out.
function buildEntries({ table, lanes, rows, now, alive = pidAlive }) {
  const known = new Map()
  for (const [sid, r] of Object.entries(table)) {
    if (SID_RE.test(sid) && r && typeof r.name === 'string' && typeof r.folder === 'string' && r.off !== true) known.set(sid, { sid, name: r.name, folder: r.folder, under: r.under, parked: r.parked, goneAt: r.goneAt })
  }
  for (const l of lanes) if (l.sid && !known.has(l.sid)) known.set(l.sid, { sid: l.sid, name: l.name, folder: l.folder })
  const live = new Map(rows.filter((r) => r && typeof r.sessionId === 'string' && (!Number.isInteger(r.pid) || alive(r.pid))).map((r) => [r.sessionId, r]))
  const out = []
  for (const e of known.values()) {
    const reg = live.get(e.sid)
    const state = reg ? (reg.waitingFor ? 'waiting' : reg.status === 'busy' ? 'working' : 'live') : e.goneAt ? 'gone' : e.parked ? 'parked' : 'closed'
    const at = reg ? (reg.statusAt ?? reg.startedAt) : (e.goneAt ?? e.parked)
    if (state === 'gone' && now - e.goneAt > GONE_MS) continue
    out.push({ sid: e.sid, name: e.name, folder: e.folder, state, lead: known.get(e.under)?.name, leadSid: known.has(e.under) ? e.under : undefined, age: Number.isFinite(at) ? ago(Math.max(0, now - at)) : undefined })
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
  for (const n of await fs.promises.readdir(dir).catch(() => [])) {
    const sid = n.endsWith('.jsonl') ? n.slice(0, -6) : ''
    if (!SID_RE.test(sid)) continue
    const st = await fs.promises.stat(path.join(dir, n)).catch(() => undefined)
    if (st && st.isFile()) out.push({ sid, at: st.mtimeMs })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max)
}

function createLaneView({ vscode, registry, lanes, loadLanes, tablePath, projectsDir, workspaceFolders, alive = pidAlive, now = Date.now }) {
  const changed = new vscode.EventEmitter()
  const kinds = vscode.TreeItemCollapsibleState
  let roots = []
  let seen = ''
  let running
  let chatsAt = -Infinity
  let chats = new Map()

  async function once() {
    const rows = await registry.list()
    const entries = buildEntries({ table: await readTable(tablePath), lanes: await loadLanes().catch(() => []), rows, now: now(), alive })
    const names = new Map(rows.filter((r) => typeof r.name === 'string').map((r) => [r.sessionId, r.name]))
    for (const e of entries) names.set(e.sid, e.name)
    const nodes = new Map(entries.map((e) => [e.sid, { kind: 'lane', ...e, kids: [] }]))
    const top = []
    for (const n of nodes.values()) (nodes.get(n.leadSid)?.kids ?? top).push(n)
    if (now() - chatsAt >= CHATS_MS) {
      chatsAt = now()
      chats = new Map(await Promise.all(workspaceFolders().map(async (f) => [f, await recentChats(projectsDir, f)])))
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
      const item = new vscode.TreeItem(node.name ?? node.sid.slice(0, 8), node.kids?.length ? kinds.Expanded : kinds.None)
      item.id = chat ? `chat:${node.folder}:${node.sid}` : `lane:${node.sid}`
      item.description = chat ? node.age : `${base} · ${node.state}`
      item.iconPath = new vscode.ThemeIcon(chat ? 'comment' : ICON[node.state])
      item.tooltip = [node.name ?? node.sid, chat ? undefined : node.state, node.lead && `lead ${node.lead}`, node.folder, node.age && `last activity ${node.age}${node.age === 'now' ? '' : ' ago'}`].filter(Boolean).join('\n')
      item.command = { command: OPEN, title: 'Open', arguments: [node.sid, node.folder] }
      return item
    },
  }

  const subs = [vscode.window.createTreeView('callboardLanes', { treeDataProvider: provider }), vscode.commands.registerCommand(OPEN, open), changed]
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  timer.unref?.()
  return { refresh, dispose: () => { clearInterval(timer); for (const s of subs) s.dispose() } }
}

module.exports = { createLaneView, buildEntries, recentChats, readTable }
