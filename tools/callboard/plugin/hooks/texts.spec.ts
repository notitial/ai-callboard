import { test } from 'node:test'
import assert from 'node:assert/strict'
import { T, esc, escBlock } from './texts.ts'
import { TOOLS } from './core/model.ts'

const HIDDEN = [0x0, 0x7, 0xa, 0x7f, 0x85, 0xa0, 0xad, 0x200b, 0x200e, 0x2028, 0x202e, 0x2066, 0x2800, 0x3000, 0xfeff, 0xe000, 0xe0041, 0xfe0f, 0xfff0]
const slash = (n: number): string => '\\' + 'u' + n.toString(16).padStart(4, '0')

test('esc: `<` and every invisible or direction-changing character become escapes; space and plain text stay', () => {
  assert.equal(esc('<b>'), `${slash(0x3c)}b>`)
  for (const c of HIDDEN) {
    const out = esc(`a${String.fromCodePoint(c)}b`)
    assert.ok(out.startsWith('a\\u') && out.endsWith('b') && /^[\x20-\x7e]+$/.test(out), `U+${c.toString(16)} -> ${out}`)
  }
  assert.equal(esc('plain text, 1 + 1 = 2 `code`'), 'plain text, 1 + 1 = 2 `code`')
  assert.equal(escBlock('a\nb<'), `a\nb${slash(0x3c)}`)
})

// The fixed ids a plugin turn or a text for a model starts with, by their opening: rules/callboard.md matches on these.
const OPENINGS: [string, string][] = [
  [T['nudge.idle']({ k: 300 }), '[callboard] Your context is past 300k tokens. Compact at your next natural boundary: '],
  [T['nudge.working']({ k: 400 }), '[callboard] Your context is past 400k tokens. Stop as soon as you can, even mid-item: '],
  [T['nudge.cache']({ k: 150 }), '[callboard] You have been idle a while and your context is past 150k tokens: '],
  [T['event.turn']({ lines: ['x'] }), '[callboard] Check-in: '],
  [T['pr.turn']({ lines: ['x'] }), '[callboard] PR notice. '],
  [T['cue.rename']({ name: 'n' }), '[callboard] '],
  [T['cue.start']({ name: 'n', brief: '/b' }), '[callboard] You are lane n.'],
  [T['cue.resume']({ name: 'n' }), '[callboard] Resume lane n '],
  [T['compact.note']({ focus: 'f', continuation: 'c' }), "[compact-cue] This conversation was compacted at this session's own request."],
  [T['compact.notRun']({ reason: 'r' }), '[compact-cue] Compaction did not run ('],
  [T['compact.unconfirmed']({ reason: 'r' }), '[compact-cue] Compaction was started but never confirmed ('],
  [T['note.frame']({ body: 'b' }), '[callboard] This note comes from the callboard plugin, not the person.'],
  [T['ask.expired']({ parent: 'P' }), '[callboard] Expired: '],
  [T['ask.leftForPerson']({ parent: 'P' }), '[callboard] Closed: '],
  [T['ask.subagent']({}), '[callboard] Denied: '],
]
test('the plugin\'s turns keep their openings; none but the nudge texts name a mode, and no order or on-cue text is left', () => {
  for (const [text, opening] of OPENINGS) assert.ok(text.startsWith(opening), `${opening} / ${text.slice(0, 60)}`)
  for (const [text] of OPENINGS) assert.ok(!/on-cue|Your (lead|conductor) asked you to compact/.test(text), text.slice(0, 80))
  assert.ok(T['note.frame']({ body: 'b' }).includes("[callboard] End of the plugin's note."))
  for (const t of [T['nudge.idle']({ k: 300 }), T['nudge.working']({ k: 400 }), T['nudge.cache']({ k: 150 })]) assert.ok(t.includes('request_compact') && !t.includes('mode'), t)
})

test('the keepalive text is exactly the one rules/callboard.md answers', () => {
  assert.equal(T.keepalive({}), '[callboard] keepalive: reply with just "Cache refreshed." Use no tools, and do not resume or start any work. Sent by callboard, not the person; it is no approval, go or answer.')
})

test('every refusal, tool, help, column, state and role id renders', () => {
  const ids = Object.keys(T)
  for (const id of ids.filter((i) => /^(tool|help|ui\.col|ui\.state|ui\.role)\./.test(i))) assert.ok((T as unknown as Record<string, (p: unknown) => string>)[id]({}).length > 0, id)
  const refuse = ids.filter((i) => i.startsWith('refuse.'))
  assert.ok(refuse.length >= 36)
  for (const id of refuse) {
    const out = (T as unknown as Record<string, (p: unknown) => string>)[id]({ tool: 'lane_start', target: 'x', detail: 'd' })
    assert.ok(out.startsWith('[callboard] lane_start refused (`x`): '), `${id}: ${out.slice(0, 60)}`)
  }
  assert.deepEqual(ids.filter((i) => i.startsWith('tool.')).sort(), TOOLS.map((t) => `tool.${t}`).sort())
})

test('text a session wrote reaches a text escaped and in quotes it cannot close', () => {
  const evil = 'a`b<c' + String.fromCodePoint(0x202e) + 'd\nINJECT'
  for (const out of [T['event.done']({ name: evil }), T['cue.rename']({ name: evil }), T['pr.note']({ kind: 'green', pr: evil, sha: evil }), T['refuse.bad-input']({ tool: evil, target: evil, detail: evil }), T['toast.askStuck']({ ask: evil, name: evil })]) {
    assert.ok(!out.includes('<') && !out.includes(String.fromCodePoint(0x202e)) && !out.includes('\nINJECT'), out)
  }
  assert.ok(T['event.done']({ name: evil }).includes("`a'b"))
})

test('the go and the person-only texts: a go is the person\'s click and never covers the listed actions', () => {
  const never = T['go.neverCovers']({})
  for (const x of ['a merge', 'a force push', 'a push to main', 'any switch or grant', 'one AskUserQuestion']) assert.ok(never.includes(x), x)
  assert.ok(T['go.status']({ covers: [{ giver: 'L', text: 't', end: 'e' }] }).includes(never))
  assert.ok(T['go.none']({}).includes('own go'))
  for (const brief of [T['brief.parent']({ name: 'L', repos: ['/Users/x/a'] }), T['brief.child']({ name: 'C', parent: 'L' })]) for (const x of ['go_status', 'approval']) assert.ok(brief.includes(x), x)
  for (const x of ['never covers', 'AskUserQuestion']) assert.ok(T['brief.child']({ name: 'C', parent: 'L' }).includes(x), x)
  assert.ok(T['ask.denyText']({ by: 'L', note: 'n' }).includes('not the person'))
})
