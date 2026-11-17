import { expect, test } from 'claude-code/testing'
import * as g from '../hooks/go'
import { CONDUCTOR_HINT_PREFIX, HOUR_MS } from '../hooks/core'
import { h, GO_DIR, LANESDIR, LEADRECDIR, ROOT, SID, T0, YES, extraStat, fakeSha, longTest, pdirs, pfs, repoKey, storeFiles, targetLogs, toasts } from './harness'
import { ledgerRows, putLedger, wireGuard } from './answer-fixtures'
import { APISID, APP2, COND, condSelf, putCond, LEADSID, OTHER, OTHERLEAD, PERSON, PIN, SVC, bindOwner, ckLane, ckRow, callCreate, condOn, condPresenceOf, creator, cueSession, dirStat, grantAt, lane, leadAt, leadCall, leadSelfReg, mgrAt, ownedBy, putLeadRecs, putStore, regAs, started, ticks, waitFor } from './fixtures'

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
  // So does one of four lines, or with an empty line.
  for (const tall of ['a\nb\nc\nd', 'a\n\nb']) expect(String((await $.tool.call(tool('go_request', { text: tall }))).deny)).toBe(`go_request refused: bad-text: ${g.GO_REFUSE['bad-text']}`)
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

test('go_request in a lead a conductor owns opens no dialog and uses none of the hour: it names the live conductor, says to wait while it is gone; the person\'s command still opens it', async ($, on) => {
  await giver($, on)
  ownedBy(OTHERLEAD)
  // The conductor CONDX is live and trusted for PIN.
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN])
  h.sessions = { ...h.sessions, ...regAs(OTHERLEAD, 4243, 'CONDX') }
  const asked = h.askCount
  const live = String((await $.tool.call(tool('go_request', { text: WORK }))).deny)
  expect(live).toBe(`go_request refused: conductor-owns: ${g.goOwnedText({ live: true, name: 'CONDX' })}`)
  expect(live).toContain('ask your conductor `CONDX` by message for a go')
  expect(live).not.toContain('wait and ask it again')
  // The conductor gone (compacting, stopped): still refused, and the lead is told to wait, never to open its own.
  h.sessions = { ...leadSelfReg(), ...ckRow() }
  const gone = String((await $.tool.call(tool('go_request', { text: WORK }))).deny)
  expect(gone).toBe(`go_request refused: conductor-owns: ${g.goOwnedText({ live: false })}`)
  expect(gone).toContain('wait and ask it again later. Never open a go of your own while it owns you')
  expect(h.askCount).toBe(asked)
  expect(goKinds()).toEqual([])
  // None of the hour was used: after the person leaves the conductor, every dialog of the hour is there.
  h.store.delete(`owner:${SID}`)
  h.askAnswer = g.GO_NO as any
  for (let i = 0; i < g.GO_REQUESTS_PER_HOUR; i++) expect((await $.tool.call(tool('go_request', { text: WORK }))).result).toContain('No go was given')
  // The person's own command in an owned lead opens the dialog: it is theirs.
  ownedBy(OTHERLEAD)
  const before = h.askCount
  expect((await goCmd($, WORK)).text).toContain('cancelled')
  expect(h.askCount).toBe(before + 1)
})

test('lane_start in a lead a conductor owns tells it to ask the conductor for a go, not to call go_request', async ($, on) => {
  await giver($, on, [ckLane({ leadSid: SID })])
  ownedBy(OTHERLEAD)
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  const r = String((await $.tool.call(leadCall('start', { lane: 'API' }))).result)
  expect(r).toContain(g.GO_TAIL_OWNED)
  expect(r).not.toContain('call go_request')
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

test('the manager reads no go, whatever a go once listed', async ($, on) => {
  await mgrAt($, on, [], { clock: true })
  await guardOn()
  putGo({ covered: [{ name: 'API', sid: SID }] })
  putCondGo({ id: GOID.replace('9d', '9e'), leads: [{ name: 'LEAD', sid: SID, repo: PIN }] })
  expect(await status($)).toBe(g.goNoneText())
  expect(goKinds()).toEqual(['go-grant', 'go-grant'])
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
  // The person's list command still prints what a go never covers.
  expect((await goCmd($, '')).text).toBe(`The go records could not be read.\n\n${g.GO_NEVER_LINE}`)
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

// ---- a conductor's own go: one click in a conductor covers the leads it owns and their lanes, the ones opened later included ----
// The giver's side: this session (SID) is the conductor COND over PIN and APP2, owning lead LEAD (session LEADSID) of PIN, whose lane API is session APISID.
// The reader's side: this session is a lead or a lane, and the go is seeded as the conductor CONDSID wrote it.
const CONDSID = '7a1b2c3d-0000-4000-8000-123456789abc'
const COND2 = '8a1b2c3d-0000-4000-8000-123456789abc'
const cgoOf = (over: Partial<g.GoConductor> = {}): g.GoConductor => ({ v: 2, id: GOID, by: { level: 'conductor', sid: CONDSID, name: 'COND', repo: COND }, at: T0 - 60_000, ends: T0 + 24 * HOUR_MS, text: WORK, leads: [], covered: [], nonce: '0'.repeat(32), ...over })
function putCondGo(over: Partial<g.GoConductor> = {}): g.GoConductor {
  const go = cgoOf(over)
  const body = g.goFileText(go)
  pdirs.add(GO_DIR)
  pfs.set(`${GO_DIR}/${go.id}.json`, { text: body, mtimeSec: go.at / 1000 })
  putLedger([{ t: new Date(go.at).toISOString(), kind: 'go-grant', id: go.id, by: go.by.sid, tier: 'conductor', hash: fakeSha(body), end: new Date(go.ends).toISOString(), repo: COND }])
  return go
}
async function condGiver($: any, on: any, opts: Parameters<typeof condOn>[3] = {}) {
  // The lane API names the lead LEAD by its session id: under a conductor's go a lane counts only by that link.
  await condOn($, on, [], { clock: true, ...opts, seed: () => {
    putStore([ckLane({ sid: APISID, leadSid: LEADSID })])
    opts.seed?.()
  } })
  await guardOn()
  h.askAnswer = GIVE
}
// This session as the lead LEAD of PIN (the reader of a conductor's go).
async function leadReader($: any, on: any, seed: () => void = () => undefined) {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...ckRow() }, seed: () => {
    putStore([ckLane()])
    seed()
  } })
  await guardOn()
}
const reads = () => goRows().filter((r) => r.kind === 'go-read').map((r) => [r.by, r.code, r.lane])
const givenGo = () => g.parseGo(pfs.get(goFiles()[0])!.text)!
const givenGoOf = () => g.parseGo(pfs.get(`${GO_DIR}/${GOID}.json`)!.text)!

test('/callboard go TEXT typed by the person in a conductor opens the dialog with its leads and their lanes; Give go writes the row, then a v 2 file', async ($, on) => {
  await condGiver($, on)
  const asked = h.askCount
  const r = await goCmd($, WORK)
  expect(h.askCount).toBe(asked + 1)
  expect(h.lastHeader).toBe(g.GO_HEADER)
  expect(h.askedOptions.at(-1)).toEqual([g.GO_NO, g.GO_YES])
  expect(h.lastQuestion.startsWith('Give conductor COND, its 1 lead and their 1 lane, later ones too, one go until ')).toBe(true)
  for (const part of [WORK, 'a merge', 'a force push']) expect(h.lastQuestion).toContain(part)
  expect(goFiles()).toHaveLength(1)
  const f = pfs.get(goFiles()[0])!
  const go = g.parseGo(f.text)!
  expect(go).toMatchObject({ v: 2, by: { level: 'conductor', sid: SID, name: 'COND', repo: COND }, text: WORK, leads: [{ name: 'LEAD', sid: LEADSID, repo: PIN }], covered: [{ name: 'API', sid: APISID }], ends: go.at + 24 * HOUR_MS })
  expect(JSON.parse(f.text).v).toBe(2)
  expect(goRows()).toEqual([expect.objectContaining({ kind: 'go-grant', id: go.id, by: SID, tier: 'conductor', hash: fakeSha(f.text), end: new Date(go.ends).toISOString(), repo: COND, lane: 'COND' })])
  expect(r.text).toContain(`Go ${g.goShort(go.id)} recorded`)
  expect(r.text).toContain('the leads LEAD and the lanes API')
  // The conductor reads its own go, with no go-read row, and the bare command lists it with its leads.
  expect(await status($)).toContain(`<<<go ${g.goShort(go.id)}\n${WORK}\n>>>`)
  expect(goKinds()).toEqual(['go-grant'])
  expect((await goCmd($, '')).text).toContain('leads at the click: LEAD; lanes at the click: API.')
})

test("go_request from a conductor's main agent opens the same dialog; a subagent is refused; a conductor that owns nothing gives a go that lists no lead", async ($, on) => {
  await condGiver($, on, { owns: [] })
  const asked = h.askCount
  expect(String((await $.tool.call(tool('go_request', { text: WORK, agentId: 'a1' }))).deny)).toBe(`go_request refused: subagent: ${g.GO_REFUSE.subagent}`)
  expect(h.askCount).toBe(asked)
  h.askAnswer = g.GO_NO as any
  expect((await $.tool.call(tool('go_request', { text: WORK }))).result).toBe(`No go was given: ${g.GO_REFUSE.cancelled}`)
  expect(h.lastQuestion).toContain('Give conductor COND and the leads and lanes opened under it one go until ')
  expect(goFiles()).toEqual([])
  h.askAnswer = GIVE
  const r = await $.tool.call(tool('go_request', { text: WORK, hours: 48 }))
  const go = givenGo()
  expect(go).toMatchObject({ v: 2, leads: [], covered: [] })
  expect(go.ends - go.at).toBeLessThanOrEqual(24 * HOUR_MS)
  expect(String(r.result)).toContain('It covers no lead yet and no lane yet')
  expect(goKinds()).toEqual(['go-grant'])
})

test("a lead the conductor's dialog listed reads the go by its session id; one go-read row that carries its name", async ($, on) => {
  await leadReader($, on)
  const go = putCondGo({ leads: [{ name: 'LEAD', sid: SID, repo: PIN }] })
  const t = await status($)
  expect(t).toContain(`Go ${g.goShort(GOID)}: given in conductor COND (session ${CONDSID})`)
  expect(t).toContain(`<<<go ${g.goShort(GOID)}\n${WORK}\n>>>`)
  expect(t).toContain(`ends ${new Date(go.ends).toISOString()}`)
  expect(await status($)).toBe(t)
  expect(reads()).toEqual([[SID, 'listed', 'LEAD']])
})

test("a lead opened after the conductor's go reads it once its record names that conductor and it is bound to it; lane_create says its next lane is covered", async ($, on) => {
  await leadReader($, on, () => ownedBy(CONDSID, { name: 'LEAD', leadSid: SID }))
  putCondGo()
  expect(await status($)).toContain(WORK)
  expect(reads()).toEqual([[SID, 'later', 'LEAD']])
  extraStat.set(`${PIN}/api`, dirStat)
  const made = String((await callCreate($, { name: 'WEB', folder: `${PIN}/api`, task: 'Build the page.' })).result)
  expect(made).toContain(`A go covers this lane: ${g.goShort(GOID)}`)
})

test("a lane reads a conductor's go through its lead: a lead the dialog listed, or one whose bound record names the conductor", async ($, on) => {
  await reader($, on)
  putCondGo({ leads: [{ name: 'LEAD', sid: LEADSID, repo: PIN }] })
  expect(await status($)).toContain(WORK)
  expect(reads()).toEqual([[SID, 'later', 'API']])
  // Another go of the same conductor that listed nobody: the lane's lead is found in the lead records.
  const other = GOID.replace('9d', '9e')
  putCondGo({ id: other })
  expect(await status($)).toContain('A go covers this session.')
  ownedBy(CONDSID, { name: 'LEAD', leadSid: LEADSID })
  expect(await status($)).toContain('2 goes cover this session.')
  expect(reads()).toEqual([[SID, 'later', 'API'], [SID, 'later', 'API']])
  // A lane the dialog listed is covered by its own session id, whatever its record says.
  putStore([ckLane({ sid: SID, leadSid: OTHERLEAD })])
  const third = GOID.replace('9d', '9f')
  putCondGo({ id: third, covered: [{ name: 'API', sid: SID }] })
  expect(await status($)).toContain('A go covers this session.')
  expect(reads().at(-1)).toEqual([SID, 'listed', 'API'])
})

test("no go under a conductor's go: a lead of another conductor, an unowned lead, a record that names another conductor session, a record that is not bound", async ($, on) => {
  await leadReader($, on)
  putCondGo()
  // No lead record at all.
  expect(await status($)).toBe(g.goNoneText())
  // Owned by another conductor, and bound to it.
  ownedBy(COND2, { name: 'LEAD', leadSid: SID })
  expect(await status($)).toBe(g.goNoneText())
  // The record names the granting conductor, but this lead's binding still names the other one.
  putLeadRecs([{ name: 'LEAD', conductorSid: CONDSID, sid: SID }])
  expect(await status($)).toBe(g.goNoneText())
  // The record names the granting conductor and nothing is bound to it.
  h.store.delete(`owner:${SID}`)
  expect(await status($)).toBe(g.goNoneText())
  // A record of that conductor that carries another lead's session.
  putLeadRecs([{ name: 'LEAD', conductorSid: CONDSID, sid: OTHERLEAD }])
  bindOwner(OTHERLEAD, CONDSID, 'LEAD')
  expect(await status($)).toBe(g.goNoneText())
  expect(goKinds()).toEqual(['go-grant'])
  // Bound to the granting conductor: covered.
  ownedBy(CONDSID, { name: 'LEAD', leadSid: SID })
  expect(await status($)).toContain(WORK)
})

test("no go under a conductor's go for a lane whose lead is not covered", async ($, on) => {
  // The lane's record names OTHERLEAD as its lead; the conductor owns LEADSID.
  await reader($, on, [ckLane({ sid: SID, leadSid: OTHERLEAD })])
  ownedBy(CONDSID, { name: 'LEAD', leadSid: LEADSID })
  putCondGo({ leads: [{ name: 'LEAD', sid: LEADSID, repo: PIN }] })
  expect(await status($)).toBe(g.goNoneText())
  // The lane's lead is owned by another conductor.
  ownedBy(COND2, { name: 'OTHER-LEAD', leadSid: OTHERLEAD })
  expect(await status($)).toBe(g.goNoneText())
  // A lane that names its lead by name only, and one whose record names the conductor itself as its lead.
  putStore([ckLane({ sid: SID, leadName: 'LEAD' })])
  expect(await status($)).toBe(g.goNoneText())
  putStore([ckLane({ sid: SID, leadSid: CONDSID })])
  expect(await status($)).toBe(g.goNoneText())
  expect(goKinds()).toEqual(['go-grant'])
})

test("lead records that cannot be read are no go under a conductor's go, with the reason; a session the dialog listed needs none", async ($, on) => {
  await leadReader($, on, () => ownedBy(CONDSID, { name: 'LEAD', leadSid: SID }))
  putCondGo()
  extraStat.set(LEADRECDIR, '501 755 2 Directory 11 64 1700000000\n')
  expect(await status($)).toBe(g.goNoneText('The lead records could not be read. Tell the person.'))
  expect(goKinds()).toEqual(['go-grant'])
  // A binding that cannot be read is no go either: the link is not known.
  extraStat.delete(LEADRECDIR)
  h.storeThrowSync = 'get'
  expect(await status($)).toBe(g.goNoneText('The lead records could not be read. Tell the person.'))
  h.storeThrowSync = undefined
  expect(goKinds()).toEqual(['go-grant'])
  extraStat.set(LEADRECDIR, '501 755 2 Directory 11 64 1700000000\n')
  // A session the dialog listed is covered by its own session id: no record is read for that link.
  const listed = GOID.replace('9d', '9e')
  putCondGo({ id: listed, leads: [{ name: 'LEAD', sid: SID, repo: PIN }] })
  expect(await status($)).toContain('A go covers this session.')
  extraStat.delete(LEADRECDIR)
  expect(await status($)).toContain('2 goes cover this session.')
})

test("a conductor reads only the goes given in its own session: none that lists it as a lead or a lane, none of another conductor", async ($, on) => {
  await condGiver($, on)
  putGo({ covered: [{ name: 'API', sid: SID }] })
  putCondGo({ id: GOID.replace('9d', '9e'), leads: [{ name: 'LEAD', sid: SID, repo: PIN }], covered: [{ name: 'API', sid: SID }] })
  expect(await status($)).toBe(g.goNoneText())
  expect(goRows().filter((r) => r.kind === 'go-read')).toEqual([])
})

test('/callboard off in a conductor ends the goes it gave, and no other', async ($, on) => {
  await condGiver($, on)
  await goCmd($, WORK)
  const mine = givenGo()
  putGo()
  putCondGo({ id: GOID.replace('9d', '9e') })
  h.askAnswer = '<yes button>' as any
  await $.command.run(lane('off'))
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(goRows().filter((r) => r.kind === 'go-end')).toEqual([expect.objectContaining({ id: mine.id, code: 'grantor-off', by: SID })])
})

test("the conductor's dialog counts, and its go holds, every lead whose bound record names it, also one in a repo off its list, with the lanes that name that lead by session id", async ($, on) => {
  const WORKREPO = '/data/x/work'
  const L2 = '00000001-0000-4000-8000-00000000abcd'
  const W1 = '00000002-0000-4000-8000-00000000abcd'
  await condGiver($, on, { repos: ['../app'] })
  ownedBy(SID, { name: 'LEAD2', leadSid: L2, repo: WORKREPO })
  storeFiles.set(`${LANESDIR}/${repoKey(WORKREPO)}.json`, JSON.stringify({ repo: WORKREPO, lanes: [{ name: 'W1', folder: WORKREPO, brief: `${WORKREPO}/BRIEF.md`, createdAt: 1, sid: W1, leadSid: L2 }], creates: [] }))
  expect((await goCmd($, WORK)).text).toContain('recorded')
  expect(h.lastQuestion).toContain('Give conductor COND, its 2 leads and their 2 lanes, later ones too, one go until ')
  expect(givenGo()).toMatchObject({ leads: [{ name: 'LEAD', sid: LEADSID, repo: PIN }, { name: 'LEAD2', sid: L2, repo: WORKREPO }], covered: [{ name: 'API', sid: APISID }, { name: 'W1', sid: W1 }] })
  // A binding that cannot be read: no dialog, since what the go would reach is not known.
  const asked = h.askCount
  h.storeThrowSync = 'get'
  expect((await goCmd($, WORK)).text).toContain('No go was given: store-unreadable:')
  h.storeThrowSync = undefined
  expect(h.askCount).toBe(asked)
})

test('more than 32 lanes or 16 leads refuse before any dialog', async ($, on) => {
  const WORKREPO = '/data/x/work'
  const sid = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-00000000abcd`
  // Each lane names its repo's lead by session id.
  const laneStore = (repo: string, n: number, from: number, leadSid: string) =>
    storeFiles.set(`${LANESDIR}/${repoKey(repo)}.json`, JSON.stringify({ repo, lanes: Array.from({ length: n }, (_, i) => ({ name: `LN-${from + i}`, folder: repo, brief: `${repo}/BRIEF.md`, createdAt: 1, sid: sid(100 + from + i), leadSid })), creates: [] }))
  await condGiver($, on, { repos: ['../app', '../app2', WORKREPO] })
  ownedBy(SID, { name: 'LEAD2', leadSid: sid(1), repo: APP2 })
  ownedBy(SID, { name: 'LEAD3', leadSid: sid(2), repo: WORKREPO })
  laneStore(PIN, 16, 0, LEADSID)
  laneStore(APP2, 16, 16, sid(1))
  laneStore(WORKREPO, 1, 32, sid(2))
  // 33 lanes of the three leads, over three repos.
  const asked = h.askCount
  expect((await goCmd($, WORK)).text).toBe(`No go was given: too-many: ${g.GO_REFUSE['too-many']}`)
  expect(String((await $.tool.call(tool('go_request', { text: WORK }))).deny)).toBe(`go_request refused: too-many: ${g.GO_REFUSE['too-many']}`)
  expect(h.askCount).toBe(asked)
  // 32 lanes and three leads pass the count.
  laneStore(PIN, 15, 0, LEADSID)
  expect((await goCmd($, WORK)).text).toContain('recorded')
  expect(givenGo().covered).toHaveLength(32)
  expect(givenGo().leads.map((x) => x.name)).toEqual(['LEAD', 'LEAD2', 'LEAD3'])
  // 18 leads: sixteen records in APP2 beside the ones of the two other repos.
  putLeadRecs(Array.from({ length: 16 }, (_, i) => ({ name: `L-${i}`, conductorSid: SID, sid: sid(200 + i) })), APP2)
  for (let i = 0; i < 16; i++) bindOwner(sid(200 + i), SID, `L-${i}`, APP2)
  const before = h.askCount
  expect((await goCmd($, WORK)).text).toBe(`No go was given: too-many: ${g.GO_REFUSE['too-many']}`)
  // Sixteen leads pass it.
  putLeadRecs(Array.from({ length: 14 }, (_, i) => ({ name: `L-${i}`, conductorSid: SID, sid: sid(200 + i) })), APP2)
  for (let i = 0; i < 14; i++) bindOwner(sid(200 + i), SID, `L-${i}`, APP2)
  expect(h.askCount).toBe(before)
  expect((await goCmd($, WORK)).text).toContain('recorded')
  expect(h.askCount).toBe(before + 1)
})

longTest("the conductor sees one toast the first time a lead or a lane opened after its go reads it, and none for one the dialog listed", async ($, on) => {
  await condGiver($, on)
  await goCmd($, WORK)
  const go = givenGo()
  const read = (by: string, code: string, name: string) => putLedger([{ t: new Date(h.nowMs).toISOString(), kind: 'go-read', id: go.id, by, code, lane: name }])
  read(LEADSID, 'listed', 'LEAD')
  read(OTHERLEAD, 'later', 'NEW-LEAD')
  read(OTHER, 'later', 'WEB')
  await h.clock!.advance(61_000)
  await waitFor(() => toasts.includes(g.goReadToast('WEB', go.id)))
  await h.clock!.advance(121_000)
  for (const name of ['NEW-LEAD', 'WEB']) expect(toasts.filter((t) => t === g.goReadToast(name, go.id))).toHaveLength(1)
  expect(toasts).not.toContain(g.goReadToast('LEAD', go.id))
})

test("a conductor's go is read from the records alone: with the conductor not live and no list file in sight the lead stays covered, until go off", async ($, on) => {
  await leadReader($, on, () => ownedBy(CONDSID, { name: 'LEAD', leadSid: SID }))
  putCondGo()
  expect(await status($)).toContain(WORK)
  expect((await goCmd($, 'off')).text).toBe(g.goOffText([GOID]))
  expect(await status($)).toBe(g.goNoneText())
})

test('a saved conductor grant that is refused when the session starts ends the goes that conductor gave, and no other', async ($, on) => {
  await started($, on, [], {
    clock: true,
    seed: () => {
      h.store.set(`${CONDUCTOR_HINT_PREFIX}${SID}`, { home: 'not a path' })
      putCondGo({ by: { level: 'conductor', sid: SID, name: 'COND', repo: COND } })
      putCondGo({ id: GOID.replace('9d', '9e') })
    },
  })
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(goRows().filter((r) => r.kind === 'go-end')).toEqual([expect.objectContaining({ id: GOID, code: 'grantor-off', by: SID })])
})

// A restarted conductor (SID) with a saved grant over PIN, the goes it gave as a conductor and one of another conductor. file: its list file now.
const condRestart = ($: any, on: any, file: string[]) => {
  h.sessions = condSelf()
  return started($, on, [], {
    clock: true,
    seed: () => {
      h.callerCwd = COND
      for (const r of [COND, PIN, APP2]) extraStat.set(`${r}/.git`, dirStat)
      putCond(file)
      h.store.set(`${CONDUCTOR_HINT_PREFIX}${SID}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
      putCondGo({ by: { level: 'conductor', sid: SID, name: 'COND', repo: COND } })
      putCondGo({ id: GOID.replace('9d', '9e') })
    },
  })
}
const ended = () => goRows().filter((r) => r.kind === 'go-end')

test('a saved conductor grant that is refused for good at a restart (no approved repo left) ends the goes that conductor gave, and no other', async ($, on) => {
  // The list file holds none of the approved repos: nothing is restored.
  await condRestart($, on, [])
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(ended()).toEqual([expect.objectContaining({ id: GOID, code: 'grantor-off', by: SID })])
})

test('a lead grant made while the unanswered conductor restore question waits ends the goes that conductor gave, and no other', async ($, on) => {
  // The list file names a repo the person has not approved: the restore asks, and nobody answers.
  await condRestart($, on, ['../app', '../app2'])
  h.askAnswer = ''
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  await ticks(2)
  expect(ended()).toEqual([])
  await grantAt($, COND)
  await ticks(2)
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(ended()).toEqual([expect.objectContaining({ id: GOID, code: 'grantor-off', by: SID })])
})

test('/callboard off in a session that gave no go and holds no lead or conductor grant ends none and tells of none it could not end', async ($, on) => {
  await reader($, on)
  putGo()
  const file = goFiles()[0]
  h.pfsFails = (a: string[]) => a[0] === '/usr/bin/head' && a[a.length - 1] === file
  h.askAnswer = '<yes button>' as any
  await $.command.run(lane('off'))
  for (let i = 0; i < 5; i++) await h.clock!.advance(2000)
  expect(toasts).not.toContain(g.GO_END_FAILED_TOAST)
  expect(goKinds()).toEqual(['go-grant'])
  h.pfsFails = undefined
})

test('a go whose sessions do not fit one go file is refused too-big before any dialog', async ($, on) => {
  // Fourteen leads in a repo whose path is 500 bytes long: each lead is held with its repo, so the file would pass 8 KB.
  const LONG = `/data/x/${'a'.repeat(492)}`
  const sid = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-00000000abcd`
  await condGiver($, on)
  putLeadRecs(Array.from({ length: 14 }, (_, i) => ({ name: `L-${i}`, conductorSid: SID, sid: sid(300 + i) })), LONG)
  for (let i = 0; i < 14; i++) bindOwner(sid(300 + i), SID, `L-${i}`, LONG)
  const asked = h.askCount
  expect((await goCmd($, WORK)).text).toBe(`No go was given: too-big: ${g.GO_REFUSE['too-big']}`)
  expect(h.askCount).toBe(asked)
  expect(goFiles()).toEqual([])
})

test("a lead the conductor's go holds from the click keeps it after it moves to another conductor, and so does a lane it opens then", async ($, on) => {
  // This session is the lead LEAD, held in the go of CONDSID at the click and owned by COND2 since.
  await leadReader($, on, () => ownedBy(COND2, { name: 'LEAD', leadSid: SID }))
  putCondGo({ leads: [{ name: 'LEAD', sid: SID, repo: PIN }] })
  expect(await status($)).toContain(WORK)
  expect(reads()).toEqual([[SID, 'listed', 'LEAD']])
  // lane_create says a lane it opens now is covered: the go reaches this lead by the session id it holds.
  expect(g.goReachesLead(givenGoOf(), SID)).toBe(true)
})
