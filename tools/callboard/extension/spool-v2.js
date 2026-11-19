'use strict'
// The window's spool for the plugin build: requests in ~/.claude/callboard/v2/open, answers beside them.
// <id>.req holds one JSON request: {op:'open',folder}, {op:'reopen',sid,folder} or {op:'close',sid,pid,name,folder}. <id> is the writer's own, one per request.
// Only the window whose first workspace folder is the request's folder takes it, and a request older than MAX_AGE_MS is dropped. The answer is <id>.result,
// JSON: {ok:true,sid?} or {ok:false,code}; a close is answered too, and its answer is not read. The panel of a close goes to the extension's sweep (lanes.js).
const fsp = require('node:fs/promises')
const path = require('node:path')
const { SID_RE, NAME_RE } = require('./reserved.js')

const MAX_AGE_MS = 120_000
const RESULT_KEEP_MS = 600_000
const MAX_BYTES = 1200
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
  if (r.op === 'close' && isSid(r.sid) && Number.isInteger(r.pid) && r.pid >= 2 && r.pid <= PID_MAX && typeof r.name === 'string' && NAME_RE.test(r.name)) {
    return { op: r.op, sid: r.sid, pid: r.pid, name: r.name, folder: r.folder }
  }
  return undefined
}

function createSpool({ dir, lanes, workspaceFolders, timeoutMs, now = Date.now }) {
  let seq = 0
  let busy = false
  const drop = (file) => fsp.unlink(file).catch(() => undefined)

  async function answer(id, reply) {
    const tmp = path.join(dir, `.${id}.${++seq}.tmp`)
    await fsp.writeFile(tmp, JSON.stringify(reply), { mode: 0o600 })
    await fsp.rename(tmp, path.join(dir, `${id}.result`)).catch(() => drop(tmp))
  }

  const refuse = async (id, code) => {
    await answer(id, { ok: false, code })
    return code
  }

  // What the window does for a request: the panel's session id for an open or a reopen, nothing for a close.
  async function perform(r) {
    if (r.op === 'close') {
      if (!lanes.adopt(r.sid, r)) throw new Error('refused')
      return undefined
    }
    return r.op === 'open' ? lanes.open(r.folder, { timeoutMs, refuseUnnamed: true }) : lanes.reopen(r.sid, { timeoutMs })
  }

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
    if (stale) return refuse(id, 'stale')
    try {
      const sid = await perform(r)
      if (r.op !== 'close' && !(r.op === 'reopen' ? sid === r.sid : isSid(sid))) throw new Error('no sid')
      await answer(id, sid === undefined ? { ok: true } : { ok: true, sid })
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
        if (m[2] === 'req') out.push([m[1], await handle(m[1])])
        else await expire(path.join(dir, f))
      }
    } catch {
      // an unreadable folder is skipped until the next scan
    } finally {
      busy = false
    }
    return out
  }

  function start(intervalMs = 1000) {
    const timer = setInterval(() => void scan(), intervalMs)
    return { dispose: () => clearInterval(timer) }
  }

  return { scan, handle, start }
}

module.exports = { createSpool, parse }
