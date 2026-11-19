import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MIN, T0, V2, fake } from '../../test/fake.ts'
import { commandComplete, commandRun, promptCompose } from './commands.ts'
import { mem } from './mem.ts'
import { T } from '../texts.ts'

const run = (f: ReturnType<typeof fake>, args: string, kind?: string) => commandRun(f.$, { args, origin: kind === undefined ? undefined : { kind } })
const me = (f: ReturnType<typeof fake>) => f.seed({ sid: 'sid-me', pid: 10, name: 'me', cwd: '/w/me', kind: 'interactive' })

test('the origin: his typed turn (composer, bridge) runs a form that widens what a session may do; every other kind, and none, is refused', async () => {
  for (const kind of ['composer', 'bridge']) {
    const f = fake()
    me(f)
    assert.equal((await run(f, 'on', kind)).text, T['cmd.on']({}))
  }
  for (const kind of ['plugin', 'sdk', 'peer', 'task-notification', 'something-new', undefined]) {
    const f = fake()
    me(f)
    for (const args of ['lead', 'off', 'on', 'go finish the tests', 'go off', 'unattended 1h', 'unattended off', 'config idle 200']) {
      const r = await run(f, args, kind)
      assert.match(r.text, /only when the person types it themselves/, `${kind} ${args}`)
    }
    assert.equal(f.h.files.has(`${V2}/sessions.json`), false)
    assert.equal(f.h.files.has(`${V2}/unattended.json`), false)
    assert.equal(f.h.files.has(`${V2}/config.json`), false)
    assert.ok(!f.h.runs.some((r) => r.argv[0] === '/usr/bin/tee' && r.argv.includes('go')))
    for (const args of ['status', 'lanes', 'help', 'rest', 'config', 'unattended']) assert.doesNotMatch((await run(f, args, kind)).text, /types it themselves/, `${kind} ${args}`)
  }
})
test('lead: the row gets the real folder and real repo paths, the lead tools are registered, lead off and off and on change the row', async () => {
  const f = fake()
  me(f)
  f.h.dirs.add('/w/repo2').add(`${HOME}/code`)
  f.h.real.set(`${HOME}/code/link`, `${HOME}/code`)
  const r = await run(f, `lead /w/repo2 ~/code/link`, 'composer')
  assert.match(r.text, /repo2/)
  const t = JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)
  assert.deepEqual(t['sid-me'], { name: 'me', folder: '/w/me', lead: { repos: ['/w/repo2', `${HOME}/code`] } })
  assert.equal(f.h.tools.filter((n) => n.startsWith('lane_')).length, 8 + 3)
  assert.match((await run(f, 'lead /no/such/dir', 'composer')).text, /input is not valid/)
  await run(f, 'lead /w/repo2', 'composer')
  assert.deepEqual(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-me'].lead.repos, ['/w/repo2', `${HOME}/code`])
  await run(f, 'lead off', 'composer')
  assert.equal(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-me'].lead, undefined)
  await run(f, 'off', 'composer')
  assert.equal(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-me'].off, true)
  await run(f, 'on', 'composer')
  assert.equal(JSON.parse(f.h.files.get(`${V2}/sessions.json`)!)['sid-me'].off, undefined)
  assert.equal(f.h.modes.get(V2), '700')
})
test('a write that does not land is said, not reported as done', async () => {
  const f = fake()
  me(f)
  f.h.files.set(`${V2}/sessions.json`, '{"broken": ')
  assert.match((await run(f, 'off', 'composer')).text, /could not read which sessions are live/)
  assert.equal(f.h.files.get(`${V2}/sessions.json`), '{"broken": ')
})
test('go: one file with the giver and 24 h; go off ends every live go, one by id, and an unknown id ends none', async () => {
  const f = fake()
  me(f)
  const g = (await run(f, 'go build the thing\nin /tmp', 'composer')).text
  const id = /Go (\w+) recorded/.exec(g)![1]
  const rec = JSON.parse(f.h.files.get(`${V2}/go/${id}.json`)!)
  assert.deepEqual({ giver: rec.giver, end: rec.end, text: rec.text }, { giver: 'sid-me', end: T0 + 24 * 60 * MIN, text: 'build the thing\nin /tmp' })
  assert.equal((await run(f, 'go off nosuchid', 'composer')).text, T['cmd.goOff']({ n: 0 }))
  assert.ok(f.h.files.has(`${V2}/go/${id}.json`))
  assert.equal((await run(f, `go off ${id}`, 'composer')).text, T['cmd.goOff']({ n: 1 }))
  assert.equal(f.h.files.has(`${V2}/go/${id}.json`), false)
  await run(f, 'go again', 'composer')
  assert.equal((await run(f, 'go off', 'composer')).text, T['cmd.goOff']({ n: 1 }))
  assert.equal((await run(f, 'go off', 'composer')).text, T['cmd.goOff']({ n: 0 }))
})
test('unattended: on writes the window, bare shows it, off removes it; config changes are saved and a bad one is refused', async () => {
  const f = fake()
  me(f)
  assert.match((await run(f, 'unattended 2h', 'composer')).text, /Unattended mode is on until/)
  assert.deepEqual(JSON.parse(f.h.files.get(`${V2}/unattended.json`)!), { start: T0, end: T0 + 120 * MIN, readAt: T0 })
  mem.win = undefined
  f.h.files.set(`${V2}/asks-${new Date(T0).getFullYear()}-${String(new Date(T0).getMonth() + 1).padStart(2, '0')}.jsonl`, `${JSON.stringify({ t: T0 + MIN, ev: 'expired', ask: 'a1', asker: 'sid-me' })}\n`)
  const shown = (await run(f, 'unattended', undefined)).text
  assert.match(shown, /^\*\*Unattended until /)
  assert.match(shown, /Closed with nobody to decide/)
  assert.match(shown, /expired a1 from .me./)
  assert.match((await run(f, 'unattended off', 'bridge')).text, /^Unattended mode is off\.\n\n\*\*Unattended until/)
  assert.equal(f.h.files.has(`${V2}/unattended.json`), false)
  assert.match((await run(f, 'config idle 200', 'composer')).text, /idleK 200/)
  assert.equal(JSON.parse(f.h.files.get(`${V2}/config.json`)!).idleK, 200)
  assert.match((await run(f, 'config idle 500', 'composer')).text, /input is not valid/)
  assert.match((await run(f, 'config reset', 'composer')).text, /defaults/)
})
test('status and lanes read the machine: the role, the parent, the goes that cover it, the children with their usage', async () => {
  const f = fake()
  me(f)
  f.seed({ sid: 'sid-kid', pid: 11, name: 'kid', cwd: '/w/kid' })
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: [] } }, 'sid-kid': { name: 'kid', folder: '/w/kid', under: 'sid-me' } })
  f.h.files.set(`${V2}/usage/sid-kid.json`, JSON.stringify({ at: T0 - 5 * MIN, tokens: 200_000, cost: 3, fiveHour: 20 }))
  await run(f, 'go the work', 'composer')
  const status = (await run(f, 'status')).text
  assert.match(status, /lead/)
  assert.match(status, /Goes \| 1/)
  const lanes = (await run(f, 'lanes')).text
  assert.match(lanes, /kid/)
  assert.match(lanes, /200k/)
  assert.match(lanes, /5m/)
})
test('the typeahead offers the commands after /callboard and nothing elsewhere', async () => {
  const f = fake()
  const next = async () => ({ suggestions: [{ text: 'x', label: 'x', description: '' }] })
  const a = await commandComplete(f.$, { text: '/callboard ', start: 11, token: 'st' }, next)
  assert.deepEqual(a.suggestions.map((s: { text: string }) => s.text), ['x', 'status'])
  assert.equal((await commandComplete(f.$, { text: '/callboard go ', start: 14, token: 'o' }, next)).suggestions.length, 1)
})
test('the briefing: a section for the manager (rules cut), a lead, a child; none for a subagent, a teammate or an off session', async () => {
  const f = fake()
  me(f)
  f.seed({ sid: 'sid-boss', pid: 11, name: 'BOSS' })
  f.h.files.set(`${HOME}/.claude/callboard/manager-name`, 'BOSS\n')
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-boss' } })
  const tools = ['mcp__callboard__request_compact']
  const compose = (extra: object = {}) => promptCompose(f.$, { traits: [], tools, ...extra }, async () => ({ sections: [{ id: 'base', text: 'b', scope: 'shared' }] }))
  const child = await compose()
  const sec = child.sections.find((s: { id: string }) => s.id === 'callboard:brief')
  assert.ok(sec.text.startsWith('[callboard] This note comes from the callboard plugin, not the person.'))
  assert.match(sec.text, /BOSS/)
  assert.equal((await compose({ tools: ['Read'] })).sections.length, 1)
  assert.equal((await compose({ traits: ['teammate'] })).sections.length, 1)
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', under: 'sid-boss', off: true } })
  mem.view = undefined
  assert.equal((await compose()).sections.length, 1)
  f.table({ 'sid-me': { name: 'me', folder: '/w/me', lead: { repos: ['/r'] } } })
  mem.view = undefined
  assert.match((await compose()).sections.find((s: { id: string }) => s.id === 'callboard:brief').text, /\/r/)
})
