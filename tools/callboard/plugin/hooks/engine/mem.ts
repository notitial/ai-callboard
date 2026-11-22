// The module memory the engine files share, and the one $.state key. `claude plugin validate` reads a key in the file that calls $.state with it, so the key is declared
// here and every other file goes through getUp and patchUp. Memory holds caches and counters of this process only: a restart loses them and nothing is decided on a lost one.
import type { Ask, AskLogRow, Config, Folder, Sid, View, WindowReading } from '../core/model.ts'
import type { CheckFacts, Open } from '../core/asks.ts'
import type { Counters, Req } from '../core/upkeep.ts'
import type { PrNote } from '../core/pr.ts'
import type { Preset } from '../core/commands.ts'

// What outlives a reload (the cache is still warm) and not a restart. `due`: a nudge recorded at a turn's end, sent by the tick once the session is quiet; its kind follows the size
// at the send. `req` carries the session id it was made in and the time its compaction ended.
export type Up = { req: (Req & { sid: Sid; doneAt?: number }) | null; counters: Counters; due: { at: number; again?: true } | null; turnEnd?: number; realEnd?: number; pingAt?: number; restAt?: number }
const UP = { plugin: 'callboard', key: 'upkeep' } as const
const EMPTY: Up = { req: null, counters: {}, due: null }

export async function getUp($: any): Promise<Up> {
  return { ...EMPTY, ...((await $.state.get(UP)).value ?? {}) }
}
// A read-modify-write that lands only if nobody wrote in between, tried three times.
export async function patchUp($: any, f: (u: Up) => Up): Promise<Up> {
  for (let i = 0; i < 3; i++) {
    const r = await $.state.get(UP)
    const next = f({ ...EMPTY, ...(r.value ?? {}) })
    if ((await $.state.set(UP, next, { ifVersion: r.version })).isSet !== false) return next
  }
  throw new Error('state-busy')
}

// What belongs to the session id and not to the process: a `/clear` (a handover's, or one the person typed) starts the next id with these empty. The process keeps the timer, the
// registered tools, the machine caches and `handedAt`.
const sessionFresh = () => ({
  // The plugin's own submitted texts, counted until the turn that carries each starts; `real` is work (a resume note), not a ping, nudge or notice.
  own: new Map<string, { n: number; real: boolean }>(),
  // Events: the ones in a submitted text not yet started, the keys spent, the sessions whose report reads signed.
  pending: new Map<string, { keys: string[]; at: number }>(),
  spent: new Set<string>(),
  signed: { at: 0, set: new Set<Sid>() },
  // Notice turns owed to this session for his own step in it (cmd.told, go.clicked), sent one a tick once it is quiet.
  owed: [] as string[],
  presetRun: undefined as { preset: Preset; result: string } | undefined,
  selfNamed: false,
  asks: undefined as { at: number; open: { ask: Ask; st: Open }[]; log: AskLogRow[] } | undefined,
  told: new Set<string>(),
  relayed: new Set<string>(),
  // The takeover of a handover in this session: when it began, the tries of the record moves and of the rename, whether the moves are done and the note owed; kept per old id.
  hand: undefined as { old: string; first: number; moves: number; renames: number; moved: boolean; noted: boolean } | undefined,
})
const fresh = () => ({
  ...sessionFresh(),
  // When this process last handed a session over: the gap between two handovers is counted on it, since the session's own state does not cross a `/clear`.
  handedAt: undefined as number | undefined,
  timer: false,
  ticking: false,
  home: undefined as Folder | undefined,
  // Every timer call records its time; a gap past SLEEP_GAP_MS means the Mac slept.
  lastTimer: undefined as number | undefined,
  woke: undefined as number | undefined,
  submits: 0,
  turnKind: undefined as 'ping' | 'unreal' | undefined,
  lastSubmit: undefined as number | undefined,
  pinged: { realEnd: 0, n: 0 },
  mid: false,
  midSkip: 0,
  // The 10 s reading of the machine (registry, table, manager) and the settings and window read beside it.
  view: undefined as { at: number; v: View } | undefined,
  cfg: undefined as { at: number; c: Config } | undefined,
  win: undefined as { at: number; w: WindowReading } | undefined,
  noSince: new Map<string, number>(),
  tableAt: 0,
  // The reports queued about sessions.
  reports: [] as { about: Sid; code: string; at: number }[],
  since: 0,
  prNotes: [] as PrNote[],
  // This folder's lead preset as registered at the session start; `presetRun` (above) is one typed run of it whose name, model and effort steps are still to run (its notice follows them).
  preset: undefined as Preset | undefined,
  prLost: new Map<string, number>(),
  prLooks: [] as number[],
  prPollAt: 0,
  prBin: undefined as { at: number; path: string | undefined } | undefined,
  toasted: new Set<string>(),
  logged: '',
  parentTools: false,
  dialogs: new Set<string>(),
  usageAt: 0,
  usageOwed: false,
  dirs: new Set<string>(),
  // The ask hook: what tool.check saw for a call (the join, 60 s), the tool calls known to have ended, this process's own registry file, and the asks every step shares.
  checks: new Map<string, { toolUseId: string; at: number; dup: boolean; approver: unknown; facts: CheckFacts }>(),
  done: new Set<string>(),
  ownPid: undefined as number | undefined,
  // The ask whose relay dialog is open: the controller that closes it, the first question it shows (how the ask hook knows it), whether the hook saw it go to the person, and
  // whether it closed by itself while he was idle.
  proxy: undefined as { id: string; ctrl: AbortController; first?: string; shown: boolean; idle?: boolean } | undefined,
  sweepAt: 0,
  tidyAt: 0,
  guard: undefined as { at: number; ok: boolean } | undefined,
})
export const mem = fresh()
// The reading of the machine is kept but read again at the next use; the last good table stays its fallback.
export function staleView(): void {
  if (mem.view !== undefined) mem.view = { ...mem.view, at: 0 }
}
export const resetMem = (): void => void Object.assign(mem, fresh())
export const resetSession = (): void => void Object.assign(mem, sessionFresh())

// A turn that starts with a pending text spends the keys that text carried; a pending text that never started expires, its keys owed again. The spent set is capped.
export function spendStarted(startText: unknown, now: number): void {
  for (const [text, p] of mem.pending) {
    const started = typeof startText === 'string' && startText.includes(text)
    if (started) for (const k of p.keys) mem.spent.add(k)
    if (started || now - p.at > 120_000) mem.pending.delete(text)
  }
  if (mem.spent.size > 500) mem.spent = new Set([...mem.spent].slice(-250))
}
