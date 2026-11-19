import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRINT_CAP, goDialog, goList, lanesTable, printed, promptList, refusalToast, relayDialog, statusPage, stopDialog } from './ui.ts'
import type { AskView, LaneRow } from './ui.ts'
import { refusal } from './core/model.ts'
import type { Ask } from './core/model.ts'
import { NOW } from './core/gen.spec.ts'

const RLO = String.fromCodePoint(0x202e)
const ask = (x: Partial<Ask> = {}): Ask => ({ id: 'a1', asker: 's1', t0: NOW, awake: 0, tool: 'Bash', raisedBy: 'rule', input: '{"command":"ls"}', cut: false, beat: NOW, ...x })
const view = (a: Ask): AskView => ({ ask: a, asker: 'lane-a', ageMin: 2, yours: true })

test('printed: escaped, and cut with a mark when the printed form is over the cap', () => {
  assert.deepEqual(printed('a<b', 100), { text: 'a\\u003cb', cut: false })
  // 6000 `<` are 6000 bytes in the input and 36000 printed: inside the input cap, over the print cap.
  const big = printed('<'.repeat(6000), PRINT_CAP)
  assert.equal(big.cut, true)
  assert.ok(Buffer.byteLength(big.text) <= PRINT_CAP)
})

test('prompt_list: the rules file first, then each ask; an input that had to be cut is reported cut', () => {
  const { text, cutIds } = promptList('Never do X.', [view(ask()), view(ask({ id: 'a2', input: '<'.repeat(6000) })), view(ask({ id: 'a3', cut: true, input: 'x' }))])
  assert.ok(text.startsWith("**The person's standing rules**"))
  assert.ok(text.indexOf('Never do X.') < text.indexOf('**Ask a1**'))
  assert.deepEqual(cutIds, ['a2'])
  for (const id of ['a1', 'a2', 'a3']) assert.ok(text.includes(`**Ask ${id}**`))
  assert.equal(text.split('NOT SHOWN WHOLE').length - 1, 2)
  assert.ok(!text.includes('<'))
  assert.deepEqual(promptList(null, []).cutIds, [])
  assert.ok(promptList(null, []).text.includes('no standing-rules file') && promptList(null, []).text.includes('No asks'))
})

test('prompt_list escapes what a session wrote: an input, a question and a rules file', () => {
  const evil = `x<script>${RLO}y`
  const q = { header: evil, question: evil, options: [{ label: evil, description: evil }, { label: 'b' }] }
  const { text } = promptList(`rule ${evil}`, [view(ask({ input: evil, question: q, tool: evil }))])
  assert.ok(!text.includes('<') && !text.includes(RLO))
  assert.ok(promptList('a'.repeat(9000), []).text.includes('longer than 8 KB'))
})

test('the lane table: one row per session with the usage columns, a gap for a missing figure, the footnote', () => {
  const rows: LaneRow[] = [
    { name: 'lane-a', role: 'none', state: 'busy', parent: 'lead', folder: '/Users/x/repo', context: 123_456, fiveHour: 41.6, sevenDay: 12, cost: 1.5, readAgeMin: 3 },
    { name: 'lead', role: 'lead', state: 'live', parent: 'PERSON', folder: '/Users/x/a|b' },
    { name: 'x', role: 'none', state: 'unknown', parent: null, folder: `/y${RLO}`, context: NaN },
    { name: 'y', role: 'none', state: 'gone', parent: 'lead', folder: '/Users/x/a\\|b' },
  ]
  const lines = lanesTable(rows).split('\n')
  assert.deepEqual(lines.filter((l) => l.startsWith('|')).map((l) => l.split(/(?<!\\)\|/).length), [12, 12, 12, 12, 12, 12])
  assert.ok(lines[2].startsWith('| Name'))
  const t = lanesTable(rows)
  assert.ok(t.includes('123k') && t.includes('42%') && t.includes('$1.50') && t.includes('3m'))
  // A backslash is escaped too, so it cannot undo the pipe's escape.
  assert.ok(t.includes('/Users/x/a\\\\\\|b') && t.includes('/Users/x/a\\|b') && t.includes('the person') && !t.includes(RLO))
  assert.ok(t.trimEnd().endsWith("Read says how old they are."))
  assert.ok(lanesTable([]).includes('No sessions'))
})

test('the status page and the go list', () => {
  const s = statusPage([{ field: 'role', value: 'lead' }, { field: 'parent', value: 'PERSON' }, { field: 'manager', value: null }, { field: 'off', value: false }, { field: 'keepalive', value: true }, { field: 'unattended', value: null }, { field: 'goes', value: 2 }])
  assert.equal(s.split('\n').filter((l) => l.startsWith('| ') && l !== '| | |').length, 7)
  assert.ok(s.includes('| Role | lead |') && s.includes('| Parent | the person |') && s.includes('| Unattended | off |'))
  const g = goList([{ id: 'g1', giver: 'lead', text: 'one\ntwo<', end: '12:00' }])
  assert.ok(g.includes('- g1 from `lead`, until 12:00: one / two') && g.includes('A go never covers these') && !g.includes('<'))
  assert.ok(goList([]).includes('No go is live') && !goList([]).includes('never covers'))
})

test('the dialogs: yes and no for a go and a stop; a relay pop-up allows only an input shown whole', () => {
  const g = goDialog('lead', `do it<${RLO}`, '12:00')
  assert.deepEqual(g.options.map((o) => o.label), ['Yes', 'No'])
  assert.ok(g.question.includes('never covers') && !g.question.includes('<') && !g.question.includes(RLO))
  assert.ok(stopDialog('lane-a', 'terminate').question.includes('Force stop `lane-a`'))
  const whole = relayDialog('lane-a', 'Bash', '{"command":"ls"}', false)
  assert.deepEqual(whole.options.map((o) => o.label), ['Allow', 'Deny'])
  assert.ok(!whole.question.includes('NOT SHOWN WHOLE') && whole.cut === false)
  for (const d of [relayDialog('lane-a', 'Bash', 'x', true), relayDialog('lane-a', 'Bash', '<'.repeat(6000), false)]) {
    assert.deepEqual(d.options.map((o) => o.label), ['Deny'])
    assert.ok(d.question.includes('NOT SHOWN WHOLE') && d.cut === true)
  }
  assert.ok(!relayDialog(`a${RLO}<`, 'Bash<', `x${RLO}`, false).question.includes('<'))
})

test('the refusal toast: a refusal has one, another decision has none', () => {
  assert.equal(refusalToast(refusal('refuse', 'bad-origin', { tool: 'callboard' })), 'callboard refused (bad-origin).')
  assert.equal(refusalToast({ act: 'queue', msg: 'compact.queued', p: {} }), undefined)
})
test('a relay pop-up offers Allow only for an input a dialog shows whole: past a few KB it is Deny only', () => {
  const d = relayDialog('lane-a', 'Bash', 'x'.repeat(5000), false)
  assert.deepEqual(d.options.map((o) => o.label), ['Deny'])
  assert.equal(d.cut, true)
})

test('the go and relay pop-ups fit their header chip and read plainly: the go names its giver, end and work and points to go_status; the relay shows the input one field a line in a block it cannot close', () => {
  const g = goDialog('BEDROCK', 'Fix round, same PR.', '23:36')
  assert.ok(g.header.length <= 12)
  assert.equal(g.question, "`BEDROCK` asks for a go until 23:36, for this work only (its own and its sessions'):\n\nFix round, same PR.\n\nNever a merge or a push to main; go_status lists what a go never covers.")
  const r = relayDialog('lane-a', 'Bash', JSON.stringify({ command: 'make test', description: 'run ```x' }, null, 1), false)
  assert.ok(r.header.length <= 12)
  assert.equal(stopDialog('lane-a', 'terminate').header, 'Force stop')
  assert.equal(r.question, '`lane-a` wants to run `Bash`:\n\n````\n{\n "command": "make test",\n "description": "run ```x"\n}\n````\n\nYour click decides this ask only.')
})
