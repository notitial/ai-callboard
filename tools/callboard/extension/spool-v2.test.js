'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSpool, parse } = require('./spool-v2.js')
const { createLanes } = require('./lanes.js')

const SID = '1a1b2c3d-0000-4000-8000-123456789abc'
const OTHER = '2b2c3d4e-0000-4000-8000-123456789abc'
const FOLDER = '/work/repo/lab'

// `lanes` stands in for lanes.js: open and reopen answer a session id, adopt answers whether it took the panel.
function world({ ws = [FOLDER], lanes = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-spool2-')), now, pick } = {}) {
  const calls = []
  let shift = 0
  const fake = {
    open: async (...a) => (calls.push(['open', ...a]), SID),
    reopen: async (...a) => (calls.push(['reopen', ...a]), a[0]),
    adopt: (...a) => (calls.push(['adopt', ...a]), true),
    ...lanes,
  }
  const spool = createSpool({ dir, lanes: fake, workspaceFolders: () => ws, timeoutMs: 20000, pick, now: now ?? (() => Date.now() + shift) })
  const put = (id, req, text = typeof req === 'string' ? req : JSON.stringify(req)) => {
    const f = path.join(dir, `${id}.req`)
    fs.writeFileSync(f, text)
    return f
  }
  const result = (id) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.result`), 'utf8')) } catch { return undefined }
  }
  return { dir, spool, calls, put, result, tick: (ms) => { shift += ms } }
}

const OPEN = { op: 'open', folder: FOLDER }
const CLOSE = { op: 'close', sid: SID, pid: 4242, name: 'LAB', folder: FOLDER }

test('an open for the window\'s folder opens a panel, answers its session id and removes the request', async () => {
  const w = world()
  const file = w.put('a1', OPEN)
  assert.deepEqual(await w.spool.scan(), [['a1', 'done']])
  assert.deepEqual(w.calls, [['open', FOLDER, { timeoutMs: 20000, refuseUnnamed: true }]])
  assert.deepEqual(w.result('a1'), { ok: true, sid: SID })
  assert.equal(fs.existsSync(file), false)
})

test('a request is handled once: the next scan finds nothing', async () => {
  const w = world()
  w.put('a1', OPEN)
  await w.spool.scan()
  assert.deepEqual(await w.spool.scan(), [])
  assert.equal(w.calls.length, 1)
})

test('a reopen reopens that session; an answer for another session id fails', async () => {
  const w = world()
  w.put('r1', { op: 'reopen', sid: SID, folder: FOLDER })
  await w.spool.scan()
  assert.deepEqual(w.calls, [['reopen', SID, { timeoutMs: 20000, folder: FOLDER }]])
  assert.deepEqual(w.result('r1'), { ok: true, sid: SID })
  const x = world({ lanes: { reopen: async () => OTHER } })
  x.put('r2', { op: 'reopen', sid: SID, folder: FOLDER })
  await x.spool.scan()
  assert.deepEqual(x.result('r2'), { ok: false, code: 'failed' })
})

test('a close hands the panel to the sweep and answers ok; a refused one answers refused', async () => {
  const w = world()
  w.put('c1', CLOSE)
  await w.spool.scan()
  assert.deepEqual(w.calls, [['adopt', SID, CLOSE]])
  assert.deepEqual(w.result('c1'), { ok: true })
  const x = world({ lanes: { adopt: () => false } })
  x.put('c2', CLOSE)
  await x.spool.scan()
  assert.deepEqual(x.result('c2'), { ok: false, code: 'refused' })
})

test('a request for another window\'s folder is left alone and answers nothing; that window takes it', async () => {
  const w = world({ ws: ['/work/other'] })
  const file = w.put('a1', OPEN)
  assert.deepEqual(await w.spool.scan(), [['a1', 'not-mine']])
  assert.equal(fs.existsSync(file), true)
  assert.equal(w.result('a1'), undefined)
  assert.equal(w.calls.length, 0)
  const mine = world({ dir: w.dir })
  assert.deepEqual(await mine.spool.scan(), [['a1', 'done']])
  assert.equal(mine.calls.length, 1)
})

test('a folder that is not exactly the window\'s first folder is not taken (a parent, a child, a trailing slash)', async () => {
  const w = world()
  for (const [i, folder] of ['/work/repo', '/work/repo/lab/sub', `${FOLDER}/`, '/work/repo/lab/../lab'].entries()) w.put(`f${i}`, { op: 'open', folder })
  assert.deepEqual((await w.spool.scan()).map((x) => x[1]), ['not-mine', 'not-mine', 'not-mine', 'not-mine'])
  assert.equal(w.calls.length, 0)
})

test('a window that serves several folders takes a request for any of them, and leaves one for a folder it does not serve', async () => {
  const w = world({ ws: [FOLDER, '/work/repo/other'] })
  w.put('a1', { op: 'open', folder: '/work/repo/other' })
  w.put('a2', { op: 'reopen', sid: SID, folder: '/work/repo/other' })
  w.put('a3', { op: 'open', folder: '/work/elsewhere' })
  assert.deepEqual(await w.spool.scan(), [['a1', 'done'], ['a2', 'done'], ['a3', 'not-mine']])
  assert.deepEqual(w.calls, [['open', '/work/repo/other', { timeoutMs: 20000, refuseUnnamed: true }], ['reopen', SID, { timeoutMs: 20000, folder: '/work/repo/other' }]])
})

test('two windows racing for one request: one handles it, the other loses the claim', async () => {
  const a = world()
  const b = world({ dir: a.dir })
  a.put('a1', OPEN)
  const out = await Promise.all([a.spool.handle('a1'), b.spool.handle('a1')])
  assert.deepEqual(out.sort(), ['claim-lost', 'done'])
  assert.equal(a.calls.length + b.calls.length, 1)
})

test('a request older than a minute is dropped with stale, whichever window finds it, and opens nothing', async () => {
  const w = world({ ws: ['/work/other'] })
  const file = w.put('a1', OPEN)
  w.tick(61_000)
  assert.deepEqual(await w.spool.scan(), [['a1', 'stale']])
  assert.deepEqual(w.result('a1'), { ok: false, code: 'stale' })
  assert.equal(fs.existsSync(file), false)
  assert.equal(w.calls.length, 0)
})

test('what is not a request is dropped with bad-request and does nothing', async () => {
  const w = world()
  const bad = [
    'not json', '[]', 'null', '{}', '{"op":"open"}', '{"op":"open","folder":""}', '{"op":"open","folder":7}', '{"op":"launch","folder":"/work/repo/lab"}',
    JSON.stringify({ op: 'reopen', folder: FOLDER }), JSON.stringify({ op: 'reopen', sid: 'x', folder: FOLDER }), JSON.stringify({ op: 'reopen', sid: [SID], folder: FOLDER }),
    JSON.stringify({ ...CLOSE, pid: 1 }), JSON.stringify({ ...CLOSE, pid: 2 ** 22 + 1 }), JSON.stringify({ ...CLOSE, pid: '4242' }), JSON.stringify({ ...CLOSE, name: 'a b' }),
    JSON.stringify({ ...CLOSE, name: undefined }), JSON.stringify({ op: 'open', folder: FOLDER, pad: 'x'.repeat(40_000) }),
    JSON.stringify({ op: 'pick', folder: FOLDER }), JSON.stringify({ op: 'pick', folder: FOLDER, ticked: [7] }), JSON.stringify({ op: 'pick', folder: FOLDER, ticked: Array(33).fill('/r') }),
  ]
  bad.forEach((t, i) => w.put(`b${i}`, t))
  fs.mkdirSync(path.join(w.dir, 'dir.req'))
  fs.symlinkSync('/etc/hosts', path.join(w.dir, 'link.req'))
  const out = await w.spool.scan()
  assert.equal(out.length, bad.length + 2)
  assert.ok(out.every(([, what]) => what === 'bad-request'))
  assert.equal(w.calls.length, 0)
})

test('a failed open answers its code: timeout, ambiguous, unnamed-panel, registry-incomplete, not-workspace, failed', async () => {
  const cases = [['timeout: x', 'timeout'], ['ambiguous: x', 'ambiguous'], ['unnamed-panel: x', 'unnamed-panel'], ['registry-incomplete: x', 'registry-incomplete'],
    ['not a workspace folder', 'not-workspace'], ['boom', 'failed']]
  for (const [message, code] of cases) {
    const w = world({ lanes: { open: async () => { throw new Error(message) } } })
    w.put('a1', OPEN)
    await w.spool.scan()
    assert.deepEqual(w.result('a1'), { ok: false, code })
  }
  const w = world({ lanes: { open: async () => 'not-a-sid' } })
  w.put('a1', OPEN)
  await w.spool.scan()
  assert.deepEqual(w.result('a1'), { ok: false, code: 'failed' })
})

test('answers older than ten minutes are removed; files that are not <id>.req or <id>.result are left alone', async () => {
  const w = world()
  fs.writeFileSync(path.join(w.dir, 'old.result'), '{}')
  fs.writeFileSync(path.join(w.dir, '.hidden.1.tmp'), '')
  fs.writeFileSync(path.join(w.dir, 'x.open'), 'open\n')
  await w.spool.scan()
  assert.equal(fs.existsSync(path.join(w.dir, 'old.result')), true)
  w.tick(601_000)
  await w.spool.scan()
  assert.equal(fs.existsSync(path.join(w.dir, 'old.result')), false)
  assert.equal(fs.existsSync(path.join(w.dir, '.hidden.1.tmp')), true)
  assert.equal(fs.existsSync(path.join(w.dir, 'x.open')), true)
})

test('a scan while another runs does nothing, and a missing folder is made', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-spool2-')), 'v2', 'open')
  let release
  const w = world({ dir, lanes: { open: () => new Promise((r) => { release = () => r(SID) }) } })
  await w.spool.scan()
  w.put('a1', OPEN)
  const first = w.spool.scan()
  while (!release) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(await w.spool.scan(), [])
  release()
  assert.deepEqual(await first, [['a1', 'done']])
})

const PICK = { op: 'pick', folder: FOLDER, ticked: ['/work/repo/a'] }

test('a pick shows the list with the saved folders ticked and answers what was ticked, or the list\'s own code', async () => {
  const seen = []
  const w = world({ pick: async (...a) => (seen.push(a), ['/work/repo/a', '/work/repo/b']) })
  const file = w.put('p1', PICK)
  assert.deepEqual(await w.spool.scan(), [['p1', 'picking']])
  await w.spool.picked()
  assert.deepEqual(seen, [[FOLDER, ['/work/repo/a']]])
  assert.deepEqual(w.result('p1'), { ok: true, folders: ['/work/repo/a', '/work/repo/b'] })
  assert.equal(fs.existsSync(file), false)
  for (const [message, code] of [['cancelled', 'cancelled'], ['timeout', 'timeout'], ['no-folders', 'no-folders'], ['too-many', 'too-many'], ['boom', 'failed']]) {
    const x = world({ pick: async () => { throw new Error(message) } })
    x.put('p1', PICK)
    await x.spool.scan()
    await x.spool.picked()
    assert.deepEqual(x.result('p1'), { ok: false, code })
  }
})

test('a pick runs beside the scan: an open is served while the list is up, a second pick is answered busy, and a new one is taken once the list closed', async () => {
  let close
  const w = world({ pick: () => new Promise((r) => { close = () => r(['/work/repo/a']) }) })
  w.put('p1', PICK)
  assert.deepEqual(await w.spool.scan(), [['p1', 'picking']])
  w.put('a1', OPEN)
  w.put('p2', PICK)
  assert.deepEqual(await w.spool.scan(), [['a1', 'done'], ['p2', 'busy']])
  assert.deepEqual(w.result('a1'), { ok: true, sid: SID })
  assert.deepEqual(w.result('p2'), { ok: false, code: 'busy' })
  assert.equal(w.result('p1'), undefined)
  close()
  await w.spool.picked()
  assert.deepEqual(w.result('p1'), { ok: true, folders: ['/work/repo/a'] })
  w.put('p3', PICK)
  assert.deepEqual(await w.spool.scan(), [['p3', 'picking']])
})

test('a pick for another window\'s folder is left alone, a stale one is dropped, and a window with no list answers failed', async () => {
  let shown = 0
  const pick = async () => (shown++, ['/work/repo/a'])
  const other = world({ ws: ['/work/other'], pick })
  other.put('p1', PICK)
  assert.deepEqual(await other.spool.scan(), [['p1', 'not-mine']])
  const old = world({ pick })
  old.put('p1', PICK)
  old.tick(61_000)
  assert.deepEqual(await old.spool.scan(), [['p1', 'stale']])
  const none = world()
  none.put('p1', PICK)
  assert.deepEqual(await none.spool.scan(), [['p1', 'failed']])
  assert.equal(shown, 0)
})

test('parse keeps only the request\'s own fields', () => {
  assert.deepEqual(parse(JSON.stringify({ ...PICK, extra: 1 })), PICK)
  assert.deepEqual(parse(JSON.stringify({ ...CLOSE, extra: 1 })), CLOSE)
  assert.deepEqual(parse(JSON.stringify({ ...OPEN, sid: SID })), OPEN)
})

test('with the real lanes.js: a close is taken', async () => {
  const lanes = createLanes({ vscode: {}, registry: {}, sleep: async () => undefined, now: Date.now })
  const w = world({ lanes: { adopt: lanes.adopt } })
  w.put('c1', CLOSE)
  await w.spool.scan()
  assert.deepEqual(w.result('c1'), { ok: true })
})

test('a request whose answer cannot be written is reported and does not stop the scan', async () => {
  const w = world()
  w.put('a1', OPEN)
  fs.mkdirSync(path.join(w.dir, 'a1.result'))
  w.put('a2', OPEN)
  assert.deepEqual(await w.spool.scan(), [['a1', 'answer-failed'], ['a2', 'done']])
})
