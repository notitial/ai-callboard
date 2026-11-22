import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_DEFAULTS, configNext, originOk, parseCommand, parseConfig, parsePreset, planCommand } from './commands.ts'
import type { Cmd, Origin } from './commands.ts'
import { NOW } from '../../test/gen.ts'

test('every form parses to its command', () => {
  const cases: [string, Cmd][] = [
    ['status', { op: 'status' }], ['  lanes ', { op: 'lanes' }], ['help', { op: 'help' }], ['off', { op: 'off' }], ['on', { op: 'on' }], ['rest', { op: 'rest' }], ['lead off', { op: 'lead-off' }], ['lead', { op: 'lead', paths: [] }],
    ['lead /Users/x/a ~/b', { op: 'lead', paths: ['/Users/x/a', '~/b'] }], ['go ship the thing', { op: 'go', text: 'ship the thing' }], ['go off', { op: 'go-off' }], ['go off abc', { op: 'go-off', id: 'abc' }],
    ['unattended', { op: 'unattended', span: { op: 'state' } }], ['unattended off', { op: 'unattended', span: { op: 'off' } }], ['unattended 2h', { op: 'unattended', span: { op: 'on', end: NOW + 2 * 3_600_000 } }],
    ['config', { op: 'config', config: 'show' }], ['config reset', { op: 'config', config: 'reset' }], ['config keepalive off', { op: 'config', config: { key: 'keepalive', value: false } }],
    ['config ping 45', { op: 'config', config: { key: 'pingAfterMin', value: 45 } }], ['config idle 250k', { op: 'config', config: { key: 'idleK', value: 250 } }], ['config working 500', { op: 'config', config: { key: 'workingK', value: 500 } }],
  ]
  for (const [args, cmd] of cases) assert.deepEqual(parseCommand(args, NOW), cmd, args)
})

test('a form that does not fit is bad; a window length that does not fit says so', () => {
  for (const a of ['', 'bogus', 'status now', 'on 1', 'lead rel/path', 'lead /a\u0007b', 'go', 'go Off', 'go OFF now', 'go off all goes', 'config ping', 'config ping 10', 'config ping 56', 'config stop 3k', 'config idle 100', 'config keepalive maybe', 'config __proto__ 5', 'config constructor 5', 'config toString 5', 'unattended soon'])
    assert.deepEqual(parseCommand(a, NOW), { op: 'bad' }, a)
  assert.deepEqual(parseCommand('unattended 10m', NOW), { op: 'bad', detail: 'short' })
  assert.deepEqual(parseCommand('unattended 20h', NOW), { op: 'bad', detail: 'long' })
})

// The origin rule: for every form, from the person's own typed turn and from anything else.
const FORMS: [string, boolean][] = [
  ['status', true], ['lanes', true], ['help', true], ['rest', true], ['config', true], ['unattended', true],
  ['off', false], ['on', false], ['lead /Users/x/a', false], ['lead off', false], ['go do the thing', false], ['go off', false], ['unattended 2h', false], ['unattended off', false],
  ['config reset', false], ['config keepalive on', false], ['config ping 40', false], ['handover', false],
]
test('origin: only the read-only forms and rest run from anywhere; every other form needs exactly the typed turn', () => {
  for (const [args, open] of FORMS) {
    const cmd = parseCommand(args, NOW) as Cmd
    assert.equal(originOk(cmd, 'typed'), true, `${args} typed`)
    for (const other of ['other', 'agent', 'mod', 'hook', 'Typed', 'typed ', '', undefined, null, 1, {}] as unknown[]) assert.equal(originOk(cmd, other as Origin), open, `${args} from ${String(other)}`)
  }
})

test('planCommand: runs, or refuses with the usage line, a bad window length or a bad origin', () => {
  assert.deepEqual(planCommand('off', 'typed', NOW), { act: 'run', cmd: { op: 'off' } })
  assert.deepEqual(planCommand('off', 'other', NOW), { act: 'refuse', msg: 'refuse.bad-origin', p: { tool: 'callboard', target: 'off' } })
  assert.deepEqual(planCommand('go ship it', 'other', NOW).msg, 'refuse.bad-origin')
  assert.deepEqual(planCommand('bogus', 'typed', NOW), { act: 'refuse', msg: 'cmd.usage', p: {} })
  assert.deepEqual(planCommand('unattended 5m', 'typed', NOW), { act: 'refuse', msg: 'refuse.bad-input', p: { tool: 'callboard', target: 'unattended', detail: 'short' } })
  // A malformed form is the usage line whatever the origin: nothing is judged before it parses.
  assert.equal(planCommand('bogus', 'other', NOW).msg, 'cmd.usage')
  assert.equal(planCommand('status', 'other', NOW).act, 'run')
})

test('the settings file: a field is read only with its type and inside its range; a bad pair gives both defaults', () => {
  assert.deepEqual(parseConfig(undefined), CONFIG_DEFAULTS)
  assert.deepEqual(parseConfig('x'), CONFIG_DEFAULTS)
  assert.deepEqual(parseConfig({ keepalive: false, pingAfterMin: 40, stopAfterH: 4, idleK: 200, workingK: 600 }), { keepalive: false, pingAfterMin: 40, stopAfterH: 4, idleK: 200, workingK: 600 })
  assert.deepEqual(parseConfig({ keepalive: 'no', pingAfterMin: 29, stopAfterH: 8.5, idleK: '200', workingK: 901 }), CONFIG_DEFAULTS)
  assert.deepEqual(parseConfig({ idleK: 700, workingK: 200 }), CONFIG_DEFAULTS)
})

test('a change that puts the idle level over the working level is refused', () => {
  assert.equal(configNext(CONFIG_DEFAULTS, { key: 'idleK', value: 450 }), undefined)
  assert.equal(configNext(CONFIG_DEFAULTS, { key: 'workingK', value: 250 }), undefined)
  assert.deepEqual(configNext(CONFIG_DEFAULTS, { key: 'idleK', value: 400 }), { ...CONFIG_DEFAULTS, idleK: 400 })
  assert.deepEqual(configNext({ ...CONFIG_DEFAULTS, idleK: 150 }, 'reset'), CONFIG_DEFAULTS)
})

test('a lead preset file: all four fields right, else no preset; callboard\'s own commands and a command that is not a plain word are refused', () => {
  const ok = { command: 'sentinel', name: 'SENTINEL', model: 'sonnet', effort: 'high' }
  assert.deepEqual(parsePreset(JSON.stringify({ ...ok, extra: 1 })), ok)
  assert.deepEqual(parsePreset(JSON.stringify({ ...ok, command: 'my-lead2', model: 'fable', effort: 'max' })), { ...ok, command: 'my-lead2', model: 'fable', effort: 'max' })
  const bad: unknown[] = [undefined, '', '{', 'null', '3', '[]', '"x"', {}, ...(['command', 'name', 'model', 'effort'] as const).map((k) => ({ ...ok, [k]: undefined })),
    { ...ok, command: 'callboard' }, { ...ok, command: 'rest' }, { ...ok, command: 'unattended' }, { ...ok, command: 'Sentinel' }, { ...ok, command: '/sentinel' }, { ...ok, command: '1a' }, { ...ok, command: 'a'.repeat(25) },
    { ...ok, name: 'two words' }, { ...ok, name: '' }, { ...ok, name: 'x'.repeat(41) }, { ...ok, model: 'gpt' }, { ...ok, effort: 'extreme' }, { ...ok, model: 3 }]
  for (const b of bad) assert.equal(parsePreset(typeof b === 'string' || b === undefined ? b : JSON.stringify(b)), undefined, JSON.stringify(b))
})
