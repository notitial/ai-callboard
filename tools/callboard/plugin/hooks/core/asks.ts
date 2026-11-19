// The ask, as one timeline: who may decide it now (eligible), when it closes, which answer counts, and what a reader is shown of it. Pure. Trust rules held here:
// an ask's deciders are only sessions above its asker now (or the person); every ask closes at 15 minutes awake; a liveness that cannot be read never closes anything
// early and never moves an owner.
import type { Answer, Ask, Decision, Person, Question, RaisedBy, Sid, UpMark, View } from './model.ts'
import { PERSON, chain, liveness, nameOf, refusal } from './model.ts'
import type { RefuseCode } from './msg.ts'

export const HEAD_START_MS = 30_000 // wall time: hidden this long by day
export const MANAGER_AT_MS = 5 * 60_000 // awake: the manager is reached whatever happened below
export const EXPIRE_MS = 15 * 60_000 // awake: every ask closes
export const STALE_BEAT_MS = 60_000
export const SWEEPER_AWAKE_MS = 90_000
const AWAKE_GAP_CAP_MS = 10_000

// Awake time: the gap since the last poll, never more than the cap and never negative (a clock that ran back or a Mac that slept adds nothing).
export const awakeAdd = (awake: number, gapMs: number): number => awake + (Number.isFinite(gapMs) ? Math.min(Math.max(gapMs, 0), AWAKE_GAP_CAP_MS) : 0)

export type StageIn = { ask: Ask; now: number; ups: readonly UpMark[]; v: View }
// reach: how many sessions of the chain the ask has reached (0: hidden). toPerson: its next owner is past the chain. relay: by day the manager's pop-up shows it.
export type Open = { open: true; reach: number; eligible: Sid[]; toPerson: boolean; relay: boolean; top: Person | 'unknown' }
export type Stage = Open | ({ open: false } & Decision<'deny'>)

// An off session's ask is never staged: the hook's first line (isOff) returns the dialog to him before any ask exists, the one place managed-or-not is decided.

export function stage(x: StageIn): Stage {
  const c = chain(x.v, x.ask.asker)
  let reach = x.now - x.ask.t0 >= HEAD_START_MS ? 1 : 0
  // An escalation by a session of the chain moves the ask one past it, at once; one by a session no longer above the asker counts for nothing.
  for (const u of x.ups) if (reach > 0 && u.kind === 'escalated' && c.up.includes(u.by)) reach = Math.max(reach, c.up.indexOf(u.by) + 2)
  if (reach > 0 && x.ask.awake >= MANAGER_AT_MS) {
    const m = c.up.indexOf(x.v.manager as Sid)
    reach = Math.max(reach, m >= 0 ? m + 1 : c.up.length + (c.top === PERSON ? 1 : 0))
  }
  const toPerson = reach > c.up.length && c.top === PERSON
  const p = { parent: c.up.length > 0 ? nameOf(x.v, c.up[0]) : c.top }
  if (x.ask.awake >= EXPIRE_MS) return { open: false, act: 'deny', msg: 'ask.expired', p }
  // A session told of the ask stays eligible while it is above the asker: a lead that restarts does not take an ask back from the manager. An escalation ends the
  // right of the escalator and of everyone below it, save the manager, who answers on the person's words.
  const top = Math.max(-1, ...x.ups.filter((u) => u.kind === 'escalated').map((u) => c.up.indexOf(u.by)))
  const marked = x.ups.map((u) => u.by).filter((s) => c.up.includes(s))
  const eligible = [...new Set([...c.up.slice(0, reach), ...marked])].filter((s) => c.up.indexOf(s) > top || s === x.v.manager)
  const relay = toPerson && reach > 0 && typeof x.v.manager === 'string' && x.v.manager !== 'unknown' && x.v.manager !== x.ask.asker
  return { open: true, reach, eligible, toPerson, relay, top: c.top }
}

// One check for an answer: it names this ask, and its author is eligible now, or the person on an ask that has reached him (the relay pop-up). Then it must fit
// the ask: deny for either kind; allow for a permission ask and answer for a question, each only on an input a reader saw whole. The label comes from the live input.
export type Verdict = Decision<'allow' | 'deny' | 'ignore'> | (Decision<'answer'> & { question: string })
export function decide(a: Answer, ask: Ask, s: Open, v: View, liveInput: unknown): Verdict {
  const no = (code: RefuseCode): Verdict => refusal('ignore', code, { tool: 'prompt_answer', target: ask.id })
  if (a.ask !== ask.id) return no('no-such-ask')
  const by = a.by === PERSON ? PERSON : nameOf(v, a.by)
  if (a.by === PERSON ? !s.toPerson : !s.eligible.includes(a.by)) return no('not-eligible')
  if (a.decision === 'deny') return { act: 'deny', msg: 'ask.denyText', p: { by, note: a.note ?? '' } }
  if (ask.cut) return no('input-cut')
  const isQuestion = ask.tool === QUESTION_TOOL
  if (a.decision === 'allow') return isQuestion ? no('bad-input') : { act: 'allow', msg: 'ask.allowed', p: { ask: ask.id } }
  const pick = isQuestion && a.option !== undefined ? answerOf(liveInput, a.option) : undefined
  return pick === undefined ? no('bad-input') : { act: 'answer', msg: 'ask.answerText', p: { label: pick.label, by }, question: pick.question }
}

// The sweep of one ask file by any session's tick: a dead asker's ask ends; a live asker's beat is judged only once the sweeper itself has been awake long enough
// since its last wake (a Mac that slept stops every beat alike), and then it is only marked stale. A live asker that finds its file stale or gone writes it again.
export function sweep(ask: Ask, v: View, now: number, sweeperAwake: number): 'keep' | 'sweep' | 'stale' {
  const l = liveness(v, ask.asker)
  return l === 'no' ? 'sweep' : l === 'yes' && sweeperAwake >= SWEEPER_AWAKE_MS && now - ask.beat > STALE_BEAT_MS ? 'stale' : 'keep'
}

// ---- what raised it ----
// What tool.check reported for the call, joined by session, tool and input hash. None (no entry, two identical calls, one too old): raised by `unknown`.
export type CheckFacts = { decision?: unknown; reason?: unknown; rule?: unknown; hook?: unknown; setting?: unknown; plugin?: unknown; ceiling?: unknown }
export const QUESTION_TOOL = 'AskUserQuestion'
const GUARD_PREFIX = 'github-mcp-guard: '
const GUARD_TOOLS = ['mcp__github__create_pull_request', 'mcp__github__add_issue_comment', 'mcp__github__add_reply_to_pull_request_comment', 'mcp__github__update_pull_request']
const set = (x: unknown): boolean => x !== undefined && x !== null && x !== ''
// The widest source behind the ask; it changes nothing about who may decide it.
export function classify(tool: string, f: CheckFacts | undefined): RaisedBy {
  if (f === undefined) return 'unknown'
  const guard = f.hook === 'PreToolUse' && !set(f.rule) && typeof f.reason === 'string' && f.reason.startsWith(GUARD_PREFIX) && GUARD_TOOLS.includes(tool)
  return set(f.ceiling) ? 'ceiling' : set(f.setting) ? 'setting' : set(f.plugin) ? 'plugin' : set(f.hook) ? (guard ? 'guard' : 'hook') : set(f.rule) ? 'rule' : 'mode'
}

// ---- questions ----
const obj = (x: unknown): Record<string, unknown> => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
const LABEL_MAX = 200
// A label may not hold a control character, a line or paragraph break, a bidi override or isolate, or a zero-width or tag character: text that can hide or reorder
// what a reader sees.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/u
// A label as every reader sees it: redacted, then trimmed, in that order.
const labelOf = (l: unknown): string => redact(str(l)).trim()
const labels = (input: unknown): unknown[] => {
  const qs = obj(input).questions
  const o = Array.isArray(qs) ? obj(qs[0]).options : undefined
  return Array.isArray(o) ? o.slice(0, 8).map((x) => obj(x).label) : []
}
// A question a session may answer: one question, single select, 2 to 4 distinct plain labels (raw and as read), a text, a header that is not Person, no answers yet.
export function questionShape(input: unknown): { ok: true } | { ok: false; code: 'question-count' | 'question-multi' | 'question-options' | 'question-person' | 'question-shape' } {
  const i = obj(input)
  if (!Array.isArray(i.questions) || i.questions.length !== 1) return { ok: false, code: 'question-count' }
  const q = obj(i.questions[0])
  if (q.multiSelect === true) return { ok: false, code: 'question-multi' }
  const raw = labels(input)
  const n = Array.isArray(q.options) ? q.options.length : 0
  const plain = raw.every((l) => typeof l === 'string' && l.trim() !== '' && bytes(l) <= LABEL_MAX && bytes(labelOf(l)) <= LABEL_MAX && !CONTROL_RE.test(l))
  if (n < 2 || n > 4 || !plain || new Set(raw.map((l) => str(l).trim())).size !== n || new Set(raw.map(labelOf)).size !== n) return { ok: false, code: 'question-options' }
  if (str(q.header).trim().toLowerCase() === 'person') return { ok: false, code: 'question-person' }
  if (typeof q.question !== 'string' || (q.header !== undefined && typeof q.header !== 'string') || 'answers' in i) return { ok: false, code: 'question-shape' }
  return { ok: true }
}
// What a reader is shown of a question: header, text and options, each redacted and capped as inputText caps a string (which then marks the ask cut).
export function questionView(input: unknown): Question | undefined {
  if (!questionShape(input).ok) return undefined
  const q = obj((obj(input).questions as unknown[])[0])
  const t = (x: unknown): string => shown(str(x), STRING_CAP).text
  return { header: t(q.header), question: t(q.question), options: (q.options as unknown[]).map((o) => ({ label: labelOf(obj(o).label), description: t(obj(o).description) })) }
}
// The chosen option (1-based, as prompt_answer takes it) from the LIVE input, never from the answer file: the question's text and the label as the asker wrote it.
export function answerOf(liveInput: unknown, option: number): { question: string; label: string } | undefined {
  if (!questionShape(liveInput).ok || !Number.isInteger(option)) return undefined
  const q = obj((obj(liveInput).questions as unknown[])[0])
  const l = labels(liveInput)[option - 1]
  return typeof l === 'string' ? { question: str(q.question), label: l.trim() } : undefined
}

// ---- redaction and capping: what a parent sees of the input. A copy of the toolkit's audit-logger.sh rules, best effort (that script says the same) ----
const REDACT: [RegExp, string | ((m: string, k: string) => string)][] = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED_PEM]'],
  [/-----BEGIN[^-]*PRIVATE KEY-----(?:\\[nrt]|[A-Za-z0-9+/=:,\s-])*/g, '[REDACTED_PEM]'],
  [/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/NR[A-Z][A-Z]-[A-Za-z0-9]+/g, '[REDACTED_NRKEY]'],
  [/(AKIA|ASIA)[A-Z0-9]+/g, '[REDACTED_AWSKEY]'],
  [/gh[pousr]_[A-Za-z0-9]+/g, '[REDACTED_GHTOKEN]'],
  [/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_GHTOKEN]'],
  [/glpat-[A-Za-z0-9_-]+/g, '[REDACTED_GLPAT]'],
  [/(?:(?<![A-Za-z0-9])|(?<=\\[nrt]))sk-(ant-)?[A-Za-z0-9_-]+/g, '[REDACTED_APIKEY]'],
  [/(sk|rk)_live_[A-Za-z0-9_-]+/g, '[REDACTED_STRIPE]'],
  [/AIza[A-Za-z0-9_-]+/g, '[REDACTED_GOOGLE]'],
  [/xox[bpasr]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:)[^@/\s]+@/gi, (_m, k) => `${k}[REDACTED]@`],
  [/(--(?:password|passwd|pass|token|secret|api[_-]?key|auth)\s+)[^\s-]\S*/gi, (_m, k) => `${k}[REDACTED]`],
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n|;&]*\s-p)[^\s=-]\S*/g, (_m, k) => `${k}[REDACTED]`],
  [/(\bBasic\s+)[A-Za-z0-9+/=]{8,}/g, (_m, k) => `${k}[REDACTED]`],
  [/((?:api[_-]?key|apikey|access[_-]?(?:token|key)|token|secret|password|passwd|[_-]pass|pwd|service_role[a-z_]*|client[_-]?secret)[A-Za-z0-9_]*"?\s*[=:]\s*"?)[^\s"&|;,]+/gi, (_m, k) => `${k}[REDACTED]`],
  [/([Bb]earer\s+)[A-Za-z0-9._-]+/g, (_m, k) => `${k}[REDACTED]`],
]
// An object key that names a secret: whatever string it holds is replaced.
const SECRET_KEY_RE = /(password|passwd|passphrase|pwd|secret|token(?!s)|api_?key|authorization|cookie|credential|private_?key|access_?key|bearer|(^|_)auth(_|$)|^(key|pass)$)/i
const secretKey = (k: string): boolean => SECRET_KEY_RE.test(k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_'))
export const redact = (s: string): string => REDACT.reduce((t, [re, to]) => t.replace(re, to as string), s)

const enc = new TextEncoder()
const bytes = (s: string): number => enc.encode(s).length
// The text cut to at most `max` bytes, never inside a character.
export function capBytes(s: string, max: number): { text: string; cut: boolean } {
  const b = enc.encode(s)
  if (b.length <= max) return { text: s, cut: false }
  return { text: new TextDecoder().decode(b.slice(0, max)).replace(/\ufffd+$/, ''), cut: true }
}
export const STRING_CAP = 10 * 1024
export const INPUT_CAP = 32 * 1024
const KEY_CAP = 200
// What a reader is shown of one string: capped before redaction (some patterns are super-linear on long text), redacted, then capped. changed: a pattern hit.
const shown = (s: string, max: number): { text: string; cut: boolean; changed: boolean } => {
  const head = capBytes(s, max + 512)
  const red = redact(head.text)
  const r = capBytes(red, max)
  return { text: r.text, cut: head.cut || r.cut, changed: red !== head.text }
}
// Text a shell or an interpreter could run: a redaction that removed some of it leaves the input cut, as a reader has not seen what runs.
const RUNNABLE_RE = /[$`(<>;|&\n\r]/
// The input as a parent reads it: every string redacted and capped, at most 12 deep, 200 items and 100 keys a level, the whole under INPUT_CAP; never throws.
// cut: a reader has not seen all of it, so no session may allow it.
export function inputText(input: unknown): { text: string; cut: boolean } {
  let cut = false
  const walk = (x: unknown, depth: number, secret: boolean): unknown => {
    if (typeof x === 'string') {
      if (secret) return ((cut ||= RUNNABLE_RE.test(x)), '[REDACTED]')
      const s = shown(x, STRING_CAP)
      cut ||= s.cut || (s.changed && RUNNABLE_RE.test(x))
      return s.text
    }
    if (x === null || x === undefined || typeof x === 'number' || typeof x === 'boolean') return x
    if (depth > 12) return ((cut = true), '[too deep]')
    if (Array.isArray(x)) return ((cut ||= x.length > 200), x.slice(0, 200).map((y) => walk(y, depth + 1, secret) ?? null))
    if (typeof x === 'object') {
      const keys = Object.keys(x).filter((k) => (x as Record<string, unknown>)[k] !== undefined)
      cut ||= keys.length > 100
      // A key shown other than as written, or as one already shown, hides an entry: the input is cut.
      // No prototype: a `__proto__` key is then an ordinary entry, found by hasOwn and shown, not a silent change of the object's prototype.
      const out: Record<string, unknown> = Object.create(null)
      for (const k of keys.slice(0, 100)) {
        const s = shown(k, KEY_CAP)
        cut ||= s.cut || s.changed || Object.hasOwn(out, s.text)
        out[s.text] = walk((x as Record<string, unknown>)[k], depth + 1, secret || secretKey(k))
      }
      return out
    }
    return ((cut = true), '[unsupported]')
  }
  const all = capBytes(JSON.stringify(walk(input, 0, false), null, 1) ?? 'null', INPUT_CAP)
  return { text: all.text, cut: cut || all.cut }
}
