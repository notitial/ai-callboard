// The plain files under ~/.claude/callboard/v2 and the engine's registry, read and written: the session table, the settings, the goes, the window, the manager's two files, the ask
// log, and the one reading of the machine (`getView`) every step of a tick shares. Trust rules held here: a read that is in doubt is `unknown`, never "no sessions"; a file that fails
// its parse is no file; the table is written under one lock by read-modify-write, and an unreadable table is never overwritten.
import { parseConfig } from '../core/commands.ts'
import { parseGo } from '../core/go.ts'
import type { AskLogRow, Config, Go, ManagerName, Registry, RegistryRow, Row, Sid, Table, View } from '../core/model.ts'
import { liveView } from '../core/model.ts'
import { run, home, path, readText, writeFile, locked, rm } from './io.ts'
import { mem, staleView } from './mem.ts'

const SID_RE = /^[A-Za-z0-9-]{1,64}$/
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/
const REGISTRY_MAX = 200
export const VIEW_MS = 10_000
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : undefined)
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)

// ---- the registry: the engine's rows, each confirmed by one `ps` for every pid and start time ----
function rowOf(j: any, file: string): RegistryRow | undefined {
  if (typeof j !== 'object' || j === null || String(j.pid) !== file.slice(0, -5) || typeof j.sessionId !== 'string' || !SID_RE.test(j.sessionId) || typeof j.procStart !== 'string' || typeof j.cwd !== 'string') return undefined
  return { sid: j.sessionId, pid: Number(j.pid), procStart: j.procStart, folder: j.cwd, name: str(j.name), nameSource: str(j.nameSource), status: str(j.status), statusAt: num(j.statusUpdatedAt), waitingFor: str(j.waitingFor) ?? null, kind: str(j.kind) }
}
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
// The rows whose pid is alive with the same start time, or `unknown`: too many files, a file that is there and stays unreadable or unparseable, two rows of one session id, a `ps` that failed or printed nothing, or no row of the
// reading session's own (a live session always has one, so a read without it is in doubt).
export async function readRegistry($: any, self: Sid): Promise<Registry> {
  const h = await home($)
  if (h === undefined) return 'unknown'
  const dir = `${h}/.claude/sessions`
  const files = ((await $.fs.list(dir).catch(() => undefined)) as { name: string; kind?: string }[] | undefined)?.filter((f) => /^[0-9]{1,10}\.json$/.test(f.name) && (f.kind ?? 'file') === 'file')
  if (files === undefined || files.length > REGISTRY_MAX) return 'unknown'
  let doubt = false
  const rows = await Promise.all(
    files.map(async (f) => {
      for (let i = 0; i < 2; i++) {
        const t = await $.fs.read(`${dir}/${f.name}`, { length: 16_385 }).catch(() => null)
        if (t === null && !(await $.fs.exists(`${dir}/${f.name}`).catch(() => true))) return undefined
        try {
          if (t !== null) return rowOf(JSON.parse(t), f.name)
        } catch {}
      }
      doubt = true
      return undefined
    }),
  )
  const ps = await run($, ['/bin/ps', '-A', '-o', 'pid=,lstart='], { env: { TZ: 'UTC', LC_ALL: 'C' } }).catch(() => undefined)
  if (doubt || ps === undefined || ps.exitCode !== 0 || ps.isStdoutTruncated === true) return 'unknown'
  const starts = new Map([...ps.stdout.matchAll(/^\s*(\d+)\s+(.+?)\s*$/gm)].map((m) => [Number(m[1]), squash(m[2]!)] as const))
  const live = rows.filter((r): r is RegistryRow => r !== undefined && starts.get(r.pid) === squash(r.procStart))
  return starts.size > 0 && live.some((r) => r.sid === self) && new Set(live.map((r) => r.sid)).size === live.length ? live : 'unknown'
}

// ---- the session table ----
function parseTable(text: string): Table | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return undefined
  const t: Table = {}
  for (const [k, r] of Object.entries(j)) {
    const o = r as Record<string, unknown> | null
    if (!KEY_RE.test(k) || typeof o !== 'object' || o === null || typeof o.name !== 'string' || typeof o.folder !== 'string') continue
    const lead = o.lead as { repos?: unknown } | undefined
    const row: Row = { name: o.name, folder: o.folder }
    for (const f of ['report', 'under', 'brief'] as const) if (typeof o[f] === 'string') row[f] = o[f] as string
    for (const f of ['parked', 'goneAt'] as const) if (num(o[f]) !== undefined) row[f] = num(o[f])
    if (typeof lead === 'object' && lead !== null && Array.isArray(lead.repos)) row.lead = { repos: lead.repos.filter((x): x is string => typeof x === 'string') }
    if (o.off === true) row.off = true
    t[k] = row
  }
  return t
}
// The table as the file holds it; no file is the empty table, an unreadable one is `undefined`.
async function readTable($: any): Promise<Table | undefined> {
  const p = await path($, 'sessions.json')
  if (p === undefined) return undefined
  if (!(await $.fs.exists(p).catch(() => true))) return {}
  const t = await readText($, p, 262_144)
  return t === undefined ? undefined : parseTable(t)
}
// One writer at a time: the table is read again inside the lock, `f` makes the new one, and the file is replaced. false: nothing was written.
export async function updateTable($: any, f: (t: Table) => Table): Promise<boolean> {
  const p = await path($, 'sessions.json')
  const done = p === undefined ? false : await locked($, 'sessions', async () => {
    const cur = await readTable($)
    return cur !== undefined && (await writeFile($, p, JSON.stringify(f(cur))))
  })
  staleView()
  return done === true
}

// ---- the manager's files and the settings ----
// The manager-name file's one line: null for no file, `unknown` for one that could not be read.
async function readManagerName($: any): Promise<ManagerName> {
  const h = await home($)
  if (h === undefined) return 'unknown'
  const p = `${h}/.claude/callboard/manager-name`
  if (!(await $.fs.exists(p).catch(() => true))) return null
  const t = await readText($, p, 256)
  return t === undefined ? 'unknown' : t.split('\n', 1)[0]!.trim() || null
}
// The manager's rules, at most 8 KB.
export async function readRules($: any): Promise<string | null> {
  const h = await home($)
  return h === undefined ? null : ((await readText($, `${h}/.claude/callboard/manager-rules.md`, 8192)) ?? null)
}
export async function cfgNow($: any): Promise<Config> {
  const now = await $.clock.now()
  if (mem.cfg !== undefined && now - mem.cfg.at < 60_000) return mem.cfg.c
  const p = await path($, 'config.json')
  const t = p === undefined ? undefined : await readText($, p, 1024)
  let raw: unknown
  try {
    raw = t === undefined ? undefined : JSON.parse(t)
  } catch {}
  mem.cfg = { at: now, c: t === undefined && mem.cfg !== undefined ? mem.cfg.c : parseConfig(raw) }
  return mem.cfg.c
}
export async function writeConfig($: any, c: Config): Promise<boolean> {
  const p = await path($, 'config.json')
  mem.cfg = undefined
  return p !== undefined && writeFile($, p, JSON.stringify(c))
}

// ---- goes and the window: written only by his typed command (and, in the ask steps, his click) ----
export async function listGoes($: any): Promise<Go[]> {
  const d = await path($, 'go')
  const names = d === undefined ? [] : (((await $.fs.list(d).catch(() => [])) as { name: string }[]) ?? []).filter((f) => /^[A-Za-z0-9]{4,32}\.json$/.test(f.name)).slice(0, 64)
  const now = await $.clock.now()
  const goes = await Promise.all(
    names.map(async (f) => {
      const t = await readText($, `${d}/${f.name}`, 2048)
      const g = t === undefined ? undefined : parseGo(safeJson(t))
      return g?.id === f.name.slice(0, -5) ? g : undefined
    }),
  )
  const ended = goes.filter((g): g is Go => g !== undefined && g.end < now - 3_600_000)
  await Promise.all(ended.map((g) => rmGo($, g.id)))
  return goes.filter((g): g is Go => g !== undefined && !ended.includes(g))
}
export const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}
export async function writeGo($: any, g: Go): Promise<boolean> {
  const p = await path($, 'go', `${g.id}.json`)
  return p !== undefined && writeFile($, p, JSON.stringify(g))
}
export async function rmGo($: any, id: string): Promise<boolean> {
  const p = /^[A-Za-z0-9]{4,32}$/.test(id) ? await path($, 'go', `${id}.json`) : undefined
  return p !== undefined && rm($, [p])
}
export async function writeWindow($: any, w: { start: number; end: number; readAt: number } | null): Promise<boolean> {
  const p = await path($, 'unattended.json')
  mem.win = undefined
  if (p === undefined) return false
  return w === null ? (await rm($, [p])) && !(await $.fs.exists(p).catch(() => true)) : writeFile($, p, JSON.stringify(w))
}
// The ask log's rows since a time, from the last 256 KB of this month's file and of the month before when the time reaches back to it; a line that is not a row is dropped. undefined: a file is there and could not be read.
export async function readAskLog($: any, since: number): Promise<AskLogRow[] | undefined> {
  const out: AskLogRow[] = []
  for (const at of [new Date(since), new Date()]) {
    const p = await path($, `asks-${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}.jsonl`)
    const size = p === undefined ? undefined : ((await $.fs.stat(p).catch(() => undefined)) as { size: number } | undefined)?.size
    if (p === undefined || size === undefined) continue
    const t = (await $.fs.read(p, { offset: Math.max(0, size - 262_144), length: 262_144 }).catch(() => undefined)) as string | undefined
    if (t === undefined) return undefined
    for (const l of t.split('\n')) {
      const r = safeJson(l) as Partial<AskLogRow> | undefined
      if (r && typeof r.t === 'number' && r.t >= since && typeof r.ev === 'string' && typeof r.ask === 'string' && typeof r.asker === 'string' && !out.some((o) => o.t === r.t && o.ask === r.ask && o.ev === r.ev)) out.push(r as AskLogRow)
    }
  }
  return out
}

// ---- the reading of the machine ----
// The registry, the table and the manager's name, as one view kept VIEW_MS: every step of a tick and every tool call in it share one read. A table that cannot be read keeps the last good
// one; with none, nothing is known of who is whose, so the whole reading is `unknown`.
export async function getView($: any, force = false): Promise<View> {
  const now = await $.clock.now()
  if (!force && mem.view !== undefined && now - mem.view.at < VIEW_MS) return mem.view.v
  const me = (await $.session.id()) as Sid
  const [reg, table, name] = await Promise.all([readRegistry($, me), readTable($), readManagerName($)])
  const last = table ?? mem.view?.v.table
  const v = liveView(last === undefined ? 'unknown' : reg, last ?? {}, name)
  mem.view = { at: now, v }
  return v
}
