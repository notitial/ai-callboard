import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PR_MAX, PR_TRACK_MS, mergeNotes, notesOf, parseAnswer, parseRef, parseTracker, refKey, refText, seenOf, trackExpired } from './pr.ts'
import type { PrNote, PrRef, Seen } from './pr.ts'
import { NOW } from '../../test/gen.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const REF: PrRef = { owner: 'acme', repo: 'widgets', number: 5 }
const node = (x: Record<string, unknown> = {}) => ({
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, headRefOid: A, reviews: { totalCount: 1 }, comments: { totalCount: 2 }, reviewThreads: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...x,
})
const answer = (n: unknown) => JSON.stringify({ data: { repository: { p5: n } } })
const look = (x: Record<string, unknown> = {}) => parseAnswer(answer(node(x)), [5])?.get(5)
const seen = (x: Partial<Seen> = {}): Seen => ({ sha: A, state: 'open', draft: false, checks: 'pending', mergeable: false, reviews: 0, comments: 0, threads: 0, ...x })

test('pr_watch input: a name in GitHub grammar and a number as an integer or its digits', () => {
  assert.deepEqual(parseRef({ owner: 'acme', repo: 'widgets', number: '12' }), { ...REF, number: 12 })
  assert.deepEqual(parseRef({ ...REF }), REF)
  assert.equal(refText(REF), 'acme/widgets#5')
  assert.equal(refKey({ ...REF, owner: 'ACME' }), refKey(REF))
  for (const x of [null, {}, { ...REF, owner: '-a' }, { ...REF, owner: 'a b' }, { ...REF, repo: '..' }, { ...REF, repo: 'a/b' }, { ...REF, number: 0 }, { ...REF, number: 1.5 }, { ...REF, number: '012' }, { ...REF, number: 10_000_000 }, { ...REF, number: '5; rm' }])
    assert.equal(parseRef(x), undefined, JSON.stringify(x))
})

test('GitHub\'s answer is read field by field: a missing or unknown field reads as its quiet value, never as mergeable', () => {
  assert.deepEqual(look(), { sha: A, state: 'open', draft: false, checks: 'green', merge: 'yes', reviews: 1, comments: 2, threads: 0 })
  assert.equal(look({ isDraft: undefined })?.draft, true)
  assert.equal(look({ isDraft: undefined })?.merge, 'no')
  assert.equal(look({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'NEW_STATE' } } }] } })?.checks, 'pending')
  // Only a rollup that is present and null means no checks; a missing or reshaped one reads as pending and is never mergeable.
  const none = { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }
  assert.deepEqual([look(none)?.checks, look(none)?.merge], ['none', 'yes'])
  for (const commits of [undefined, null, {}, { nodes: [] }, { nodes: [{}] }, { nodes: [{ commit: {} }] }]) assert.deepEqual([look({ commits })?.checks, look({ commits })?.merge], ['pending', 'no'], JSON.stringify(commits))
  assert.equal(look({ mergeable: 'UNKNOWN' })?.merge, 'unknown')
  assert.equal(look({ mergeable: 'CONFLICTING' })?.merge, 'no')
  assert.equal(look({ reviewDecision: 'CHANGES_REQUESTED' })?.merge, 'no')
  assert.deepEqual([look({ reviews: { totalCount: -1 }, comments: 'x', reviewThreads: null })?.reviews, look({ comments: 'x' })?.comments], [0, 0])
})

test('an answer that cannot be read is no observation; a node that fails is left out; a prototype key is not a field', () => {
  for (const s of ['', 'not json', '[]', 'null', '{}', '{"data":{}}', '{"data":{"repository":null}}']) assert.equal(parseAnswer(s, [5]), undefined, s)
  assert.equal(parseAnswer(undefined, [5]), undefined)
  assert.equal(look({ headRefOid: 'abc' }), undefined)
  assert.equal(look({ headRefOid: A.toUpperCase() }), undefined)
  for (const state of ['toString', 'constructor', '__proto__', 'merged', 1, null]) assert.equal(look({ state }), undefined, String(state))
  // A property put on Object.prototype is not a field of any node.
  const proto = Object.prototype as Record<string, unknown>
  Object.defineProperty(proto, 'state', { value: 'OPEN', configurable: true })
  Object.defineProperty(proto, 'headRefOid', { value: A, configurable: true })
  try {
    assert.equal(parseAnswer(answer({}), [5])?.size, 0)
  } finally {
    delete proto.state
    delete proto.headRefOid
  }
  const two = JSON.stringify({ data: { repository: { p5: node(), p6: node({ headRefOid: 'x' }) } } })
  assert.deepEqual([...parseAnswer(two, [5, 6, 7])!.keys()], [5])
})

test('the fingerprint: the last answer stands while the merge state is unknown; a fresh commit with no check is not mergeable', () => {
  const l = look()!
  assert.equal(seenOf(l).mergeable, true)
  assert.equal(seenOf({ ...l, merge: 'unknown' }).mergeable, false)
  assert.equal(seenOf({ ...l, merge: 'unknown' }, seen({ mergeable: true })).mergeable, true)
  assert.equal(seenOf({ ...l, merge: 'unknown' }, seen({ sha: B, mergeable: true })).mergeable, false)
  assert.equal(seenOf({ ...l, checks: 'none' }, seen({ sha: B })).mergeable, false)
  assert.equal(seenOf({ ...l, checks: 'none' }, seen()).mergeable, true)
  assert.equal('merge' in seenOf(l), false)
})

test('notes: green or failed once per change, the new activity as counts, mergeable once, an end alone; a note holds no free text', () => {
  const next = seen({ checks: 'green', reviews: 1, comments: 2, mergeable: true })
  const { notes, ended } = notesOf(REF, seen(), next, NOW, 'lane-a')
  assert.equal(ended, false)
  assert.deepEqual(notes, [
    { pr: 'acme/widgets#5', at: NOW, lane: 'lane-a', kind: 'green', sha: 'aaaaaaa' },
    { pr: 'acme/widgets#5', at: NOW, lane: 'lane-a', kind: 'activity', reviews: 1, comments: 2, threads: 0 },
    { pr: 'acme/widgets#5', at: NOW, lane: 'lane-a', kind: 'mergeable' },
  ])
  assert.deepEqual(notesOf(REF, next, next, NOW).notes, [])
  assert.equal(notesOf(REF, seen(), seen({ checks: 'failed' }), NOW).notes[0].kind, 'failed')
  assert.deepEqual(notesOf(REF, seen({ reviews: 3 }), seen({ reviews: 1 }), NOW).notes, [])
  assert.deepEqual(notesOf(REF, seen(), seen({ state: 'merged', checks: 'green' }), NOW), { notes: [{ pr: 'acme/widgets#5', at: NOW, kind: 'merged' }], ended: true })
  assert.deepEqual(notesOf(REF, seen({ state: 'closed' }), seen({ state: 'closed' }), NOW), { notes: [], ended: true })
})

test('notes merge per PR and lane: the newest check result, summed activity, one mergeable; an end drops what came before it', () => {
  const n = (kind: PrNote['kind'], at: number, x: Partial<PrNote> = {}): PrNote => ({ kind, pr: 'o/r#1', at, ...x })
  assert.deepEqual(mergeNotes([n('failed', 3), n('green', 1), n('green', 2, { sha: 'bbbbbbb' })]).map((x) => [x.kind, x.at]), [['failed', 3]])
  const act = mergeNotes([n('activity', 2, { reviews: 1, comments: 0, threads: 2 }), n('activity', 1, { reviews: 0, comments: 3, threads: 0 })])
  assert.deepEqual(act, [{ kind: 'activity', pr: 'o/r#1', at: 2, reviews: 1, comments: 3, threads: 2 }])
  assert.equal(mergeNotes([n('mergeable', 1), n('mergeable', 2)]).length, 1)
  // A failed check makes an earlier mergeable note stale; a mergeable note after a failure stands beside it.
  assert.deepEqual(mergeNotes([n('mergeable', 1), n('failed', 2)]).map((x) => x.kind), ['failed'])
  assert.deepEqual(mergeNotes([n('failed', 1), n('mergeable', 2)]).map((x) => x.kind), ['failed', 'mergeable'])
  assert.deepEqual(mergeNotes([n('green', 1), n('activity', 2, { reviews: 1 }), n('merged', 3), n('green', 4, { lane: 'z' })]).map((x) => x.kind), ['merged', 'green'])
  assert.equal(mergeNotes([n('green', 1), n('green', 1, { pr: 'o/r#2' })]).length, 2)
  assert.deepEqual(mergeNotes([]), [])
})

test('the tracker file: only this session\'s, a bad entry is dropped, the rest kept', () => {
  const good = { ...REF, at: NOW, seen: seen() }
  const file = (x: unknown) => JSON.stringify({ sid: 's1', prs: x })
  assert.deepEqual(parseTracker(file([good]), 's1'), { sid: 's1', prs: [good] })
  assert.equal(parseTracker(file([good]), 's2'), undefined)
  for (const t of ['', 'x', 'null', '{}', '{"sid":"s1"}', file('x')]) assert.equal(parseTracker(t, 's1'), undefined, t)
  const bad = [{ ...good, number: 0 }, { ...good, at: 'now' }, { ...good, seen: { ...good.seen, sha: 'z' } }, { ...good, seen: { ...good.seen, checks: 'toString' } }, { ...good, seen: { ...good.seen, reviews: 1.5 } }, { ...good, seen: { ...good.seen, comments: -1 } }, null, 7]
  // (A file holds at most PR_MAX entries, so the bad ones go in two files.)
  for (const some of [bad.slice(0, 4), bad.slice(4)]) assert.deepEqual(parseTracker(file([...some, good, { ...good, owner: 'ACME' }]), 's1')?.prs, [good])
  const many = Array.from({ length: PR_MAX + 3 }, (_, i) => ({ ...good, number: i + 1 }))
  assert.equal(parseTracker(file(many), 's1')?.prs.length, PR_MAX)
})

test('tracking ends 20 minutes after the last pr_watch call; a stamp more than that in the future is expired too, not kept for good', () => {
  assert.equal(trackExpired({ at: NOW - PR_TRACK_MS + 1 }, NOW), false)
  assert.equal(trackExpired({ at: NOW - PR_TRACK_MS }, NOW), true)
  assert.equal(trackExpired({ at: NOW + 5 * 60_000 }, NOW), false)
  assert.equal(trackExpired({ at: NOW + 3_600_000 }, NOW), true)
})
