'use strict'
// The window's spool for the plugin build: requests in ~/.claude/callboard/v2/open, answers beside them.
// <id>.req holds one JSON request: {op:'open',folder}, {op:'reopen',sid,folder}, {op:'close',sid,pid,name,folder} or {op:'pick',folder,ticked}. <id> is the writer's own, one per request.
// The writer writes `.<id>.tmp` and renames it to <id>.req, uses a fresh random <id> per request, and gives the folder exactly as VS Code names a workspace folder.
// Only a window that serves the folder takes it (`workspaceFolders()`: its first folder, or every folder when the Claude extension carries the cwd patch,
// claude-patch.js), and a request older than MAX_AGE_MS (twice the writer's own wait) is dropped. The answer is <id>.result,
// JSON: {ok:true,sid?} or {ok:false,code}; a close is not answered (the writer does not wait for one). The panel of a close goes to the extension's sweep (lanes.js).
// A pick shows the conductor's tick list (pick.js) and is answered {ok:true,folders} with what the person ticked. It waits for the person, so it is claimed like
// any request and then runs beside the scan: the window goes on serving opens while the list is up. One list at a time; a second pick is answered `busy`.
const fsp = require('node:fs/promises')
const path = require('node:path')
const { SID_RE, LABEL_RE } = require('./reserved.js')
const { CODES: PICK_CODES, PICK_MAX } = require('./pick.js')

const MAX_AGE_MS = 60_000
const RESULT_KEEP_MS = 600_000
// Room for a pick's ticked folders.
const MAX_BYTES = 40_000
const PID_MAX = 2 ** 22
const FILE_RE = /^([A-Za-z0-9_-]{1,40})\.(req|result)$/

const isSid = (v) => typeof v === 'string' && SID_RE.test(v)

// The request in the text, or undefined for anything that is not one. The folder is only compared with the window's own, so it needs no other check.
function parse(text) {
  let r
  try {
    r = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!r || typeof r.folder !== 'string' || r.folder === '') return undefined
  if (r.op === 'open') return { op: r.op, folder: r.folder }
  if (r.op === 'reopen' && isSid(r.sid)) return { op: r.op, sid: r.sid, folder: r.folder }
  if (r.op === 'close' && isSid(r.sid) && Number.isInteger(r.pid) && r.pid >= 2 && r.pid <= PID_MAX && typeof r.name === 'string' && LABEL_RE.test(r.name)) {
    return { op: r.op, sid: r.sid, pid: r.pid, name: r.name, folder: r.folder }
  }
  // The ticked folders only choose which rows of the list start ticked, so a string is all each needs to be.
  if (r.op === 'pick' && Array.isArray(r.ticked) && r.ticked.length <= PICK_MAX && r.ticked.every((p) => typeof p === 'string')) return { op: r.op, folder: r.folder, ticked: r.ticked }
  return undefined
}

function createSpool({ dir, lanes, workspaceFolders, timeoutMs, pick, now = Date.now }) {
  let seq = 0
  let busy = false
  // The tick list that is up, if one is: a promise that settles once its answer is written.
  let picking
  const drop = (file) => fsp.unlink(file).catch(() => undefined)

  async function answer(id, reply) {
    const tmp = path.join(dir, `.${id}.${++seq}.tmp`)
    await fsp.writeFile(tmp, JSON.stringify(reply), { mode: 0o600 })
    await fsp.rename(tmp, path.join(dir, `${id}.result`))
  }

  const refuse = async (id, code) => {
    await answer(id, { ok: false, code })
    return code
  }

  // What the window does for an open or a reopen: the panel's session id.
  const perform = (r) => (r.op === 'open' ? lanes.open(r.folder, { timeoutMs, refuseUnnamed: true }) : lanes.reopen(r.sid, { timeoutMs, folder: r.folder }))

  // One request file. Returns what happened, for the tests; nothing is thrown for a bad request. A request for another window's folder stays where it is.
  async function handle(id) {
    const file = path.join(dir, `${id}.req`)
    const st = await fsp.lstat(file).catch(() => undefined)
    if (!st) return 'gone'
    const text = st.isFile() && st.size <= MAX_BYTES ? await fsp.readFile(file, 'utf8').catch(() => undefined) : undefined
    const r = parse(text)
    const stale = now() - st.mtimeMs > MAX_AGE_MS
    if (r && !stale && !(workspaceFolders() || []).includes(r.folder)) return 'not-mine'
    // The claim is a rename: of two windows that race, one loses it (an unlink is not exclusive on every file system).
    const taken = path.join(dir, `.${id}.${process.pid}.${++seq}.taken`)
    if (!(await fsp.rename(file, taken).then(() => true, () => false))) return 'claim-lost'
    await drop(taken)
    if (!r) return refuse(id, 'bad-request')
    if (r.op === 'close') return !stale && lanes.adopt(r.sid, r) ? 'done' : 'dropped'
    if (stale) return refuse(id, 'stale')
    if (r.op === 'pick') {
      if (!pick) return refuse(id, 'failed')
      if (picking) return refuse(id, 'busy')
      picking = Promise.resolve()
        .then(() => pick(r.folder, r.ticked))
        .then((folders) => answer(id, { ok: true, folders }), (e) => refuse(id, PICK_CODES.find((c) => c === (e && e.message)) ?? 'failed'))
        .catch(() => undefined)
        .finally(() => {
          picking = undefined
        })
      return 'picking'
    }
    try {
      const sid = await perform(r)
      if (!(r.op === 'reopen' ? sid === r.sid : isSid(sid))) throw new Error('no sid')
      await answer(id, { ok: true, sid })
      return 'done'
    } catch (e) {
      const m = String((e && e.message) || '')
      return refuse(id, /^(timeout|ambiguous|unnamed-panel|live-elsewhere|registry-incomplete|refused)/.exec(m)?.[1] ?? (m.includes('workspace folder') ? 'not-workspace' : 'failed'))
    }
  }

  async function expire(file) {
    const st = await fsp.lstat(file).catch(() => undefined)
    if (st && now() - st.mtimeMs > RESULT_KEEP_MS) await drop(file)
  }

  async function scan() {
    if (busy) return []
    busy = true
    const out = []
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      for (const f of await fsp.readdir(dir)) {
        const m = FILE_RE.exec(f)
        if (!m) continue
        // A request whose answer cannot be written is already claimed: it is reported and the scan goes on.
        if (m[2] === 'req') out.push([m[1], await handle(m[1]).catch(() => 'answer-failed')])
        else await expire(path.join(dir, f))
      }
    } catch {
      // an unreadable folder is skipped until the next scan
    } finally {
      busy = false
    }
    return out
  }

  function start() {
    const timer = setInterval(() => void scan(), 1000)
    return { dispose: () => clearInterval(timer) }
  }

  return { scan, handle, start, picked: () => picking ?? Promise.resolve() }
}

module.exports = { createSpool, parse }
