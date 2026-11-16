import { expect, test } from 'claude-code/testing'
import { helpText, LOG_KEEP_MS, LOG_PRUNE_MAX, LOG_MAX_BYTES, OFF_YES, OFF_NO, RESTORE_YES, RESTORE_NO, nudgeText, KEEPALIVE_TEXT, configText, configSetText, CONFIG_DEFAULTS, CONFIG_USAGE, CONFIG_NOT_PERSON, CONFIG_RESET_TEXT, OFF_NOTHING } from '../hooks/core'
import { h, GOOD, ROOT, SID, T0, YES, engine, extraStat, laneSeed, longTest } from './harness'
import { advanceQuiet, allEvents, events, killed, lane, LANES, lead, LEAD_LANES, leadCall, logged, MIN, newTrace, nudges, PERSON, person, pings, started, STATUS_NONE, ticks, TURN, USAGE, warm } from './fixtures'

test('/callboard on from any origin gets the usage line: no dialog, no state, no store write, no log line', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await started($, on, stdins, { trace })
  const writes = trace.log.length
  const keys = [...h.store.keys()].sort()
  const origins = [PERSON, { kind: 'bridge' }, { kind: 'plugin', name: 'x' }, { kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'sdk' }, null]
  for (const origin of origins) expect((await $.command.run(lane('on', origin))).text).toBe(USAGE)
  expect(h.askCount).toBe(0)
  expect(trace.log.slice(writes)).toEqual([])
  expect([...h.store.keys()].sort()).toEqual(keys)
  expect(allEvents(stdins)).toEqual([])
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('not enabled')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('the prompt box offers the /callboard words from the command table, after the engine\'s own rows, and only for a /callboard draft', async ($, on) => {
  // What the engine's own typeahead answers beneath the plugins: one row of its own, which must stay first.
  on('prompt.autocomplete', () => ({ suggestions: [{ text: 'engine-row' }] }))
  await started($, on, [])
  const ask = async (text: string) => {
    const start = text.lastIndexOf(' ') + 1
    return (await $.prompt.autocomplete({ text, cursor: text.length, token: text.slice(start), start })).suggestions.map((s: { text: string }) => s.text)
  }
  expect(await ask('/callboard co')).toEqual(['engine-row', 'conductor', 'config'])
  expect(await ask('/callboard checkin r')).toEqual(['engine-row', 'resume'])
  expect(await ask('/callboard config checkin o')).toEqual(['engine-row', 'on', 'off'])
  expect(await ask('/callboard checkin pause 3')).toEqual(['engine-row'])
  expect(await ask('/other co')).toEqual(['engine-row'])
})

test('each dialog offers its own exact button pair', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.askAnswer = YES
    h.restoreAnswer = YES
    await $.command.run(lane('lane'))
    expect(h.askedOptions).toEqual([[RESTORE_YES, RESTORE_NO]])
    h.askedOptions = []
    // The session is now a lane (restored): the lead question is not asked at all; its buttons are checked in the tests of that section.
    await $.command.run(lane('lead'))
    expect(h.askedOptions).toEqual([])
    h.askedOptions = []
    await $.command.run(lane('off', { kind: 'plugin', name: 'x' }))
    expect(h.askedOptions).toEqual([[OFF_YES, OFF_NO]])
  } finally {
    laneSeed.text = undefined
  }
})

test('status shows the lane and the lead only; off of a plain session says there was nothing to turn off', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect((await $.command.run(lane('on'))).text).toBe(USAGE)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('not enabled')
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  expect((await $.command.run(lane('maybe'))).text).toBe(USAGE)
})

test('session start deletes other sessions\' logs no one wrote to in 90 days, never its own, a young one, a link, a folder or a stray name', async ($, on) => {
  const argv: string[][] = []
  const sid = (d: string) => `${d.repeat(8)}-0000-4000-8000-123456789abc`
  const old = T0 - LOG_KEEP_MS - 1000
  engine(on, argv, [])
  h.logList = [
    { name: `${sid('5')}.jsonl`, kind: 'file', size: 9, mtimeMs: old, isLink: false },
    { name: `${SID}.jsonl`, kind: 'file', size: 9, mtimeMs: old, isLink: false },
    { name: `${sid('6')}.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - LOG_KEEP_MS + 60_000, isLink: false },
    { name: `${sid('7')}.jsonl`, kind: 'file', size: 9, mtimeMs: old, isLink: true },
    { name: `${sid('8')}.jsonl`, kind: 'dir', size: 9, mtimeMs: old, isLink: false },
    { name: 'notes.jsonl', kind: 'file', size: 9, mtimeMs: old, isLink: false },
    { name: '../x.jsonl', kind: 'file', size: 9, mtimeMs: old, isLink: false },
  ]
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const removed = argv.filter((a) => a[0] === '/bin/rm').map((a) => a[a.length - 1]).filter((x) => x.startsWith(`${ROOT}/log/`))
  expect(removed).toEqual([`${ROOT}/log/${sid('5')}.jsonl`])
})

test('session start looks at the oldest logs first, so a folder of more than 500 still loses its old ones', async ($, on) => {
  const argv: string[][] = []
  engine(on, argv, [])
  const young = Array.from({ length: 500 }, (_, i) => ({ name: `${String(i).padStart(8, '7')}-0000-4000-8000-123456789abc.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - 1000, isLink: false }))
  const old = { name: `${'4'.repeat(8)}-0000-4000-8000-123456789abc.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - LOG_KEEP_MS - 1000, isLink: false }
  h.logList = [...young, old]
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1].startsWith(`${ROOT}/log/`)).map((a) => a[a.length - 1])).toEqual([`${ROOT}/log/${old.name}`])
})

test('session start deletes at most LOG_PRUNE_MAX old logs', async ($, on) => {
  const argv: string[][] = []
  engine(on, argv, [])
  h.logList = Array.from({ length: LOG_PRUNE_MAX + 3 }, (_, i) => ({ name: `${String(i).padStart(8, '9')}-0000-4000-8000-123456789abc.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - LOG_KEEP_MS - 1000, isLink: false }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1].startsWith(`${ROOT}/log/`)).length).toBe(LOG_PRUNE_MAX)
})

test('a log past 1 MB stops taking refusals and errors, but the stop line before the signal is still written', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  extraStat.set(`${ROOT}/log/${SID}.jsonl`, `501 600 1 Regular File 77 ${LOG_MAX_BYTES + 1} 1700000000\n`)
  h.askAnswer = 'Cancel'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  h.askAnswer = 'Force stop'
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('pid-changed')
  expect(events(stdins).some((e) => e.event === 'refused')).toBe(false)
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  expect((await $.tool.call(leadCall('terminate'))).result).toContain('SIGTERM sent to process 4242')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('terminating:LABLANE')
  extraStat.delete(`${ROOT}/log/${SID}.jsonl`)
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  await $.tool.call(leadCall('terminate'))
  expect(events(stdins).some((e) => e.event === 'refused')).toBe(true)
})

test('config: /callboard config prints the settings from any origin and logs nothing', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  for (const origin of [PERSON, { kind: 'bridge' }, { kind: 'plugin' }, { kind: 'peer' }, { kind: 'script' }])
    expect((await $.command.run(lane('config', origin))).text).toBe(['**Callboard settings**', '', '| Setting | Value | Default |', '|---|---|---|', '| Keepalive | ON | ✓ |', '| Ping after | 50 min | ✓ |', '| Stop after | 2 h | ✓ |', '| Idle level | 300k | ✓ |', '| Working level | 400k | ✓ |', '| Check-ins | ON | ✓ |', '| Conductor leads | ON | ✓ |', '| Lanes per hour | 30 | ✓ |', '| Escalation | OFF | ON |'].join('\n'))
  expect(logged(stdins)).toEqual([])
  expect(h.store.has('config')).toBe(false)
  expect((await $.command.run(lane('bogus'))).text).toBe(USAGE)
})

test('/callboard help and a bare /callboard print the same command table; a word it does not know prints the short usage', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  const help = (await $.command.run(lane('help'))).text
  expect(help).toBe(helpText())
  expect(help.startsWith('**Callboard commands**\n\n| Command | What it does |\n|---|---|\n| lanes |')).toBe(true)
  expect((await $.command.run(lane(''))).text).toBe(help)
  expect((await $.command.run(lane('  help '))).text).toBe(help)
  for (const origin of [{ kind: 'plugin' }, { kind: 'peer' }, { kind: 'script' }, null]) expect((await $.command.run(lane('help', origin))).text).toBe(help)
  for (const word of ['help me', 'helps', 'bogus']) expect((await $.command.run(lane(word))).text).toBe(USAGE)
  expect(logged(stdins)).toEqual([])
})

test('config: the person sets each setting from the prompt or the phone; it is stored, logged and printed; it is never a lane command', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  let want = { ...CONFIG_DEFAULTS }
  for (const [args, field, value, origin] of [
    ['keepalive off', 'keepalive', false, PERSON],
    ['ping 30', 'pingAfterMin', 30, { kind: 'bridge' }],
    ['stop 8', 'stopAfterH', 8, PERSON],
    ['working 900', 'workingK', 900, PERSON],
    ['idle 800k', 'idleK', 800, PERSON],
    ['checkin off', 'checkin', false, PERSON],
    ['conductor-leads off', 'conductorLeads', false, PERSON],
    ['lanes 45', 'lanesPerHour', 45, PERSON],
  ] as const) {
    want = { ...want, [field]: value }
    expect((await $.command.run(lane(`config ${args}`, origin))).text).toBe(configSetText(field, want))
    expect(h.store.get('config')).toEqual({ ...want, savedAt: h.nowMs })
    expect(logged(stdins).at(-1)).toBe(`config-set:${field}:${origin === PERSON ? 'prompt' : 'phone'}`)
  }
  expect((await $.command.run(lane('config'))).text).toBe(configText(want, false))
  expect(logged(stdins).some((x) => x.startsWith('command:lane') || x.startsWith('command:config'))).toBe(false)
  expect((await $.command.run(lane('status'))).text).toContain('| Lane | NONE |')
  expect((await $.command.run(lane('config reset'))).text).toBe(CONFIG_RESET_TEXT)
  expect(h.store.get('config')).toEqual({ ...CONFIG_DEFAULTS, savedAt: h.nowMs })
  expect(logged(stdins).at(-1)).toBe('config-set:reset:prompt')
})

test('config: a change from a plugin, another session or a script is refused with a fixed text and no dialog; nothing is written (D3)', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  const asked = h.askCount
  for (const [origin, code] of [[{ kind: 'plugin' }, 'plugin'], [{ kind: 'peer' }, 'session'], [{ kind: 'script' }, 'other']] as const) {
    for (const args of ['config keepalive off', 'config ping 30', 'config conductor-leads off', 'config lanes 60', 'config reset']) expect((await $.command.run(lane(args, origin))).text).toBe(CONFIG_NOT_PERSON)
    expect(logged(stdins)).toContain(`refused:config-not-person:${code}`)
  }
  expect(h.askCount).toBe(asked)
  expect(h.store.has('config')).toBe(false)
})

test('config: out of range or unknown is refused with the usage; the two levels are checked against each other as stored', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  for (const args of ['config ping 29', 'config ping 56', 'config stop 9', 'config idle 149', 'config working 901', 'config lanes 0', 'config lanes 61', 'config ping 50 now', 'config loud on', 'config conductor-leads'])
    expect((await $.command.run(lane(args))).text).toBe(CONFIG_USAGE)
  expect(h.store.has('config')).toBe(false)
  expect((await $.command.run(lane('config idle 450'))).text).toBe('Raise working first (now 400k).')
  expect((await $.command.run(lane('config working 250'))).text).toBe('Lower idle first (now 300k).')
  expect(h.store.has('config')).toBe(false)
  // The check reads the stored levels, not this session's cache: another session raised working meanwhile.
  h.store.set('config', { workingK: 500, savedAt: h.nowMs })
  expect((await $.command.run(lane('config idle 450'))).text).toBe(configSetText('idleK', { ...CONFIG_DEFAULTS, idleK: 450, workingK: 500 }))
  expect(h.store.get('config')).toEqual({ ...CONFIG_DEFAULTS, idleK: 450, workingK: 500, savedAt: h.nowMs })
  expect(logged(stdins).filter((x) => x.startsWith('config-set'))).toEqual(['config-set:idleK:prompt'])
})

test('config: invalid stored fields fall back to their defaults, logged once per load', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.store.set('config', { keepalive: 'no', pingAfterMin: 99, stopAfterH: 4, idleK: 350, workingK: 450, path: '/etc/x', savedAt: 1 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(lane('config'))).text).toBe(['**Callboard settings**', '', '| Setting | Value | Default |', '|---|---|---|', '| Keepalive | ON | ✓ |', '| Ping after | 50 min | ✓ |', '| Stop after | 4 h | 2 h |', '| Idle level | 350k | 300k |', '| Working level | 450k | 400k |', '| Check-ins | ON | ✓ |', '| Conductor leads | ON | ✓ |', '| Lanes per hour | 30 | ✓ |', '| Escalation | OFF | ON |'].join('\n'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(logged(stdins).filter((x) => x.startsWith('config-invalid'))).toEqual(['config-invalid:keepalive', 'config-invalid:pingAfterMin'])
})

longTest('config: a change another session stored reaches this session within a minute', async ($, on) => {
  await warm($, on)
  await h.clock!.advance(MIN)
  h.store.set('config', { pingAfterMin: 30, savedAt: h.nowMs })
  await advanceQuiet(28 * MIN)
  expect(pings()).toEqual([])
  await h.clock!.advance(MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('config: the nudge uses the configured idle level, in the hook and in the tick, and prints it', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config idle 200'))
  h.tokensNow = 199_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  h.tokensNow = 210_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 200, workingK: 400 })])
  expect(nudges()[0]).toContain('Your context is past 200k tokens.')
})

test('config: a raised idle level records no nudge below it', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config idle 350'))
  h.tokensNow = 349_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-'))).toBe(false)
  h.tokensNow = 350_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 350, workingK: 400 })])
})

test('config: a working session gets the soft text at the idle level and the hard text at the configured working level', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config working 450'))
  h.agentsNow = [{ status: 'running' }]
  h.tokensNow = 410_000
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 })])
  expect(logged(stdins)).not.toContain('nudge-dropped:below-level')
  h.tokensNow = 450_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 }), nudgeText('working', { idleK: 300, workingK: 450 })])
  expect(nudges()[1]).toContain('Your context is past 450k tokens.')
})

test('config: a lead is nudged from the idle level with the soft text and at the configured working level with the hard one', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config working 450'))
  laneSeed.text = LEAD_LANES('/data/x/work')
  await $.command.run(lane('lead'))
  h.tokensNow = 299_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-'))).toBe(false)
  h.tokensNow = 449_999
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 })])
  h.tokensNow = 450_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 }), nudgeText('working', { idleK: 300, workingK: 450 })])
})
