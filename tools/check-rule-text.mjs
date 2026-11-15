// Checks that rules/callboard.md quotes the callboard mod's fixed texts exactly: the keepalive text, the prompt notice and
// the opener of each of the four compaction nudges. A session matches those turns against the rule, so a drifted word
// would make it treat a real turn as an ordinary message.
//   node tools/check-rule-text.mjs
// Exit 0 when every quote matches, 1 with one line per mismatch, 2 when a file cannot be read. Needs node 22.18 or later,
// which runs the mod's TypeScript as it is.
// It lives here, not under tools/callboard, because the callboard folder stays self-contained: it knows nothing of rules/.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hooks = join(root, 'tools/callboard/mod/hooks')
let rule, core, prompts
try {
  rule = readFileSync(join(root, 'rules/callboard.md'), 'utf8')
  core = await import(join(hooks, 'core.ts'))
  prompts = await import(join(hooks, 'prompts.ts'))
} catch (e) {
  console.error(`cannot load: ${e.message}`)
  process.exit(2)
}

const problems = []
const quoted = (text) => rule.includes('`' + text + '`')

if (!quoted(core.KEEPALIVE_TEXT)) problems.push('rules/callboard.md does not quote KEEPALIVE_TEXT exactly')
if (!quoted(prompts.PROMPT_NOTICE_TEXT)) problems.push('rules/callboard.md does not quote PROMPT_NOTICE_TEXT exactly')

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

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log(`rules/callboard.md matches the mod: keepalive, prompt notice, ${openers.length} nudge openers`)
