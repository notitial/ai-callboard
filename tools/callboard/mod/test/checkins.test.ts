import { expect, test } from 'claude-code/testing'
import { GOOD, h, NO, PROMPTS_DIR, PS_TABLE, ROOT, SID, T0, leadFiles, longTest, pdirs, pfs, resultFiles, toasts } from './harness'
import { SENT_NOTE } from '../hooks/core'
import { putLedger, OFF_FILE } from './answer-fixtures'
import { ANY, APISID, LEADPATH, MGR_SESS, MIN, OTHER, OTHERLEAD, OWN_ROW, PIN, QUIET, RESULT, TURN, bareList, checkins, ckLane, ckLead, ckRow, ckText, CK_GUARD_WHY, CK_NO_RECORD, CK_PROMPT_TAIL, cueSession, grantAt, idleFor, lane, leadAt, leadCall, leadFileText, leadReg, leadSelfReg, logged, madeLane, mdBox, mgrAt, midCtx, newTrace, notices, postBeneath, putStore, regAs, sleepFor, started, statusTable, ticks } from './fixtures'

longTest('check-in: a lane quiet 30 min gets one fixed notice from an idle lead, not before; once per since; again after it worked (seen busy twice)', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  await idleFor(28 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  expect(logged(stdins).filter((x) => x.startsWith('checkin'))).toEqual(['checkin:quiet:1'])
  await idleFor(32 * MIN)
  expect(checkins().length).toBe(1)
  // The lane worked (seen busy at two observations) and went idle again: a new since, told again after 30 min.
  h.sessions = { ...leadSelfReg(), ...ckRow({ status: 'busy', statusUpdatedAt: h.nowMs }) }
  await idleFor(8 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(28 * MIN)
  expect(checkins().length).toBe(1)
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET), ckText(QUIET)])
})

const WAITING = { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T0 }
const PROMPT = '`API` (waiting on a prompt for over 5 min)'
const PROMPT_TOAST = 'Lane API: waiting on a prompt for over 5 min.'

test('check-in: a lane waiting on a prompt 5 min is told to an idle lead at once, with no 20 min of idle, once, with one toast; lane_list and /callboard lanes show waiting in minutes', async ($, on) => {
  await ckLead($, on, [], WAITING)
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts).toEqual([])
  const row = (w: string) => mdBox(ANY, [['API', 'api', 'live', w]])
  expect((await $.command.run(lane('lanes'))).text).toBe(row(`${Math.floor((h.nowMs - T0) / MIN)}m`))
  expect(await bareList($)).toBe(row(`${Math.floor((h.nowMs - T0) / MIN)}m`))
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
  expect(toasts).toEqual([PROMPT_TOAST])
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
  expect(toasts).toEqual([PROMPT_TOAST])
})

test('check-in: a busy lead is told of a lane waiting on a prompt beside a tool result, once, and no turn is submitted for it; the person gets the toast', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await ckLead($, on, stdins, WAITING)
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(4 * MIN)
  expect(await midCtx($)).toEqual([])
  await idleFor(4 * MIN)
  expect(toasts).toEqual([PROMPT_TOAST])
  expect(await midCtx($, 'PostToolUse', { agent_id: 'sub-1' })).toEqual([])
  expect(await midCtx($)).toEqual([ckText(PROMPT)])
  expect(logged(stdins)).toContain('checkin:prompt:1 mid-turn')
  expect(await midCtx($)).toEqual([])
  // The idle notice has nothing left to say once the lead's turn ends.
  h.sessions = { ...leadSelfReg(), ...ckRow(WAITING) }
  await $.turn.complete(TURN as any)
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts).toEqual([PROMPT_TOAST])
})

// A request of lane API (session OTHER, or `sid`) in the prompts folder, open and in the reach of the lead LEAD of PIN (and the manager above it), with the switch on.
const REQ_ID = '7a1b2c3d-0000-4000-8000-123456789abc'
function putOpenRequest(over: Record<string, unknown> = {}) {
  const sid = typeof over.sid === 'string' ? over.sid : OTHER
  const q = { id: REQ_ID, sid, pid: 4500, procStart: 'Tue Oct 27 20:37:50 2026', level: 'lane', lane: 'API', leadName: 'LEAD', repo: PIN, tool: 'Bash', inputHash: 'c'.repeat(64), raisedBy: 'rule', at: T0, expiresAt: T0 + 21 * MIN, nonce: 'n-1', input: { command: 'ssh host uptime' }, truncated: false, ...over }
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  pdirs.add(PROMPTS_DIR)
  pdirs.add(`${PROMPTS_DIR}/${sid}`)
  pfs.set(`${PROMPTS_DIR}/${sid}/${REQ_ID}.request.json`, { text: JSON.stringify(q), mtimeSec: T0 / 1000 })
}
const endRequest = (sid = OTHER) => pfs.set(`${PROMPTS_DIR}/${sid}/${REQ_ID}.done`, { text: '', mtimeSec: h.nowMs / 1000 })
const ckMid = async ($: any) => (await midCtx($)).filter((t: string) => t.startsWith('[callboard] Check-in:'))

test('check-in: a lane waiting on a prompt that the lead holds as a request gets no check-in at 5 min, the toast still shows; the request ending with the lane still waiting brings the check-in back', async ($, on) => {
  await ckLead($, on, [], WAITING)
  putOpenRequest()
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts).toEqual([PROMPT_TOAST])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([])
  endRequest()
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, CK_NO_RECORD)])
  expect(toasts).toEqual([PROMPT_TOAST])
})

test('check-in: a prompt already told to the lead is not told again when a request later holds it and ends with the lane still waiting', async ($, on) => {
  await ckLead($, on, [], WAITING)
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
  putOpenRequest()
  await idleFor(4 * MIN)
  endRequest()
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
})

for (const [what, put] of [
  ['of a lane of another lead', () => putOpenRequest({ leadName: 'OTHERLEAD' })],
  ['with answering off', () => { putOpenRequest(); h.store.delete('answering') }],
  ['the lead has passed up', () => { putOpenRequest(); pfs.set(`${PROMPTS_DIR}/${OTHER}/${REQ_ID}.escalate-lead.json`, { text: JSON.stringify({ id: REQ_ID, tier: 'up', why: 'x', at: T0 + MIN, level: 'lead', sid: SID }), mtimeSec: T0 / 1000 }) }],
] as const) {
  test(`check-in: a request ${what} is not the lead's to hold: the check-in comes as it did`, async ($, on) => {
    await ckLead($, on, [], WAITING)
    put()
    await idleFor(8 * MIN)
    expect(checkins()).toEqual([ckText(PROMPT, what === 'with answering off' ? CK_GUARD_WHY : CK_NO_RECORD)])
    expect(toasts).toEqual([PROMPT_TOAST])
  })
}

test('check-in: a request left open past its expiresAt holds nothing: the lead is told of the lane still waiting', async ($, on) => {
  await ckLead($, on, [], WAITING)
  putOpenRequest()
  await idleFor(20 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, CK_NO_RECORD)])
  expect(toasts).toEqual([PROMPT_TOAST])
})

longTest('check-in: a request put to the person holds past its expiresAt, as its wait does, and no longer than that wait', async ($, on) => {
  await ckLead($, on, [], WAITING)
  putOpenRequest()
  pfs.set(`${PROMPTS_DIR}/${OTHER}/${REQ_ID}.relay.json`, { text: JSON.stringify({ id: REQ_ID, short: REQ_ID.slice(0, 8), by: { level: 'lead', sid: SID, name: 'LEAD' }, at: T0 + MIN, nonce: 'n-1' }), mtimeSec: T0 / 1000 })
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts).toEqual([PROMPT_TOAST])
  await idleFor(92 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, CK_NO_RECORD)])
})

test('check-in: a busy lead is not told beside a tool result of a lane waiting on a prompt it holds as a request, until the request ends', async ($, on) => {
  postBeneath(on)
  await ckLead($, on, [], WAITING)
  putOpenRequest()
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(8 * MIN)
  expect(toasts).toEqual([PROMPT_TOAST])
  expect(await ckMid($)).toEqual([])
  endRequest()
  await idleFor(2 * MIN)
  expect(await ckMid($)).toEqual([ckText(PROMPT, CK_NO_RECORD)])
  expect(toasts).toEqual([PROMPT_TOAST])
})

test('manager check-ins: a lane waiting on a prompt 10 min that the manager holds as a request gets no manager turn, the toast still shows; it is told once the request ends', async ($, on) => {
  const sess = { ...leadSelfReg({ name: 'MANAGER' }), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600, statusUpdatedAt: T0 }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500, ...WAITING }), ...leadReg() }
  await mgrAt($, on, [], { clock: true, sess, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  putOpenRequest({ sid: APISID })
  await idleFor(12 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
  endRequest(APISID)
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, CK_NO_RECORD)])
})

test('check-in: a busy lead is not told in the middle of a turn of a quiet lane, nor of a waiting prompt while check-ins are paused', async ($, on) => {
  postBeneath(on)
  await ckLead($, on)
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow() }
  await idleFor(36 * MIN)
  expect(await midCtx($)).toEqual([])
  expect((await $.command.run(lane('checkin pause 1h'))).text).toBe('Check-ins paused in this session for 60 min.')
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow({ ...WAITING, statusUpdatedAt: h.nowMs }) }
  await idleFor(12 * MIN)
  expect(await midCtx($)).toEqual([])
  expect(checkins()).toEqual([])
  // The person's toast is not the session's check-in: the pause does not hold it back.
  expect(toasts).toEqual([PROMPT_TOAST])
})

test('check-in: the toast for a waiting prompt is shown with check-ins switched off, and no check-in is sent', async ($, on) => {
  await ckLead($, on, [], WAITING)
  await $.command.run(lane('config checkin off'))
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
  await idleFor(8 * MIN)
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
})

test('check-in: a prompt that waited through a sleep is told to an idle lead right after the wake, with the toast', async ($, on) => {
  await ckLead($, on, [], WAITING)
  await sleepFor(30 * MIN)
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
})

test('check-in: within 30 min of a wake a lane waiting on a prompt 5 min is told to an idle lead, alone: quiet and gone lanes wait for the 30 min', async ($, on) => {
  const web = (over: Record<string, unknown>) => cueSession(APISID, 'WEB', `${PIN}/web`, { pid: 4600, ...over })
  const lab = cueSession(OTHERLEAD, 'LAB', `${PIN}/lab`, { pid: 4700, statusUpdatedAt: T0 })
  await ckLead($, on, [], {}, [ckLane(), { name: 'WEB', folder: `${PIN}/web`, brief: `${PIN}/web/BRIEF.md`, createdAt: 1, sid: APISID }, { name: 'LAB', folder: `${PIN}/lab`, brief: `${PIN}/lab/BRIEF.md`, createdAt: 1, sid: OTHERLEAD }])
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...web({ status: 'busy', statusUpdatedAt: T0 }), ...lab }
  await idleFor(8 * MIN)
  await sleepFor(30 * MIN)
  // After the wake: API has been quiet over 30 min, LAB's session is gone, and WEB starts to wait on a prompt.
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...web({ ...WAITING, statusUpdatedAt: h.nowMs }) }
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(4 * MIN)
  const WEB_PROMPT = ckText('`WEB` (waiting on a prompt for over 5 min)')
  expect(checkins()).toEqual([WEB_PROMPT])
  expect(toasts.filter((t) => t.includes('waiting on a prompt'))).toEqual(['Lane WEB: waiting on a prompt for over 5 min.'])
  await idleFor(16 * MIN)
  expect(checkins()).toEqual([WEB_PROMPT])
  await idleFor(12 * MIN)
  expect(checkins()).toEqual([WEB_PROMPT, ckText(`${QUIET}; \`LAB\` (session gone, report not signed done)`)])
})

test('check-in: within 30 min of a wake a busy lead is told of a waiting prompt beside a tool result', async ($, on) => {
  postBeneath(on)
  await ckLead($, on, [], WAITING)
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(4 * MIN)
  expect(await midCtx($)).toEqual([])
  await sleepFor(6 * MIN)
  await idleFor(4 * MIN)
  expect(await midCtx($)).toEqual([ckText(PROMPT)])
  expect(await midCtx($)).toEqual([])
  expect(checkins()).toEqual([])
})

test('manager check-ins: within 30 min of a wake a lane waiting on a prompt 10 min is told to the manager with its lead live, not at 5 min', async ($, on) => {
  const sess = (api: Record<string, unknown>) => ({ ...leadSelfReg({ name: 'MANAGER' }), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600, statusUpdatedAt: T0 }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500, ...api }), ...leadReg() })
  await mgrAt($, on, [], { clock: true, sess: sess({ status: 'busy', statusUpdatedAt: T0 }), seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  await idleFor(4 * MIN)
  await sleepFor(6 * MIN)
  h.sessions = sess({ ...WAITING, statusUpdatedAt: h.nowMs })
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
})

test('check-in: a turn sent for a waiting prompt carries the other owed lanes too, before the lead has been idle 20 min', async ($, on) => {
  const web = (over: Record<string, unknown>) => cueSession(APISID, 'WEB', `${PIN}/web`, { pid: 4600, ...over })
  await ckLead($, on, [], {}, [ckLane(), { name: 'WEB', folder: `${PIN}/web`, brief: `${PIN}/web/BRIEF.md`, createdAt: 1, sid: APISID }])
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...web({ status: 'busy', statusUpdatedAt: T0 }) }
  await idleFor(20 * MIN)
  await $.turn.complete(TURN as any)
  await idleFor(4 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...web({ ...WAITING, statusUpdatedAt: h.nowMs }) }
  // API is quiet 30 min by now, and the lead's last turn ended 12 min ago: nothing is sent for it alone.
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(`${QUIET}; \`WEB\` (waiting on a prompt for over 5 min)`)])
})

test('check-in: the mid-turn text shares the hourly cap: capped, it stays owed, logged once, and is told when the cap frees', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await ckLead($, on, stdins, WAITING)
  for (let i = 1; i <= 12; i++) {
    putStore([ckLane({ createdAt: 10 ** i })])
    await h.clock!.advance(2000)
  }
  expect(notices()).toBe(12)
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(8 * MIN)
  expect(await midCtx($)).toEqual([])
  expect(await midCtx($)).toEqual([])
  expect(logged(stdins).filter((x) => x === 'notice-capped:attention')).toEqual(['notice-capped:attention'])
  await idleFor(56 * MIN)
  expect(await midCtx($)).toEqual([ckText(PROMPT)])
})

test('check-in: no mid-turn text while a compaction is armed, nor from an observation older than two minutes', async ($, on) => {
  postBeneath(on)
  await ckLead($, on, [], WAITING)
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(8 * MIN)
  // The clock moves three minutes with the tick held: the last observation is stale.
  let wake!: () => void
  h.timerHeld = new Promise<void>((r) => (wake = r))
  await h.clock!.advance(2000)
  await h.clock!.set(h.nowMs + 3 * MIN)
  expect(await midCtx($)).toEqual([])
  h.timerHeld = undefined
  wake()
  await idleFor(4 * MIN)
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  expect(await midCtx($)).toEqual([])
})

test('manager check-ins: a busy manager is told of a lane waiting on a prompt 10 min beside a tool result, with its lead live', async ($, on) => {
  postBeneath(on)
  const sess = (over: Record<string, unknown> = {}) => ({ ...leadSelfReg({ name: 'MANAGER', ...over }), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600, statusUpdatedAt: T0 }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500, ...WAITING }), ...leadReg() })
  await mgrAt($, on, [], { clock: true, sess: sess(), seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.sessions = sess({ status: 'busy' })
  await idleFor(8 * MIN)
  expect(await midCtx($)).toEqual([])
  await idleFor(4 * MIN)
  expect(await midCtx($)).toEqual([ckText(PROMPT)])
  expect(await midCtx($)).toEqual([])
  expect(checkins()).toEqual([])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
})

test('check-in: a pause typed after the observation, or the lead\'s own lane_resume, takes the waiting prompt back from the mid-turn path', async ($, on) => {
  postBeneath(on)
  await ckLead($, on, [], WAITING)
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(8 * MIN)
  expect((await $.command.run(lane('checkin pause 1m'))).text).toBe('Check-ins paused in this session for 1 min.')
  expect(await midCtx($)).toEqual([])
  expect((await $.command.run(lane('checkin on'))).text).toBe('Check-ins are on again in this session.')
  expect((await $.tool.call(leadCall('resume', { lane: 'API' }))).result).toContain('cue resume acted')
  expect(await midCtx($)).toEqual([])
})

test('manager check-ins: a lane waiting on a prompt 10 min is told to the manager even with its lead live, not at 5 min', async ($, on) => {
  const sess = { ...leadSelfReg({ name: 'MANAGER' }), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600, statusUpdatedAt: T0 }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500, ...WAITING }), ...leadReg() }
  await mgrAt($, on, [], { clock: true, sess, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([])
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
  expect(toasts.filter((t) => t === PROMPT_TOAST)).toEqual([PROMPT_TOAST])
})

test('check-in: a lane whose session is gone is told', async ($, on) => {
  await ckLead($, on)
  await idleFor(4 * MIN)
  h.sessions = leadSelfReg()
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText('`API` (session gone, report not signed done)')])
})
test('check-in: a lane signed done is not told, quiet or gone; a parked lane and a lane with no saved session never seen live are never gone', async ($, on) => {
  await ckLead($, on, [], {}, [{ name: 'LAB', folder: `${PIN}/lab`, brief: `${PIN}/lab/B.md`, createdAt: 1 }, ckLane(), { ...madeLane('PARKED'), sid: OTHERLEAD, parked: 5 }])
  h.reportFile = { text: `notes\nstatus: done ${OTHER}\n`, mtimeSec: T0 / 1000 }
  await idleFor(36 * MIN)
  expect((await bareList($)).split('\n').filter((l) => l.startsWith('| ↳ ')).map((l) => l.split('|')[1].trim().slice(2))).toEqual(['LAB', 'API', 'PARKED'])
  h.sessions = leadSelfReg()
  await idleFor(20 * MIN)
  expect(checkins()).toEqual([])
})

test('check-in: none within 30 min of a wake (the lanes slept too), then the notice', async ($, on) => {
  await ckLead($, on)
  await idleFor(8 * MIN)
  await sleepFor(30 * MIN)
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

longTest('/callboard checkin: only the person pauses (a fixed refusal otherwise), 1 min to 24 h; status shows it; on ends it; config checkin off stops them', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  const status = async () => (await $.command.run(lane('status'))).text
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Conductor', 'none: /callboard lead join'], ['Check-ins', 'ON']))
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'peer' }, null]) expect((await $.command.run(lane('checkin pause 2h', origin))).text).toBe('Only you can pause check-ins: type /callboard checkin yourself.')
  expect(logged(stdins).filter((x) => x.startsWith('refused:checkin'))).toEqual(['refused:checkin-not-person:plugin', 'refused:checkin-not-person:session', 'refused:checkin-not-person:other'])
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'peer' }, null]) for (const a of ['checkin pause', 'checkin resume']) expect((await $.command.run(lane(a, origin))).text).toBe('Only you can pause check-ins: type /callboard checkin yourself.')
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Conductor', 'none: /callboard lead join'], ['Check-ins', 'ON']))
  await $.command.run(lane('config checkin off'))
  expect((await $.command.run(lane('checkin on'))).text).toBe('Check-ins are on again in this session, but off on this Mac: /callboard config checkin on turns them on.')
  await $.command.run(lane('config checkin on'))
  for (const bad of ['checkin pause 25h', 'checkin pause 0m', 'checkin']) expect((await $.command.run(lane(bad))).text).toBe('Use /callboard checkin pause [Nm|Nh] or checkin resume. A pause is 1 minute to 24 hours.')
  expect((await $.command.run(lane('checkin pause'))).text).toBe('Check-ins paused in this session for 60 min.')
  expect(logged(stdins).at(-1)).toBe('checkin-pause:60m:prompt')
  await idleFor(40 * MIN)
  expect(await status()).toMatch(/^\*\*Callboard status\*\*\n\n\| Role \| State \|\n\|---\|---\|\n\| Lane \| NONE \|\n\| Lead \| ON \|\n\| Conductor \| none: \/callboard lead join \|\n\| Check-ins \| PAUSED for (19|20|21) more min \|\n\| Escalation \| OFF \(default blocked[^\n]*\|\n\| Prompts \| NO \(escalation is off\) \|\n\| Unattended \| OFF \|$/)
  expect(checkins()).toEqual([])
  expect((await $.command.run(lane('checkin resume'))).text).toBe('Check-ins are on again in this session.')
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Conductor', 'none: /callboard lead join'], ['Check-ins', 'ON']))
  await $.command.run(lane('config checkin off'))
  await idleFor(8 * MIN)
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Conductor', 'none: /callboard lead join'], ['Check-ins', 'OFF']))
  expect(checkins()).toEqual([])
  await $.command.run(lane('config checkin on'))
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: not with a draft in the box or a dialog open; owed until they clear', async ($, on) => {
  await ckLead($, on)
  h.draftNow = 'half a sentence'
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([])
  h.draftNow = ''
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const open = $.command.run(lane('off', { kind: 'plugin', name: 'x' }))
  // Under the dialog's own 90 s limit, and past a minute: one observation runs while it is open.
  await h.clock!.advance(64_000)
  expect(checkins()).toEqual([])
  release(NO)
  await open
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: shares the hourly cap with the lanes-changed notice; capped, it stays owed, logged once', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  for (let i = 1; i <= 12; i++) {
    putStore([ckLane({ createdAt: 10 ** i })])
    await h.clock!.advance(2000)
  }
  expect(notices()).toBe(12)
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([])
  expect(logged(stdins).filter((x) => x === 'notice-capped:attention')).toEqual(['notice-capped:attention'])
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

const otherLeadLive = (live: boolean) => {
  const path = `${ROOT}/leads/${OTHERLEAD}.json`
  if (live) leadFiles.set(path, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  else leadFiles.delete(path)
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...(live ? regAs(OTHERLEAD, 4243, 'LEAD2') : {}) }
}

test('check-in: a lane that names another lead by its session id is told to that lead, and to this one only once that lead is gone', async ($, on) => {
  await ckLead($, on, [], {}, [ckLane({ leadSid: OTHERLEAD })])
  otherLeadLive(true)
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([])
  otherLeadLive(false)
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a lane that names this lead by its session id is told while another lead is live', async ($, on) => {
  await ckLead($, on, [], {}, [ckLane({ leadSid: SID })])
  otherLeadLive(true)
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a presence read that fails keeps what the lead saw of another lead\'s lane: it is not told again', async ($, on) => {
  await ckLead($, on, [], {}, [ckLane({ leadSid: OTHERLEAD })])
  otherLeadLive(false)
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  h.leadsListHook = () => Promise.reject(new Error('read failed'))
  await idleFor(4 * MIN)
  h.leadsListHook = undefined
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: an off while the tick reads another lead\'s presence leaves no memory behind for the next grant', async ($, on) => {
  await ckLead($, on, [], {}, [ckLane({ leadSid: OTHERLEAD })])
  otherLeadLive(false)
  await idleFor(20 * MIN)
  // The tick's own presence read is the first at an instant; the check-in's reads after it hang.
  const gates: (() => void)[] = []
  let at = -1
  let reads = 0
  h.leadsListHook = () => {
    reads = h.nowMs === at ? reads + 1 : 1
    at = h.nowMs
    return reads > 1 ? new Promise<void>((r) => gates.push(r)) : Promise.resolve()
  }
  await idleFor(4 * MIN)
  expect(gates.length).toBeGreaterThan(0)
  await $.command.run(lane('off'))
  h.leadsListHook = undefined
  for (const r of gates) r()
  await ticks(2)
  await grantAt($, PIN)
  await idleFor(20 * MIN)
  expect(checkins()).toEqual([])
})

test('check-in: the lead\'s own lane_resume starts what it saw of that lane over', async ($, on) => {
  await ckLead($, on)
  await idleFor(20 * MIN)
  expect((await $.tool.call(leadCall('resume', { lane: 'API' }))).result).toContain('cue resume acted')
  await idleFor(14 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(20 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a lane whose status time moves with no work seen (its own keepalive ping) is told once, not again', async ($, on) => {
  await ckLead($, on)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a subagent\'s or a refused lane_resume leaves what the lead saw of the lane alone', async ($, on) => {
  await ckLead($, on, [], WAITING)
  await idleFor(4 * MIN)
  expect(JSON.stringify(await $.tool.call({ ...leadCall('resume', { lane: 'API' }), agentId: 'a1' }))).toContain('for the main agent only')
  h.autoAnswer = 'refused busy'
  expect(JSON.stringify(await $.tool.call(leadCall('resume', { lane: 'API' })))).toContain('lane_resume refused')
  // The wait still counts from the first observation: a cleared one would start it over and tell nothing yet.
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT)])
})

test('/callboard checkin outside a lead is refused and stores nothing', async ($, on) => {
  const trace = newTrace()
  await started($, on, [], { trace })
  const writes = trace.log.length
  for (const a of ['checkin pause 1h', 'checkin pause', 'checkin on', 'checkin resume']) expect((await $.command.run(lane(a))).text).toBe('Check-ins are for a lead, conductor or manager, and this session is none of them. Nothing changed.')
  expect(trace.log.slice(writes)).toEqual([])
})

test('check-in: a slow observation never holds the tick: a cue is claimed and answered meanwhile', async ($, on) => {
  await ckLead($, on)
  let release: () => void = () => undefined
  // The first tick reads the lanes once in its own steps, then starts the observation, whose lane read hangs (well inside its 60 s limit below).
  let reads = 0
  h.lanesListHook = () => {
    if (++reads < 2) return Promise.resolve()
    h.lanesListHook = undefined
    return new Promise<void>((r) => (release = r))
  }
  await h.clock!.advance(2000)
  h.cueFile = { ino: 77, text: 'resume\n', present: true, mtimeSec: Math.floor(h.nowMs / 1000) }
  await ticks(4)
  expect(resultFiles.get(RESULT)).toBe('resume refused not-eligible 77\n')
  release()
})

for (const [what, set, logLine, again] of [
  ['throws: its lanes are owed and sent at a later minute', () => { h.submitFails = true }, 'checkin-failed:quiet:1', true],
  ['times out: its lanes stay told', () => { h.submitHangs = true }, 'checkin-unconfirmed:quiet:1', false],
] as const) {
  test(`check-in: a notice whose submit ${what}`, async ($, on) => {
    const stdins: string[] = []
    await ckLead($, on, stdins)
    await idleFor(28 * MIN)
    set()
    await idleFor(4 * MIN)
    await h.clock!.advance(62_000)
    h.submitFails = false
    h.submitHangs = false
    await idleFor(8 * MIN)
    const lines = logged(stdins).filter((x) => x.startsWith('checkin'))
    expect(lines[0]).toBe(logLine)
    expect(lines.includes('checkin:quiet:1')).toBe(again)
    if (!again) expect(lines).toEqual([logLine])
  })
}

test('check-in: /callboard off ends the check-in memory: after lead again, a lane still quiet is told again once its new window passes', async ($, on) => {
  await ckLead($, on)
  await idleFor(32 * MIN)
  expect(checkins().length).toBe(1)
  await $.command.run(lane('off'))
  await grantAt($, PIN)
  await idleFor(28 * MIN)
  expect(checkins().length).toBe(1)
  await idleFor(8 * MIN)
  expect(checkins().length).toBe(2)
})

test('check-in: a plain session and a bound lane never get one', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true, bound: true, seed: () => putStore([ckLane()]) })
  h.sessions = { ...OWN_ROW(), ...ckRow() }
  await $.turn.complete(TURN as any)
  await idleFor(40 * MIN)
  await $.command.run(lane('lane off'))
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([])
  expect(logged(stdins).filter((x) => x.startsWith('checkin'))).toEqual([])
})

test('check-in: quiet reads the signature of the live session: a report signed by an older session of the lane does not hide it', async ($, on) => {
  const NEWSID = '8a1b2c3d-0000-4000-8000-123456789abc'
  await ckLead($, on, [], undefined)
  h.sessions = { ...leadSelfReg(), ...cueSession(NEWSID, 'API', `${PIN}/api`, { pid: 4500 }) }
  h.reportFile = { text: `notes\nstatus: done ${OTHER}\n`, mtimeSec: T0 / 1000 }
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a minute with no usable lead name neither rebuilds what the lead saw nor forgets what it was told', async ($, on) => {
  await ckLead($, on, [], {}, [ckLane({ leadName: 'LEAD' })])
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  // A twin row in another letter case voids the lead's name for a while.
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...regAs(OTHERLEAD, 4600, 'lead') }
  await idleFor(8 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow() }
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a lead that never had a name is still checked in on for a legacy lane', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg({ name: undefined }), ...ckRow() }, seed: () => putStore([ckLane()]) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a status change after only 10 min of quiet starts the quiet window again', async ($, on) => {
  await ckLead($, on)
  await idleFor(10 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(26 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('manager check-ins: only lanes no live lead reaches are told; a lane a lead reaches is told once that lead is gone', async ($, on) => {
  await mgrAt($, on, [], { clock: true, sess: { ...MGR_SESS({ name: 'MANAGER' }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText('`LABLANE` (quiet for 30 min, report not signed done)')])
  leadFiles.delete(LEADPATH)
  h.sessions = MGR_SESS({ name: 'MANAGER' })
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText('`LABLANE` (quiet for 30 min, report not signed done)'), ckText(QUIET)])
})

// ---- the reason a check-in gives for a waiting prompt (checkin-why.ts) ----
const NO_TIER_WHY = 'no tier was in reach of its ask'
const ROW = (kind: string, over: Record<string, unknown> = {}, dt = 20_000) => ({ t: new Date(T0 + dt).toISOString(), kind, lane: 'API', repo: `${PIN}/api`, ...over })

test('check-in: the reason for a waiting prompt is the latest ledger row its own lane wrote since the wait began; another lane, another repo and an older prompt are not read', async ($, on) => {
  await ckLead($, on, [], WAITING)
  putLedger([ROW('no-tier'), ROW('not-judgeable', { code: 'question-scope', lane: 'OTHER' }, 40_000), ROW('not-judgeable', { code: 'question-scope', repo: '/Users/x/elsewhere' }, 50_000)])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, NO_TIER_WHY)])
})

test('check-in: a row from before the wait (the previous prompt) is no reason: with the switch on and no row of this wait it says no record', async ($, on) => {
  await ckLead($, on, [], WAITING)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  putLedger([ROW('no-tier', {}, -60_000)])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, CK_NO_RECORD)])
})

test('check-in: the OFF file is the reason, whatever the ledger holds', async ($, on) => {
  await ckLead($, on, [], WAITING)
  putLedger([ROW('no-tier')])
  pfs.set(OFF_FILE, { text: '', mtimeSec: T0 / 1000 })
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, 'the person\'s OFF file is in place, so no tier is asked')])
})

test('check-in: a row of a kind with no reason (a closed request) gives no reason: the fixed tail stays alone', async ($, on) => {
  await ckLead($, on, [], WAITING)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  putLedger([ROW('returned')])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([`[callboard] Check-in: some lanes may need you. ${PROMPT}. Call lane_list and look at each.${CK_PROMPT_TAIL} ${SENT_NOTE}`])
})

test('check-in: a request still open with another tier is the reason', async ($, on) => {
  await ckLead($, on, [], WAITING)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  putLedger([ROW('requested', { id: REQ_ID })])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(PROMPT, 'a request for it is open with another tier')])
})

test('check-in: a request that was closed by a row with only its id gives no reason: the fixed tail stays alone', async ($, on) => {
  await ckLead($, on, [], WAITING)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  putLedger([ROW('requested', { id: REQ_ID }), { t: new Date(T0 + 60_000).toISOString(), kind: 'abandoned', code: 'swept', id: REQ_ID }])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([`[callboard] Check-in: some lanes may need you. ${PROMPT}. Call lane_list and look at each.${CK_PROMPT_TAIL} ${SENT_NOTE}`])
})

test('check-in: a lane with earlier requests this month still has its current request\'s closing row read', async ($, on) => {
  await ckLead($, on, [], WAITING)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  const old = ['a', 'b', 'c', 'd'].map((x, i) => ROW('relayed', { id: `7a1b2c3d-0000-4000-8000-12345678900${x === 'a' ? 1 : i}` }, -600_000 - i * 1000))
  putLedger([...old, ROW('relayed', { id: REQ_ID }), { t: new Date(T0 + 60_000).toISOString(), kind: 'relay-left', id: REQ_ID }])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([`[callboard] Check-in: some lanes may need you. ${PROMPT}. Call lane_list and look at each.${CK_PROMPT_TAIL} ${SENT_NOTE}`])
})

test('check-in: the text beside a tool result carries the same reason', async ($, on) => {
  postBeneath(on)
  await ckLead($, on, [], WAITING)
  putLedger([ROW('no-tier')])
  h.sessions = { ...leadSelfReg({ status: 'busy' }), ...ckRow(WAITING) }
  await idleFor(8 * MIN)
  expect(await midCtx($)).toEqual([ckText(PROMPT, NO_TIER_WHY)])
})
