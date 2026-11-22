// A fake of the engine's `$` for the engine specs and the kit tests: an in-memory file system, the few host programs the adapters run, a clock the test moves, the session, the state, the
// prompt box and the UI.
import { mem, resetMem } from '../hooks/engine/mem.ts'

export const HOME = '/Users/x'
export const V2 = `${HOME}/.claude/callboard/v2`
export const T0 = 1_700_000_000_000
export const START = 'Tue Oct 27 20:37:50 2026'
export const MIN = 60_000

export type Row = { sid: string; pid: number; name?: string; nameSource?: string; cwd?: string; status?: string; waitingFor?: string; kind?: string; statusUpdatedAt?: number; procStart?: string; alive?: boolean; bridge?: boolean }
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
    notified: [] as [string, string][],
    unnotified: [] as string[],
    asked: [] as { question: string; options: string[]; header: string }[],
    askAnswer: (() => Promise.resolve('Yes')) as (q: string) => Promise<unknown>,
    calls: [] as { tool: string; input: any; signal?: AbortSignal }[],
    // The plugin's own Bash calls, kept apart from its dialogs; the person's answer in the engine's own dialog for one (true: Yes; undefined or false: No; a string: No with
    // that typed; an object: Yes on the command he changed to it); the reason lines that dialog showed.
    bash: [] as any[],
    bashAnswer: (async () => undefined) as (input: any) => Promise<unknown>,
    reasons: [] as unknown[],
    // The plugin's own tool.check and tool.run hooks (set by a spec): the engine runs them on each Bash the plugin calls.
    check: undefined as undefined | ((e: any, next: any) => Promise<unknown>),
    toolRun: undefined as undefined | ((e: any, next: any) => Promise<unknown>),
    // The plugin's own PermissionRequest hook, run on each AskUserQuestion it calls (set by a spec): the engine consults it before the dialog shows.
    permission: undefined as undefined | ((e: any, next: any) => Promise<unknown>),
    sleepDone: false,
    sleepMoves: false,
    sleepFails: false,
    draft: '',
    usage: { context: { tokens: 0 }, cost: { usd: 1.5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 40 }] } as unknown,
    tools: [] as string[],
    commands: [] as string[],
    listed: [] as { name: string; source: string; description?: string }[],
    compactRuns: [] as string[],
    model: 'claude-sonnet-5-5',
    ps: '',
    psFails: false,
    real: new Map<string, string>(),
    ghBin: undefined as string | undefined,
    ghOut: undefined as undefined | { exitCode: number; stdout: string; isStdoutTruncated?: boolean },
    state: new Map<string, { value: unknown; version: number }>(),
    every: undefined as undefined | (() => unknown),
    unreadable: new Set<string>(),
    kinds: new Map<string, string>(),
    undeletable: new Set<string>(),
    onSleep: undefined as undefined | (() => unknown),
  }
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
    if (cmd === '/bin/realpath') return h.real.has(paths[0]) ? ok(`${h.real.get(paths[0])}\n`) : h.dirs.has(paths[0]) || paths[0] === h.root ? ok(`${paths[0]}\n`) : bad
    if (cmd === h.ghBin) return h.ghOut ?? bad
    return bad
  }
  // The plugin's own tool call. An AskUserQuestion runs h.permission first (its result is ignored), then shows each question (h.asked) and resolves with h.askAnswer's answer
  // to each: a label is that question's pick, an object is the call's whole result, and undefined (a dismissal) resolves `{ deny }`. An abort resolves `{ deny }` at once, as the
  // engine does. A Bash runs h.check, then on an ask h.permission and the person's h.bashAnswer, then on an allow or a Yes h.toolRun, whose answer it resolves with (a run with
  // no hook is a result). Any other tool is refused.
  const call = async (c: { tool: string; input: any }, o: { signal?: AbortSignal } = {}): Promise<unknown> => {
    if (c.tool === 'Bash') h.bash.push(c.input)
    else h.calls.push({ ...c, signal: o.signal })
    if (c.tool !== 'AskUserQuestion' && c.tool !== 'Bash') return { deny: 'no such tool' }
    const signal = o.signal
    const cut = { deny: 'cancelled by the plugin' }
    if (signal?.aborted) return cut
    const aborted = new Promise<unknown>((res) => signal?.addEventListener('abort', () => res(cut), { once: true }))
    const nextOf = (r: unknown) => Object.assign(async () => r, { origin: { plugin: 'callboard', tier: 'user' }, signal })
    const bash = async (): Promise<unknown> => {
      const v: any = h.check === undefined ? { decision: 'ask' } : await h.check({ tool: 'Bash', input: c.input }, nextOf({ decision: 'ask' }))
      if (v?.decision === 'deny') return { deny: v.reason ?? 'refused' }
      let run = c.input
      if (v?.decision === 'ask') {
        h.reasons.push(v.reason)
        await h.permission?.({ tool_name: 'Bash', tool_input: c.input }, nextOf({}))
        const got = await h.bashAnswer(c.input)
        const no = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
        if (got === undefined || got === false) return { deny: no }
        if (typeof got === 'string') return { deny: `${no} To tell you how to proceed, the user said:\n${got}` }
        if (typeof got === 'object') run = { ...c.input, ...got }
      }
      if (h.toolRun === undefined) return { result: { stdout: '' } }
      // A deny of a tool.run hook reaches the caller as the engine's error result, as on the real engine.
      const out: any = await h.toolRun({ tool: 'Bash', ...run }, nextOf({ result: { stdout: '' } }))
      return out?.deny === undefined ? out : { result: `Error: ${out.deny}`, text: out.deny, isError: true }
    }
    if (c.tool === 'Bash') return Promise.race([bash(), aborted])
    const shown = async (): Promise<unknown> => {
      const next = Object.assign(async () => ({}), { origin: { plugin: 'callboard', tier: 'user' }, signal })
      await h.permission?.({ tool_name: c.tool, tool_input: c.input }, next)
      const qs: { question: string; header: string; options: { label: string }[] }[] = c.input.questions
      for (const q of qs) h.asked.push({ question: q.question, options: q.options.map((x) => x.label), header: q.header })
      const got = await Promise.all(qs.map((q) => h.askAnswer(q.question)))
      if (got.some((x) => x === undefined)) return { deny: 'dismissed' }
      const whole = got.find((x) => typeof x === 'object')
      return whole ?? { result: { questions: qs, answers: Object.fromEntries(qs.map((q, k) => [q.question, got[k]])) } }
    }
    return Promise.race([shown(), aborted])
  }
  const $ = {
    clock: { now: async () => h.now, every: (_ms: number, f: () => unknown) => void (h.every = f), sleep: (_ms: number) => (h.sleepDone ? Promise.resolve() : new Promise<void>(() => undefined)) },
    env: { get: async (n: string) => (n === 'HOME' ? HOME : undefined) },
    session: { id: async () => h.sid, usage: async () => h.usage, root: async () => h.root, model: async () => h.model },
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
        if ((o.ifVersion !== undefined && (cur?.version ?? 0) !== o.ifVersion)) return { isSet: false }
        h.state.set(k.key, { value, version: (cur?.version ?? 0) + 1 })
        return { isSet: true }
      },
    },
    prompt: {
      read: async () => ({ text: h.draft }),
      submit: async ({ text }: { text: string }) => {
        h.submitted.push(text)
        setStatus('busy')
      },
    },
    ui: { toast: async (t: string) => void h.toasts.push(t), notify: async (t: string, o: { key: string }) => void h.notified.push([o.key, t]), cancelNotify: async (key: string) => void h.unnotified.push(key), ask: (q: string, o: { options: string[]; header: string }) => (h.asked.push({ question: q, options: o.options, header: o.header }), h.askAnswer(q)) },
    agent: { list: async () => [], call },
    command: { register: async (c: { name: string }) => void h.commands.push(c.name), list: async () => h.listed, run: async (c: { command: string; args: string }) => {
      h.compactRuns.push(`${c.command} ${c.args}`)
      if (c.command === 'model') h.model = `claude-${c.args}-5-5`
    } },
    tool: { register: async (t: { name: string }) => void h.tools.push(t.name) },
  }
  resetMem()
  h.dirs.add(`${HOME}/.claude/sessions`)
  // A live registry row: its file and its `ps` line. A row with `alive: false` has a file and no process.
  const seed = (r: Row) => {
    h.files.set(`${HOME}/.claude/sessions/${r.pid}.json`, JSON.stringify({ sessionId: r.sid, pid: r.pid, procStart: r.procStart ?? START, cwd: r.cwd ?? '/w/x', name: r.name, nameSource: r.nameSource, status: r.status ?? 'idle', waitingFor: r.waitingFor, kind: r.kind, statusUpdatedAt: r.statusUpdatedAt, bridgeSessionId: r.bridge ? 'bridge-1' : undefined }))
    if (r.alive !== false) h.ps += `  ${r.pid} ${START}\n`
  }
  // The own row's status in the registry: a submitted text makes the session busy, as the engine does.
  const setStatus = (status: string) => {
    for (const [p, t] of h.files) if (p.startsWith(`${HOME}/.claude/sessions/`) && t.includes(`"sessionId":"${h.sid}"`)) h.files.set(p, JSON.stringify({ ...JSON.parse(t), status }))
  }
  const table = (t: unknown) => void h.files.set(`${V2}/sessions.json`, JSON.stringify(t))
  const file = (name: string) => h.files.get(`${V2}/${name}`)
  return { $: $ as any, h, seed, table, file, idle: () => setStatus('idle') }
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
