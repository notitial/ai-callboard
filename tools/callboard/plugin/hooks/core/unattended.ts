// The unattended window: the span his command asks for and what a reader makes of the window file. Pure. Trust rule held here: a window that cannot be read is
// `unknown`, which no dialog treats as off, so a failed read never opens a pop-up. The window changes nothing but whether a pop-up may open.
import type { Window, WindowReading } from './model.ts'

export const WINDOW_MIN_MS = 30 * 60_000
export const WINDOW_MAX_MS = 14 * 3_600_000
const MINUTE = 60_000

// `/callboard unattended` with nothing (the state), `off`, `Nm`, `Nh` (at most two decimals) or `HH:MM` (the next such local time). An end outside 30 minutes to
// 14 hours from now is refused with the nearest end that fits, to the minute.
export type SpanOp = { op: 'state' } | { op: 'off' } | { op: 'on'; end: number } | { op: 'bad' } | { op: 'short'; earliest: number } | { op: 'long'; latest: number }
export function parseSpan(args: string, now: number): SpanOp {
  const a = args.trim()
  if (a === '' || a === 'off') return { op: a === '' ? 'state' : 'off' }
  const until = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(a)
  const span = /^(\d{1,2}(?:\.\d{1,2})?) ?h$/.exec(a) ?? /^(\d{1,4}) ?m$/.exec(a)
  let end: number
  if (until) {
    const d = new Date(now)
    d.setHours(Number(until[1]), Number(until[2]), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    end = d.getTime()
  } else if (span) end = now + Math.round(Number(span[1]) * (a.endsWith('h') ? 60 * MINUTE : MINUTE))
  else return { op: 'bad' }
  if (end - now < WINDOW_MIN_MS) return { op: 'short', earliest: Math.ceil((now + WINDOW_MIN_MS) / MINUTE) * MINUTE }
  if (end - now > WINDOW_MAX_MS) return { op: 'long', latest: Math.floor((now + WINDOW_MAX_MS) / MINUTE) * MINUTE }
  return { op: 'on', end }
}

// The window file as a reader takes it. raw: the parsed file, undefined for no file, anything else (an unreadable file included) for a file that is not a window.
// A failed read keeps the last good reading while it has not ended; with none it is unknown. A window on is one whose span holds now.
export function readWindow(raw: unknown, now: number, last?: WindowReading): WindowReading {
  if (raw === undefined) return { state: 'off' }
  const w = (raw ?? {}) as Partial<Window>
  const ok = Number.isFinite(w.start) && Number.isFinite(w.end) && w.end! > w.start! && w.end! - w.start! <= WINDOW_MAX_MS + MINUTE
  if (!ok) return last?.state === 'on' && now >= last.window.end ? { state: 'off' } : (last ?? { state: 'unknown' })
  return now >= w.start! && now < w.end! ? { state: 'on', window: { start: w.start!, end: w.end!, readAt: Number.isFinite(w.readAt) ? w.readAt! : 0 } } : { state: 'off' }
}
