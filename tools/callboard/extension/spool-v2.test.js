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
function world({ ws = [FOLDER], lanes = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-spool2-')), now, pick, remote, pin } = {}) {
  const calls = []
  let shift = 0
  const fake = {
    open: async (...a) => (calls.push(['open', ...a]), SID),
    reopen: async (...a) => (calls.push(['reopen', ...a]), a[0]),
    adopt: (...a) => (calls.push(['adopt', ...a]), true),
    ...lanes,
  }
  const spool = createSpool({ dir, lanes: fake, workspaceFolders: () => ws, timeoutMs: 20000, pick, remote: remote && ((...a) => (calls.push(['remote', ...a]), remote(...a))), pin: pin && (() => (calls.push(['pin']), pin())), now: now ?? (() => Date.now() + shift) })
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

test('a close hands the panel to the sweep and answers nothing; a refused or stale one is dropped', async () => {
  const w = world()
  const file = w.put('c1', CLOSE)
  assert.deepEqual(await w.spool.scan(), [['c1', 'done']])
  assert.deepEqual(w.calls, [['adopt', SID, CLOSE]])
  assert.equal(w.result('c1'), undefined)
  assert.equal(fs.existsSync(file), false)
  const x = world({ lanes: { adopt: () => false } })
  x.put('c2', CLOSE)
  assert.deepEqual(await x.spool.scan(), [['c2', 'dropped']])
  assert.equal(x.result('c2'), undefined)
  const y = world()
  y.put('c3', CLOSE)
  y.tick(61_000)
  assert.deepEqual(await y.spool.scan(), [['c3', 'dropped']])
  assert.deepEqual(y.calls, [])
  assert.equal(y.result('c3'), undefined)
})

test('a close names the tab by its label: a name with a space is taken, one over 25 characters or with a control character is not', async () => {
  assert.deepEqual(parse(JSON.stringify({ ...CLOSE, name: 'Fix login bug' })), { ...CLOSE, name: 'Fix login bug' })
  assert.deepEqual(parse(JSON.stringify({ ...CLOSE, name: 'x'.repeat(25) })), { ...CLOSE, name: 'x'.repeat(25) })
  for (const name of ['x'.repeat(26), '', 'a\nb', 'a\u007fb']) assert.equal(parse(JSON.stringify({ ...CLOSE, name })), undefined, JSON.stringify(name))
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

test('a remote runs the Claude extension\'s command for the session and answers ok, or the code it gave', async () => {
  const answers = { a: 'ok', b: 'no-channel', c: 'ambiguous', d: 'busy', e: 'failed', f: 'bad-request', g: 'something else', h: undefined }
  for (const [id, code] of Object.entries(answers)) {
    const w = world({ remote: async () => code })
    w.put(id, { op: 'remote', sid: SID, on: true, folder: FOLDER })
    assert.deepEqual(await w.spool.scan(), [[id, code === 'ok' ? 'done' : code === undefined || code === 'something else' ? 'failed' : code]])
    assert.deepEqual(w.calls, [['remote', SID, true]])
    assert.deepEqual(w.result(id), code === 'ok' ? { ok: true } : { ok: false, code: ['no-channel', 'ambiguous', 'busy', 'failed', 'bad-request'].includes(code) ? code : 'failed' })
  }
  const off = world({ remote: async () => 'ok' })
  off.put('o1', { op: 'remote', sid: SID, on: false, folder: FOLDER })
  await off.spool.scan()
  assert.deepEqual(off.calls, [['remote', SID, false]])
})

test('a remote answers patch-missing when the command is not registered or no command was given, and failed when the command throws', async () => {
  const missing = world({ remote: async () => { throw new Error("command 'callboard remote session' not found") } })
  missing.put('m1', { op: 'remote', sid: SID, on: true, folder: FOLDER })
  await missing.spool.scan()
  assert.deepEqual(missing.result('m1'), { ok: false, code: 'patch-missing' })
  const none = world()
  none.put('m2', { op: 'remote', sid: SID, on: true, folder: FOLDER })
  await none.spool.scan()
  assert.deepEqual(none.result('m2'), { ok: false, code: 'patch-missing' })
  const boom = world({ remote: async () => { throw new Error('boom') } })
  boom.put('m3', { op: 'remote', sid: SID, on: true, folder: FOLDER })
  await boom.spool.scan()
  assert.deepEqual(boom.result('m3'), { ok: false, code: 'failed' })
})

test('a remote whose command never settles is answered busy after the open wait, and the scan goes on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-spool2-'))
  const spool = createSpool({ dir, lanes: { open: async () => SID, reopen: async (s) => s, adopt: () => true }, workspaceFolders: () => [FOLDER], timeoutMs: 20, remote: () => new Promise(() => {}) })
  fs.writeFileSync(path.join(dir, 'h1.req'), JSON.stringify({ op: 'remote', sid: SID, on: true, folder: FOLDER }))
  assert.deepEqual(await spool.scan(), [['h1', 'busy']])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'h1.result'), 'utf8')), { ok: false, code: 'busy' })
})

test('a remote for another window\'s folder stays, and a stale one is refused without running the command', async () => {
  const w = world({ remote: async () => 'ok' })
  const file = w.put('x1', { op: 'remote', sid: SID, on: true, folder: '/work/repo/other' })
  assert.deepEqual(await w.spool.scan(), [['x1', 'not-mine']])
  assert.equal(fs.existsSync(file), true)
  w.put('x2', { op: 'remote', sid: SID, on: true, folder: FOLDER })
  w.tick(61_000)
  await w.spool.scan()
  assert.deepEqual(w.result('x2'), { ok: false, code: 'stale' })
  assert.equal(w.calls.length, 0)
})

test('what is not a request is dropped with bad-request and does nothing', async () => {
  const w = world()
  const bad = [
    'not json', '[]', 'null', '{}', '{"op":"open"}', '{"op":"open","folder":""}', '{"op":"open","folder":7}', '{"op":"launch","folder":"/work/repo/lab"}',
    JSON.stringify({ op: 'reopen', folder: FOLDER }), JSON.stringify({ op: 'reopen', sid: 'x', folder: FOLDER }), JSON.stringify({ op: 'reopen', sid: [SID], folder: FOLDER }),
    JSON.stringify({ ...CLOSE, pid: 1 }), JSON.stringify({ ...CLOSE, pid: 2 ** 22 + 1 }), JSON.stringify({ ...CLOSE, pid: '4242' }), JSON.stringify({ ...CLOSE, sid: 'nope' }),
    JSON.stringify({ ...CLOSE, name: undefined }), JSON.stringify({ op: 'open', folder: FOLDER, pad: 'x'.repeat(40_000) }),
    JSON.stringify({ op: 'remote', folder: FOLDER, on: true }), JSON.stringify({ op: 'remote', sid: 'x', on: true, folder: FOLDER }), JSON.stringify({ op: 'remote', sid: SID, on: 'yes', folder: FOLDER }), JSON.stringify({ op: 'remote', sid: SID, folder: FOLDER }),
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
  assert.deepEqual(await w.spool.scan(), [['c1', 'done']])
})

test('a request whose answer cannot be written is reported and does not stop the scan', async () => {
  const w = world()
  w.put('a1', OPEN)
  fs.mkdirSync(path.join(w.dir, 'a1.result'))
  w.put('a2', OPEN)
  assert.deepEqual(await w.spool.scan(), [['a1', 'answer-failed'], ['a2', 'done']])
})

test('a pin runs the pin callback once and answers nothing; a stale one is dropped, another folder\'s stays, a bad one is refused, and a window without the callback drops it', async () => {
  const PIN = { op: 'pin', sid: SID, folder: FOLDER }
  assert.deepEqual(parse(JSON.stringify(PIN)), PIN)
  assert.equal(parse(JSON.stringify({ ...PIN, sid: 'nope' })), undefined)
  const w = world({ pin: async () => undefined })
  const file = w.put('p1', PIN)
  assert.deepEqual(await w.spool.scan(), [['p1', 'done']])
  assert.deepEqual(w.calls, [['pin']])
  assert.equal(w.result('p1'), undefined)
  assert.equal(fs.existsSync(file), false)
  const x = world({ ws: ['/elsewhere'], pin: async () => undefined })
  const other = x.put('p2', PIN)
  assert.deepEqual(await x.spool.scan(), [['p2', 'not-mine']])
  assert.deepEqual(x.calls, [])
  assert.equal(fs.existsSync(other), true, 'another window\'s request stays')
  const y = world({ pin: async () => undefined })
  const old = y.put('p3', PIN)
  y.tick(61_000)
  assert.deepEqual(await y.spool.scan(), [['p3', 'dropped']])
  assert.deepEqual(y.calls, [])
  assert.equal(fs.existsSync(old), false, 'a stale request is taken and dropped')
  const z = world({ pin: async () => undefined })
  z.put('p4', { ...PIN, sid: 'nope' })
  assert.deepEqual(await z.spool.scan(), [['p4', 'bad-request']])
  assert.deepEqual(z.calls, [])
  const u = world()
  const bare = u.put('p5', PIN)
  assert.deepEqual(await u.spool.scan(), [['p5', 'dropped']])
  assert.equal(fs.existsSync(bare), false)
  const t = world({ pin: async () => { throw new Error('boom') } })
  t.put('p6', PIN)
  assert.deepEqual(await t.spool.scan(), [['p6', 'done']], 'a pin that throws does not stop the scan')
  const s = world({ pin: () => new Promise(() => undefined) })
  s.put('p7', PIN)
  assert.deepEqual(await s.spool.scan(), [['p7', 'done']], 'a pin that never settles does not hold the scan')
})
