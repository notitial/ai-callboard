// The usage readings: every session writes its own figures to usage/<sid>.json, and a lane list reads the files of the sessions it shows. Display only: nothing is decided on a
// reading, the file holds figures and no identity, and a figure that is not a number in range reads as none.
import type { Sid } from '../core/model.ts'
import { log, path, readText, rm, run, writeFile } from './io.ts'
import { mem } from './mem.ts'
import { safeJson } from './store.ts'

const WRITE_MS = 30_000
const KEEP_MS = 24 * 3_600_000
type Reading = { at: number; tokens?: number; cost?: number; fiveHour?: number; sevenDay?: number }
const fig = (x: unknown, max: number): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : undefined)
async function file($: any, sid: Sid): Promise<string | undefined> {
  return /^[A-Za-z0-9-]{1,64}$/.test(sid) ? path($, 'usage', `${sid}.json`) : undefined
}

// A write that is owed and 30 s after the last one; one that came sooner waits for the tick.
export async function usageFlush($: any, sid: Sid): Promise<void> {
  const now = await $.clock.now()
  if (!mem.usageOwed || now - mem.usageAt < WRITE_MS) return
  mem.usageOwed = false
  mem.usageAt = now
  const u = await $.session.usage().catch(() => undefined)
  const pct = (kind: string) => (Array.isArray(u?.rateLimits) ? u.rateLimits : []).find((w: { kind?: unknown } | null) => w?.kind === kind)?.percentUsed
  const p = await file($, sid)
  const body = JSON.stringify({ at: now, tokens: fig(u?.context?.tokens, 1e8), cost: fig(u?.cost?.usd, 1e6), fiveHour: fig(pct('five_hour'), 100), sevenDay: fig(pct('seven_day'), 100) })
  if (p === undefined || !(await writeFile($, p, body))) {
    mem.usageOwed = true
    await log($, sid, 'error', 'usage-write')
  }
}
export async function usageMeasure($: any, e: any, next: any) {
  mem.usageOwed = true
  Promise.resolve(usageFlush($, await $.session.id())).catch(() => undefined)
  return next(e)
}
export async function usageDrop($: any, sid: Sid): Promise<void> {
  const p = await file($, sid)
  if (p !== undefined) await rm($, [p])
}
// Files a day old, taken once at the start.
export async function usageSweep($: any): Promise<void> {
  const d = await path($, 'usage')
  if (d !== undefined) await run($, ['/usr/bin/find', d, '-type', 'f', '-mtime', '+1', '-delete']).catch(() => undefined)
}
export async function usageRead($: any, sid: Sid, now: number): Promise<Reading | undefined> {
  const p = await file($, sid)
  const t = p === undefined ? undefined : await readText($, p, 1024)
  const j = (t === undefined ? undefined : safeJson(t)) as Record<string, unknown> | undefined
  const at = fig(j?.at, Infinity)
  return j === undefined || at === undefined || at > now || now - at > KEEP_MS ? undefined : { at, tokens: fig(j.tokens, 1e8), cost: fig(j.cost, 1e6), fiveHour: fig(j.fiveHour, 100), sevenDay: fig(j.sevenDay, 100) }
}
