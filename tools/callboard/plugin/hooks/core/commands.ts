// The /callboard command: its twelve forms, the settings schema, and the origin rule. Pure. Trust rule held here: a form that is not read-only (it widens what a session
// may do, or changes a setting or a go or the window) runs only when the caller says it came from the person's own typed turn. The origin is an input: the adapter decides
// it (the probe of a typed turn is not run yet), and originOk below is the one place it is judged. Anything but exactly `typed` counts as not typed.
import type { Config, Decision, LaneEffort, LaneModel } from './model.ts'
import { LANE_EFFORTS, LANE_MODELS, NAME_RE, refusal } from './model.ts'
import { goCommand } from './go.ts'
import { parseSpan } from './unattended.ts'
import type { SpanOp } from './unattended.ts'

export const CONFIG_DEFAULTS: Readonly<Config> = Object.freeze({ keepalive: true, pingAfterMin: 50, stopAfterH: 2, idleK: 300, workingK: 400 })
export const CONFIG_RANGE = { pingAfterMin: [30, 55], stopAfterH: [1, 8], idleK: [150, 800], workingK: [150, 900] } as const
type Num = keyof typeof CONFIG_RANGE
const inRange = (k: Num, v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= CONFIG_RANGE[k][0] && v <= CONFIG_RANGE[k][1]
// The settings file as read: a field only when it has the right type and lies in its range, else its default; a working level under the idle level gives both defaults.
export function parseConfig(raw: unknown): Config {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const cfg: Config = { ...CONFIG_DEFAULTS, ...(typeof r.keepalive === 'boolean' ? { keepalive: r.keepalive } : {}) }
  for (const k of Object.keys(CONFIG_RANGE) as Num[]) if (Object.hasOwn(r, k) && inRange(k, r[k])) cfg[k] = r[k]
  return cfg.workingK < cfg.idleK ? { ...cfg, idleK: CONFIG_DEFAULTS.idleK, workingK: CONFIG_DEFAULTS.workingK } : cfg
}

export type ConfigOp = 'show' | 'reset' | { key: 'keepalive'; value: boolean } | { key: Num; value: number }
export type Cmd =
  | { op: 'status' | 'lanes' | 'help' | 'lead-off' | 'off' | 'on' | 'rest' }
  | { op: 'lead'; paths: string[]; preset?: Preset }
  | { op: 'go'; text: string }
  | { op: 'go-off'; id?: string }
  | { op: 'unattended'; span: Extract<SpanOp, { op: 'state' | 'off' | 'on' }> }
  | { op: 'config'; config: ConfigOp }
// A form that does not parse: `detail` says a window length that does not fit; none is the usage line.
export type Bad = { op: 'bad'; detail?: 'short' | 'long' }
// The new settings after one change, or undefined when the idle level would pass the working one.
export function configNext(cur: Config, op: Exclude<ConfigOp, 'show'>): Config | undefined {
  const next = op === 'reset' ? { ...CONFIG_DEFAULTS } : ({ ...cur, [op.key]: op.value } as Config)
  return next.idleK > next.workingK ? undefined : next
}
const WORDS = ['status', 'lanes', 'help', 'off', 'on', 'rest'] as const
const KEYS: Record<string, Num> = Object.assign(Object.create(null), { ping: 'pingAfterMin', stop: 'stopAfterH', idle: 'idleK', working: 'workingK' })
function parseConfigArgs(a: string[]): ConfigOp | undefined {
  if (a.length === 0) return 'show'
  if (a.length === 1 && a[0] === 'reset') return 'reset'
  if (a[0] === 'keepalive' && a.length === 2 && (a[1] === 'on' || a[1] === 'off')) return { key: 'keepalive', value: a[1] === 'on' }
  const m = a.length === 2 ? /^([1-9][0-9]{0,3})(k?)$/.exec(a[1]) : null
  const key = KEYS[a[0]]
  // A trailing k is thousands of tokens, so it fits only the two levels.
  return m && key !== undefined && (m[2] === '' || key === 'idleK' || key === 'workingK') && inRange(key, Number(m[1])) ? { key, value: Number(m[1]) } : undefined
}
// The words after /callboard, as one form. Paths are taken as typed (absolute, or from home); the adapter resolves them.
export function parseCommand(args: string, now: number): Cmd | Bad {
  const t = args.trim()
  const w = t.split(/\s+/, 1)[0]
  const rest = t.slice(w.length).trim()
  const a = rest === '' ? [] : rest.split(/\s+/)
  const bad: Bad = { op: 'bad' }
  if ((WORDS as readonly string[]).includes(w)) return a.length === 0 ? { op: w as (typeof WORDS)[number] } : bad
  if (w === 'lead') return rest === 'off' ? { op: 'lead-off' } : a.every((p) => /^~?\/[^\u0000-\u001f\u007f-\u009f]*$/.test(p)) ? { op: 'lead', paths: a } : bad
  if (w === 'go') {
    const g = goCommand(rest)
    return g === 'bad' ? bad : g.op === 'give' ? { op: 'go', text: g.text } : { op: 'go-off', ...(g.id === undefined ? {} : { id: g.id }) }
  }
  if (w === 'unattended') {
    const s = parseSpan(rest, now)
    return s.op === 'bad' ? bad : s.op === 'short' || s.op === 'long' ? { op: 'bad', detail: s.op } : { op: 'unattended', span: s }
  }
  const config = w === 'config' ? parseConfigArgs(a) : undefined
  return config === undefined ? bad : { op: 'config', config }
}

// The one place a command's origin is judged. Only the read-only forms, and `rest` (it touches this session's own pings), run from anywhere.
export type Origin = 'typed' | 'other'
const OPEN = new Set(['status', 'lanes', 'help', 'rest'])
export const originOk = (cmd: Cmd, origin: Origin): boolean =>
  origin === 'typed' || OPEN.has(cmd.op) || (cmd.op === 'config' && cmd.config === 'show') || (cmd.op === 'unattended' && cmd.span.op === 'state')

// What to do with the words typed: run the form, or refuse (a usage line, a window length that does not fit, an origin that is not his typed turn).
export function planCommand(args: string, origin: Origin, now: number): { act: 'run'; cmd: Cmd } | Decision<'refuse'> {
  const cmd = parseCommand(args, now)
  if (cmd.op === 'bad') return cmd.detail === undefined ? { act: 'refuse', msg: 'cmd.usage', p: {} } : refusal('refuse', 'bad-input', { tool: 'callboard', target: 'unattended', detail: cmd.detail })
  return originOk(cmd, origin) ? { act: 'run', cmd } : refusal('refuse', 'bad-origin', { tool: 'callboard', target: cmd.op })
}

// A folder's lead preset (.claude/callboard-lead.json): the command that makes a session there a lead, and the name, model and effort it is given. A file that is not an
// object with all four fields right, or whose command is one of callboard's own, is no preset. Whether the command is a built-in is the engine's to check.
export type Preset = { command: string; name: string; model: LaneModel; effort: LaneEffort }
const OWN_COMMANDS: readonly string[] = ['callboard', 'rest', 'unattended']
export function parsePreset(text: string | undefined): Preset | undefined {
  let r: Record<string, unknown> | null
  try {
    r = JSON.parse(text ?? '')
  } catch {
    return undefined
  }
  const { command, name, model, effort } = r ?? {}
  const ok = typeof command === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(command) && !OWN_COMMANDS.includes(command) && typeof name === 'string' && NAME_RE.test(name)
  return ok && (LANE_MODELS as readonly unknown[]).includes(model) && (LANE_EFFORTS as readonly unknown[]).includes(effort) ? { command, name, model: model as LaneModel, effort: effort as LaneEffort } : undefined
}
