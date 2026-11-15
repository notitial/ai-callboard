import { expect, test } from 'claude-code/testing'
import * as c from '../hooks/core'
import { condFiles, h, ROOT, SID, T0, extraStat, fakeSha, leadFiles, storeFiles, toasts } from './harness'
import { ledgerRows } from './answer-fixtures'
import { COND, KEY, LEADPS, OTHERLEAD, PIN, condPresenceOf, dirStat, lane, leadRecFile, leadRecsJson, leadSelfReg, logged, ownedBy, putCond, putLeadRecs, putStore, regAs, started, STATUS_NONE, ticks } from './fixtures'

// A lead's conductor (ADR 0007): the person's `/callboard lead join` and `leave`, `/callboard off`, the question after a Lead click, the name rules, the rename carry.
// The session under test is the lead LEAD (SID) in PIN; the conductor CONDX (OTHERLEAD) is a fixture with its registry row, presence file, saved grant and list file.
const HOME = '/Users/x'
const CAND = { sid: OTHERLEAD, name: 'CONDX', home: COND }
const COND2 = '7a1b2c3d-0000-4000-8000-123456789abc'
const COND2_HOME = '/Users/x/code/cond2'
const NO = 'Cancel'
const ownerRows = () => ledgerRows().filter((r) => r.kind === 'lead-owner')
const bound = () => h.store.get(`owner:${SID}`) as { repo: string; rec: string; conductorSid: string } | undefined
const noOwner = () => {
  expect(storeFiles.has(leadRecFile()) ? leadRecsJson().leads : []).toEqual([])
  expect(bound()).toBeUndefined()
}
const joined = (sid = OTHERLEAD, name = 'CONDX') => {
  expect(leadRecsJson().leads).toMatchObject([{ name: 'LEAD', how: 'joined', conductorSid: sid, conductorName: name, sid: SID }])
  expect(bound()).toEqual({ repo: PIN, rec: fakeSha(c.leadRecordText(PIN, leadRecsJson().leads[0])), conductorSid: sid, at: h.nowMs })
}
const condSeed = () => {
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN])
}
const cond2Seed = () => {
  extraStat.set(`${COND2_HOME}/.git`, dirStat)
  extraStat.set(`${COND2_HOME}/.claude`, '501 755 2 Directory 8 64 1700000000\n')
  condFilesSet(`${COND2_HOME}/.claude/callboard-conductor.json`, ['../app'])
  h.store.set(`conductor:${COND2}`, { home: COND2_HOME, repos: [PIN], savedAt: T0 - 60_000 })
  leadFiles.set(`${ROOT}/leads/${COND2}.json`, { text: JSON.stringify({ sid: COND2, pid: 4244, procStart: LEADPS, level: 'conductor', name: 'ABE', repos: [PIN], home: COND2_HOME }) })
}
const condFilesSet = (path: string, repos: string[]) => condFiles.set(path, c.conductorFileText(repos))
const sessions = (...extra: Record<string, string>[]) => Object.assign({}, leadSelfReg(), regAs(OTHERLEAD, 4243, 'CONDX'), ...extra)

// A lead that has no conductor yet, with CONDX live and trusted for its repo. `lead` true: the lead grant is made (a conductor is live but the question is not asked, since the
// grant is set up before CONDX registers).
async function joiner($: any, on: any, stdins: string[] = [], o: { sess?: Record<string, string>; seed?: () => void } = {}) {
  h.sessions = leadSelfReg()
  await started($, on, stdins, { clock: true })
  extraStat.set(`${PIN}/.git`, dirStat)
  h.callerCwd = PIN
  h.askAnswer = 'Lead'
  await $.command.run(lane('lead'))
  expect(h.askCount).toBe(1)
  h.sessions = o.sess ?? sessions()
  condSeed()
  o.seed?.()
  h.askCount = 0
  h.askedOptions = []
  h.askScript = undefined
  h.askAnswer = 'Join'
}
const join = ($: any, args = '', origin: unknown = { kind: 'composer' }) => $.command.run(lane(`lead join${args ? ` ${args}` : ''}`, origin))
const leave = ($: any, origin: unknown = { kind: 'composer' }) => $.command.run(lane('lead leave', origin))
const refusedText = (code: string) => c.joinRefusalText(code)
const nothing = () => {
  noOwner()
  expect(ownerRows()).toEqual([])
}

test('/callboard lead join with one live conductor asks once, then writes the ledger row, the record and the binding', async ($, on) => {
  const stdins: string[] = []
  await joiner($, on, stdins)
  const res = await join($)
  expect(res.text).toBe(c.joinedText('LEAD', CAND))
  expect(h.askCount).toBe(1)
  expect(h.lastHeader).toBe('Lead Owner')
  expect(h.lastQuestion).toBe(c.joinQuestion('LEAD', PIN, CAND, HOME))
  joined()
  expect(ownerRows()).toMatchObject([{ code: 'joined', hash: KEY, repo: PIN, lane: 'LEAD', target: SID, by: OTHERLEAD }])
  expect(toasts).toContain(c.joinedToast('LEAD', CAND))
  expect(logged(stdins)).toContain('owner-joined:CONDX')
  // An assigned lead is exactly like one the conductor opened: its status says so, and a second Join is refused with no question.
  expect(await statusRow($)).toBe(`CONDX (${OTHERLEAD.slice(0, 8)})`)
  h.askCount = 0
  expect((await join($)).text).toBe(refusedText('already-owned'))
  expect(h.askCount).toBe(0)
})

const statusRow = async ($: any) => /\| Conductor \| (.*) \|/.exec((await $.command.run(lane('status'))).text)?.[1]

test('a Join the person cancels, answers with free text or dismisses changes nothing', async ($, on) => {
  await joiner($, on)
  h.askAnswer = NO
  expect((await join($)).text).toBe('Cancelled. Nothing changed.')
  h.askAnswer = 'something else'
  expect((await join($)).text).toBe('Cancelled. Nothing changed.')
  expect(h.askCount).toBe(2)
  nothing()
})

test('a Join refuses before any question: not the person, not a lead, no conductor, an unknown one, an unnamed lead, a name a lane holds', async ($, on) => {
  await joiner($, on)
  for (const origin of [{ kind: 'plugin' }, { kind: 'peer' }, { kind: 'script' }, null]) expect((await join($, '', origin)).text).toBe(refusedText('join-origin'))
  expect((await leave($, { kind: 'plugin' })).text).toBe(refusedText('join-origin'))
  expect((await join($, 'NOBODY')).text).toBe(refusedText('conductor-unknown'))
  h.sessions = leadSelfReg()
  expect((await join($)).text).toBe(refusedText('no-conductor'))
  h.sessions = sessions({ ...leadSelfReg({ name: 'two words' }) })
  expect((await join($)).text).toBe(refusedText('lead-needs-name'))
  h.sessions = sessions()
  putStore([{ name: 'LEAD', folder: `${PIN}/api`, brief: `${PIN}/api/B.md`, createdAt: 1 }])
  expect((await join($)).text).toBe(refusedText('name-in-use'))
  expect(h.askCount).toBe(0)
  nothing()
})

test('a Join in a session that is not a lead is refused not-lead', async ($, on) => {
  const stdins: string[] = []
  h.sessions = sessions()
  await started($, on, stdins, { clock: true })
  expect((await join($)).text).toBe(refusedText('not-lead'))
  expect((await leave($)).text).toBe(refusedText('not-lead'))
  expect(h.askCount).toBe(0)
})

test('a lead that has a conductor is refused already-owned with no question, whether the conductor is live or gone', async ($, on) => {
  await joiner($, on)
  ownedBy(OTHERLEAD)
  expect((await join($)).text).toBe(refusedText('already-owned'))
  h.sessions = leadSelfReg()
  expect((await join($)).text).toBe(refusedText('already-owned'))
  expect(h.askCount).toBe(0)
  expect(ownerRows()).toEqual([])
  expect(leadRecsJson().leads).toHaveLength(1)
})

test('a lead that got a conductor while the question was open is refused after the click, and the record stays as it was', async ($, on) => {
  await joiner($, on)
  h.askScript = async () => {
    ownedBy(OTHERLEAD, { name: 'OLD-NAME' })
    return 'Join'
  }
  expect((await join($)).text).toBe(refusedText('already-owned'))
  expect(leadRecsJson().leads.map((l) => l.name)).toEqual(['OLD-NAME'])
  expect(ownerRows()).toEqual([])
})

test('a candidate that stops reaching the repo while the question is open is refused no-conductor', async ($, on) => {
  await joiner($, on)
  h.askScript = async () => {
    putCond([])
    return 'Join'
  }
  expect((await join($)).text).toBe(refusedText('no-conductor'))
  nothing()
})

test('a candidate renamed while the question is open is refused changed', async ($, on) => {
  await joiner($, on)
  h.askScript = async () => {
    condPresenceOf(OTHERLEAD, 4243, 'RENAMED', [PIN])
    h.sessions = sessions(regAs(OTHERLEAD, 4243, 'RENAMED'))
    return 'Join'
  }
  expect((await join($)).text).toBe(refusedText('changed'))
  nothing()
})

test('/callboard off typed while the Join question is open wins: nothing is written', async ($, on) => {
  await joiner($, on)
  h.askScript = async () => {
    await $.command.run(lane('off'))
    return 'Join'
  }
  expect((await join($)).text).toBe(refusedText('off-meanwhile'))
  nothing()
})

test('with several conductors a picker shows each one by name, folder and short id, then the question names the pick', async ($, on) => {
  await joiner($, on, [], { seed: cond2Seed, sess: sessions(regAs(COND2, 4244, 'ABE')) })
  h.askScript = async (q: string, opts: string[]) => (q === c.JOIN_PICK_QUESTION ? opts.find((o) => o.startsWith('ABE')) ?? 'none' : 'Join')
  expect((await join($)).text).toBe(c.joinedText('LEAD', { sid: COND2, name: 'ABE', home: COND2_HOME }))
  expect(h.askedOptions[0]).toEqual([`ABE · ~/code/cond2 · ${COND2.slice(0, 8)}`, `CONDX · ~/code/cond · ${OTHERLEAD.slice(0, 8)}`])
  joined(COND2, 'ABE')
  // Naming one by its argument skips the picker.
  await $.command.run(lane('lead leave'))
  h.askedOptions = []
  h.askScript = undefined
  expect((await join($, 'condx')).text).toBe(c.joinedText('LEAD', CAND))
  expect(h.askedOptions).toEqual([[c.JOIN_YES, c.JOIN_NO]])
})

test('/callboard lead leave removes the record and the binding, writes a left row, and a second leave says there is no conductor', async ($, on) => {
  await joiner($, on)
  await join($)
  const res = await leave($)
  expect(res.text).toBe(c.leftText())
  noOwner()
  expect(ownerRows().map((r) => r.code)).toEqual(['joined', 'left'])
  expect(ownerRows()[1]).toMatchObject({ target: SID, repo: PIN, was: OTHERLEAD })
  expect((await leave($)).text).toBe(refusedText('no-owner'))
  // A leave and then a join assigns again, by the person's own two commands, each with its row.
  expect((await join($)).text).toBe(c.joinedText('LEAD', CAND))
  expect(ownerRows().map((r) => r.code)).toEqual(['joined', 'left', 'joined'])
})

test('a record another lead left under the same name is not touched by this lead leaving', async ($, on) => {
  await joiner($, on)
  await join($)
  const mine = leadRecsJson().leads[0]
  putLeadRecs([mine, { name: 'OTHER-LEAD', sid: '8a1b2c3d-0000-4000-8000-123456789abc', conductorSid: OTHERLEAD }])
  await leave($)
  expect(leadRecsJson().leads.map((l) => l.name)).toEqual(['OTHER-LEAD'])
})

test('/callboard off removes the lead record and the binding, says so, and writes an off row; a lead that fails to lose its record still loses its binding', async ($, on) => {
  await joiner($, on)
  await join($)
  const res = await $.command.run(lane('off'))
  expect(res.text).toContain('Its conductor tie is removed.')
  noOwner()
  expect(ownerRows().map((r) => r.code)).toEqual(['joined', 'off'])
  // Again, with a record write that fails: the binding goes first and the reply says the record stayed.
  h.askScript = async (_q: string, opts: string[]) => (opts.includes('Lead') ? 'Lead' : c.JOIN_NONE)
  await $.command.run(lane('lead'))
  h.askScript = undefined
  h.askAnswer = 'Join'
  await join($)
  h.leadRecWrites = 'fail'
  const res2 = await $.command.run(lane('off'))
  expect(res2.text).toContain('its lead record could not be')
  expect(bound()).toBeUndefined()
  expect(leadRecsJson().leads).toHaveLength(1)
})

test('/callboard off in a session that is no lead removes a left-behind binding', async ($, on) => {
  h.sessions = sessions()
  await started($, on, [], { clock: true })
  h.store.set(`owner:${SID}`, { repo: PIN, rec: 'a'.repeat(64), conductorSid: OTHERLEAD, at: T0 })
  await $.command.run(lane('off'))
  expect(bound()).toBeUndefined()
})

test('a Cancel of a repeated /callboard lead ends the grant and takes its conductor tie with it', async ($, on) => {
  await joiner($, on)
  await join($)
  h.askAnswer = NO
  await $.command.run(lane('lead'))
  noOwner()
  expect(ownerRows().map((r) => r.code)).toEqual(['joined', 'off'])
})

test('/callboard status in a lead shows its conductor: none, live, or a record that changed', async ($, on) => {
  await joiner($, on)
  expect(await statusRow($)).toBe('none: /callboard lead join')
  ownedBy(OTHERLEAD)
  expect(await statusRow($)).toBe(`CONDX (${OTHERLEAD.slice(0, 8)})`)
  h.sessions = leadSelfReg()
  expect(await statusRow($)).toBe(`a conductor (gone)`)
  h.sessions = sessions()
  putLeadRecs([{ name: 'LEAD', sid: SID, conductorSid: COND2 }])
  expect(await statusRow($)).toBe(c.ownerStatus('record-changed'))
  expect(STATUS_NONE).toContain('Lead')
})

test('a new session with the name of an owned lead gets no owner: /callboard lead refuses name-in-use, even for a record with no session', async ($, on) => {
  h.sessions = sessions()
  await started($, on, [], { clock: true })
  extraStat.set(`${PIN}/.git`, dirStat)
  h.callerCwd = PIN
  for (const rec of [{ name: 'LEAD', sid: '8a1b2c3d-0000-4000-8000-123456789abc' }, { name: 'lead', sid: undefined }]) {
    putLeadRecs([rec as never])
    h.askCount = 0
    h.askAnswer = 'Lead'
    const res = await $.command.run(lane('lead'))
    expect(res.text).toBe(`Lead stays off: ${c.REASON_TEXT['name-in-use']}`)
    expect(h.askCount).toBe(0)
  }
  // The lead's own record never refuses it.
  putLeadRecs([{ name: 'LEAD', sid: SID }])
  expect((await $.command.run(lane('lead'))).text).toBe(c.LEAD_ON_TEXT)
})

test('the question after a Lead click lists the live conductors with None for now; a pick writes the record, None for now and a dismissal write nothing', async ($, on) => {
  const stdins: string[] = []
  h.sessions = sessions()
  await started($, on, stdins, { clock: true })
  extraStat.set(`${PIN}/.git`, dirStat)
  condSeed()
  h.callerCwd = PIN
  const label = c.joinLabel(CAND, HOME)
  h.askScript = async (q: string, opts: string[]) => (q === c.JOIN_PICK_QUESTION ? c.JOIN_NONE : opts[0])
  let res = await $.command.run(lane('lead'))
  expect(h.askedOptions[1]).toEqual([label, c.JOIN_NONE])
  expect(res.text).toBe(`${c.LEAD_ON_TEXT}${c.JOIN_NOT_PICKED}`)
  nothing()
  // A pick of the conductor: the record and binding are written, and the reply says so.
  await $.command.run(lane('off'))
  h.askScript = async (q: string, opts: string[]) => (q === c.JOIN_PICK_QUESTION ? label : opts[0])
  res = await $.command.run(lane('lead'))
  expect(res.text).toBe(`${c.LEAD_ON_TEXT}\n${c.joinedText('LEAD', CAND)}`)
  expect(h.lastHeader).toBe('Lead Owner')
  joined()
  expect(ownerRows()).toMatchObject([{ code: 'joined', by: OTHERLEAD }])
  // A dismissal (an answer not offered) writes nothing.
  await $.command.run(lane('off'))
  h.askScript = async (q: string, opts: string[]) => (q === c.JOIN_PICK_QUESTION ? 'not offered' : opts[0])
  res = await $.command.run(lane('lead'))
  expect(res.text).toBe(`${c.LEAD_ON_TEXT}${c.JOIN_NOT_PICKED}`)
  expect(bound()).toBeUndefined()
})

test('the question after a Lead click is not asked when no conductor is live, when the lead has no name, or when the answer is not the grant', async ($, on) => {
  h.sessions = leadSelfReg()
  await started($, on, [], { clock: true })
  extraStat.set(`${PIN}/.git`, dirStat)
  h.callerCwd = PIN
  h.askAnswer = 'Lead'
  expect((await $.command.run(lane('lead'))).text).toBe(c.LEAD_ON_TEXT)
  expect(h.askCount).toBe(1)
  await $.command.run(lane('off'))
  h.askCount = 0
  h.sessions = sessions({ ...leadSelfReg({ name: 'two words' }) })
  condSeed()
  expect((await $.command.run(lane('lead'))).text).toBe(`${c.LEAD_ON_TEXT}${c.JOIN_NOT_ASKED_NAME}`)
  expect(h.askCount).toBe(1)
  await $.command.run(lane('off'))
  h.sessions = sessions()
  h.askCount = 0
  h.askAnswer = NO
  expect((await $.command.run(lane('lead'))).text).toBe('Lead stays off.')
  expect(h.askCount).toBe(1)
  nothing()
})

test('a lead that was just joined and is renamed moves its record in one write, the binding stays byte for byte, then the lanes follow', async ($, on) => {
  const stdins: string[] = []
  await joiner($, on, stdins)
  await join($)
  const before = JSON.stringify(bound())
  h.sessions = sessions({ ...leadSelfReg({ name: 'NEW-NAME', nameSource: 'user' }) })
  await tickOnce()
  expect(leadRecsJson().leads.map((l) => l.name)).toEqual(['NEW-NAME'])
  expect(JSON.stringify(bound())).toBe(before)
  expect(ownerRows().map((r) => r.code)).toEqual(['joined'])
})

test('a rename to a name a lane, another lead or another repo holds carries nothing, keeps the lead bound under the old name and tells the person once', async ($, on) => {
  await joiner($, on)
  await join($)
  putLeadRecs([...leadRecsJson().leads, { name: 'TAKEN', sid: '8a1b2c3d-0000-4000-8000-123456789abc', conductorSid: OTHERLEAD }])
  const before = JSON.stringify(bound())
  h.sessions = sessions({ ...leadSelfReg({ name: 'taken', nameSource: 'user' }) })
  for (let i = 0; i < 3; i++) await tickOnce()
  expect(leadRecsJson().leads.map((l) => l.name).sort()).toEqual(['LEAD', 'TAKEN'])
  expect(JSON.stringify(bound())).toBe(before)
  expect(toasts.filter((t) => t === c.renameTakenToast('LEAD', 'taken'))).toHaveLength(1)
})

// The rename look runs every 10 s of the mock clock; one step of the timer is 2 s.
async function tickOnce() {
  await ticks(6)
}
