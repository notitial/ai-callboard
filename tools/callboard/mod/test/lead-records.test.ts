import { expect, test } from 'claude-code/testing'
import { keptKey, leadRecordText } from '../hooks/core'
import type { LeadStore } from '../hooks/core'
import { loadLeadRecords, loadLeadRecordsFor, editLeadRecs, bindingOf, boundTo, ownerLive, ownOwner } from '../hooks/engine/lead-records'
import { registryEntries, unlockRetry } from '../hooks/engine/store'
import { h, LANESDIR, LEADRECDIR, SID, T0, extraStat, fakeSha, lockLog, lockOwnerReads, psDead, recLocks, statErr, storeFiles } from './harness'
import { APP2, COND, KEY, LEADPS, LOCK_CYCLE, OTHER, OTHERLEAD, PIN, STOREFILE, bindOwner, callCreate, condPresenceOf, dirStat, leadAt, leadRecFile, leadRecsJson, leadSelfReg, logged, ownedBy, ownerText, putCond, putLeadRecs, regAs, storeLaneNames } from './fixtures'

// Nothing calls the lead-record functions through a command or a tool yet, so these tests call them with a handle built over the harness's own mocks: each
// call goes to the handler the harness registered for it, as a call from the mod's hooks does.
function direct(on0: any) {
  const handlers = new Map<string, any>()
  const on = (name: string, handler: any) => {
    handlers.set(name, handler)
    return on0(name, handler)
  }
  const call = async (name: string, e: unknown) => (await handlers.get(name)(undefined, e, undefined))?.value
  const knob = { listThrows: false }
  const $$ = {
    process: { run: (argv: string[], init: unknown) => call('process.run', { argv, init }) },
    fs: {
      list: async (path: string) => {
        if (knob.listThrows) throw new Error('list')
        return call('fs.list', { path })
      },
    },
    store: { get: (key: string) => call('store.get', { key }), set: (key: string, value: unknown) => call('store.set', { key, value }), delete: (key: string) => call('store.delete', { key }) },
    session: { id: async () => SID },
    clock: { now: async () => h.nowMs, sleep: () => new Promise(() => undefined) },
    ui: { toast: async () => undefined },
  }
  return { on, $$, knob }
}
const REC_LOCK = `${LEADRECDIR}/.${KEY}.lock`
const lanesLockTouched = (argv: string[][]) => argv.some((a) => a.some((x) => x.startsWith(`${LANESDIR}/.`) && x.includes('.lock')))
const names = (r: unknown) => (r as { store: LeadStore }[]).map((x) => `${x.store.repo}:${x.store.leads.map((l) => l.name).join(',')}`)
// The conductor CONDX (session OTHERLEAD, pid 4243) in COND, trusted for PIN: its presence file, its saved grant and its list file all hold the repo.
const condSeed = () => {
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN])
}
const WITH_COND = () => ({ ...leadSelfReg(), ...regAs(OTHERLEAD, 4243, 'CONDX') })

test('lead records: a good file loads; one with the wrong name, owner, mode, link count or size, a repo too broad or with no .git, or text that does not parse is skipped and logged', async ($, on) => {
  const stdins: string[] = []
  const d = direct(on)
  await leadAt($, d.on, stdins)
  expect(await loadLeadRecords(d.$$)).toEqual([])
  putLeadRecs([{}, { name: 'SECOND' }])
  putLeadRecs([{ name: 'OTHER' }], APP2)
  expect(names(await loadLeadRecords(d.$$))).toEqual([`${PIN}:LEAD,SECOND`, `${APP2}:OTHER`])
  expect(logged(stdins)).not.toContain('error:lead-record-skipped')
  for (const bad of ['501 644 1 Regular File 77 50 1700000000\n', '502 600 1 Regular File 77 50 1700000000\n', '501 600 2 Regular File 77 50 1700000000\n', '501 600 1 Regular File 77 99999 1700000000\n', '501 600 1 Symbolic Link 77 50 1700000000\n']) {
    h.storeStatOverride = bad
    expect(await loadLeadRecords(d.$$)).toEqual([])
  }
  h.storeStatOverride = undefined
  expect(logged(stdins)).toContain('error:lead-record-skipped')
  // The other file still counts when one is bad: a file not named by its repo's hash, text that is no store, a repo with no .git, a repo too broad.
  const good = storeFiles.get(leadRecFile())!
  storeFiles.delete(leadRecFile())
  storeFiles.set(`${LEADRECDIR}/${'c'.repeat(64)}.json`, good)
  expect(names(await loadLeadRecords(d.$$))).toEqual([`${APP2}:OTHER`])
  storeFiles.delete(`${LEADRECDIR}/${'c'.repeat(64)}.json`)
  for (const text of ['{', good.replace('"joined"', '"moved"'), good.replace(PIN, '/Users/x/code/../app'), JSON.stringify({ ...JSON.parse(good), creates: [] })]) {
    storeFiles.set(leadRecFile(), text)
    expect(names(await loadLeadRecords(d.$$))).toEqual([`${APP2}:OTHER`])
  }
  storeFiles.set(leadRecFile(), good)
  extraStat.delete(`${PIN}/.git`)
  expect(names(await loadLeadRecords(d.$$))).toEqual([`${APP2}:OTHER`])
  extraStat.set(`${PIN}/.git`, dirStat)
  storeFiles.set(leadRecFile(), good.replace(PIN, '/Users/x'))
  extraStat.set('/Users/x/.git', dirStat)
  expect(names(await loadLeadRecords(d.$$))).toEqual([`${APP2}:OTHER`])
  // A lane store is not a lead record, and a lead record is not a lane store: each folder lists its own files.
  storeFiles.set(leadRecFile(), good)
  storeFiles.set(STOREFILE, JSON.stringify({ repo: PIN, lanes: [], creates: [] }))
  expect(names(await loadLeadRecords(d.$$))).toEqual([`${PIN}:LEAD,SECOND`, `${APP2}:OTHER`])
  expect(storeLaneNames()).toEqual([])
})

test('lead records: a folder that is not there yet is no records; one that cannot be trusted or listed is a refusal code, never "no records"', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on)
  putLeadRecs([{}])
  statErr.set(LEADRECDIR, `stat: ${LEADRECDIR}: No such file or directory`)
  expect(await loadLeadRecords(d.$$)).toEqual([])
  expect(await loadLeadRecordsFor(d.$$, PIN)).toEqual([])
  statErr.set(LEADRECDIR, 'stat: timed out')
  expect(await loadLeadRecords(d.$$)).toBe('unsafe-dir')
  expect(await loadLeadRecordsFor(d.$$, PIN)).toBe('unsafe-dir')
  statErr.clear()
  extraStat.set(LEADRECDIR, '501 755 2 Directory 11 64 1700000000\n')
  expect(await loadLeadRecords(d.$$)).toBe('unsafe-dir')
  extraStat.delete(LEADRECDIR)
  d.knob.listThrows = true
  expect(await loadLeadRecords(d.$$)).toBe('store-unreadable')
  d.knob.listThrows = false
  expect(names(await loadLeadRecords(d.$$))).toEqual([`${PIN}:LEAD`])
})

test('lead records for one folder: only the files of the folder and of the folders above it are read', async ($, on) => {
  const argv: string[][] = []
  const d = direct(on)
  await leadAt($, d.on, [], { argv })
  putLeadRecs([{}])
  putLeadRecs([{ name: 'OTHER' }], APP2)
  argv.length = 0
  expect(names(await loadLeadRecordsFor(d.$$, `${PIN}/api/deep`))).toEqual([`${PIN}:LEAD`])
  expect(argv.some((a) => a.includes(leadRecFile(APP2)))).toBe(false)
  expect(names(await loadLeadRecordsFor(d.$$, APP2))).toEqual([`${APP2}:OTHER`])
  expect(await loadLeadRecordsFor(d.$$, COND)).toEqual([])
  expect(await loadLeadRecordsFor(d.$$, 'code/app')).toEqual([])
  expect(await loadLeadRecordsFor(d.$$, '/Users/x')).toEqual([])
})

test('a lead-record edit makes the file, hands the next edit the parsed store, and takes and frees the lock of its own folder', async ($, on) => {
  const argv: string[][] = []
  const d = direct(on)
  await leadAt($, d.on, [], { argv })
  h.lockKnobsDir = LEADRECDIR
  argv.length = 0
  const rec = { name: 'LEAD', createdAt: 5, how: 'joined' as const, conductorSid: OTHERLEAD, sid: SID }
  let seen: unknown = 'unset'
  const w = await editLeadRecs(d.$$, KEY, async (store) => {
    seen = store
    return { store: { repo: PIN, leads: [rec] } }
  })
  expect(seen).toBe(undefined)
  expect(w).toEqual({ text: JSON.stringify({ repo: PIN, leads: [rec] }) })
  expect(leadRecsJson()).toEqual({ repo: PIN, leads: [rec] })
  expect(lockLog).toEqual(LOCK_CYCLE)
  expect(recLocks.get(REC_LOCK)).toEqual({ held: false })
  expect(lanesLockTouched(argv)).toBe(false)
  expect(storeFiles.has(STOREFILE)).toBe(false)
  await editLeadRecs(d.$$, KEY, async (store) => {
    seen = store
    return { skip: true }
  })
  expect(seen).toEqual({ repo: PIN, leads: [rec] })
  expect(await editLeadRecs(d.$$, KEY, async () => ({ no: 'name-in-use' }))).toEqual({ no: 'name-in-use' })
  expect(leadRecsJson()).toEqual({ repo: PIN, leads: [rec] })
  expect(recLocks.get(REC_LOCK)).toEqual({ held: false })
})

test('a lead-record edit never overwrites a file it cannot read safely or parse, refuses a file too large to read back, and says when its write did not land', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on)
  putLeadRecs([{}])
  const before = storeFiles.get(leadRecFile())!
  let ran = false
  const add = async (store: LeadStore | undefined) => {
    ran = true
    return { store: { repo: PIN, leads: [...(store?.leads ?? []), { name: 'NEW', createdAt: 1, how: 'joined' as const, conductorSid: OTHERLEAD }] } }
  }
  h.storeStatOverride = '501 644 1 Regular File 77 50 1700000000\n'
  expect(await editLeadRecs(d.$$, KEY, add)).toEqual({ no: 'store-unreadable' })
  h.storeStatOverride = undefined
  storeFiles.set(leadRecFile(), before.replace('"joined"', '"moved"'))
  expect(await editLeadRecs(d.$$, KEY, add)).toEqual({ no: 'store-owner' })
  expect(ran).toBe(false)
  storeFiles.set(leadRecFile(), before)
  expect(await editLeadRecs(d.$$, KEY, async () => ({ store: { repo: `/${'r'.repeat(400)}`, leads: Array.from({ length: 200 }, (_, i) => ({ name: `L${i}`, createdAt: 1, how: 'joined' as const, conductorSid: OTHERLEAD })) } }))).toMatchObject({ no: 'store-size' })
  expect(storeFiles.get(leadRecFile())).toBe(before)
  h.leadRecWrites = 'fail'
  expect(await editLeadRecs(d.$$, KEY, add)).toEqual({ no: 'write-failed' })
  expect(storeFiles.get(leadRecFile())).toBe(before)
  h.leadRecWrites = 'ok'
  expect(await editLeadRecs(d.$$, KEY, add)).toMatchObject({ text: expect.stringContaining('"NEW"') })
  expect(leadRecsJson().leads.map((l) => l.name)).toEqual(['LEAD', 'NEW'])
})

test('a lead-record edit and a lane-store edit of one repo do not wait on each other: each lands while the other folder\'s lock is held', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on, [], { clock: true })
  const live = ownerText(4242, 'live-nonce-0001', LEADPS)
  // The lane store's lock is held by a live process: the record edit lands at once.
  h.lockState = { held: true, owner: live, mtimeSec: T0 / 1000 }
  expect(await editLeadRecs(d.$$, KEY, async () => ({ store: { repo: PIN, leads: [{ name: 'LEAD', createdAt: 1, how: 'joined', conductorSid: OTHERLEAD }] } }))).toMatchObject({ text: expect.any(String) })
  expect(h.lockState).toMatchObject({ held: true, owner: live })
  // The record's lock is held by a live process: lane_create lands at once.
  h.lockState = { held: false }
  recLocks.set(REC_LOCK, { held: true, owner: live, mtimeSec: T0 / 1000 })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(recLocks.get(REC_LOCK)).toMatchObject({ held: true, owner: live })
})

test('a held lead-record lock refuses store-busy after its wait, and a stale one is broken', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on, [], { clock: true })
  const edit = () => editLeadRecs(d.$$, KEY, async () => ({ store: { repo: PIN, leads: [] } }))
  recLocks.set(REC_LOCK, { held: true, owner: ownerText(4242, 'live-nonce-0001', LEADPS), mtimeSec: T0 / 1000 })
  const busy = edit()
  for (let i = 0; i < 12; i++) await h.clock!.advance(250)
  expect(await busy).toEqual({ no: 'store-busy' })
  expect(storeFiles.has(leadRecFile())).toBe(false)
  recLocks.set(REC_LOCK, { held: true, owner: ownerText(9999, 'dead-nonce-0001'), mtimeSec: T0 / 1000 })
  psDead.add('9999')
  const broke = edit()
  for (let i = 0; i < 4; i++) await h.clock!.advance(250)
  expect(await broke).toEqual({ text: JSON.stringify({ repo: PIN, leads: [] }) })
  expect(recLocks.get(REC_LOCK)).toEqual({ held: false })
  expect(h.lockState).toEqual({ held: false })
})

test('a lead-record release that could not be confirmed is retried against the lead-records folder, never the lane store\'s lock', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  const d = direct(on)
  await leadAt($, d.on, stdins, { clock: true, argv })
  h.lockKnobsDir = LEADRECDIR
  argv.length = 0
  lockOwnerReads.push(undefined, undefined)
  // The lane store's lock of the same repo is held by someone else meanwhile: an unlock aimed at the wrong folder would look at it.
  const theirs = ownerText(4242, 'their-nonce-0003', LEADPS)
  h.lockState = { held: true, owner: theirs, mtimeSec: T0 / 1000, ino: 14 }
  expect(await editLeadRecs(d.$$, KEY, async () => ({ store: { repo: PIN, leads: [] } }))).toMatchObject({ text: expect.any(String) })
  expect(recLocks.get(REC_LOCK)).toMatchObject({ held: true })
  expect(logged(stdins)).toContain('error:lock-unconfirmed')
  // The retry the tick makes (unlockRetry), called here: this file's copy of the mod's memory holds the owed release, not the running mod's.
  await unlockRetry(d.$$, SID)
  expect(recLocks.get(REC_LOCK)).toEqual({ held: false })
  expect(lockLog.slice(-2)).toEqual(['rm-owner', 'rmdir'])
  expect(h.lockState).toMatchObject({ held: true, owner: theirs })
  expect(lanesLockTouched(argv)).toBe(false)
  lockLog.length = 0
  await unlockRetry(d.$$, SID)
  expect(lockLog).toEqual([])
})

test('a binding is read from the lead\'s own key and counts only whole; a record is bound while its lead\'s binding names its repo, hash and conductor', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on)
  expect(await bindingOf(d.$$, SID)).toBe(undefined)
  ownedBy(OTHERLEAD)
  const rec = leadRecsJson().leads[0]
  const r = { key: KEY, repo: PIN, rec }
  expect(await bindingOf(d.$$, SID)).toEqual({ repo: PIN, rec: fakeSha(leadRecordText(PIN, rec)), conductorSid: OTHERLEAD, at: T0 })
  expect(await bindingOf(d.$$, OTHER)).toBe(undefined)
  expect(await boundTo(d.$$, r)).toBe(true)
  // The name, the parked time and the conductor's name are not in the hash: a renamed or parked record is still bound.
  expect(await boundTo(d.$$, { ...r, rec: { ...rec, name: 'RENAMED', parked: 5, conductorName: 'X' } })).toBe(true)
  expect(await boundTo(d.$$, { ...r, rec: { ...rec, conductorSid: OTHER } })).toBe(false)
  expect(await boundTo(d.$$, { ...r, rec: { ...rec, how: 'made' } })).toBe(false)
  expect(await boundTo(d.$$, { ...r, repo: APP2 })).toBe(false)
  expect(await boundTo(d.$$, { ...r, rec: { ...rec, sid: OTHER } })).toBe(false)
  // A record with no session (a force-stopped lead kept for its lanes) is bound only by the proof its force stop left: a record file alone, or a proof of
  // another name, conductor, repo or hash, is not.
  const kept = { ...r, rec: { ...rec, sid: undefined } }
  const hash = fakeSha(leadRecordText(PIN, rec))
  expect(await boundTo(d.$$, kept)).toBe(false)
  const proof = { repo: PIN, rec: hash, conductorSid: OTHERLEAD, at: T0, name: rec.name }
  h.store.set(keptKey(hash, rec.name), proof)
  expect(await boundTo(d.$$, kept)).toBe(true)
  expect(await boundTo(d.$$, { ...kept, rec: { ...kept.rec, name: 'FORGED' } })).toBe(false)
  for (const bad of [{ conductorSid: OTHER }, { repo: APP2 }, { rec: 'f'.repeat(64) }, { name: 'OTHERNAME' }]) {
    h.store.set(keptKey(hash, rec.name), { ...proof, ...bad })
    expect(await boundTo(d.$$, kept), JSON.stringify(bad)).toBe(false)
  }
  h.store.delete(keptKey(hash, rec.name))
  h.store.set(`owner:${SID}`, { ...(h.store.get(`owner:${SID}`) as object), rec: 'short' })
  expect(await bindingOf(d.$$, SID)).toBe(undefined)
  expect(await boundTo(d.$$, r)).toBe(false)
  h.store.delete(`owner:${SID}`)
  expect(await boundTo(d.$$, r)).toBe(false)
})

test('ownerLive gives the owner only when the record is found, its lead is bound to it, and its conductor is live and trusted for the repo', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on, [], { sess: WITH_COND(), seed: condSeed })
  const live = (await registryEntries(d.$$))!
  const owner = (leadName: string | undefined, o: { except?: string; folder?: string; leadSid?: string } = {}) => ownerLive(d.$$, live, o.except ?? SID, o.folder ?? PIN, leadName, undefined, o.leadSid)
  expect(await owner('LEAD')).toBe(undefined)
  ownedBy(OTHERLEAD)
  const rec = { key: KEY, repo: PIN, rec: leadRecsJson().leads[0] }
  expect(await owner('LEAD')).toEqual({ sid: OTHERLEAD, name: 'CONDX', rec })
  expect(await owner('LEAD', { folder: `${PIN}/api` })).toEqual({ sid: OTHERLEAD, name: 'CONDX', rec })
  // A lane that names no lead follows the repo's only record; a lead known only by its session is found by it; a lead with no name gets nothing.
  expect(await owner(undefined)).toMatchObject({ sid: OTHERLEAD })
  expect(await owner('ANOTHER-NAME', { leadSid: SID })).toMatchObject({ sid: OTHERLEAD })
  expect(await owner('')).toBe(undefined)
  expect(await owner('NOBODY')).toBe(undefined)
  expect(await owner('LEAD', { folder: APP2 })).toBe(undefined)
  // The owner asking about its own lead is not its own tier.
  expect(await owner('LEAD', { except: OTHERLEAD })).toBe(undefined)
  // Records the caller already loaded are used as they are.
  expect(await ownerLive(d.$$, live, SID, PIN, 'LEAD', [])).toBe(undefined)
  expect(await ownerLive(d.$$, live, SID, PIN, 'LEAD', [{ key: KEY, store: leadRecsJson() }])).toMatchObject({ sid: OTHERLEAD })
  // Records that cannot be read give no owner.
  statErr.set(LEADRECDIR, 'stat: timed out')
  expect(await owner('LEAD')).toBe(undefined)
  statErr.clear()
  // A record whose lead never bound to it, or left, routes nothing; a record with no session routes only with its force stop's proof: a forged one, written
  // straight into the records folder, gives its conductor no reach over the lanes that name it.
  const binding = h.store.get(`owner:${SID}`) as Record<string, unknown>
  h.store.delete(`owner:${SID}`)
  expect(await owner('LEAD')).toBe(undefined)
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD }])
  expect(await owner('LEAD')).toBe(undefined)
  h.store.set(keptKey(binding.rec as string, 'LEAD'), { ...binding, name: 'LEAD' })
  expect(await owner('LEAD')).toMatchObject({ sid: OTHERLEAD })
  putLeadRecs([{ name: 'FOO', conductorSid: OTHERLEAD }])
  expect(await owner('FOO')).toBe(undefined)
  // A record edited to another conductor no longer matches the binding.
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHER, sid: SID }])
  h.store.set(`owner:${SID}`, binding)
  expect(await owner('LEAD')).toBe(undefined)
  // The conductor must pass the lead's conductor checks: no saved grant, no owner.
  ownedBy(OTHERLEAD)
  expect(await owner('LEAD')).toMatchObject({ sid: OTHERLEAD })
  h.store.delete(`conductor:${OTHERLEAD}`)
  expect(await owner('LEAD')).toBe(undefined)
})

test('ownOwner: a lead\'s own owner from its binding; record-changed when its record is gone or names another conductor; a renamed record still matches', async ($, on) => {
  const d = direct(on)
  await leadAt($, d.on, [], { sess: WITH_COND(), seed: condSeed })
  const live = (await registryEntries(d.$$))!
  expect(await ownOwner(d.$$, SID, live)).toBe(undefined)
  ownedBy(OTHERLEAD)
  expect(await ownOwner(d.$$, SID, live)).toMatchObject({ sid: OTHERLEAD, name: 'CONDX', rec: { repo: PIN, rec: { name: 'LEAD', sid: SID } } })
  // The name is in neither the hash nor the binding.
  putLeadRecs([{ name: 'RENAMED', conductorSid: OTHERLEAD, sid: SID }])
  expect(await ownOwner(d.$$, SID, live)).toMatchObject({ sid: OTHERLEAD, rec: { rec: { name: 'RENAMED' } } })
  statErr.set(LEADRECDIR, 'stat: timed out')
  expect(await ownOwner(d.$$, SID, live)).toBe('store-unreadable')
  statErr.clear()
  putLeadRecs([{ name: 'RENAMED', conductorSid: OTHER, sid: SID }])
  expect(await ownOwner(d.$$, SID, live)).toBe('record-changed')
  // A record of the same name that names another session is not this lead's.
  putLeadRecs([{ name: 'LEAD', conductorSid: OTHERLEAD, sid: OTHER }])
  expect(await ownOwner(d.$$, SID, live)).toBe('record-changed')
  putLeadRecs([])
  expect(await ownOwner(d.$$, SID, live)).toBe('record-changed')
  // The owner is not live any more: no owner, and nothing changed.
  ownedBy(OTHERLEAD)
  expect(await ownOwner(d.$$, SID, live)).toMatchObject({ sid: OTHERLEAD })
  h.store.delete(`conductor:${OTHERLEAD}`)
  expect(await ownOwner(d.$$, SID, live)).toBe(undefined)
  bindOwner(SID, OTHERLEAD, 'LEAD')
  h.store.delete(`owner:${SID}`)
  expect(await ownOwner(d.$$, SID, live)).toBe(undefined)
})
