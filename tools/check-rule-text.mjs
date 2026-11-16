// Checks that rules/callboard.md quotes the callboard mod's fixed texts exactly: the keepalive text, the prompt notice, the
// opener and the closing line of the PR notice, the opener of the signed-done notice, and the opener of each of the four compaction nudges. A session matches those turns against the rule, so a drifted word
// would make it treat a real turn as an ordinary message.
// It also checks that the rule carries the briefings' sentence on instructions from a session's own chain (CHAIN_TRUST) word for word.
//   node tools/check-rule-text.mjs
// Exit 0 when every quote matches, 1 with one line per mismatch, 2 when a file cannot be read. Needs node 22.18 or later,
// which runs the mod's TypeScript as it is.
// It lives here, not under tools/callboard, because the callboard folder stays self-contained: it knows nothing of rules/.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hooks = join(root, 'tools/callboard/mod/hooks')
let rule, core, prompts, prWatch
try {
  rule = readFileSync(join(root, 'rules/callboard.md'), 'utf8')
  core = await import(join(hooks, 'core.ts'))
  prompts = await import(join(hooks, 'prompts.ts'))
  prWatch = await import(join(hooks, 'pr-watch.ts'))
} catch (e) {
  console.error(`cannot load: ${e.message}`)
  process.exit(2)
}

const problems = []
const quoted = (text) => rule.includes('`' + text + '`')

if (!quoted(core.KEEPALIVE_TEXT)) problems.push('rules/callboard.md does not quote KEEPALIVE_TEXT exactly')
if (!quoted(prompts.PROMPT_NOTICE_TEXT)) problems.push('rules/callboard.md does not quote PROMPT_NOTICE_TEXT exactly')
// The PR notice: the rule quotes how it opens and its closing line.
const PR_OPENER = '[callboard] PR notice.'
if (!prWatch.PR_NOTICE_HEAD.startsWith(`${PR_OPENER} `) || !quoted(PR_OPENER)) problems.push('rules/callboard.md does not quote the opener of PR_NOTICE_HEAD exactly')
if (!quoted(prWatch.PR_NOTICE_TAIL)) problems.push('rules/callboard.md does not quote PR_NOTICE_TAIL exactly')

// The signed-done notice: the rule quotes how it opens.
const DONE_OPENER = '[callboard] Signed done:'
if (!core.doneText([{ lane: 'A', code: 'done', since: 0 }])?.startsWith(`${DONE_OPENER} `) || !quoted(DONE_OPENER)) problems.push('rules/callboard.md does not quote the opener of the signed-done notice exactly')

// The nudge section lists each opener as a backquoted line that starts with [callboard]; a trailing " ..." marks where the quote stops.
const nudgeSection = rule.split('## The compaction nudge')[1]?.split('\n## ')[0] ?? ''
const openers = [...nudgeSection.matchAll(/^ {2}- `(\[callboard\] [^`]*?)(?: \.\.\.)?`/gm)].map((m) => m[1])
// The order (kind lead) has a second wording for a session holding a lead grant, told by its conductor.
const texts = [...core.NUDGE_KINDS.map((kind) => core.nudgeText(kind)), core.nudgeText('lead', core.CONFIG_DEFAULTS, 'lead')]
if (openers.length !== texts.length) problems.push(`rules/callboard.md lists ${openers.length} nudge openers, the mod has ${texts.length} nudge texts`)
for (const opener of openers) {
  if (texts.filter((t) => t.startsWith(opener)).length !== 1) problems.push(`no nudge text starts with the quoted opener: ${opener}`)
}
for (const [i, text] of texts.entries()) {
  if (!openers.some((o) => text.startsWith(o))) problems.push(`the ${core.NUDGE_KINDS[i] ?? 'lead (to a lead)'} nudge has no quoted opener in rules/callboard.md`)
}

// The chain sentence: the rule carries the briefings' sentence word for word, wrapped over its own lines.
if (typeof core.CHAIN_TRUST !== 'string' || !rule.replace(/\s+/g, ' ').includes(`- ${core.CHAIN_TRUST} `)) problems.push('rules/callboard.md does not carry CHAIN_TRUST exactly')

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log(`rules/callboard.md matches the mod: keepalive, prompt notice, PR notice, signed-done notice, ${openers.length} nudge openers`)
