import { expect } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { h, T0, extraStat, laneSeed, longTest, pfs } from './harness'
import { LEADKEY, PIN, dirStat, leadSelfReg, started } from './fixtures'
import { OFF_FILE, PRQ, addMgrT, askCheck, byMgr, decideBy, hookRows, putWindow, reqFiles, rowKinds, startReq, waitingRow } from './answer-fixtures'

// ---- ADR 0011: an ask raised while the lead's saved grant is still being restored holds for it ----
// A session that starts with a saved lead grant for its own folder, the first try failing (the session list cannot be read yet), so the restore stays pending and
// the tick tries again. The manager is the tier above a lead. The test clock is the mock clock: the hook's waits end as the test advances it.
async function pendingLead($: any, on: any, opts: { scope?: string } = {}) {
  h.extraRows = {}
  h.prVerdict = { decision: 'ask', rule: 'Bash(ssh:*)' }
  h.prBeneath = undefined
  h.prBeneathCalls = 0
  h.prSetup = true
  for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionDenied'] as const) on(ev, () => ({}))
  on('tool.check', () => (h.prSetup ? { decision: 'allow' } : h.prVerdict))
  on('classic.PermissionRequest', () => ({}))
  laneSeed.text = undefined
  h.sessions = leadSelfReg()
  await started($, on, [], {
    clock: true,
    seed: () => {
      extraStat.set(`${PIN}/.git`, dirStat)
      h.callerCwd = PIN
      h.store.set(LEADKEY, { pin: PIN, savedAt: T0 - 60_000 })
      h.sessionsUnsafe = true
    },
  })
  h.prSetup = false
  h.store.set('answering', { scope: opts.scope ?? 'all', asks: false, savedAt: T0 })
  addMgrT()
}
// The ask, then the clock in 2 s steps (the restore ticks and the hook's polls) until the hook has answered; `act` runs after each step with the time since the ask.
async function ask($: any, act: (rel: number) => void | Promise<void> = () => undefined, maxMs = 200_000) {
  await askCheck($)
  h.sessions = waitingRow(T0 + 500)
  let result: unknown
  let done = false
  const p = startReq($).then((v: unknown) => {
    result = v
    done = true
  })
  const t0 = h.nowMs
  for (let rel = 0; !done && rel < maxMs; rel += 2000) {
    await h.clock!.advance(2000)
    await act(rel + 2000)
  }
  await p
  return { result, took: h.nowMs - t0 }
}
const landRestore = (rel: number) => {
  if (rel === 6000) h.sessionsUnsafe = false
}

longTest('restore: an ask raised while the lead grant is being restored waits for it, then rises as a lead\'s ask and is answered: no no-check row, no pass to the panel', async ($, on) => {
  await pendingLead($, on)
  let decided = false
  const { result } = await ask($, (rel) => {
    landRestore(rel)
    if (!decided && reqFiles().length > 0) {
      decided = true
      decideBy(byMgr)
    }
  })
  expect(result).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
  expect(hookRows()[0].tier).toBe('manager')
})

longTest('restore: a restore that ends (its 15 tries run out) ends the hold with one not-judgeable lead-restore row, and the dialog stays the person\'s', async ($, on) => {
  await pendingLead($, on)
  const { result, took } = await ask($)
  expect(result).toEqual({})
  expect(rowKinds()).toEqual(['not-judgeable lead-restore'])
  expect(took).toBeGreaterThan(20_000)
  expect(took).toBeLessThan(prm.RESTORE_HOLD_MS)
  expect(reqFiles().length).toBe(0)
})

longTest('restore: the person\'s click during the hold ends it with no row and no request', async ($, on) => {
  await pendingLead($, on)
  const { result, took } = await ask($, async (rel) => {
    if (rel === 10_000) await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: PRQ, tool_use_id: 'tu1', tool_response: {} } as any)
  })
  expect(result).toEqual({})
  expect(rowKinds()).toEqual([])
  expect(took).toBeLessThanOrEqual(14_000)
  expect(reqFiles().length).toBe(0)
})

longTest('restore: the OFF file during the hold ends it with no row', async ($, on) => {
  await pendingLead($, on)
  const { result, took } = await ask($, (rel) => {
    if (rel === 10_000) pfs.set(OFF_FILE, { text: '', mtimeSec: h.nowMs / 1000 })
  })
  expect(result).toEqual({})
  expect(rowKinds()).toEqual([])
  expect(took).toBeLessThanOrEqual(14_000)
})

longTest('restore: inside a held unattended window nobody is there: at the end of the hold the ask is denied as a lead\'s own prompt with nobody above it, with its one row', async ($, on) => {
  await pendingLead($, on)
  putWindow()
  const { result } = await ask($, () => undefined, prm.RESTORE_HOLD_MS)
  expect(result).toEqual({ decision: { behavior: 'deny', message: prm.TIER_PROMPT_DENY } })
  expect(rowKinds().filter((k) => k !== 'unattended-on')).toEqual(['abandoned no-tier'])
})

longTest('restore: a switch scoped to one lane never holds a pending lead\'s ask', async ($, on) => {
  await pendingLead($, on, { scope: 'svc-other' })
  const { result, took } = await ask($, () => undefined, 10_000)
  expect(result).toEqual({})
  expect(rowKinds()).toEqual([])
  expect(took).toBeLessThanOrEqual(4000)
})

const Q = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'a', description: 'x' }, { label: 'b', description: 'y' }], multiSelect: false }] }
longTest('restore: a pending lead\'s own question is not held: it stays the person\'s, in the lead\'s panel', async ($, on) => {
  await pendingLead($, on)
  expect(await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: Q } as any)).toEqual({})
  expect(rowKinds()).toEqual([])
})

longTest('restore: a pending lead\'s own question inside a held unattended window is denied at once', async ($, on) => {
  await pendingLead($, on)
  putWindow()
  expect(await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: Q } as any)).toEqual({ decision: { behavior: 'deny', message: prm.TIER_QUESTION_DENY } })
  expect(rowKinds().filter((k) => k !== 'unattended-on')).toEqual([])
})

longTest('restore: an ask with no tool.check entry (nothing to judge) is not held and leaves no row', async ($, on) => {
  await pendingLead($, on)
  h.sessions = waitingRow(T0 + 500)
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual([])
  expect(h.nowMs - T0).toBeLessThanOrEqual(4000)
})
