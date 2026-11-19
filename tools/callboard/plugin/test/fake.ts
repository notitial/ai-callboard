// A fake of the engine's `$` for the engine specs and the kit tests: an in-memory file system, the few host programs the adapters run, a clock the test moves, the session, the state, the
// prompt box and the UI.
import { mem, resetMem } from '../hooks/engine/mem.ts'

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
    sleepMoves: false,
    sleepFails: false,
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
    kinds: new Map<string, string>(),
    undeletable: new Set<string>(),
    onSleep: undefined as undefined | (() => unknown),
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
        if (h.undeletable.has(p)) return bad
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
    if (cmd === '/bin/ln') {
      const [from, to] = paths
      if (!h.files.has(from) || h.files.has(to)) return bad
      h.files.set(to, h.files.get(from)!)
      return ok()
    }
    if (cmd === '/bin/sleep') {
      if (h.sleepFails) return bad
      if (h.sleepMoves) h.now += Number(paths[0]) * 1000
      await h.onSleep?.()
      return ok()
    }
    if (cmd === '/usr/bin/find') return ok()
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
        return [...under(d)].map(([name, kind]) => ({ name, kind: h.kinds.get(`${d}/${name}`) ?? kind }))
      },
      stat: async (p: string) => {
        if (h.kinds.has(p)) return { kind: h.kinds.get(p), size: 0, mtimeMs: h.now }
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

// A second session on the same machine: one file system, clock and process list with `f`, its own session id, toasts and dialogs. Make every peer before the first call: a fake resets the
// module memory.
export function peer(f: ReturnType<typeof fake>, sid: string) {
  const g = fake({ sid })
  for (const k of ['files', 'dirs', 'modes', 'mtimes'] as const) (g.h as any)[k] = f.h[k]
  for (const k of ['now', 'ps', 'psFails'] as const) Object.defineProperty(g.h, k, { get: () => f.h[k], set: (x) => void ((f.h as any)[k] = x) })
  return g
}
// One call made as a peer while another session's loop waits: the caches of one process (the asks, the told marks) and the row it found for itself are put back after it.
export async function as<T>(fn: () => Promise<T>): Promise<T> {
  const own = mem.ownPid
  mem.asks = undefined
  mem.told.clear()
  try {
    return await fn()
  } finally {
    mem.ownPid = own
  }
}
// The protected-paths guard in place: wired in the settings, with its marker.
export function guard(f: ReturnType<typeof fake>) {
  f.h.files.set(`${HOME}/.claude/settings.json`, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'bash ~/guards/protected-paths-guard.sh' }] }] } }))
  f.h.files.set(`${HOME}/.claude/callboard/.protected-checkout`, '')
}
// The machine of the ask specs: a lane (`sid-me`) under a lead, the manager `BOSS`, the lane waiting on a prompt, and the lane's sleeps moving the clock.
export function tiers() {
  const f = fake()
  f.seed({ sid: 'sid-me', pid: 10, name: 'lane', cwd: '/w/me', kind: 'interactive', status: 'waiting', waitingFor: 'permission', statusUpdatedAt: T0 })
  f.seed({ sid: 'sid-lead', pid: 11, name: 'lead', cwd: '/w/lead', kind: 'interactive' })
  f.seed({ sid: 'sid-boss', pid: 12, name: 'BOSS', cwd: '/w/boss', kind: 'interactive' })
  f.h.files.set(`${HOME}/.claude/callboard/manager-name`, 'BOSS\n')
  guard(f)
  f.table({ 'sid-me': { name: 'lane', folder: '/w/me', under: 'sid-lead' }, 'sid-lead': { name: 'lead', folder: '/w/lead', lead: { repos: [] } } })
  f.h.sleepMoves = true
  return f
}
