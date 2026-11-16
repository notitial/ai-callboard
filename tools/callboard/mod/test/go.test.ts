import { expect, test } from 'claude-code/testing'
import * as g from '../hooks/go'
import { HOUR_MS } from '../hooks/core'
import { h, GO_DIR, ROOT, SID, T0, YES, extraStat, fakeSha, longTest, pdirs, pfs, targetLogs, toasts } from './harness'
import { ledgerRows, putLedger, wireGuard } from './answer-fixtures'
import { LEADSID, OTHER, OTHERLEAD, PERSON, PIN, SVC, ckLane, ckRow, callCreate, creator, cueSession, dirStat, lane, leadAt, leadCall, leadSelfReg, mgrAt, putStore, started, waitFor } from './fixtures'

// ---- the go (ADR 0009): the dialog in a lead's session, the go file and its rows, go_request, go_status, /callboard go ----
// The giver's side: this session (SID) is the lead LEAD of PIN, with the store lane API bound to session OTHER. The reader's side: this session is a plain one
// whose lane record a test seeds, and the go file and its `go-grant` row are seeded as the lead LEADSID wrote them.
const GIVE = g.GO_YES
const WORK = 'Build the API: the schema change in api/db and its migration.'
const GOID = '9d1b2c3d-0000-4000-8000-123456789abc'
const goCmd = ($: any, args: string, origin: unknown = PERSON) => $.command.run(lane(args === '' ? 'go' : `go ${args}`, origin))
const tool = (name: string, input: Record<string, unknown> = {}) => ({ tool: `mcp__callboard__${name}`, ...input }) as any
const status = async ($: any) => String((await $.tool.call(tool('go_status'))).result)
const goFiles = () => [...pfs.keys()].filter((k) => k.startsWith(`${GO_DIR}/`) && k.endsWith('.json'))
const goRows = () => ledgerRows().filter((r) => String(r.kind).startsWith('go-'))
const goKinds = () => goRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
// The markers are seeded once the session start has read where the mod loads from.
const guardOn = async (without?: Parameters<typeof wireGuard>[0]) => {
  await waitFor(() => h.liveHeadAsked !== undefined)
  wireGuard(without)
}
async function giver($: any, on: any, lanes: unknown[] = [ckLane()]) {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...ckRow() }, seed: () => putStore(lanes) })
  await guardOn()
  h.askAnswer = GIVE
}
async function reader($: any, on: any, lanes: unknown[] = [ckLane({ sid: SID, leadSid: LEADSID })], guard = true) {
  await started($, on, [], { clock: true, seed: () => putStore(lanes) })
  extraStat.set(`${PIN}/.git`, dirStat)
  if (guard) await guardOn()
}
const goOf = (over: Partial<g.Go> = {}): g.Go => ({ v: 1, id: GOID, by: { level: 'lead', sid: LEADSID, name: 'LEAD', repo: PIN }, at: T0 - 60_000, ends: T0 + 24 * HOUR_MS, text: WORK, covered: [], nonce: '0'.repeat(32), ...over })
// A go as its lead wrote it: the file, and the row carrying the hash of the file's bytes. row: false leaves the row out, or names the fields that differ.
function putGo(over: Partial<g.Go> = {}, row: boolean | Record<string, unknown> = true, file = true): g.Go {
  const go = goOf(over)
  const body = g.goFileText(go)
  pdirs.add(GO_DIR)
  if (file) pfs.set(`${GO_DIR}/${go.id}.json`, { text: body, mtimeSec: go.at / 1000 })
  if (row !== false) putLedger([{ t: new Date(go.at).toISOString(), kind: 'go-grant', id: go.id, by: go.by.sid, tier: 'lead', hash: fakeSha(body), end: new Date(go.ends).toISOString(), repo: PIN, ...(row === true ? {} : row) }])
  return go
}
// Waits (real time) until the dialog is up, then lets its 10 minutes pass on the mock clock.
const dialogTimesOut = async (p: Promise<any>) => {
  const n = h.askCount
  await waitFor(() => h.askCount !== n)
  await new Promise((r) => setTimeout(r, 10))
  await h.clock!.advance(g.GO_DIALOG_MS + 1000)
  return p
}

test('/callboard go TEXT typed by the person in a lead opens the mod\'s dialog; Give go writes the row, then the file', async ($, on) => {
  await giver($, on)
  const asked = h.askCount
  const r = await goCmd($, WORK)
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastHeader).toBe(g.GO_HEADER)
  expect(h.askedOptions.at(-1)).toEqual([g.GO_NO, g.GO_YES])
  // Three fixed lines of the mod's, the lane as a count and not by name, then the description last.
  const lines = String(h.lastQuestion).split('\n')
  expect(lines).toHaveLength(4)
  expect(lines[0]).toMatch(/^Give lead LEAD and its 1 lane, later ones too, one go until \w{3} \d{1,2} \w{3} \d\d:\d\d\? \/callboard go off ends it\.$/)
  expect(lines.slice(1)).toEqual([g.GO_NEVER_DIALOG, 'Everything below was typed with the command, not written by callboard:', WORK])
  expect(goFiles()).toHaveLength(1)
  const f = pfs.get(goFiles()[0])!
  const go = g.parseGo(f.text)!
  expect(go).toMatchObject({ by: { level: 'lead', sid: SID, name: 'LEAD', repo: PIN }, text: WORK, covered: [{ name: 'API', sid: OTHER }], ends: go.at + 24 * HOUR_MS })
  expect(go.at).toBeGreaterThanOrEqual(T0)
  expect(goFiles()[0]).toBe(`${GO_DIR}/${go.id}.json`)
  expect(pdirs.has(GO_DIR)).toBe(true)
  expect(goRows()).toEqual([expect.objectContaining({ kind: 'go-grant', id: go.id, by: SID, tier: 'lead', hash: fakeSha(f.text), end: new Date(go.ends).toISOString(), repo: PIN, lane: 'LEAD' })])
  expect(r.text).toContain(g.goShort(go.id))
  // The session it was given in is covered by its own go, with no go-read row.
  expect(await status($)).toContain(`<<<go ${g.goShort(go.id)}\n${WORK}\n>>>`)
  expect(goKinds()).toEqual(['go-grant'])
  // The bare command lists it.
  expect((await goCmd($, '')).text).toContain(g.goShort(go.id))
})

test('for N h sets the end; more than 48 h and an empty or control-character text open no dialog', async ($, on) => {
  await giver($, on)
  const asked = h.askCount
  expect((await goCmd($, `for 49 h ${WORK}`)).text).toBe(g.GO_USAGE)
  expect((await goCmd($, 'bad\u0007text')).text).toContain('No go was given: bad-text')
  expect(h.askCount).toBe(asked)
  await goCmd($, `for 2 h ${WORK}`)
  const go = g.parseGo(pfs.get(goFiles()[0])!.text)!
  expect(go.ends - go.at).toBeLessThanOrEqual(2 * HOUR_MS)
  expect(go.ends - go.at).toBeGreaterThan(2 * HOUR_MS - 5000)
  expect(go.text).toBe(WORK)
})

test('Cancel and a dismissal write nothing; the command from a plugin, a peer or no origin is refused before any dialog', async ($, on) => {
  await giver($, on)
  for (const a of [g.GO_NO, undefined, 'Something else']) {
    h.askAnswer = a as any
    expect((await goCmd($, WORK)).text).toBe(`No go was given: cancelled: ${g.GO_REFUSE.cancelled}`)
  }
  h.askAnswer = GIVE
  const asked = h.askCount
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'peer' }, null]) {
    for (const args of [WORK, 'off', '', 'list']) expect((await goCmd($, args, origin)).text).toBe(g.GO_NOT_PERSON)
  }
  expect(h.askCount).toBe(asked)
  expect(goFiles()).toEqual([])
  expect(goRows()).toEqual([])
})

longTest('a dialog nobody answers times out after 10 minutes and writes nothing; a click on it afterwards records nothing and the person is told', async ($, on) => {
  await giver($, on)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  expect((await dialogTimesOut(goCmd($, WORK))).text).toBe(`No go was given: timed-out: ${g.GO_REFUSE['timed-out']}`)
  expect(toasts).toContain(g.GO_TIMED_OUT_TOAST)
  release(GIVE)
  await waitFor(() => toasts.includes(g.GO_LATE_TOAST))
  expect(goFiles()).toEqual([])
  expect(goRows()).toEqual([])
  // The dialog is no longer held open for the session: the next one is asked.
  h.askHang = undefined
  expect((await goCmd($, WORK)).text).toContain('recorded')
  expect(goFiles()).toHaveLength(1)
})

test('go_request from the lead\'s main agent opens the same dialog with the default end; a subagent is refused; Cancel is a result, not a go', async ($, on) => {
  await giver($, on)
  const asked = h.askCount
  expect(String((await $.tool.call(tool('go_request', { text: WORK, agentId: 'a1' }))).deny)).toBe(`go_request refused: subagent: ${g.GO_REFUSE.subagent}`)
  expect(String((await $.tool.call(tool('go_request', { text: '' }))).deny)).toContain('go_request refused: bad-text')
  // A description past the limit opens no dialog, and the refusal says how long it may be.
  expect(String((await $.tool.call(tool('go_request', { text: 'x'.repeat(g.GO_TEXT_MAX + 1) }))).deny)).toBe(`go_request refused: bad-text: ${g.GO_REFUSE['bad-text']}`)
  expect(g.GO_REFUSE['bad-text']).toContain('two or three lines')
  expect(h.askCount).toBe(asked)
  h.askAnswer = g.GO_NO as any
  expect((await $.tool.call(tool('go_request', { text: WORK }))).result).toBe(`No go was given: ${g.GO_REFUSE.cancelled}`)
  expect(goFiles()).toEqual([])
  h.askAnswer = GIVE
  // An end the model names is not read: the tool has no such input.
  const r = await $.tool.call(tool('go_request', { text: WORK, hours: 48 }))
  const go = g.parseGo(pfs.get(goFiles()[0])!.text)!
  expect(go.ends - go.at).toBeLessThanOrEqual(24 * HOUR_MS)
  expect(String(r.result)).toContain(g.goShort(go.id))
  expect(h.lastQuestion).toContain(WORK)
  expect(goKinds()).toEqual(['go-grant'])
})

test('the seventh go_request dialog in an hour is refused; the person\'s own command is not counted', async ($, on) => {
  await giver($, on)
  h.askAnswer = g.GO_NO as any
  for (let i = 0; i < g.GO_REQUESTS_PER_HOUR; i++) expect((await $.tool.call(tool('go_request', { text: WORK }))).result).toContain('No go was given')
  const asked = h.askCount
  expect(String((await $.tool.call(tool('go_request', { text: WORK }))).deny)).toBe(`go_request refused: rate: ${g.GO_REFUSE.rate}`)
  expect(h.askCount).toBe(asked)
  expect((await goCmd($, WORK)).text).toContain('cancelled')
  expect(h.askCount).toBe(asked + 1)
})

test('go_request and /callboard go TEXT are refused in a plain session and in the manager; no dialog opens', async ($, on) => {
  await started($, on, [], { clock: true })
  await guardOn()
  const asked = h.askCount
  // A session that is no lead has no go_request tool behind it, and the command refuses.
  expect((await goCmd($, WORK)).text).toBe(`No go was given: not-lead: ${g.GO_REFUSE['not-lead']}`)
  expect(String((await $.tool.call(tool('go_request', { text: WORK }))).deny)).toBe(`go_request refused: not-lead: ${g.GO_REFUSE['not-lead']}`)
  expect(h.askCount).toBe(asked)
  expect(goFiles()).toEqual([])
})

test('the manager gives no go', async ($, on) => {
  await mgrAt($, on, [], { clock: true })
  await guardOn()
  const asked = h.askCount
  expect((await goCmd($, WORK)).text).toBe(`No go was given: manager: ${g.GO_REFUSE.manager}`)
  expect(String((await $.tool.call(tool('go_request', { text: WORK }))).deny)).toBe(`go_request refused: manager: ${g.GO_REFUSE.manager}`)
  expect(h.askCount).toBe(asked)
})

test('no go is given while the protected-paths guard is missing, and go_status reports none', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...ckRow() }, seed: () => putStore([ckLane()]) })
  await guardOn('callboard')
  h.askAnswer = GIVE
  const asked = h.askCount
  expect((await goCmd($, WORK)).text).toContain('No go was given: guard: callboard cannot keep a go while the protected-paths guard is missing')
  expect(h.askCount).toBe(asked)
  putGo({ by: { level: 'lead', sid: SID, name: 'LEAD', repo: PIN } })
  expect(await status($)).toContain(`${g.GO_NONE} Callboard reports no go while the protected-paths guard is missing`)
})

test('go_status in a lane opened after the go, whose record carries its own session id and names the granting lead, returns the text, the end and the never-list, with one go-read row', async ($, on) => {
  await reader($, on)
  const go = putGo()
  const t = await status($)
  expect(t).toContain(`Go ${g.goShort(GOID)}: given in`)
  expect(t).toContain(`(session ${LEADSID})`)
  expect(t).toContain(`ends ${new Date(go.ends).toISOString()}`)
  expect(t).toContain(`<<<go ${g.goShort(GOID)}\n${WORK}\n>>>`)
  expect(t).toContain(g.GO_NEVER_TEXT)
  expect(goRows().filter((r) => r.kind === 'go-read')).toEqual([expect.objectContaining({ id: GOID, by: SID, code: 'later', lane: 'API' })])
  // A second read, after a resume or a compaction, writes no second row.
  expect(await status($)).toBe(t)
  expect(goKinds()).toEqual(['go-grant', 'go-read later'])
  // A subagent of the lane reads the same.
  expect(String((await $.tool.call(tool('go_status', { agentId: 'a1' }))).result)).toBe(t)
})

test('a go on file whose description is longer than a new go may have is still read', async ($, on) => {
  await reader($, on)
  const text = 'x'.repeat(g.GO_FILE_TEXT_MAX)
  putGo({ text })
  expect(g.goTextNo(text)).toBe('bad-text')
  expect(await status($)).toContain(`<<<go ${g.goShort(GOID)}\n${text}\n>>>`)
})

test('a lane the lead had at the click is covered by its session id; a joined lane is covered; a lane parked and reopened is covered', async ($, on) => {
  await reader($, on, [])
  putGo({ covered: [{ name: 'API', sid: SID }] })
  expect(await status($)).toContain(WORK)
  expect(goKinds()).toEqual(['go-grant', 'go-read listed'])
  // A joined lane: its record names the lead it joined and carries its own session id.
  putStore([{ name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: 9, adopted: true, lead: LEADSID, sid: SID }])
  putGo({ id: GOID.replace('9d', '9e') })
  const t = await status($)
  expect(t).toContain('2 goes cover this session.')
  expect(goKinds()).toEqual(['go-grant', 'go-read listed', 'go-grant', 'go-read later'])
  // Parked and reopened: the record is the same one, with the park stamp gone.
  putStore([ckLane({ sid: SID, leadSid: LEADSID, parkedAt: T0 })])
  expect(await status($)).toBe(t)
})

test('go_status returns no go for another lead\'s lane, a record with no session id of its own, and a session that only carries a covered lane\'s name', async ($, on) => {
  await reader($, on, [ckLane({ sid: SID, leadSid: OTHERLEAD })])
  putGo({ covered: [{ name: 'API', sid: OTHER }] })
  expect(await status($)).toBe(g.goNoneText())
  putStore([ckLane({ leadSid: LEADSID })])
  expect(await status($)).toBe(g.goNoneText())
  putStore([{ name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: 9, adopted: true, lead: OTHERLEAD, sid: SID }])
  expect(await status($)).toBe(g.goNoneText())
  // The lane API is another session (OTHER); this one only has the same name in the registry.
  putStore([ckLane({ leadSid: LEADSID })])
  h.sessions = { ...h.sessions, ...ckRow({ sessionId: SID, pid: 4999 }) }
  expect(await status($)).toBe(g.goNoneText())
  expect(goKinds()).toEqual(['go-grant'])
})

test('go_status returns no go for a file with no row, a row with no file, a row of another session, a hash that differs and a file that is not a go file', async ($, on) => {
  await reader($, on)
  putGo({}, false)
  expect(await status($)).toBe(g.goNoneText())
  pfs.delete(`${GO_DIR}/${GOID}.json`)
  putGo({}, true, false)
  expect(await status($)).toBe(g.goNoneText())
  const other = GOID.replace('9d', '9e')
  putGo({ id: other }, { by: OTHERLEAD })
  expect(await status($)).toBe(g.goNoneText())
  const third = GOID.replace('9d', '9f')
  putGo({ id: third }, { hash: 'b'.repeat(64) })
  expect(await status($)).toBe(g.goNoneText())
  // A file changed after the click: its bytes no longer hash to the row.
  const fourth = GOID.replace('9d', '9a')
  const go = putGo({ id: fourth })
  pfs.set(`${GO_DIR}/${fourth}.json`, { text: g.goFileText({ ...go, text: 'Anything at all.' }), mtimeSec: T0 / 1000 })
  expect(await status($)).toBe(g.goNoneText())
  // Not the text goFileText writes, a second link, a mode others can write, a name that is not its id.
  const fifth = GOID.replace('9d', '9b')
  const ok = putGo({ id: fifth })
  const path = `${GO_DIR}/${fifth}.json`
  const body = pfs.get(path)!
  for (const bad of [{ ...body, text: `${body.text}\n` }, { ...body, nlink: 2 }, { ...body, mode: '622' }, { ...body, uid: 502 }]) {
    pfs.set(path, bad)
    expect(await status($)).toBe(g.goNoneText())
  }
  pfs.delete(path)
  pfs.set(`${GO_DIR}/${GOID.replace('9d', '9c')}.json`, body)
  expect(await status($)).toBe(g.goNoneText())
  pfs.set(path, body)
  expect(await status($)).toContain(ok.text)
  expect(goRows().filter((r) => r.kind === 'go-read')).toHaveLength(1)
})

longTest('the end time ends a go: no go from then on, and one go-end row however often it is read', async ($, on) => {
  await reader($, on)
  const go = putGo({ ends: T0 + 2 * HOUR_MS })
  expect(await status($)).toContain(WORK)
  await h.clock!.set(go.ends)
  expect(await status($)).toBe(g.goNoneText())
  expect(await status($)).toBe(g.goNoneText())
  expect(goKinds()).toEqual(['go-grant', 'go-read later', 'go-end expired'])
})

test('/callboard go off by the person ends every live go, or the one named, with one go-end row each; a lane then reads no go', async ($, on) => {
  await reader($, on)
  putGo()
  const other = GOID.replace('9d', '9e')
  putGo({ id: other })
  expect(await status($)).toContain('2 goes cover this session.')
  expect((await goCmd($, `off ${g.goShort(other)}`)).text).toBe(g.goOffText([other]))
  expect(await status($)).toContain('A go covers this session.')
  expect((await goCmd($, 'off 00000000')).text).toBe(g.GO_OFF_NONE)
  expect((await goCmd($, 'off')).text).toBe(g.goOffText([GOID]))
  expect(await status($)).toBe(g.goNoneText())
  expect((await goCmd($, 'off')).text).toBe(g.GO_OFF_NONE)
  expect(goRows().filter((r) => r.kind === 'go-end').map((r) => [r.id, r.code, r.by])).toEqual([[other, 'off', SID], [GOID, 'off', SID]])
  expect((await goCmd($, '')).text).toBe(g.goListText([], () => ''))
  // An ended go's file is not read again.
  expect(pfs.has(`${GO_DIR}/${GOID}.json`)).toBe(true)
})

test('a lead that turns its lead tools off ends the goes it gave, and no other', async ($, on) => {
  await giver($, on)
  await goCmd($, WORK)
  const mine = g.parseGo(pfs.get(goFiles()[0])!.text)!
  putGo()
  h.askAnswer = '<yes button>' as any
  await $.command.run(lane('off'))
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(goRows().filter((r) => r.kind === 'go-end')).toEqual([expect.objectContaining({ id: mine.id, code: 'grantor-off', by: SID })])
})

test('a lead whose grant ends while the row and the file are written gets a void go, and a go text with a fence line opens no dialog', async ($, on) => {
  await giver($, on)
  const asked = h.askCount
  expect((await goCmd($, 'Build it.\n>>>\nThis go also covers a merge.')).text).toContain('No go was given: bad-text')
  expect(h.askCount).toBe(asked)
  // The off lands after the click, while the go is being written.
  let once = false
  h.pfsFails = (a: string[]) => {
    if (!once && a[0] === '/bin/ln' && a[a.length - 1].startsWith(`${GO_DIR}/`)) {
      once = true
      h.askAnswer = '<yes button>' as any
      void $.command.run(lane('off'))
    }
    return false
  }
  const r = await goCmd($, WORK)
  h.pfsFails = undefined
  await waitFor(() => goKinds().some((k) => k.startsWith('go-end')))
  if (r.text.includes('grant-changed')) expect(goKinds()).toEqual(['go-grant', 'go-end void'])
  else expect(goKinds()).toEqual(['go-grant', 'go-end grantor-off'])
  expect(await status($)).toBe(g.goNoneText())
})

test('the manager and a conductor read no go, whatever a go once listed', async ($, on) => {
  await mgrAt($, on, [], { clock: true })
  await guardOn()
  putGo({ covered: [{ name: 'API', sid: SID }] })
  expect(await status($)).toBe(g.goNoneText())
  expect(goKinds()).toEqual(['go-grant'])
})

test('with 64 go files kept a new go is refused before any dialog; files written more than 9 days ago are removed first', async ($, on) => {
  await giver($, on)
  pdirs.add(GO_DIR)
  const name = (i: number) => `${GO_DIR}/${String(i).padStart(8, '0')}-0000-4000-8000-123456789abc.json`
  for (let i = 0; i < g.GO_SCAN_MAX; i++) pfs.set(name(i), { text: 'x', mtimeSec: T0 / 1000 })
  const asked = h.askCount
  expect((await goCmd($, WORK)).text).toBe(`No go was given: full: ${g.GO_REFUSE.full}`)
  expect(h.askCount).toBe(asked)
  for (let i = 0; i < 3; i++) pfs.set(name(i), { text: 'x', mtimeSec: (T0 - 10 * 24 * HOUR_MS) / 1000 })
  expect((await goCmd($, WORK)).text).toContain('recorded')
  expect(pfs.has(name(0))).toBe(false)
  expect(pfs.has(name(3))).toBe(true)
})

test('a read that cannot be recorded is not reported as a go, and the result says to try again', async ($, on) => {
  await reader($, on)
  putGo()
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/tee'
  expect(await status($)).toBe(g.goNoneText(g.GO_UNCONFIRMED))
  h.pfsFails = undefined
  expect(await status($)).toContain(WORK)
})

test('a lead cannot take the manager grant over its lead grant, so a go always ends with the lead grant', async ($, on) => {
  await giver($, on)
  h.askAnswer = '<yes button>' as any
  expect((await $.command.run(lane('manager'))).text).toContain('this session is a lead, so it cannot be the manager')
})

test('a lead that restarted as a new conversation counts its existing lanes in the dialog and covers them', async ($, on) => {
  // The lane was made by the earlier conversation of this lead: its record names that session, not this one.
  await giver($, on, [ckLane({ leadSid: LEADSID })])
  await goCmd($, WORK)
  expect(h.lastQuestion).toContain('and its 1 lane, later ones too,')
  expect(g.parseGo(pfs.get(goFiles()[0])!.text)!.covered).toEqual([{ name: 'API', sid: OTHER }])
})

longTest('lane_create and lane_start end by saying whether a go covers the lane', async ($, on) => {
  await creator($, on)
  await guardOn()
  expect(String((await callCreate($)).result)).toContain(g.goTail(undefined))
  h.askAnswer = GIVE
  await goCmd($, WORK)
  const go = g.parseGo(pfs.get(goFiles()[0])!.text)!
  // A lane this lead makes after the go will be covered once it is open.
  const made = String((await callCreate($, { name: 'WEB', folder: `${PIN}/api`, task: 'Build the page.' })).result)
  expect(made).toContain(g.goShort(go.id))
  expect(made).not.toContain(g.goTail(undefined))
  // lane_start names the go for a lane whose record carries its session and this lead; a lane of another lead's making gets the no-go tail.
  putStore([ckLane({ leadSid: SID })])
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  const startedText = String((await $.tool.call(leadCall('start', { lane: 'API' }))).result)
  expect(startedText).toContain('cue start acted for lane API.')
  expect(startedText).toContain(g.goShort(go.id))
  putStore([ckLane({ leadSid: OTHERLEAD })])
  expect(String((await $.tool.call(leadCall('start', { lane: 'API' }))).result)).toContain(g.goTail(undefined))
})

longTest('the giver sees one toast the first time a lane opened after the go reads it, and none for a lane the lead had at the click', async ($, on) => {
  await giver($, on)
  await goCmd($, WORK)
  const go = g.parseGo(pfs.get(goFiles()[0])!.text)!
  const read = (by: string, code: string, name: string) => putLedger([{ t: new Date(h.nowMs).toISOString(), kind: 'go-read', id: go.id, by, code, lane: name }])
  read(OTHER, 'listed', 'API')
  read(OTHERLEAD, 'later', 'WEB')
  await h.clock!.advance(61_000)
  await waitFor(() => toasts.includes(g.goReadToast('WEB', go.id)))
  await h.clock!.advance(121_000)
  expect(toasts.filter((t) => t === g.goReadToast('WEB', go.id))).toHaveLength(1)
  expect(toasts).not.toContain(g.goReadToast('API', go.id))
})

test('a go folder that cannot be checked is no go', async ($, on) => {
  await reader($, on)
  putGo()
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/stat' && a[a.length - 1] === GO_DIR
  expect(await status($)).toBe(g.goNoneText('The go records could not be read. Tell the person.'))
  h.pfsFails = undefined
  expect(await status($)).toContain(WORK)
  expect(ROOT).toBe(GO_DIR.slice(0, -3))
})

longTest('a lane_start whose answer came after the wait still says whether a go covers the lane', async ($, on) => {
  await giver($, on, [ckLane({ leadSid: SID })])
  await goCmd($, WORK)
  const go = g.parseGo(pfs.get(goFiles()[0])!.text)!
  h.autoAnswer = undefined
  const line = (event: string) => `${JSON.stringify({ t: new Date(h.nowMs + 5000).toISOString(), event, reason: '' })}\n`
  targetLogs.set(`${ROOT}/log/${OTHER}.jsonl`, line('brief-sha256') + line('started'))
  const p = $.tool.call(leadCall('start', { lane: 'API' }))
  for (let i = 0; i < 42; i++) await h.clock!.advance(500)
  const late = String((await p).result)
  expect(late).toContain('the session started')
  expect(late).toContain(g.goShort(go.id))
})

test('a lead grant moved to another folder ends the goes given for the old one', async ($, on) => {
  await giver($, on)
  await goCmd($, WORK)
  const go = g.parseGo(pfs.get(goFiles()[0])!.text)!
  h.callerCwd = '/elsewhere'
  h.askAnswer = YES
  await $.command.run(lane('lead', { kind: 'bridge' }))
  expect(h.lastQuestion).toContain('lanes in elsewhere?')
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(goRows().filter((r) => r.kind === 'go-end')).toEqual([expect.objectContaining({ id: go.id, code: 'grantor-off', by: SID })])
  expect(await status($)).toBe(g.goNoneText())
})

test('go_request while another dialog is open is busy and uses none of the hour', async ($, on) => {
  await giver($, on)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const n = h.askCount
  const open = goCmd($, WORK)
  await waitFor(() => h.askCount !== n)
  for (let i = 0; i < g.GO_REQUESTS_PER_HOUR + 1; i++) expect(String((await $.tool.call(tool('go_request', { text: WORK }))).deny)).toBe(`go_request refused: busy: ${g.GO_REFUSE.busy}`)
  release(g.GO_NO)
  await open
  h.askHang = undefined
  h.askAnswer = g.GO_NO as any
  expect((await $.tool.call(tool('go_request', { text: WORK }))).result).toBe(`No go was given: ${g.GO_REFUSE.cancelled}`)
  expect(h.askCount).toBe(n + 2)
})

test('a go file that cannot be read when goes are ended is told: the reply of go off, and a toast at /callboard off', async ($, on) => {
  await giver($, on)
  await goCmd($, WORK)
  const file = goFiles()[0]
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/head' && a[a.length - 1] === file
  expect((await goCmd($, 'off')).text).toBe(`${g.GO_OFF_NONE} ${g.goMissedText(1)}`)
  await $.command.run(lane('off'))
  await waitFor(() => toasts.includes(g.GO_END_FAILED_TOAST))
  expect(goKinds()).toEqual(['go-grant'])
  h.pfsFails = undefined
})
