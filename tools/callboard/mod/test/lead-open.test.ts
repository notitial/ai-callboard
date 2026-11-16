import { expect } from 'claude-code/testing'
import { REASON_TEXT } from '../hooks/core'
import * as c from '../hooks/core'
import { toasts, h, SID, pdirs, teeTexts, OFFERS_DIR, longTest, PROMPTS_DIR, ROOT, T0, extraStat, leadFiles, pfs } from './harness'
import { ledgerRows } from './answer-fixtures'
import { APP2, ticks, CSESS, LEADPS, LEADSID, OTHERLEAD, PIN, condOn, leadAt, leadFileText, leadReg, putLeadRecs, regAs } from './fixtures'

const call = (over: Record<string, unknown> = {}) => ({ tool: 'mcp__callboard__lead_open', repo: PIN, name: 'LEAD-N', task: 'Do the work.', ...over }) as any
const NEWSID = '12345678-aaaa-4bbb-8ccc-dddddddddddd'
const KEY = 'a'.repeat(64)
const LEDGER = `${PROMPTS_DIR}/ledger-2023-11.jsonl`
const RESULT = `${ROOT}/open/LEAD-N.result`
const offers = () => [...pfs.keys()].filter((k) => k.startsWith(`${OFFERS_DIR}/`))
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString()
// Ledger rows as the conductor SID's earlier opens left them.
const seedRows = (...rows: Record<string, unknown>[]) => pfs.set(LEDGER, { text: rows.map((r, i) => JSON.stringify({ hash: KEY, nonce: `n${i}`, by: SID, lane: `LEAD-${i}`, ...r })).join('\n') + '\n', mtimeSec: T0 / 1000 })
const mvs = (argv: string[][], needle: string) => argv.filter((a) => a[0] === '/bin/mv' && a.some((x) => x.includes(needle)))
const cueTexts = (argv: string[][]) => mvs(argv, `${ROOT}/cue/`).map((a) => teeTexts.get(a[3]))

async function conductor($: any, on: any, argv: string[][], opts: { sess?: Record<string, string>; seed?: () => void } = {}) {
  await condOn($, on, [], { clock: true, argv, sess: opts.sess, seed: opts.seed })
  extraStat.set(ROOT, '501 700 2 Directory 8 64 1700000000\n')
  h.openResultPath = RESULT
}
// One call; `answer` is what the window writes into the result file once the request is out.
async function open($: any, answer?: string, over: Record<string, unknown> = {}) {
  const p = $.tool.call(call(over))
  if (answer !== undefined) {
    await h.clock!.advance(500)
    h.openResult = answer
    await h.clock!.advance(500)
  }
  return JSON.stringify(await p)
}
// A refusal before the first write leaves no ledger row, no offer, no brief and no request.
const wroteNothing = (argv: string[][]) => {
  expect(ledgerRows()).toEqual([])
  expect(offers()).toEqual([])
  expect(mvs(argv, '/BRIEF.md')).toEqual([])
  expect(mvs(argv, '.lead')).toEqual([])
}

longTest('lead_open opens a panel, writes the brief, cues it and reports the lead on: no void row, the offer and claim gone', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('lead LEAD-N is on as session 12345678')
  expect(r).not.toContain('model you asked for')
  expect(ledgerRows().map((x) => x.kind)).toEqual(['lead-offer'])
  expect(ledgerRows()[0]).toMatchObject({ hash: KEY, repo: PIN, lane: 'LEAD-N' })
  expect(offers()).toEqual([])
  expect(cueTexts(argv)).toEqual([`lead ${ledgerRows()[0].nonce}\n`])
  expect(mvs(argv, `${PIN}/.archive/LEAD-N/BRIEF.md`).length).toBeGreaterThan(0)
  expect(mvs(argv, `${ROOT}/open/LEAD-N.lead`).length).toBe(1)
  expect(ledgerRows().some((x) => x.kind === 'lead-grant')).toBe(false)
})

// The answer a window of the nonce-echoing extension writes: the request's nonce is the one the ledger row carries.
// The window answers after `waitMs` (a multiple of 500), with the nonce of the request's own ledger row.
async function openEchoing($: any, nonce: (real: string) => string, waitMs = 500) {
  const p = $.tool.call(call())
  for (let waited = 0; waited < waitMs; waited += 500) await h.clock!.advance(500)
  const real = String(ledgerRows().filter((x) => x.kind === 'lead-offer').slice(-1)[0].nonce)
  h.openResult = `ok ${NEWSID} ${nonce(real)}\n`
  await h.clock!.advance(500)
  return JSON.stringify(await p)
}

longTest('lead_open takes an answer that echoes the request nonce, one with none, and refuses one that names another nonce', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await openEchoing($, (n) => n)).toContain('lead LEAD-N is on as session 12345678')
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead LEAD-N is on as session')
  const briefs = mvs(argv, '/BRIEF.md').length
  const takenBack = () => argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1] === `${ROOT}/open/LEAD-N.lead`).length
  const rmBefore = takenBack()
  const bad = await openEchoing($, () => 'f'.repeat(32))
  expect(takenBack()).toBe(rmBefore + 1)
  expect(bad).toContain('lead_open refused: bad-result: the window answer was not valid.')
  expect(mvs(argv, '/BRIEF.md').length).toBe(briefs)
  expect(offers()).toEqual([])
})

longTest('a lead panel is waited for up to 70 s: an answer at 30 s is taken, a window silent for the whole wait is not', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await openEchoing($, (n) => n, 30_000)).toContain('lead LEAD-N is on as session')
  const p = $.tool.call(call({ name: 'LEAD-M' }))
  let done = false
  void p.then(() => { done = true })
  for (let i = 0; i < 65; i++) await h.clock!.advance(1000)
  expect(done).toBe(false)
  for (let i = 0; i < 10; i++) await h.clock!.advance(1000)
  expect(JSON.stringify(await p)).toContain('no window answered in time')
})

longTest('lead_open refuses before any write: repo, name, task and model that fail their checks, and a repo outside the conductor\'s reach', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const refused = async (over: Record<string, unknown>, code: string) => {
    expect(await open($, undefined, over), code).toContain(`lead_open refused: ${code}`)
    wroteNothing(argv)
  }
  await refused({ repo: 'app' }, 'bad-repo')
  await refused({ name: 'lead n' }, 'bad-name')
  await refused({ name: 'MANAGER' }, 'reserved-name')
  await refused({ task: '' }, 'bad-task')
  await refused({ model: 'gpt' }, 'bad-model')
  await refused({ repo: '/Users/x/code/other' }, 'not-in-reach')
  await refused({ repo: '/Users/x/code/cond' }, 'not-in-reach')
})

longTest('lead_open refuses a name a lane or a live session carries, in any letter case, and a request already waiting for that name', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  await open($, undefined, { name: 'api' }).then((r) => expect(r).toContain(REASON_TEXT['name-in-use']))
  wroteNothing(argv)
  h.openList = [{ name: 'LEAD-N.open', kind: 'file', size: 9, mtimeMs: 0, isLink: false }]
  expect(await open($)).toContain(REASON_TEXT['name-in-open'])
  h.openList = [{ name: 'lead-n.Reopen', kind: 'file', size: 9, mtimeMs: 0, isLink: false }]
  expect(await open($)).toContain(REASON_TEXT['name-in-open'])
  wroteNothing(argv)
  // A result file left over is no request.
  h.openList = [{ name: 'LEAD-N.result', kind: 'file', size: 9, mtimeMs: 0, isLink: false }]
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('lead_open refuses when an offer or a claim is in place; each writes nothing', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: '{}', mtimeSec: T0 / 1000 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  pfs.delete(`${OFFERS_DIR}/${KEY}.json`)
  pfs.set(`${OFFERS_DIR}/${KEY}.claim`, { text: '', mtimeSec: T0 / 1000 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  pfs.delete(`${OFFERS_DIR}/${KEY}.claim`)
  expect(ledgerRows()).toEqual([])
  expect(mvs(argv, '.lead')).toEqual([])
})

// The per-conductor limits: nothing is written when one holds, and the refusal says which limit it is and what to do.
longTest('lead_open refuses a fifth lead of a conductor, parked ones counted, and names the leads that hold the slots; another conductor\'s leads do not count', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { seed: () => putLeadRecs([{ name: 'LEAD-A', conductorSid: SID }, { name: 'LEAD-B', conductorSid: SID, sid: LEADSID, parked: 5 }, { name: 'LEAD-C', conductorSid: SID }, { name: 'LEAD-D', conductorSid: SID }, { name: 'OTHER', conductorSid: OTHERLEAD }]) })
  const r = await open($)
  expect(r).toContain('lead-cap: you already own 4 leads')
  expect(r).toContain('LEAD-A, LEAD-B (parked), LEAD-C, LEAD-D')
  expect(r).toContain('Retire one with lead_retire')
  expect(r).not.toContain('OTHER')
  wroteNothing(argv)
})

longTest('lead_open counts the conductor\'s leads across its repos, `joined` ones too, and not those of a repo out of its reach', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, {
    seed: () => {
      putLeadRecs([{ name: 'LEAD-A', conductorSid: SID, how: 'made' }, { name: 'LEAD-B', conductorSid: SID, how: 'joined' }])
      putLeadRecs([{ name: 'LEAD-C', conductorSid: SID }], APP2)
      putLeadRecs([{ name: 'LEAD-D', conductorSid: SID }], '/Users/x/elsewhere')
    },
  })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  pfs.delete(`${OFFERS_DIR}/${KEY}.json`)
  putLeadRecs([{ name: 'LEAD-C', conductorSid: SID }, { name: 'LEAD-E', conductorSid: SID }], APP2)
  h.openResult = undefined
  const r = await open($, undefined, { name: 'LEAD-M' })
  expect(r).toContain('lead-cap: you already own 4 leads')
  expect(r).not.toContain('LEAD-D')
})

longTest('lead_open allows three owned leads, and an eighth open an hour; the ninth is refused with the time the oldest leaves the hour; nothing is written', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { seed: () => putLeadRecs([{ name: 'LEAD-A', conductorSid: SID }, { name: 'LEAD-B', conductorSid: SID }, { name: 'LEAD-C', conductorSid: SID }]) })
  const grants = (ages: number[]) => ages.map((m) => ({ kind: 'lead-grant', t: iso(m * 60_000) }))
  seedRows(...grants([59, 50, 40, 30, 20, 10, 5]))
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead LEAD-N is on as session 12345678')
  expect(mvs(argv, '.lead').length).toBe(1)
  pfs.delete(`${OFFERS_DIR}/${KEY}.json`)
  seedRows(...grants([59, 50, 40, 30, 20, 10, 5, 1]))
  h.openResult = undefined
  const r = await open($, undefined, { name: 'LEAD-M' })
  expect(r).toContain('open-backstop: you opened 8 leads in the last hour')
  expect(r).toContain(`allowed in 1 min, at ${new Date(Math.ceil((T0 + 60_000) / 60_000) * 60_000).toISOString().slice(11, 16)} UTC`)
  expect(mvs(argv, '.lead').length).toBe(1)
  expect(offers()).toEqual([])
})

longTest('lead_open: grants of another conductor and voided or older ones do not count against the backstop', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const OTHER = '8a1b2c3d-0000-4000-8000-123456789abc'
  seedRows(
    ...[5, 10, 15, 20, 25, 30, 35, 40].map((m) => ({ kind: 'lead-grant', by: OTHER, t: iso(m * 60_000) })),
    { kind: 'lead-grant', t: iso(61 * 60_000) },
    { kind: 'lead-grant', nonce: 'v1', t: iso(5 * 60_000) },
    { kind: 'lead-offer-void', nonce: 'v1', by: undefined, t: iso(4 * 60_000) },
  )
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

// With no cap on live leads, a looping conductor could fill the repo's record file; the open then stops before any write, not after a grant that leaves a lead with no owner.
longTest('lead_open refuses a repo whose lead record file is full, before any write', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { seed: () => putLeadRecs(Array.from({ length: c.LEAD_STORE_MAX }, (_, i) => ({ name: `OLD-${i}`, sid: undefined }))) })
  expect(await open($)).toContain(REASON_TEXT['lead-record-cap'])
  wroteNothing(argv)
})

// A live lead is no bar to an open: the conductor's own, one another conductor owns and one made by hand (no owner), all live in the repo. 
longTest('lead_open opens beside live leads of the repo (its own, another conductor\'s, one made by hand)', async ($, on) => {
  const argv: string[][] = []
  const OTHERCOND = '8a1b2c3d-0000-4000-8000-123456789abc'
  const HANDSID = '7a1b2c3d-0000-4000-8000-123456789abc'
  await conductor($, on, argv, {
    sess: { ...CSESS(), ...leadReg(), ...regAs(OTHERLEAD, 4243, 'LEAD-A'), ...regAs(HANDSID, 4244, 'LEAD-B') },
    seed: () => {
      leadFiles.set(`${ROOT}/leads/${LEADSID}.json`, { text: leadFileText() })
      leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4243, procStart: LEADPS, repo: PIN }) })
      leadFiles.set(`${ROOT}/leads/${HANDSID}.json`, { text: JSON.stringify({ sid: HANDSID, pid: 4244, procStart: LEADPS, repo: PIN }) })
      putLeadRecs([{ name: 'LEAD', conductorSid: SID, sid: LEADSID }, { name: 'LEAD-A', conductorSid: OTHERCOND, sid: OTHERLEAD }, { name: 'LEAD-B', conductorSid: undefined, sid: HANDSID }])
    },
  })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead LEAD-N is on as session 12345678')
  expect(ledgerRows().map((x) => x.kind)).toEqual(['lead-offer'])
  expect(mvs(argv, '.lead').length).toBe(1)
})

longTest('lead_open: failed and refused opens spend nothing; the next open still goes through', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  seedRows({ kind: 'lead-offer', t: iso(61 * 60_000) }, { kind: 'lead-offer', t: iso(62 * 60_000) }, { kind: 'lead-offer', t: iso(63 * 60_000) })
  expect(await open($, 'error failed\n')).toContain('the panel did not open')
  expect(offers()).toEqual([])
  for (const code of ['timeout', 'unnamed-panel']) {
    h.openResult = undefined
    expect(await open($, `error ${code}\n`)).toContain('lead_open refused')
    expect(offers()).toEqual([])
  }
  h.openResult = undefined
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  expect(ledgerRows().filter((x) => x.kind === 'lead-offer-void').length).toBe(3)
  expect(ledgerRows().some((x) => x.kind === 'lead-grant')).toBe(false)
  expect(mvs(argv, '.lead').length).toBe(4)
})

longTest('lead_open: an offer of this conductor still open holds a slot; one the panel answered or one older than ten minutes does not', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, { seed: () => putLeadRecs([{ name: 'LEAD-A', conductorSid: SID }, { name: 'LEAD-B', conductorSid: SID }, { name: 'LEAD-C', conductorSid: SID }]) })
  seedRows({ kind: 'lead-offer', hash: 'f'.repeat(64), nonce: 'p1', lane: 'LEAD-P', t: iso(2 * 60_000) })
  const r = await open($)
  expect(r).toContain('LEAD-P (still opening)')
  expect(ledgerRows().length).toBe(1)
  expect(mvs(argv, '.lead')).toEqual([])
  expect(offers()).toEqual([])
  seedRows({ kind: 'lead-offer', hash: 'f'.repeat(64), nonce: 'p1', lane: 'LEAD-P', t: iso(2 * 60_000) }, { kind: 'lead-grant', hash: 'f'.repeat(64), nonce: 'p1', t: iso(60_000) })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('a write that fails after the ledger row takes the offer back and voids the row with its code; nothing is left to block the next try', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.pfsFails = (a: string[]) => a[0] === '/bin/ln' && a.some((x) => x.startsWith(OFFERS_DIR))
  expect(await open($)).toContain(REASON_TEXT['offer-write'])
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void offer-write'])
  expect(offers()).toEqual([])
  expect(mvs(argv, '.lead')).toEqual([])
  h.pfsFails = undefined
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('a throw while the request is written takes the offer back and voids it; an offer left behind is removed once it is ten minutes old, not before', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.mvHook = (path: string) => {
    if (path.endsWith('/open/LEAD-N.lead')) throw new Error('boom')
  }
  expect(await open($)).toContain('lead_open')
  h.mvHook = undefined
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void offer-write'])
  expect(offers()).toEqual([])
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: '{}', mtimeSec: T0 / 1000 - 9 * 60 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  expect(pfs.has(`${OFFERS_DIR}/${KEY}.json`)).toBe(true)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: '{}', mtimeSec: T0 / 1000 - 11 * 60 })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  expect(offers()).toEqual([])
})

longTest('a brief that cannot be written sends no cue: the offer is voided as brief-write and the panel stays an ordinary one', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.mvHook = (path: string) => {
    if (path.endsWith('/LEAD-N/BRIEF.md')) throw new Error('boom')
  }
  const r = await open($, `ok ${NEWSID}\n`)
  h.mvHook = undefined
  expect(r).toContain('lead_open refused: lead panel opened for LEAD-N')
  expect(r).toContain('its brief could not be written')
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void brief-write'])
  expect(offers()).toEqual([])
  expect(mvs(argv, `${ROOT}/cue/`)).toEqual([])
})

longTest('the window never answering takes the offer back and says a panel may still appear; the conductor can ask again after', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const p = $.tool.call(call())
  for (let i = 0; i < 140; i++) await h.clock!.advance(1000)
  const r = JSON.stringify(await p)
  expect(r).toContain('no window answered in time')
  expect(offers()).toEqual([])
  expect(mvs(argv, '/BRIEF.md')).toEqual([])
  expect(ledgerRows().map((x) => x.kind)).toEqual(['lead-offer', 'lead-offer-void'])
  h.openResult = undefined
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('one open at a time per conductor: a second call while the first waits is refused, and the first still finishes', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const first = $.tool.call(call())
  await h.clock!.advance(500)
  expect(JSON.stringify(await $.tool.call(call({ name: 'LEAD-M' })))).toContain(REASON_TEXT['open-in-flight'])
  h.openResult = `ok ${NEWSID}\n`
  await h.clock!.advance(500)
  expect(JSON.stringify(await first)).toContain('is on as session')
  expect(mvs(argv, '.lead').length).toBe(1)
})

longTest('config conductor-leads off makes the tool refuse and writes nothing; on lets it through again', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.store.set('config', { conductorLeads: false, savedAt: h.nowMs })
  expect(await open($)).toContain(REASON_TEXT['conductor-leads-off'])
  wroteNothing(argv)
  h.store.set('config', { conductorLeads: true, savedAt: h.nowMs })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('a settings read that fails makes lead_open refuse and write nothing, the switch not being checkable', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.storeThrowSync = 'get'
  const r = await open($)
  h.storeThrowSync = undefined
  expect(r).toContain(REASON_TEXT['config-unreadable'])
  wroteNothing(argv)
})

longTest('only a conductor has lead_open: a lead that calls it is refused, and nothing is written', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv, clock: true })
  extraStat.set(ROOT, '501 700 2 Directory 8 64 1700000000\n')
  expect(await open($)).toContain(REASON_TEXT['not-conductor'])
  wroteNothing(argv)
})

// A call that runs on until it ends: the window answers the open at once and the clock moves a second at a time (a wait for a held cue is a sleep).
async function openAdv($: any) {
  const p = $.tool.call(call())
  let done = false
  void p.then(() => { done = true })
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  for (let i = 0; i < 80 && !done; i++) await h.clock!.advance(1000)
  return JSON.stringify(await p)
}
const nonceOf = () => String(ledgerRows().filter((x) => x.kind === 'lead-offer').slice(-1)[0].nonce)
const kinds = () => ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)

longTest('an ok answer that says model-unset tells the conductor the model was not changed', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'ok model-unset'
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('is on as session 12345678')
  expect(r).toContain('The model you asked for was not changed')
  expect(kinds()).toEqual(['lead-offer'])
})

longTest('a panel that is not ready twice is given up: offer and claim taken back, the row voided with the reason, the panel named', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'held draft-in-box'
  const r = await openAdv($)
  expect(cueTexts(argv)).toEqual([`lead ${nonceOf()}\n`, `lead ${nonceOf()}\n`])
  expect(r).toContain('it was not ready: draft-in-box')
  expect(r).toContain('the panel now carries that name, but it did not become a lead')
  expect(kinds()).toEqual(['lead-offer', 'lead-offer-void draft-in-box'])
  expect(offers()).toEqual([])
})

longTest('a panel that is not ready once and then ok is taken on the second cue', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'held not-idle'
  h.cueWriteHook = () => {
    if (cueTexts(argv).length >= 1) h.autoAnswer = 'ok -'
  }
  const r = await openAdv($)
  expect(r).toContain('is on as session 12345678')
  expect(cueTexts(argv).length).toBe(2)
  expect(kinds()).toEqual(['lead-offer'])
})

longTest('a refusal from the panel takes the offer and claim back and voids the row; the hour is not spent', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'refused offer-mismatch'
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('did not become a lead: offer-mismatch')
  expect(kinds()).toEqual(['lead-offer', 'lead-offer-void offer-mismatch'])
  expect(offers()).toEqual([])
  expect(cueTexts(argv).length).toBe(1)
})

longTest('no answer to the cue takes nothing back and says the panel may still become the lead', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = undefined
  const p = $.tool.call(call())
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  for (let i = 0; i < 60; i++) await h.clock!.advance(1000)
  const r = JSON.stringify(await p)
  expect(r).toContain('may still become the lead')
  expect(kinds()).toEqual(['lead-offer'])
  expect(offers().length).toBe(1)
})

// ---- the offer sweep ----
const staleOffer = (over: Record<string, unknown> = {}) =>
  c.offerText({ v: 1, name: 'LEAD-N', repo: PIN, model: 'sonnet', conductor: { sid: SID, pid: 4242, start: 'x' }, at: T0 - 11 * 60_000, nonce: 'b'.repeat(32), ...over } as any)

longTest('a conductor takes away its own offer nobody answered once it is ten minutes old: the row is voided as expired, the offer and claim go', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  pdirs.add(OFFERS_DIR)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer(), mtimeSec: T0 / 1000 - 11 * 60 })
  pfs.set(`${OFFERS_DIR}/${KEY}.claim`, { text: 'x', mtimeSec: T0 / 1000 - 11 * 60 })
  seedRows({ kind: 'lead-offer', t: iso(11 * 60_000), nonce: 'b'.repeat(32), by: SID })
  await ticks(32)
  expect(kinds()).toEqual(['lead-offer', 'lead-offer-void expired'])
  expect(offers()).toEqual([])
})

longTest('the sweep leaves a young offer, another conductor\'s offer and an offer already closed by a grant or void alone (the last only loses its files)', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  pdirs.add(OFFERS_DIR)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer(), mtimeSec: T0 / 1000 - 5 * 60 })
  seedRows({ kind: 'lead-offer', t: iso(11 * 60_000), nonce: 'b'.repeat(32), by: SID })
  await ticks(32)
  expect(offers().length).toBe(1)
  expect(kinds()).toEqual(['lead-offer'])
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer({ conductor: { sid: OTHERLEAD, pid: 4243, start: 'x' } }), mtimeSec: T0 / 1000 - 11 * 60 })
  await ticks(32)
  expect(offers().length).toBe(1)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer(), mtimeSec: T0 / 1000 - 11 * 60 })
  seedRows({ kind: 'lead-offer', t: iso(11 * 60_000), nonce: 'b'.repeat(32), by: SID }, { kind: 'lead-grant', t: iso(10 * 60_000), nonce: 'b'.repeat(32) })
  await ticks(32)
  expect(offers()).toEqual([])
  expect(kinds()).toEqual(['lead-offer', 'lead-grant'])
})

// ---- the conductor's check on grants in its name ----
const unasked = () => toasts.filter((t) => t.includes('has no record of asking for it'))

longTest('a grant row in the conductor\'s name for a nonce it never offered is toasted once; one it offered, one by another session and an old one are not', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  const mine = nonceOf()
  const row = (over: Record<string, unknown>) => ({ kind: 'lead-grant', hash: 'c'.repeat(64), repo: PIN, lane: 'LEAD-X', by: SID, ...over })
  seedRows(
    { kind: 'lead-offer', t: iso(1000), hash: KEY, nonce: mine, by: SID },
    row({ t: iso(1000), nonce: mine }),
    row({ t: iso(2000), nonce: 'd'.repeat(32), by: OTHERLEAD }),
    row({ t: iso(25 * 3_600_000), nonce: 'e'.repeat(32) }),
  )
  await ticks(32)
  expect(unasked()).toEqual([])
  seedRows(row({ t: iso(1000), nonce: 'f'.repeat(32) }))
  await ticks(32)
  expect(unasked().length).toBe(1)
  expect(unasked()[0]).toContain('LEAD-X')
  await ticks(64)
  expect(unasked().length).toBe(1)
})

longTest('a claim left with no offer goes once it is ten minutes old, not before', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  pfs.set(`${OFFERS_DIR}/${KEY}.claim`, { text: 'x', mtimeSec: T0 / 1000 - 9 * 60 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  pfs.set(`${OFFERS_DIR}/${KEY}.claim`, { text: 'x', mtimeSec: T0 / 1000 - 11 * 60 })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  expect(offers()).toEqual([])
})

// The text the brief's last write carried: the temporary file moved onto BRIEF.md, as tee wrote it.
const briefText = (argv: string[][]) => {
  const mv = mvs(argv, `${PIN}/.archive/LEAD-N/BRIEF.md`).at(-1)
  return mv === undefined ? undefined : teeTexts.get(mv.find((x) => x.endsWith('.tmp')) ?? '')
}

longTest('lead_open with job: true writes the job brief; the offer carries no flag and keeps its keys', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const p = $.tool.call(call({ job: true }))
  await h.clock!.advance(500)
  const offer = offers().find((k) => k.endsWith('.json'))
  const seen = offer === undefined ? undefined : pfs.get(offer)?.text
  h.openResult = `ok ${NEWSID}\n`
  await h.clock!.advance(500)
  expect(JSON.stringify(await p)).toContain('lead LEAD-N is on as session 12345678')
  expect(seen).toBeDefined()
  expect(Object.keys(JSON.parse(seen!))).toEqual(['v', 'name', 'repo', 'model', 'conductor', 'at', 'nonce'])
  expect(seen).not.toContain('job')
  expect(briefText(argv)).toBe(c.leadJobBriefText('LEAD-N', 'Do the work.'))
})

longTest('lead_open with job: false or no job writes the plain brief, and a job that is not a boolean is refused before any write', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await open($, undefined, { job: 'yes' })).toContain(REASON_TEXT['bad-job'])
  wroteNothing(argv)
  expect(await open($, `ok ${NEWSID}\n`, { job: false })).toContain('is on as session')
  expect(briefText(argv)).toBe(c.leadBriefText('LEAD-N', 'Do the work.'))
})
