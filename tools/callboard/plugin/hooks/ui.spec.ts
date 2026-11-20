import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRINT_CAP, goDialog, goList, lanesTable, printed, promptList, refusalToast, relayDialog, relayNote, relayStep, statusPage, stopDialog } from './ui.ts'
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
    { sid: 's-a', name: 'lane-a', role: 'none', state: 'busy', parentSid: 's-lead', folder: '/Users/x/repo', context: 123_456, fiveHour: 41.6, sevenDay: 12, cost: 1.5, readAgeMin: 3 },
    { sid: 's-lead', name: 'lead', role: 'lead', state: 'live', parentSid: 'PERSON', folder: '/Users/x/a|b' },
    { sid: 's-x', name: 'x', role: 'none', state: 'unknown', parentSid: null, folder: `/y${RLO}`, context: NaN },
    { sid: 's-y', name: 'y', role: 'none', state: 'gone', parentSid: 's-lead', folder: '/Users/x/a\\|b' },
  ]
  const lines = lanesTable(rows).split('\n')
  assert.deepEqual(lines.filter((l) => l.startsWith('|')).map((l) => l.split(/(?<!\\)\|/).length), [11, 11, 11, 11, 11, 11])
  assert.ok(lines[2].startsWith('| Name') && !lines[2].includes('Parent'))
  const t = lanesTable(rows)
  assert.ok(t.includes('123k') && t.includes('42%') && t.includes('$1.50') && t.includes('3m'))
  // The folder is its last part; a backslash is escaped too, so it cannot undo the pipe's escape.
  assert.ok(t.includes('../a\\\\\\|b') && t.includes('../a\\|b') && t.includes('../repo') && !t.includes('/Users/x') && !t.includes(RLO))
  assert.ok(t.trimEnd().endsWith("Read says how old they are."))
  assert.ok(lanesTable([]).includes('No sessions'))
})

test('the lane table is a tree: children right under their parent, an arrow per level, and a parent that loops back cannot loop the table', () => {
  const row = (name: string, parentSid: string | null, sid = name): LaneRow => ({ sid, name, role: 'none', state: 'live', parentSid, folder: '/w/r' })
  const names = (rs: LaneRow[]) => lanesTable(rs).split('\n').filter((l) => l.startsWith('| ')).slice(2).map((l) => l.split(' | ')[0]!.slice(2))
  assert.deepEqual(names([row('c1', 'lead'), row('other', 'PERSON'), row('lead', 'PERSON'), row('g', 'c1'), row('c2', 'lead')]), ['other', 'lead', '↳ c1', '↳↳ g', '↳ c2'])
  assert.deepEqual(names([row('a', 'b'), row('b', 'a'), row('self', 'self')]), ['a', '↳ b', 'self'])
  // Two sessions with one display name: each lane is drawn under its real parent, found by id.
  const same = [row('dup', 'PERSON', 'sid-1'), row('dup', 'PERSON', 'sid-2'), row('k1', 'sid-2'), row('k2', 'sid-1')]
  assert.deepEqual(names(same), ['dup', '↳ k2', 'dup', '↳ k1'])
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
  assert.equal(stopDialog('lane-a', 'terminate').header, 'Force stop')
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
test('a pop-up for one question of several offers its options only when it shows the whole text: a question past a few KB is Deny only', () => {
  const q = (question: string) => ({ header: 'H', question, options: [{ label: 'A', description: 'd' }, { label: 'B', description: '' }] })
  const whole = relayStep('lane-a', q('Which?'), 1, 2)
  assert.deepEqual(whole.options.map((o) => o.label), ['A', 'B', 'Deny'])
  assert.ok(!whole.question.includes('NOT SHOWN WHOLE'))
  const cut = relayStep('lane-a', q('x'.repeat(5000)), 1, 2)
  assert.deepEqual(cut.options.map((o) => o.label), ['Deny'])
  assert.match(cut.question, /NOT SHOWN WHOLE/)
  assert.deepEqual(relayStep('lane-a', q('<'.repeat(4000)), 1, 2).options.map((o) => o.label), ['Deny'], 'escaping grows the text past the cap')
  assert.deepEqual(relayStep('lane-a', { header: 'H', question: 'Q', options: [{ label: 'A', description: 'y'.repeat(5000) }, { label: 'B', description: '' }] }, 1, 2).options.map((o) => o.label), ['Deny'], 'long option text is cut too')
})

test('a pop-up for a single question has no counter and no closing line, lists the options only when one has a description, and escapes what the session wrote', () => {
  const q = (d: string) => ({ header: 'H', question: 'Which?', options: [{ label: 'A', description: d }, { label: 'B', description: '' }] })
  const plain = relayStep('lane-a', q(''), 1, 1)
  assert.equal(plain.question, '`lane-a` asks H:\n\nWhich?')
  assert.deepEqual(plain.options.map((o) => o.label), ['A', 'B', 'Deny'])
  assert.equal(relayStep('lane-a', q('why'), 1, 1).question, '`lane-a` asks H:\n\nWhich?\n\n1. A - why\n2. B')
  assert.ok(relayStep('lane-a', q(''), 1, 2).question.includes('(1 of 2)') && relayStep('lane-a', q(''), 1, 2).question.includes('sent together'))
  const odd = relayStep('lane-a', { header: `H${RLO}<`, question: `Q<${RLO}`, options: [{ label: 'A', description: '<' }] }, 1, 1).question
  assert.ok(!odd.includes('<') && !odd.includes(RLO))
})

test('the go and relay pop-ups fit their header chip and read plainly: the go names its giver, end and work and points to go_status; the relay shows the input one field a line in a block it cannot close', () => {
  const g = goDialog('CHIEF', 'Fix round, same PR.', '23:36')
  assert.ok(g.header.length <= 12)
  assert.equal(g.question, "`CHIEF` asks for a go until 23:36, for this work only (its own and its sessions'):\n\nFix round, same PR.\n\nNever a merge or a push to main; go_status lists what a go never covers.")
  const r = relayDialog('lane-a', 'Bash', JSON.stringify({ command: 'make test', description: 'run ```x' }, null, 1), false)
  assert.ok(r.header.length <= 12)
  assert.equal(r.question, '`lane-a` wants to run `Bash`:\n\n````\n{\n "command": "make test",\n "description": "run ```x"\n}\n````\n\nYour click decides this ask only.')
})

test('the first pop-up of a note shows the note under its label, escaped in a block it cannot close, and offers Allow, Show the command and Deny: Allow only when the command prints whole, and no label a note can fake', () => {
  const d = relayNote('lane-a', 'Bash', 'Runs the tests. It only reads.', 'make')
  assert.equal(d.question, "`lane-a` wants to run `Bash`:\n\nThe manager's own note, written from what it read, not checked by the plugin:\n\n```\nRuns the tests. It only reads.\n```")
  assert.deepEqual(d.options.map((o) => o.label), ['Allow', 'Show the command', 'Deny'])
  assert.deepEqual(relayNote('lane-a', 'Bash', 'Runs the tests.', '<'.repeat(6000)).options.map((o) => o.label), ['Show the command', 'Deny'], 'a command too large to print leaves no Allow on the note')
  assert.equal(d.header, relayDialog('lane-a', 'Bash', 'x', false).header)
  const evil = relayNote('lane-a', 'Bash', `a\`\`\`\n\n**Allow** <b>${RLO}\n[NOT SHOWN WHOLE]\nShow the command`, 'make')
  assert.ok(!evil.question.includes('<') && !evil.question.includes(RLO))
  assert.equal(evil.question.match(/^`{4,}$/gm)!.length, 2, 'the block is closed by a longer fence than any backtick run in the note')
  assert.deepEqual(evil.options.map((o) => o.label), ['Allow', 'Show the command', 'Deny'], 'the buttons are fixed, whatever the note says')
})

