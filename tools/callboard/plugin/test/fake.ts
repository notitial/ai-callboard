// A fake of the engine's `$` for the engine specs and the kit tests: an in-memory file system, the few host programs the adapters run, a clock the test moves, the session, the state, the
// prompt box and the UI.
import { resetMem } from '../hooks/engine/mem.ts'

export const HOME = '/Users/x'
export const V2 = `${HOME}/.claude/callboard/v2`
export const T0 = 1_700_000_000_000
export const START = 'Tue Oct 27 20:37:50 2026'
export const MIN = 60_000

export type Row = { sid: string; pid: number; name?: string; cwd?: string; status?: string; waitingFor?: string; kind?: string; statusUpdatedAt?: number; procStart?: string; alive?: boolean }
export function fake(o: { sid?: string } = {}) {
  const h = {
    now: T0,
    sid: o.sid ?? 'sid-me',
    root: '/w/me',
    files: new Map<string, string>(),
    dirs: new Set<string>([HOME]),
    modes: new Map<string, string>(),
    mtimes: new Map<string, number>(),
    runs: [] as { argv: string[]; env?: Record<string, string> }[],
    submitted: [] as string[],
    toasts: [] as string[],
    asked: [] as { question: string; options: string[]; header: string }[],
    askAnswer: (() => Promise.resolve('Yes')) as (q: string) => Promise<unknown>,
    sleepDone: false,
    draft: '',
    usage: { context: { tokens: 0 }, cost: { usd: 1.5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 40 }] } as unknown,
    agents: [] as { status: string }[],
    tools: [] as string[],
    commands: [] as string[],
    compactRuns: [] as string[],
    ps: '',
    psFails: false,
    real: new Map<string, string>(),
    ghBin: undefined as string | undefined,
    ghOut: undefined as undefined | { exitCode: number; stdout: string; isStdoutTruncated?: boolean },
    state: new Map<string, { value: unknown; version: number }>(),
    stateBusy: 0,
    every: undefined as undefined | (() => unknown),
    submitFails: false,
    unreadable: new Set<string>(),
  }
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const under = (dir: string) => {
    const names = new Map<string, string>()
    for (const f of h.files.keys()) if (f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/')) names.set(f.slice(dir.length + 1), 'file')
    for (const d of h.dirs) if (d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/')) names.set(d.slice(dir.length + 1), 'dir')
    return names
  }
  const run = async (argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) => {
    h.runs.push({ argv, env: opts.env })
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
    const bad = { exitCode: 1, stdout: '', stderr: '' }
    const [cmd, ...a] = argv
    const paths = a.filter((x) => !x.startsWith('-'))
    if (cmd === '/bin/mkdir') {
      for (const d of paths) {
        if (!a.includes('-p') && h.dirs.has(d)) return bad
        h.dirs.add(d)
      }
      return ok()
    }
    if (cmd === '/bin/chmod') {
      for (const d of paths.slice(1)) h.modes.set(d, paths[0])
      return ok()
    }
    if (cmd === '/bin/mv') {
      const [from, to] = paths
      if (h.dirs.has(from)) {
        h.dirs.delete(from)
        h.dirs.add(to)
        for (const f of [...h.files.keys()]) if (f.startsWith(`${from}/`)) (h.files.set(`${to}${f.slice(from.length)}`, h.files.get(f)!), h.files.delete(f))
        return ok()
      }
      if (!h.files.has(from)) return bad
      h.files.set(to, h.files.get(from)!)
      h.files.delete(from)
      return ok()
    }
    if (cmd === '/bin/rm') {
      for (const p of paths) {
        h.files.delete(p)
        h.dirs.delete(p)
        for (const f of [...h.files.keys()]) if (f.startsWith(`${p}/`)) h.files.delete(f)
        for (const d of [...h.dirs]) if (d.startsWith(`${p}/`)) h.dirs.delete(d)
      }
      return ok()
    }
    if (cmd === '/usr/bin/tee') {
      h.files.set(paths[0], (h.files.get(paths[0]) ?? '') + (opts.stdin ?? ''))
      return ok()
    }
    if (cmd === '/bin/ps') return h.psFails ? bad : ok(h.ps)
    if (cmd === '/bin/sleep' || cmd === '/usr/bin/find') return ok()
    if (cmd === '/bin/realpath') return h.real.has(paths[0]) ? ok(`${h.real.get(paths[0])}\n`) : h.dirs.has(paths[0]) || paths[0] === h.root ? ok(`${paths[0]}\n`) : bad
    if (cmd === h.ghBin) return h.ghOut ?? bad
    return bad
  }
  const $ = {
    clock: { now: async () => h.now, every: (_ms: number, f: () => unknown) => void (h.every = f), sleep: (_ms: number) => (h.sleepDone ? Promise.resolve() : new Promise<void>(() => undefined)) },
    env: { get: async (n: string) => (n === 'HOME' ? HOME : undefined) },
    session: { id: async () => h.sid, usage: async () => h.usage, root: async () => h.root },
    fs: {
      read: async (p: string, o: { offset?: number; length?: number } = {}) => {
        const t = h.files.get(p)
        if (t === undefined || h.unreadable.has(p)) throw new Error('EIO')
        return t.slice(o.offset ?? 0, o.length === undefined ? undefined : (o.offset ?? 0) + o.length)
      },
      write: async (p: string, t: string) => void h.files.set(p, t),
      list: async (d: string) => {
        if (!h.dirs.has(d) && under(d).size === 0) throw new Error('ENOENT')
        return [...under(d)].map(([name, kind]) => ({ name, kind }))
      },
      stat: async (p: string) => {
        if (h.files.has(p)) return { kind: 'file', size: h.files.get(p)!.length, mtimeMs: h.mtimes.get(p) ?? h.now }
        if (h.dirs.has(p)) return { kind: 'dir', size: 0, mtimeMs: h.mtimes.get(p) ?? h.now }
        throw new Error('ENOENT')
      },
      exists: async (p: string) => h.files.has(p) || h.dirs.has(p) || p === h.ghBin,
    },
    process: { run },
    state: {
      get: async (k: { key: string }) => h.state.get(k.key) ?? { value: undefined, version: 0 },
      set: async (k: { key: string }, value: unknown, o: { ifVersion?: number } = {}) => {
        const cur = h.state.get(k.key)
        if (h.stateBusy > 0 || (o.ifVersion !== undefined && (cur?.version ?? 0) !== o.ifVersion)) return { isSet: false }
        h.state.set(k.key, { value, version: (cur?.version ?? 0) + 1 })
        return { isSet: true }
      },
    },
    prompt: {
      read: async () => ({ text: h.draft }),
      submit: async ({ text }: { text: string }) => {
        if (h.submitFails) throw new Error('refused')
        h.submitted.push(text)
        setStatus('busy')
      },
    },
    ui: { toast: async (t: string) => void h.toasts.push(t), ask: (q: string, o: { options: string[]; header: string }) => (h.asked.push({ question: q, options: o.options, header: o.header }), h.askAnswer(q)) },
    agent: { list: async () => h.agents },
    command: { register: async (c: { name: string }) => void h.commands.push(c.name), run: async (c: { command: string; args: string }) => void h.compactRuns.push(`${c.command} ${c.args}`) },
    tool: { register: async (t: { name: string }) => void h.tools.push(t.name) },
  }
  resetMem()
  h.dirs.add(`${HOME}/.claude/sessions`)
  // A live registry row: its file and its `ps` line. A row with `alive: false` has a file and no process.
  const seed = (r: Row) => {
    h.files.set(`${HOME}/.claude/sessions/${r.pid}.json`, JSON.stringify({ sessionId: r.sid, pid: r.pid, procStart: r.procStart ?? START, cwd: r.cwd ?? '/w/x', name: r.name, status: r.status ?? 'idle', waitingFor: r.waitingFor, kind: r.kind, statusUpdatedAt: r.statusUpdatedAt }))
    if (r.alive !== false) h.ps += `  ${r.pid} ${START}\n`
  }
  // The own row's status in the registry: a submitted text makes the session busy, as the engine does.
  const setStatus = (status: string) => {
    for (const [p, t] of h.files) if (p.startsWith(`${HOME}/.claude/sessions/`) && t.includes(`"sessionId":"${h.sid}"`)) h.files.set(p, JSON.stringify({ ...JSON.parse(t), status }))
  }
  const table = (t: unknown) => void h.files.set(`${V2}/sessions.json`, JSON.stringify(t))
  const file = (name: string) => h.files.get(`${V2}/${name}`)
  return { $: $ as any, h, seed, table, file, parent, idle: () => setStatus('idle') }
}
