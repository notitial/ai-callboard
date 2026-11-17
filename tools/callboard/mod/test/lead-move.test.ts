// A lead's saved grant whose folder moved (ADR 0002, Lead re-grant): the repo token in the repo's own .git, minted at a grant, and the restore that asks the
// person when the saved folder is gone and the session's folder holds the same token.
import { expect, test } from 'claude-code/testing'
import * as g from '../hooks/go'
import { HOUR_MS, REPO_ID_FILE, REPO_ID_PREFIX, leadMoveQuestion, leadMovedToast, notRestoredToast } from '../hooks/core'
import { h, NO, SID, T0, YES, GO_DIR, extraStat, fakeSha, gitFiles, longTest, pdirs, pfs, realFails, realMap, toasts } from './harness'
import { ledgerRows, putLedger } from './answer-fixtures'
import { LEADKEY, PIN, dirStat, lane, leadSelfReg, logged, started, statusText, ticks, waitFor } from './fixtures'

const OLD = '/Users/x/old/app'
const NEW = '/Users/x/new/app'
const ID = '0000beef-0000-4000-8000-123456789abc'
const tokenAt = (repo: string) => `${repo}/.git/${REPO_ID_FILE}`
const GONE = { n: 1_000_000, err: 'realpath: x: No such file or directory' }
const goKinds = () => ledgerRows().filter((r) => String(r.kind).startsWith('go-')).map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
const movedRows = () => ledgerRows().filter((r) => r.kind === 'lead-moved')
const restoreLogs = (stdins: string[]) => logged(stdins).filter((x) => x.startsWith('lead-restore') || x.startsWith('lead-restored') || x.startsWith('lead-repo-id'))

// A go this session gave as lead of OLD: its file and its go-grant row.
function putGo(): g.Go {
  const go: g.Go = { v: 1, id: '9d1b2c3d-0000-4000-8000-123456789abc', by: { level: 'lead', sid: SID, name: 'LEAD', repo: OLD }, at: T0 - 60_000, ends: T0 + 24 * HOUR_MS, text: 'Build the API.', covered: [], nonce: '0'.repeat(32) }
  const body = g.goFileText(go)
  pdirs.add(GO_DIR)
  pfs.set(`${GO_DIR}/${go.id}.json`, { text: body, mtimeSec: go.at / 1000 })
  putLedger([{ t: new Date(go.at).toISOString(), kind: 'go-grant', id: go.id, by: SID, tier: 'lead', hash: fakeSha(body), end: new Date(go.ends).toISOString(), repo: OLD }])
  return go
}

// A session that starts in NEW with a saved lead grant for OLD carrying the token ID: OLD is gone, NEW is a git root whose .git holds that token, and the mod
// minted it. o.seed changes any part of that world before the start.
async function mover($: any, on: any, stdins: string[], o: { hint?: Record<string, unknown>; seed?: () => void; answer?: string } = {}) {
  h.sessions = leadSelfReg({ cwd: NEW })
  await started($, on, stdins, {
    clock: true,
    seed: () => {
      h.repoIdFs = true
      h.callerCwd = NEW
      extraStat.set(`${NEW}/.git`, dirStat)
      realFails.set(OLD, { ...GONE })
      pfs.set(tokenAt(NEW), { text: `${ID}\n`, mtimeSec: T0 / 1000 })
      h.store.set(`${REPO_ID_PREFIX}${ID}`, { at: T0 - HOUR_MS })
      h.store.set(LEADKEY, { pin: OLD, savedAt: T0 - 60_000, repoId: ID, ...o.hint })
      h.askAnswer = o.answer ?? YES
      o.seed?.()
    },
  })
  h.askAnswer = o.answer ?? YES
}

longTest('a moved folder with the saved token: the person is asked in the lead dialog; Lead makes it lead there, writes one lead-moved row, ends the goes, re-briefs and saves the new pin', async ($, on) => {
  const stdins: string[] = []
  const go = await (async () => {
    let made: g.Go | undefined
    await mover($, on, stdins, { seed: () => (made = putGo()) })
    return made!
  })()
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  expect(h.lastQuestion).toBe(leadMoveQuestion(OLD, NEW))
  expect(h.askedOptions.at(-1)).toEqual(['Lead', 'Cancel'])
  await waitFor(() => toasts.includes(leadMovedToast(OLD, NEW)))
  expect(await statusText($)).toContain('| Lead | ON |')
  expect(movedRows()).toEqual([expect.objectContaining({ kind: 'lead-moved', by: SID, repo: NEW, was: OLD })])
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(ledgerRows().filter((r) => r.kind === 'go-end')).toEqual([expect.objectContaining({ id: go.id, code: 'grantor-off', by: SID })])
  expect(h.appendRows.length).toBe(1)
  expect(JSON.stringify(h.appendRows[0])).toContain(NEW.split('/').pop()!)
  expect(h.store.get(LEADKEY)).toMatchObject({ pin: NEW, repoId: ID })
  expect(restoreLogs(stdins)).toContain('lead-restored:moved')
  await ticks(3)
  expect(h.askCount).toBe(1)
  expect(movedRows().length).toBe(1)
})

test('a moved folder keeps the session\'s /callboard here', async ($, on) => {
  const here = { v: 1, sid: SID, at: T0 - 1000, until: T0 + 3_600_000 }
  await mover($, on, [], { seed: () => h.store.set('relay-here', here) })
  await ticks(3)
  await waitFor(() => toasts.includes(leadMovedToast(OLD, NEW)))
  expect(h.store.get('relay-here')).toEqual(here)
})

test('Cancel on the moved-folder question is the person\'s no: no lead, the saved grant goes, its goes end, no lead-moved row', async ($, on) => {
  const stdins: string[] = []
  await mover($, on, stdins, { answer: NO, seed: () => putGo() })
  await ticks(3)
  await waitFor(() => restoreLogs(stdins).includes('lead-restore-rejected:move-cancelled'))
  expect(await statusText($)).toContain('| Lead | OFF |')
  expect(h.store.has(LEADKEY)).toBe(false)
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  expect(movedRows()).toEqual([])
})

test('no answer to the moved-folder question: no lead, the saved grant stays and its goes end, the toast says it is asked again at the next start', async ($, on) => {
  const stdins: string[] = []
  await mover($, on, stdins, { answer: 'Something else', seed: () => putGo() })
  await ticks(3)
  await waitFor(() => toasts.includes(notRestoredToast('lead', 'move-unanswered', OLD)))
  expect(await statusText($)).toContain('| Lead | OFF |')
  expect(h.store.get(LEADKEY)).toMatchObject({ pin: OLD, repoId: ID })
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  await ticks(3)
  expect(h.askCount).toBe(1)
})

test('a failure after the click (the tools never register): the question ends with a toast and is not asked again; the saved grant stays, its goes end', async ($, on) => {
  const stdins: string[] = []
  await mover($, on, stdins, { seed: () => putGo() })
  h.registerGate = new Promise<void>(() => undefined)
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  await h.clock!.advance(31_000)
  await waitFor(() => toasts.includes(notRestoredToast('lead', 'grant-failed', OLD)))
  expect(restoreLogs(stdins)).toContain('lead-restore-rejected:grant-failed')
  expect(h.store.get(LEADKEY)).toMatchObject({ pin: OLD })
  await waitFor(() => goKinds().includes('go-end grantor-off'))
  await ticks(4)
  expect(h.askCount).toBe(1)
})

test('a check that fails after the click (the token gone meanwhile): no lead, no lead-moved row, the saved grant stays', async ($, on) => {
  const stdins: string[] = []
  let release: (a: string) => void = () => undefined
  await mover($, on, stdins, { seed: () => (h.askHang = new Promise<string>((r) => (release = r))) })
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  pfs.delete(tokenAt(NEW))
  release(YES)
  await waitFor(() => toasts.includes(notRestoredToast('lead', 'move-changed', OLD)))
  expect(await statusText($)).toContain('| Lead | OFF |')
  expect(movedRows()).toEqual([])
  expect(h.store.get(LEADKEY)).toMatchObject({ pin: OLD })
})

test('a lead-moved row that cannot be written: no lead, the saved grant stays', async ($, on) => {
  const stdins: string[] = []
  await mover($, on, stdins, { seed: () => (h.pfsFails = (a: string[]) => a[0] === '/usr/bin/tee' && a.some((x) => /\/ledger-\d{4}-\d{2}\.jsonl$/.test(x))) })
  await ticks(3)
  await waitFor(() => restoreLogs(stdins).includes('lead-restore-rejected:ledger-write'))
  expect(await statusText($)).toContain('| Lead | OFF |')
  expect(h.store.get(LEADKEY)).toMatchObject({ pin: OLD })
})

test('an old folder left as a link to the new one is gone too: the person is asked', async ($, on) => {
  await mover($, on, [], {
    seed: () => {
      realFails.delete(OLD)
      realMap.set(OLD, NEW)
    },
  })
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  expect(h.lastQuestion).toBe(leadMoveQuestion(OLD, NEW))
})

test('an old folder that cannot be read is tried again from the tick; once it reads as gone, the person is asked', async ($, on) => {
  await mover($, on, [], { seed: () => realFails.set(OLD, { n: 4, err: 'realpath: x: Permission denied' }) })
  expect(h.askCount).toBe(0)
  expect(h.store.has(LEADKEY)).toBe(true)
  realFails.set(OLD, { ...GONE })
  await ticks(4)
  await waitFor(() => h.askCount === 1)
})

test('a lead the person turns on while the moved-folder question waits: the question is never asked, the new lead stays, the old folder\'s goes end', async ($, on) => {
  await mover($, on, [], { seed: () => putGo() })
  await $.command.run(lane('lead'))
  expect(await statusText($)).toContain('| Lead | ON |')
  const asked = h.askCount
  await ticks(4)
  expect(h.askCount).toBe(asked)
  expect(h.lastQuestion).not.toBe(leadMoveQuestion(OLD, NEW))
  expect(await statusText($)).toContain('| Lead | ON |')
  expect(h.store.get(LEADKEY)).toMatchObject({ pin: NEW })
  expect(movedRows()).toEqual([])
  await waitFor(() => goKinds().includes('go-end grantor-off'))
})

// Each of these is a definite no: no question, the saved grant goes with its goes, and the toast is today's for another folder.
for (const [name, seed, code] of [
  ['a saved grant with no token', () => h.store.set(LEADKEY, { pin: OLD, savedAt: T0 - 60_000 }), 'wrong-folder'],
  ['an old folder that is still there', () => realFails.delete(OLD), 'move-old-there'],
  ['another token in the folder', () => pfs.set(tokenAt(NEW), { text: '0000cafe-0000-4000-8000-123456789abc\n', mtimeSec: T0 / 1000 }), 'move-token'],
  ['no token in the folder (a clone)', () => pfs.delete(tokenAt(NEW)), 'move-token'],
  ['a token the mod never minted (an archive)', () => h.store.delete(`${REPO_ID_PREFIX}${ID}`), 'move-token'],
  ['a token file others can read', () => pfs.set(tokenAt(NEW), { text: `${ID}\n`, mtimeSec: T0 / 1000, mode: '644' }), 'move-token'],
  ['a token file with a second link', () => pfs.set(tokenAt(NEW), { text: `${ID}\n`, mtimeSec: T0 / 1000, nlink: 2 }), 'move-token'],
  ['a worktree (.git a file)', () => {
    extraStat.set(`${NEW}/.git`, '501 644 1 Regular File 9 40 1700000000\n')
    gitFiles.set(`${NEW}/.git`, 'gitdir: /Users/x/old/app/.git/worktrees/app\n')
  }, 'move-no-git'],
  ['a .git folder its group can write', () => extraStat.set(`${NEW}/.git`, '501 775 8 Directory 6 256 1700000000\n'), 'move-no-git'],
  ['a folder whose real path is another (a linked parent)', () => realMap.set(NEW, '/Users/x/elsewhere/app'), 'move-pin'],
  ['a broad folder', () => {
    h.callerCwd = '/Users/x/Documents'
    h.sessions = leadSelfReg({ cwd: '/Users/x/Documents' })
  }, 'move-pin'],
] as const) {
  test(`no question for ${name}: refused ${code}, the saved grant and its goes end`, async ($, on) => {
    const stdins: string[] = []
    await mover($, on, stdins, {
      seed: () => {
        putGo()
        seed()
      },
    })
    await ticks(2)
    expect(h.askCount).toBe(0)
    expect(restoreLogs(stdins)).toContain(`lead-restore-rejected:${code}`)
    expect(h.store.has(LEADKEY)).toBe(false)
    await waitFor(() => goKinds().includes('go-end grantor-off'))
    expect(toasts.some((t) => t.startsWith('Lead not restored: the session started in another folder'))).toBe(true)
  })
}

// ---- the token at a grant ----
async function granter($: any, on: any, stdins: string[], seed?: () => void) {
  h.sessions = leadSelfReg()
  await started($, on, stdins, {
    clock: true,
    seed: () => {
      h.repoIdFs = true
      h.callerCwd = PIN
      extraStat.set(`${PIN}/.git`, dirStat)
      seed?.()
    },
  })
  h.askAnswer = YES
}
const mintedIds = () => [...h.store.keys()].filter((k) => k.startsWith(REPO_ID_PREFIX))

test('a lead grant in a repo with no token mints one: the file, the mark and the saved grant carry the same id; a second grant reuses it', async ($, on) => {
  await granter($, on, [])
  await $.command.run(lane('lead'))
  await waitFor(() => (h.store.get(LEADKEY) as { repoId?: string } | undefined)?.repoId !== undefined)
  const id = (h.store.get(LEADKEY) as { repoId: string }).repoId
  expect(pfs.get(tokenAt(PIN))?.text).toBe(`${id}\n`)
  expect(mintedIds()).toEqual([`${REPO_ID_PREFIX}${id}`])
  expect([...pfs.keys()].filter((k) => k.includes('.callboard-repo-id.'))).toEqual([])
  await $.command.run(lane('off'))
  await $.command.run(lane('lead'))
  await waitFor(() => (h.store.get(LEADKEY) as { repoId?: string } | undefined)?.repoId === id)
  expect(mintedIds()).toEqual([`${REPO_ID_PREFIX}${id}`])
})

test('a lead grant in a repo whose token the mod never minted saves none and leaves the file as it is', async ($, on) => {
  const stdins: string[] = []
  const foreign = '0000cafe-0000-4000-8000-123456789abc'
  await granter($, on, stdins, () => pfs.set(tokenAt(PIN), { text: `${foreign}\n`, mtimeSec: T0 / 1000 }))
  await $.command.run(lane('lead'))
  await waitFor(() => logged(stdins).includes('lead-repo-id:foreign'))
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  expect(pfs.get(tokenAt(PIN))?.text).toBe(`${foreign}\n`)
  expect(mintedIds()).toEqual([])
})

test('a lead grant in a repo whose token file is not a private one saves none and never replaces it', async ($, on) => {
  const stdins: string[] = []
  await granter($, on, stdins, () => pfs.set(tokenAt(PIN), { text: `${ID}\n`, mtimeSec: T0 / 1000, mode: '644' }))
  await $.command.run(lane('lead'))
  await waitFor(() => logged(stdins).includes('lead-repo-id:bad'))
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  expect(pfs.get(tokenAt(PIN))).toMatchObject({ text: `${ID}\n`, mode: '644' })
})

test('a lead grant in a worktree writes no token and saves none', async ($, on) => {
  await granter($, on, [], () => {
    extraStat.set(`${PIN}/.git`, '501 644 1 Regular File 9 40 1700000000\n')
    gitFiles.set(`${PIN}/.git`, 'gitdir: /Users/x/code/main/.git/worktrees/app\n')
  })
  await $.command.run(lane('lead'))
  expect(await statusText($)).toContain('| Lead | ON |')
  await ticks(2)
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  expect(pfs.has(tokenAt(PIN))).toBe(false)
  expect(mintedIds()).toEqual([])
})

test('a restore in its own folder keeps the saved token and saves it again with the grant', async ($, on) => {
  await granter($, on, [], () => {
    pfs.set(tokenAt(PIN), { text: `${ID}\n`, mtimeSec: T0 / 1000 })
    h.store.set(`${REPO_ID_PREFIX}${ID}`, { at: T0 - HOUR_MS })
    h.store.set(LEADKEY, { pin: PIN, savedAt: T0 - 60_000, repoId: ID })
  })
  expect(await statusText($)).toContain('| Lead | ON |')
  expect(h.askCount).toBe(0)
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0, repoId: ID })
})

test('a mint whose link fails leaves no token, no temporary file and no mark, and saves the grant with none', async ($, on) => {
  await granter($, on, [], () => (h.pfsFails = (a: string[]) => a[0] === '/bin/ln'))
  await $.command.run(lane('lead'))
  expect(await statusText($)).toContain('| Lead | ON |')
  await ticks(2)
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  expect(pfs.has(tokenAt(PIN))).toBe(false)
  expect([...pfs.keys()].filter((k) => k.includes('.callboard-repo-id.'))).toEqual([])
  expect(mintedIds()).toEqual([])
})

test('a mint that loses the race to another lead\'s token still being written is no answer yet: nothing logged as bad, its own mark gone', async ($, on) => {
  const stdins: string[] = []
  const other = '0000cafe-0000-4000-8000-123456789abc'
  await granter($, on, stdins, () => {
    h.pfsFails = (a: string[]) => {
      if (a[0] === '/bin/ln' && !pfs.has(tokenAt(PIN))) pfs.set(tokenAt(PIN), { text: `${other}\n`, mtimeSec: T0 / 1000, nlink: 2 })
      return false
    }
  })
  await $.command.run(lane('lead'))
  expect(await statusText($)).toContain('| Lead | ON |')
  await ticks(2)
  expect(logged(stdins)).not.toContain('lead-repo-id:bad')
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  expect(pfs.get(tokenAt(PIN))?.text).toBe(`${other}\n`)
  expect(mintedIds()).toEqual([])
})

test('a record with no token gains one at its next restore in its own folder', async ($, on) => {
  await granter($, on, [], () => h.store.set(LEADKEY, { pin: PIN, savedAt: T0 - 60_000 }))
  expect(await statusText($)).toContain('| Lead | ON |')
  await waitFor(() => (h.store.get(LEADKEY) as { repoId?: string } | undefined)?.repoId !== undefined)
  const id = (h.store.get(LEADKEY) as { repoId: string }).repoId
  expect(pfs.get(tokenAt(PIN))?.text).toBe(`${id}\n`)
  expect(h.store.has(`${REPO_ID_PREFIX}${id}`)).toBe(true)
})
