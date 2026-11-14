import { expect, test } from 'claude-code/testing'
import { h, ROOT, T0, extraStat, longTest, resultFiles, targetLogs } from './harness'
import { NEWSID, OTHER, cueSession, events, fileStat, lead, leadCall } from './fixtures'

// lane_open, lane_rename and lane_start with a panel that is slow to register, or an answer that comes late.

const LAB = '/data/x/work/lab'
const WANTED = '7a1b2c3d-0000-4000-8000-123456789abc'
const advance = async (ms: number) => {
  for (let i = 0; i < ms / 500; i++) await h.clock!.advance(500)
}
const renameCall = (sid: string) => leadCall('rename', { sid, lane: 'LABLANE' })
// An unnamed panel session of the lane folder that started `ago` ms before now.
const panel = (id: string, ago = 20_000, extra: Record<string, unknown> = {}) => cueSession(id, 'auto-name', LAB, { nameSource: 'derived', entrypoint: 'claude-vscode', startedAt: T0 - ago, ...extra })

longTest('lane_open waits for a panel that answers after 8 s, up to 45 s', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins, { sess: {}, clock: true })
  let done = false
  const p = $.tool.call(leadCall('open')).then((r: any) => {
    done = true
    return r
  })
  await advance(20_000)
  expect(done).toBe(false)
  h.openResult = `ok ${NEWSID}\n`
  await advance(1000)
  expect((await p).result).toContain(`session ${NEWSID}`)
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(expect.arrayContaining(['open-requested:LABLANE', 'opened:LABLANE']))
})

longTest('lane_open with no answer gives up after 45 s, not 8 s, and says so', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  let done = false
  const p = $.tool.call(leadCall('open')).then((r: any) => {
    done = true
    return r
  })
  await advance(9000)
  expect(done).toBe(false)
  await advance(38_000)
  expect(JSON.stringify(await p)).toContain('no window answered within 45 seconds')
})

longTest('lane_rename with an id no session carries names the unnamed session in the lane folder, and renames nothing', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { sess: panel(OTHER), argv, clock: true })
  const p = $.tool.call(renameCall(WANTED))
  await advance(10_000)
  const text = JSON.stringify(await p)
  expect(text).toContain(`no-live-session: no live session has id ${WANTED}`)
  expect(text).toContain(`The one unnamed session in the lane folder is ${OTHER}`)
  expect(text).not.toContain('lane name')
  expect(argv.some((a) => a[0] === '/bin/mv' && a[a.length - 1].endsWith('.cue'))).toBe(false)
})

longTest('lane_rename with an id no session carries and no unnamed session in the folder says the panel may still be registering', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  const p = $.tool.call(renameCall(WANTED))
  await advance(10_000)
  const text = JSON.stringify(await p)
  expect(text).toContain('no-live-session: no live session has id')
  expect(text).toContain('20 seconds or more')
})

test('lane_rename offers no session a rename would refuse: a named one, one in another folder, one that is too old, a terminal session', async ($, on) => {
  const sess = {
    ...cueSession(OTHER, 'named-by-user', LAB, { nameSource: 'user', entrypoint: 'claude-vscode', startedAt: T0 - 20_000 }),
    ...cueSession('8a1b2c3d-0000-4000-8000-123456789abc', 'auto-2', '/data/x/work/other', { nameSource: 'derived', entrypoint: 'claude-vscode', startedAt: T0 - 20_000, pid: 4243 }),
    ...cueSession('9a1b2c3d-0000-4000-8000-123456789abc', 'auto-3', LAB, { nameSource: 'derived', entrypoint: 'claude-vscode', startedAt: T0 - 600_000, pid: 4244 }),
    ...cueSession('aa1b2c3d-0000-4000-8000-123456789abc', 'cli', LAB, { nameSource: 'derived', entrypoint: 'cli', startedAt: T0 - 20_000, pid: 4245 }),
  }
  await lead($, on, [], { sess, clock: true })
  const p = $.tool.call(renameCall(WANTED))
  await advance(10_000)
  expect(JSON.stringify(await p)).toContain('20 seconds or more')
})

longTest('lane_rename waits for the session to register and then cues it', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  const p = $.tool.call(renameCall(WANTED))
  await advance(3500)
  h.sessions = panel(WANTED)
  await advance(3000)
  expect((await p).result).toContain('cue rename acted')
})

longTest('lane_start takes an answer that comes after 6 s', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoAnswer = undefined
  let done = false
  const p = $.tool.call(leadCall('start')).then((r: any) => {
    done = true
    return r
  })
  await advance(9000)
  expect(done).toBe(false)
  resultFiles.set(`${ROOT}/result/${OTHER}.result`, `start ok - ${h.autoIno}\n`)
  await advance(1000)
  expect((await p).result).toContain('cue start acted')
})

longTest('lane_rename takes an answer that comes after 6 s', async ($, on) => {
  await lead($, on, [], { sess: panel(OTHER), clock: true })
  h.autoAnswer = undefined
  const p = $.tool.call(renameCall(OTHER))
  await advance(9000)
  resultFiles.set(`${ROOT}/result/${OTHER}.result`, `rename ok - ${h.autoIno}\n`)
  await advance(1000)
  expect((await p).result).toContain('cue rename acted')
})

// No answer in 20 s: the session's own log and cue folder say what became of the cue.
const LOG = `${ROOT}/log/${OTHER}.jsonl`
// A log line dated `at` ms after the start of the test's clock; the cue goes out a few ms into the call, so +5000 is after it and -60000 before.
const logLine = (event: string, at = 5000) => `${JSON.stringify({ t: new Date(h.nowMs + at).toISOString(), event, reason: '' })}\n`

longTest('lane_start with no answer is done when the session log shows it started', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins, { clock: true })
  h.autoAnswer = undefined
  targetLogs.set(LOG, logLine('brief-sha256') + logLine('started'))
  const p = $.tool.call(leadCall('start'))
  await advance(21_000)
  const r = await p
  expect(r.result).toContain('the session started')
  expect(JSON.stringify(r)).not.toContain('no-answer')
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('acted-late:start LABLANE')
})

longTest('lane_rename with no answer is done when the session log shows the rename', async ($, on) => {
  await lead($, on, [], { sess: panel(OTHER), clock: true })
  h.autoAnswer = undefined
  targetLogs.set(LOG, logLine('renamed'))
  const p = $.tool.call(renameCall(OTHER))
  await advance(21_000)
  const r = await p
  expect(r.result).toContain(`session ${OTHER} took the rename`)
  expect(r.result).toContain('lane_start')
})

longTest('a log line dated before the cue is an earlier cue\'s: no answer stays no-answer', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoAnswer = undefined
  targetLogs.set(LOG, logLine('started', -60_000))
  const p = $.tool.call(leadCall('start'))
  await advance(21_000)
  expect(JSON.stringify(await p)).toContain('no-answer: the session did not answer in time')
})

longTest('a log line of the other verb is not taken for this one: no answer stays no-answer', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoAnswer = undefined
  targetLogs.set(LOG, logLine('renamed'))
  const p = $.tool.call(leadCall('start'))
  await advance(21_000)
  expect(JSON.stringify(await p)).toContain('no-answer: the session did not answer in time')
})

longTest('no answer with the cue still in the session cue folder says it has not been read and not to repeat the call', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoAnswer = undefined
  extraStat.set(`${ROOT}/cue/${OTHER}.cue`, fileStat)
  const p = $.tool.call(leadCall('start'))
  await advance(21_000)
  const text = JSON.stringify(await p)
  expect(text).toContain('no-answer: the session has not read the cue yet')
  expect(text).toContain('do not repeat the call')
})

longTest('no answer with no sign of the outcome keeps the plain no-answer text', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoAnswer = undefined
  const p = $.tool.call(leadCall('start'))
  await advance(21_000)
  expect(JSON.stringify(await p)).toContain('no-answer: the session did not answer in time')
})
