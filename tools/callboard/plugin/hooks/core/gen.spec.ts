// The generator the core's property tests share: random machines of every session shape (no row; a row under a live lead, a gone lead, a session that is no lead,
// an off lead; a lead; a conductor; a minted lead under a conductor, a gone one or a session that is none; the manager by name, two sessions with its name; off; parked; gone; unnamed; a row never opened; two registry rows for one id; an unreadable
// registry or manager-name file), each session idle, busy, compacting or in a dialog. Seeded, so a failure names its seed.
import type { ManagerName, RegistryRow, Row, Sid, Table, View, WindowReading } from './model.ts'
import { liveView } from './model.ts'

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]

export const MANAGER = 'BOSS'
export const NOW = Date.UTC(2026, 10, 19, 9, 0, 0)
const STATUS: [string, string | null][] = [['idle', null], ['busy', null], ['compacting', null], ['waiting', 'permission']]
const NAMES = ['L1', 'L2', 'lane-a', 'lane-b', MANAGER, 'x']

export type World = { v: View; sids: Sid[]; reg: RegistryRow[]; table: Table }
export function world(r: () => number): World {
  const n = 2 + Math.floor(r() * 9)
  const sids = Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-00000000000${i}`)
  const ghost = '00000000-0000-0000-0000-0000000000ff' // a session id no registry row carries
  const reg: RegistryRow[] = []
  const table: Table = {}
  for (const sid of sids) {
    const live = r() < 0.75
    const name = r() < 0.1 ? undefined : pick(r, NAMES)
    const [status, waitingFor] = pick(r, STATUS)
    const start = r() < 0.1 ? 'not a date' : new Date(NOW - Math.floor(r() * 86_400_000)).toUTCString()
    const row: RegistryRow = { sid, pid: 100 + reg.length, procStart: start, folder: pick(r, ['/Users/x/repo', '/Users/x/repo/sub', '/Users/x/other']), status, waitingFor, statusAt: NOW - Math.floor(r() * 3_600_000) }
    if (name !== undefined) row.name = name
    if (live) reg.push(row)
    if (live && r() < 0.1) reg.push({ ...row, pid: row.pid + 1000 }) // two rows for one id
    if (r() < 0.6) {
      const t: Row = { name: name ?? 'unnamed', folder: row.folder }
      const shape = r()
      if (shape < 0.25) t.lead = { repos: r() < 0.5 ? [] : ['/Users/x/other'], ...(r() < 0.3 ? { conductor: true as const } : {}) }
      else if (shape < 0.75) t.under = pick(r, [...sids, ghost])
      else if (shape < 0.85) (t.lead = { repos: [], minted: true as const }), (t.under = pick(r, [...sids, ghost]))
      if (r() < 0.12) t.off = true
      if (r() < 0.12) t.parked = NOW - Math.floor(r() * 40 * 86_400_000)
      if (r() < 0.15) t.goneAt = NOW - Math.floor(r() * 3 * 86_400_000)
      if (r() < 0.1 && t.lead && !t.lead.minted) t.under = pick(r, sids) // a typed lead's under is never read
      table[sid] = t
    }
  }
  if (r() < 0.2) table['new:fresh'] = { name: 'fresh', folder: '/Users/x/repo', under: pick(r, sids) }
  const managerName: ManagerName = pick(r, [MANAGER, MANAGER, MANAGER, null, 'unknown'])
  const registry = r() < 0.1 ? 'unknown' : reg
  return { v: liveView(registry, table, managerName), sids: [...sids, ...Object.keys(table).filter((k) => !sids.includes(k)), ghost], reg, table }
}
// A live registry row for the hand-built cases.
export const reg = (sid: Sid, name: string, x: Partial<RegistryRow> = {}): RegistryRow => ({ sid, pid: 100, procStart: 'Thu Nov 19 08:00:00 2026', folder: '/Users/x/repo', name, status: 'idle', waitingFor: null, statusAt: NOW - 3_600_000, ...x })
export const WINDOWS: WindowReading[] = [{ state: 'off' }, { state: 'unknown' }, { state: 'on', window: { start: NOW - 3_600_000, end: NOW + 3_600_000, readAt: 0 } }]
// Run a property over many seeded worlds; the seed is in the failure message.
export function forAll(runs: number, body: (r: () => number, w: World, seed: number) => void): void {
  for (let seed = 1; seed <= runs; seed++) {
    const r = rng(seed)
    try {
      body(r, world(r), seed)
    } catch (e) {
      throw new Error(`seed ${seed}: ${(e as Error).message}`, { cause: e })
    }
  }
}
