// The plain files under ~/.claude/callboard/v2 and the engine's registry, read and written: the session table, the settings, the goes, the window, the manager's two files, the ask
// log, and the one reading of the machine (`getView`) every step of a tick shares. Trust rules held here: a read that is in doubt is `unknown`, never "no sessions"; a file that fails
// its parse is no file; the table is written under one lock by read-modify-write, and an unreadable table is never overwritten.
import { parseConfig } from '../core/commands.ts'
import { parseGo } from '../core/go.ts'
import type { Answer, Ask, AskLogRow, Config, Go, LaneEffort, LaneModel, ManagerName, Question, RaisedBy, Registry, RegistryRow, Row, Sid, Table, UpMark, View } from '../core/model.ts'
import { LANE_EFFORTS, LANE_MODELS, liveView } from '../core/model.ts'
import { createExcl, home, locked, path, readText, rm, run, writeFile } from './io.ts'
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
  const own = live.find((r) => r.sid === self)
  mem.ownPid = own?.pid
  return starts.size > 0 && own !== undefined && new Set(live.map((r) => r.sid)).size === live.length ? live : 'unknown'
}
// This session's own registry row, by one file read (not the whole registry): the row of the pid the last full read found, if it still names this session.
export async function readOwnRow($: any, self: Sid): Promise<RegistryRow | undefined> {
  const h = await home($)
  const t = h === undefined || mem.ownPid === undefined ? undefined : await readText($, `${h}/.claude/sessions/${mem.ownPid}.json`, 16_385)
  const r = t === undefined ? undefined : rowOf(safeJson(t), `${mem.ownPid}.json`)
  return r?.sid === self ? r : undefined
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
    const lead = o.lead as { repos?: unknown; conductor?: unknown; minted?: unknown } | undefined
    const row: Row = { name: o.name, folder: o.folder }
    for (const f of ['report', 'under', 'brief'] as const) if (typeof o[f] === 'string') row[f] = o[f] as string
    for (const f of ['parked', 'goneAt'] as const) if (num(o[f]) !== undefined) row[f] = num(o[f])
    // A row is a conductor or a minted lead, never both: a row that claims both is a minted lead, so the flag a conductor's powers rest on cannot ride on a minted row.
    if (typeof lead === 'object' && lead !== null && Array.isArray(lead.repos)) row.lead = { repos: lead.repos.filter((x): x is string => typeof x === 'string'), ...(lead.minted === true ? { minted: true as const } : lead.conductor === true ? { conductor: true as const } : {}) }
    if (o.off === true) row.off = true
    if ((LANE_MODELS as readonly unknown[]).includes(o.model)) row.model = o.model as LaneModel
    if ((LANE_EFFORTS as readonly unknown[]).includes(o.effort)) row.effort = o.effort as LaneEffort
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

// ---- the conductor's repos: kept per conductor folder, written only by his typed command ----
const CONDUCTOR_REPOS_MAX = 32
const conductorFile = (t: string | undefined): Record<string, unknown> => {
  const j = t === undefined ? undefined : safeJson(t)
  return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : {}
}
export async function conductorRepos($: any, folder: string): Promise<string[]> {
  const p = await path($, 'conductors.json')
  const l = conductorFile(p === undefined ? undefined : await readText($, p, 65_536))[folder]
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string' && x.startsWith('/')).slice(0, CONDUCTOR_REPOS_MAX) : []
}
export async function saveConductorRepos($: any, folder: string, repos: string[]): Promise<boolean> {
  const p = await path($, 'conductors.json')
  return p !== undefined && (await locked($, 'conductors', async () => writeFile($, p, JSON.stringify({ ...conductorFile(await readText($, p, 65_536)), [folder]: repos.slice(0, CONDUCTOR_REPOS_MAX) })))) === true
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
function askLogPath($: any, at: Date): Promise<string | undefined> {
  return path($, `asks-${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}.jsonl`)
}
// One row appended to this month's ask log. The raised and expired rows carry the tool name in `code`, so a notice can name it.
export async function logAsk($: any, row: Omit<AskLogRow, 't'>): Promise<void> {
  const now = await $.clock.now()
  const p = await askLogPath($, new Date(now))
  if (p !== undefined) await run($, ['/usr/bin/tee', '-a', '--', p], { stdin: `${JSON.stringify({ t: now, ...row })}\n` }).catch(() => undefined)
}
// Log files older than 90 days are removed.
export async function tidyAskLogs($: any): Promise<void> {
  const d = await path($)
  const now = await $.clock.now()
  const old = d === undefined ? [] : (((await $.fs.list(d).catch(() => [])) as { name: string }[]) ?? []).filter((f) => /^asks-\d{4}-\d{2}\.jsonl$/.test(f.name))
  for (const f of old) if (now - (((await $.fs.stat(`${d}/${f.name}`).catch(() => undefined)) as { mtimeMs: number } | undefined)?.mtimeMs ?? now) > 90 * 86_400_000) await rm($, [`${d}/${f.name}`])
}

// ---- the asks: asks/<id>.json (the asker's), <id>.answer (created exclusively), <id>.up.<session> (an escalation or a told mark, by that session) ----
const ASK_ID_RE = /^[a-z0-9]{8,32}$/
const RAISED: readonly RaisedBy[] = ['mode', 'rule', 'guard', 'hook', 'setting', 'plugin', 'ceiling', 'unknown']
function askPath($: any, id: string, ext = 'json'): Promise<string | undefined> {
  return ASK_ID_RE.test(id) ? path($, 'asks', `${id}.${ext}`) : Promise.resolve(undefined)
}
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
// An ask file read leniently: anything that is not an ask is no ask.
function parseAsk(j: any): Ask | undefined {
  if (typeof j !== 'object' || j === null || typeof j.id !== 'string' || !ASK_ID_RE.test(j.id) || typeof j.asker !== 'string' || !SID_RE.test(j.asker) || ![j.t0, j.awake, j.beat].every(isNum)) return undefined
  if (typeof j.cut !== 'boolean' || typeof j.tool !== 'string' || typeof j.input !== 'string' || !RAISED.includes(j.raisedBy)) return undefined
  const one = (q: any): Question | undefined => typeof q === 'object' && q !== null && typeof q.header === 'string' && typeof q.question === 'string' && Array.isArray(q.options) && q.options.every((o: any) => typeof o?.label === 'string') ? { header: q.header, question: q.question, options: q.options.map((o: any) => ({ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) })) } : undefined
  const question = one(j.question)
  const qs = Array.isArray(j.questions) ? j.questions.map(one) : []
  return { id: j.id, asker: j.asker, t0: j.t0, awake: j.awake, tool: j.tool, raisedBy: j.raisedBy, input: j.input, cut: j.cut, beat: j.beat, ...(question === undefined ? {} : { question }), ...(qs.length >= 2 && qs.length <= 4 && qs.every((x) => x !== undefined) ? { questions: qs as Question[] } : {}) }
}
export async function writeAsk($: any, a: Ask): Promise<boolean> {
  const p = await askPath($, a.id)
  return p !== undefined && writeFile($, p, JSON.stringify(a))
}
export async function readAsk($: any, id: string): Promise<Ask | undefined> {
  const p = await askPath($, id)
  const t = p === undefined ? undefined : await readText($, p, 262_144)
  const a = t === undefined ? undefined : parseAsk(safeJson(t))
  return a?.id === id ? a : undefined
}
async function readUps($: any, d: string, names: string[], id: string): Promise<UpMark[]> {
  const mine = names.filter((n) => n.startsWith(`${id}.up.`) && SID_RE.test(n.slice(id.length + 4))).slice(0, 8)
  const ups = await Promise.all(mine.map(async (n) => {
    const j = safeJson((await readText($, `${d}/${n}`, 4096)) ?? '') as { kind?: unknown; at?: unknown; note?: unknown } | undefined
    return (j?.kind === 'escalated' || j?.kind === 'told') && isNum(j.at) ? { kind: j.kind, by: n.slice(id.length + 4), at: j.at, ...(j.kind === 'escalated' && typeof j.note === 'string' ? { note: j.note } : {}) } : undefined
  }))
  return ups.filter((u): u is UpMark => u !== undefined)
}
async function askNames($: any): Promise<{ d: string; names: string[]; failed: boolean } | undefined> {
  const d = await path($, 'asks')
  if (d === undefined) return undefined
  let failed = false
  const l = (await $.fs.list(d).catch(() => ((failed = true), []))) as { name: string }[]
  return { d, names: l.map((f) => f.name).slice(0, 512), failed }
}
// Every ask file with the marks beside it, and the ids already answered. A mark's session is its file's name, never its content.
export async function readAsks($: any): Promise<{ asks: Ask[]; ups: Map<string, UpMark[]>; answered: Set<string> }> {
  const f = await askNames($)
  const asks = f === undefined ? [] : (await Promise.all(f.names.filter((n) => n.endsWith('.json')).slice(0, 64).map((n) => readAsk($, n.slice(0, -5))))).filter((a): a is Ask => a !== undefined)
  const ups = new Map<string, UpMark[]>()
  for (const a of asks) ups.set(a.id, await readUps($, f!.d, f!.names, a.id))
  return { asks, ups, answered: new Set(f?.names.filter((n) => n.endsWith('.answer')).map((n) => n.slice(0, -7))) }
}
// One ask's marks and whether it is answered: the asker's poll and an answer's check read this and nothing more.
export async function askState($: any, id: string): Promise<{ ups: UpMark[]; answered: boolean }> {
  const f = await askNames($)
  return f === undefined ? { ups: [], answered: false } : { ups: await readUps($, f.d, f.names, id), answered: f.names.includes(`${id}.answer`) }
}
// Whether an ask is still open: its file is there and no answer is. A folder that cannot be listed counts as open: a pop-up is not closed on a failed read.
export async function askOpen($: any, id: string): Promise<boolean> {
  const f = await askNames($)
  return f !== undefined && (f.failed || (f.names.includes(`${id}.json`) && !f.names.includes(`${id}.answer`)))
}
export async function readAnswer($: any, id: string): Promise<Answer | undefined> {
  const p = await askPath($, id, 'answer')
  const j = (p === undefined ? undefined : safeJson((await readText($, p, 4096)) ?? '')) as Partial<Answer> | null | undefined
  if (!j || j.ask !== id || typeof j.by !== 'string' || !['allow', 'deny', 'answer'].includes(j.decision as string) || !isNum(j.at)) return undefined
  return { ask: id, by: j.by, decision: j.decision!, at: j.at, ...(typeof j.note === 'string' ? { note: j.note } : {}), ...(Number.isInteger(j.option) ? { option: j.option } : {}), ...(Array.isArray(j.picks) && j.picks.every(Number.isInteger) ? { picks: j.picks } : {}) }
}
// The first writer wins: 'exists' says an answer is already there.
export async function writeAnswer($: any, a: Answer): Promise<'ok' | 'exists' | 'error'> {
  const p = await askPath($, a.ask, 'answer')
  return p === undefined ? 'error' : createExcl($, p, JSON.stringify(a))
}
export async function rmAnswer($: any, id: string): Promise<void> {
  const p = await askPath($, id, 'answer')
  if (p !== undefined) await rm($, [p])
}
// A mark by one session, its own, written whole (a told mark gives way to its escalation). An escalation may carry a note.
export async function writeUp($: any, id: string, by: Sid, kind: UpMark['kind'], at: number, note?: string): Promise<boolean> {
  const p = SID_RE.test(by) ? await askPath($, id, `up.${by}`) : undefined
  return p !== undefined && writeFile($, p, JSON.stringify({ kind, at, ...(note === undefined ? {} : { note }) }))
}
// Entries of the ask folder whose ask file is gone (a late answer or mark) and temporary files left by a killed writer, once two minutes old.
export async function tidyAsks($: any): Promise<void> {
  const d = await path($, 'asks')
  const now = await $.clock.now()
  const all = d === undefined ? [] : (((await $.fs.list(d).catch(() => [])) as { name: string }[]) ?? []).map((f) => f.name)
  const gone = all.filter((n) => n.endsWith('.tmp') || !all.includes(`${n.split('.')[0]}.json`))
  for (const n of gone.slice(0, 64)) if (now - (((await $.fs.stat(`${d}/${n}`).catch(() => undefined)) as { mtimeMs: number } | undefined)?.mtimeMs ?? now) > 120_000) await rm($, [`${d}/${n}`])
}
// An ask's files, all of them.
export async function rmAsk($: any, id: string): Promise<void> {
  const f = await askNames($)
  if (f !== undefined && ASK_ID_RE.test(id)) await rm($, f.names.filter((n) => n === `${id}.json` || n === `${id}.answer` || n.startsWith(`${id}.up.`)).map((n) => `${f.d}/${n}`))
}
// The machine-wide OFF file: while it is there no tier answers an ask. A read that fails counts as there.
export async function offFile($: any): Promise<boolean> {
  const h = await home($)
  return h === undefined || (await $.fs.exists(`${h}/.claude/callboard/OFF`).catch(() => true))
}
type Settings = { disableAllHooks?: unknown; hooks?: { PreToolUse?: { hooks?: { type?: unknown; command?: unknown }[] }[] } }
// The guard go_status reads before it reports a go: settings wire a PreToolUse command hook that runs protected-paths-guard.sh with hooks not disabled, and the callboard folder carries
// the `.protected-checkout` marker. Kept 60 s; a failed read is a missing guard.
export async function guardOk($: any): Promise<boolean> {
  const now = await $.clock.now()
  if (mem.guard !== undefined && now - mem.guard.at < 60_000) return mem.guard.ok
  const h = await home($)
  const s = h === undefined ? undefined : (safeJson((await readText($, `${h}/.claude/settings.json`, 262_144)) ?? '') as Settings | undefined)
  const pre = s?.hooks?.PreToolUse
  const wired = s?.disableAllHooks !== true && Array.isArray(pre) && pre.some((m) => Array.isArray(m?.hooks) && m.hooks.some((x) => x?.type === 'command' && typeof x.command === 'string' && x.command.includes('protected-paths-guard.sh')))
  const ok = wired && ((await $.fs.stat(`${h}/.claude/callboard/.protected-checkout`).catch(() => undefined)) as { kind?: string } | undefined)?.kind === 'file'
  mem.guard = { at: now, ok }
  return ok
}

// The ask log's rows since a time, from the last 256 KB of this month's file and of the month before when the time reaches back to it; a line that is not a row is dropped. undefined: a file is there and could not be read.
export async function readAskLog($: any, since: number): Promise<AskLogRow[] | undefined> {
  const out: AskLogRow[] = []
  const paths = new Set([await askLogPath($, new Date(since)), await askLogPath($, new Date(await $.clock.now()))])
  for (const p of paths) {
    const st = p === undefined ? undefined : ((await $.fs.stat(p).catch(() => undefined)) as { size: number; kind?: string } | undefined)
    const size = st?.kind === 'file' ? st.size : undefined
    if (p === undefined || size === undefined) continue
    const t = (await $.fs.read(p, { offset: Math.max(0, size - 262_144), length: 262_144 }).catch(() => undefined)) as string | undefined
    if (t === undefined) return undefined
    for (const l of t.split('\n')) {
      const r = safeJson(l) as Partial<AskLogRow> | undefined
      if (r && typeof r.t === 'number' && r.t >= since && typeof r.ev === 'string' && typeof r.ask === 'string' && typeof r.asker === 'string' && !out.some((o) => o.t === r.t && o.ask === r.ask && o.ev === r.ev && o.by === r.by)) out.push(r as AskLogRow)
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
