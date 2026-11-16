import test from 'node:test'
import assert from 'node:assert/strict'
import * as c from './core.ts'
import * as prm from './prompts.ts'
import * as go from './go.ts'
import { COMMAND_TABLE, argumentHint, completions, firstWords, usageLine } from './core.ts'

const words = (draft: string, word: string): string[] => completions(draft, word).map((s) => s.text)

test('every form is written once, each with a help line', () => {
  const forms = COMMAND_TABLE.map((r) => r.form)
  assert.equal(new Set(forms).size, forms.length)
  for (const r of COMMAND_TABLE) assert.ok(r.help.length > 0 && !r.help.includes('\n'), r.form)
})

test('the hint and the usage lines are built from the table', () => {
  assert.equal(argumentHint(), 'lanes|status|lead|lane|escalation|go|here|unattended|conductor|manager|config|reserve|checkin|rest|off|help')
  assert.deepEqual(firstWords().slice(0, 3), ['lanes', 'status', 'lead'])
  assert.equal(usageLine('conductor'), 'Use /callboard conductor [NAME], conductor add NAME|PATH or conductor remove NAME|PATH.')
  assert.equal(usageLine('checkin'), 'Use /callboard checkin pause [Nm|Nh] or checkin resume.')
  assert.equal(usageLine('status'), 'Use /callboard status.')
})

test('the first word completes to every first word that starts with it, once, with its help line', () => {
  assert.deepEqual(words('/callboard ', 'l'), ['lanes', 'lead', 'lane'])
  assert.deepEqual(words('/callboard ', 'co'), ['conductor', 'config'])
  assert.deepEqual(words('/callboard ', 'LEAD'), ['lead'])
  assert.deepEqual(completions('/callboard ', 'lead'), [{ text: 'lead', label: 'lead', description: COMMAND_TABLE[2].help }])
  assert.deepEqual(words('/callboard ', 'zz'), [])
})

test('a later word completes from the forms the earlier words fit', () => {
  assert.deepEqual(words('/callboard lead ', 'j'), ['join'])
  assert.deepEqual(words('/callboard lane ', 'o'), ['off'])
  assert.deepEqual(words('/callboard checkin ', 'p'), ['pause'])
  assert.deepEqual(words('/callboard checkin ', 'r'), ['resume'])
  assert.deepEqual(words('/callboard reserve ', 'r'), ['remove'])
  assert.deepEqual(words('/callboard reserve ', 'a'), ['add'])
  assert.deepEqual(words('/callboard conductor ', 'a'), ['add'])
  assert.deepEqual(words('/callboard config ', 'k'), ['keepalive'])
  assert.deepEqual(words('/callboard config checkin ', 'o'), ['on', 'off'])
  assert.deepEqual(words('/callboard config conductor-leads ', 'of'), ['off'])
  assert.deepEqual(words('/callboard config ', 'p'), ['ping'])
  assert.deepEqual(words('/callboard escalation ', 'o'), ['off'])
  assert.deepEqual(words('/callboard go ', 'o'), ['off'])
  assert.deepEqual(words('/callboard unattended ', 'o'), ['off'])
})

test('a value the person supplies, a word past the end of a form and a draft that is not /callboard offer nothing', () => {
  assert.deepEqual(words('/callboard lead ', 'N'), [])
  assert.deepEqual(words('/callboard checkin pause ', '3'), [])
  assert.deepEqual(words('/callboard config ping ', '4'), [])
  assert.deepEqual(words('/callboard off ', 'o'), [])
  assert.deepEqual(words('/callboard checkin resume ', 'r'), [])
  assert.deepEqual(words('/other ', 'l'), [])
  assert.deepEqual(words('hello /callboard ', 'l'), [])
  assert.deepEqual(words('', '/callboard'), [])
  assert.deepEqual(words('/callboard', 'l'), [])
})

// Every line a form stands for: each optional token left out and filled in, each `a|b` alternative, a value replaced by one the parser takes.
const NUMBER: Record<string, string> = { ping: '40', stop: '2', idle: '200', working: '400' }
function lines(form: string): string[] {
  let out: string[][] = [[]]
  for (const t of form.split(' ')) {
    const optional = t.startsWith('[')
    const alts = t.replace(/^\[|\]$/g, '').split('|').filter((a) => !/^N[mh]$/.test(a))
    const choices = /[A-Z]/.test(t) ? [t.includes('Nm|Nh') ? '3m' : t.startsWith('SHORT') || t.startsWith('[SHORT') ? '0a1b2c3d' : 'blue'] : alts
    out = out.flatMap((l) => [...(optional ? [l] : []), ...choices.map((c) => [...l, t === 'N' ? NUMBER[l[l.length - 1]] : c])])
  }
  return out.map((l) => l.join(' '))
}

test('every line a form of the table stands for is one the parser or the handler reads', () => {
  for (const row of COMMAND_TABLE) {
    for (const line of lines(row.form)) {
      const [first, ...rest] = line.split(' ')
      // These are read by the handler itself, ahead of the parser, each by its own parser.
      if (first === 'help' || first === 'rest') continue
      if (first === 'escalation') assert.notEqual(prm.parseEscalationArgs(rest.join(' ')), 'bad', line)
      else if (first === 'go') assert.notEqual(go.parseGoArgs(rest.join(' ')), 'bad', line)
      else if (first === 'here') assert.notEqual(prm.parseHereArgs(rest.join(' ')), 'bad', line)
      else if (first === 'unattended') assert.notEqual(prm.parseUnattendedArgs(rest.join(' ')), 'bad', line)
      else {
        const arg = c.parseCommandArgs(line)
        assert.notEqual(arg, undefined, line)
        assert.doesNotMatch(JSON.stringify(arg), /"bad"/, line)
      }
    }
  }
})

test('the sample lines cover the optional and the alternative forms', () => {
  assert.deepEqual(lines('reserve [add] NAME'), ['reserve blue', 'reserve add blue'])
  assert.deepEqual(lines('config ping|stop|idle|working N'), ['config ping 40', 'config stop 2', 'config idle 200', 'config working 400'])
  assert.deepEqual(lines('checkin pause [Nm|Nh]'), ['checkin pause', 'checkin pause 3m'])
})

test('the first typed word of a line is read as typed: a word in another letter case fits no form', () => {
  assert.deepEqual(words('/callboard Checkin ', 'p'), [])
  assert.deepEqual(words('/callboard checkin ', 'P'), ['pause'])
  assert.deepEqual(words('/callboard lead\n', 'j'), [])
  assert.deepEqual(words('/callboard lead ', 'j'), ['join'])
})

test('a form is written in lower case words and upper-case values, and every first word has a row of its own', () => {
  for (const row of COMMAND_TABLE) for (const t of row.form.split(' ')) assert.ok(/^\[?[a-z][a-z-]*(\|[a-z][a-z-]*)*\]?$/.test(t) || (/[A-Z]/.test(t) && !/[a-z]\|/.test(t.replace(/Nm\|Nh/, ''))), `${row.form}: ${t}`)
  for (const w of firstWords()) assert.ok(COMMAND_TABLE.some((r) => r.form === w || r.form.startsWith(`${w} `)), w)
})
