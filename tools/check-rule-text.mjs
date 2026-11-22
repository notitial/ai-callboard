// Checks that rules/callboard.md quotes the callboard plugin's fixed texts exactly: the keepalive text, the opener and the closing
// line of the PR notice, the opener of the signed-done notice, the opener of the check-in, of the closed-ask turn, of both cues and of the own-step notice (its three go-click
// forms), and the opener of each of the three compaction nudges. A session
// matches those turns against the rule, so a drifted word would make it treat a real turn as an ordinary message.
// It also checks that the rule carries the briefings' sentences on instructions from the layer above a session and on plan first word for word.
//   node tools/check-rule-text.mjs
// Exit 0 when every quote matches, 1 with one line per mismatch, 2 when a file cannot be read. Needs node 22.18 or later,
// which runs the plugin's TypeScript as it is.
// It lives here, not under tools/callboard, because the callboard folder stays self-contained: it knows nothing of rules/.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let rule, T
try {
  rule = readFileSync(join(root, 'rules/callboard.md'), 'utf8')
  T = (await import(join(root, 'tools/callboard/plugin/hooks/texts.ts'))).T
} catch (e) {
  console.error(`cannot load: ${e.message}`)
  process.exit(2)
}

const problems = []
const quoted = (text) => rule.includes('`' + text + '`')

const keepalive = T.keepalive()
if (!quoted(keepalive)) problems.push('rules/callboard.md does not quote the keepalive text exactly')

// The PR notice: the rule quotes how it opens and its closing line.
const PR_OPENER = '[callboard] PR notice.'
const prLines = T['pr.turn']({ lines: [] }).split('\n')
if (!prLines[0].startsWith(`${PR_OPENER} `) || !quoted(PR_OPENER)) problems.push('rules/callboard.md does not quote the opener of the PR notice exactly')
if (!quoted(prLines.at(-1))) problems.push('rules/callboard.md does not quote the closing line of the PR notice exactly')

// The signed-done notice: a line of the check-in; the rule quotes how it reads.
const DONE_OPENER = 'Signed done:'
if (!T['event.done']({ name: 'A' }).startsWith(`${DONE_OPENER} `) || !quoted(DONE_OPENER)) problems.push('rules/callboard.md does not quote the opener of the signed-done line exactly')

// The check-in: the rule quotes how it opens.
const CHECKIN_OPENER = '[callboard] Check-in: something under you needs a look.'
if (!T['event.turn']({ lines: [] }).startsWith(CHECKIN_OPENER) || !quoted(CHECKIN_OPENER)) problems.push(`rules/callboard.md does not quote the check-in opener exactly: ${CHECKIN_OPENER}`)

// The own-step notice: the rule quotes how the turn opens after the person's command and after each outcome of their go click.
const ownStep = [T['cmd.told']({ result: 'x' }), T['cmd.toldPreset']({ command: 'NAME', result: 'x', failed: [] }), T['go.clicked']({ outcome: 'given' }), T['go.clicked']({ outcome: 'declined' }), T['go.clicked']({ outcome: 'unsaved' })]
for (const opener of ['[callboard] The person ran /callboard in this session:', '[callboard] The person ran /NAME in this session:', '[callboard] The person clicked Yes on your go request', '[callboard] The person declined the go you asked for', '[callboard] The person said yes to the go you asked for, but it could not be saved']) {
  if (!ownStep.some((t) => t.startsWith(opener)) || !quoted(opener)) problems.push(`rules/callboard.md does not quote the own-step opener exactly: ${opener}`)
}

// The parent's cue: the rule quotes how the start cue and the resume cue open, and no other cue exists.
const cues = Object.keys(T).filter((id) => id.startsWith('cue.')).sort()
if (cues.join() !== 'cue.resume,cue.start') problems.push(`the plugin sends cues other than a start and a resume: ${cues.join(', ')}`)
for (const [opener, text] of [['[callboard] You are lane `NAME` of `PARENT`.', T['cue.start']({ name: 'NAME', brief: '/b', parent: 'PARENT' })], ['[callboard] Resume lane `NAME` from', T['cue.resume']({ name: 'NAME' })]]) {
  if (!text.startsWith(opener) || !rule.includes('``' + opener + '``')) problems.push(`rules/callboard.md does not quote the cue opener exactly: ${opener}`)
}

// The closed-ask turn (unattended mode): the rule quotes how it opens.
const CLOSED_OPENER = '[callboard] Closed: the person is away and nobody is above you to decide this.'
if (!T['ask.away']().startsWith(CLOSED_OPENER) || !quoted(CLOSED_OPENER)) problems.push(`rules/callboard.md does not quote the closed-ask opener exactly: ${CLOSED_OPENER}`)

// The nudge section lists each opener as a backquoted line that starts with [callboard]; a trailing " ..." marks where the quote stops.
const nudgeSection = rule.split('## The compaction nudge')[1]?.split('\n## ')[0] ?? ''
const openers = [...nudgeSection.matchAll(/^ {2}- `(\[callboard\] [^`]*?)(?: \.\.\.)?`/gm)].map((m) => m[1])
const kinds = Object.keys(T).filter((id) => id.startsWith('nudge.')).map((id) => id.slice(6))
const texts = kinds.map((kind) => T[`nudge.${kind}`]({ k: { idle: 300, working: 400, cache: 150 }[kind] ?? 300 }))
if (openers.length !== texts.length) problems.push(`rules/callboard.md lists ${openers.length} nudge openers, the plugin has ${texts.length} nudge texts`)
for (const opener of openers) {
  if (texts.filter((t) => t.startsWith(opener)).length !== 1) problems.push(`no nudge text starts with the quoted opener: ${opener}`)
}
for (const [i, text] of texts.entries()) {
  if (!openers.some((o) => text.startsWith(o))) problems.push(`the ${kinds[i]} nudge has no quoted opener in rules/callboard.md`)
}

// The sentence on the layer above: a lane's briefing carries it with its parent's name; the rule carries the form for a session with no named parent,
// word for word, wrapped over its own lines. That form is in the lead's briefing, taken from there by its opening words.
const lead = T['brief.parent']({ name: 'A', sid: 'S', repos: [], rules: '', rulesCut: false })
const chain = lead.split('\n').map((l) => l.replace(/^- /, '')).find((l) => l.startsWith('An instruction from the layer directly above you'))
if (!chain) problems.push('the lead briefing no longer carries the sentence on the layer above')
else if (!rule.replace(/\s+/g, ' ').includes(`- ${chain} `)) problems.push("rules/callboard.md does not carry the briefings' sentence on the layer above exactly")

// The plan-first sentence: a lane's briefing carries it as a line of its own; the rule carries it word for word.
const planFirst = T['brief.child']({ name: 'A', sid: 'S', parent: 'P', lead: true }).split('\n').map((l) => l.replace(/^- /, '')).find((l) => l.startsWith('A brief is a task, not an approved plan'))
if (!planFirst) problems.push('the lane briefing no longer carries the plan-first sentence')
else if (!rule.replace(/\s+/g, ' ').includes(`- ${planFirst} `)) problems.push("rules/callboard.md does not carry the briefing's plan-first sentence exactly")

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log(`rules/callboard.md matches the plugin: keepalive, PR notice, signed-done line, check-in, cue and own-step openers, ${openers.length} nudge openers, the layer-above and plan-first sentences`)
