// The process calls, the log, the person's dialogs and toasts, the small file reads and writes, the one sender of the plugin's own turns, and the window reading.
// Trust rules held here: a dialog answer is the person's own click or a failure, and no dialog opens unless the window reads off; every file lives under one folder made 0700;
// a write goes to a temporary name and is renamed; the plugin's own submitted texts are counted so a turn of its own is told from a person's.
import type { Sid, WindowReading } from '../core/model.ts'
import { readWindow } from '../core/unattended.ts'
import type { DialogSpec } from '../ui.ts'
import { mem, staleView } from './mem.ts'

export const TICK_MS = 2000
const MV = '/bin/mv'
const RM = '/bin/rm'

export function run($: any, argv: string[], o: Record<string, unknown> = {}): Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }> {
  return $.process.run(argv, { timeoutMs: 5000, ...o })
}
// true: `rm` exited 0.
export function rm($: any, paths: string[]): Promise<boolean> {
  return run($, [RM, '-rf', '--', ...paths]).then((r) => r.exitCode === 0, () => false)
}
// A wait inside one hook goes through a host process, never $.clock.sleep, which counts against the hook's own 10 s. false: the process failed.
export async function pause($: any, ms: number): Promise<boolean> {
  return (await $.process.run(['/bin/sleep', String(ms / 1000)], { timeoutMs: ms + 5000 }).catch(() => undefined))?.exitCode === 0
}
// A toast only informs: it runs after the effect it reports and never changes a result.
export function toast($: any, text: string): void {
  try {
    Promise.resolve($.ui.toast(text)).catch(() => undefined)
  } catch {}
}
// The OS notification beside a relayed ask's dialog, keyed by the ask, and its withdrawal. Both only inform: a host that cannot raise or withdraw one changes nothing.
export function notify($: any, key: string, text: string): void {
  try {
    Promise.resolve($.ui.notify(text, { key })).catch(() => undefined)
  } catch {}
}
export function unnotify($: any, key: string): void {
  try {
    Promise.resolve($.ui.cancelNotify(key)).catch(() => undefined)
  } catch {}
}

// The person's home, from the engine's environment; a path with an odd segment is no home. Everything lives under <home>/.claude/callboard/v2.
export async function home($: any): Promise<string | undefined> {
  if (mem.home === undefined) {
    const h = await $.env.get('HOME').catch(() => undefined)
    if (typeof h === 'string' && h.startsWith('/') && h.split('/').slice(1).every((s) => /^[A-Za-z0-9._ -]+$/.test(s) && s !== '.' && s !== '..')) mem.home = h
  }
  return mem.home
}
async function v2($: any): Promise<string | undefined> {
  const h = await home($)
  return h === undefined ? undefined : `${h}/.claude/callboard/v2`
}
export async function path($: any, ...parts: string[]): Promise<string | undefined> {
  const r = await v2($)
  return r === undefined ? undefined : [r, ...parts].join('/')
}
// A folder of ours, made once per process and set 0700, with the root above it.
export async function ensureDir($: any, d: string): Promise<void> {
  if (mem.dirs.has(d)) return
  const top = (await v2($))!
  await run($, ['/bin/mkdir', '-p', d])
  await run($, ['/bin/chmod', '700', d, top])
  mem.dirs.add(d)
}
// At most `max` bytes of a file; undefined for no file, a failed read or a longer file.
export async function readText($: any, p: string, max = 65_536): Promise<string | undefined> {
  try {
    if ((await $.fs.stat(p)).kind !== 'file') return undefined
    const t = await $.fs.read(p, { length: max + 1 })
    return typeof t === 'string' && t.length <= max ? t : undefined
  } catch {
    return undefined
  }
}
// Written whole under a temporary name and renamed over the file.
export async function writeFile($: any, p: string, text: string): Promise<boolean> {
  const tmp = `${p}.${newId()}.tmp`
  try {
    await ensureDir($, p.slice(0, p.lastIndexOf('/')))
    const st = await $.fs.stat(p).catch(() => undefined)
    if (st !== undefined && st.kind !== 'file') return false
    await $.fs.write(tmp, text)
    await run($, ['/bin/chmod', '600', tmp])
    if ((await run($, [MV, '-f', '--', tmp, p])).exitCode === 0) return true
  } catch {}
  await rm($, [tmp])
  return false
}
// Created only if `p` does not exist, so the first writer wins: written under a temporary name and hard-linked into place, which fails when `p` is there.
export async function createExcl($: any, p: string, text: string): Promise<'ok' | 'exists' | 'error'> {
  const tmp = `${p}.${newId()}.tmp`
  try {
    await ensureDir($, p.slice(0, p.lastIndexOf('/')))
    await $.fs.write(tmp, text)
    await run($, ['/bin/chmod', '600', tmp])
    return (await run($, ['/bin/ln', '--', tmp, p])).exitCode === 0 ? 'ok' : (await $.fs.exists(p)) ? 'exists' : 'error'
  } catch {
    return 'error'
  } finally {
    await rm($, [tmp])
  }
}
// A fresh random id for an ask, a go or a temporary name: 10 characters of 0-9 and a-z.
export const newId = (): string => (Math.random().toString(36) + '0000000000').slice(2, 12)
// One writer at a time: a lock folder made by `mkdir` that holds its owner's token, removed only by that owner. One 10 s old is moved aside by a waiter (a move that finds
// nothing fails), so a stale lock is normally broken once; two waiters that both saw it stale can still both break it. undefined: the lock was not got.
export async function locked<T>($: any, name: string, f: () => Promise<T>): Promise<T | undefined> {
  const dir = await path($, `${name}.lock`)
  const token = Math.random().toString(36).slice(2)
  if (dir === undefined) return undefined
  await ensureDir($, dir.slice(0, dir.lastIndexOf('/')))
  for (let i = 0; i < 40; i++) {
    if ((await run($, ['/bin/mkdir', dir]).catch(() => undefined))?.exitCode === 0) {
      await $.fs.write(`${dir}/owner`, token).catch(() => undefined)
      try {
        return await f()
      } finally {
        if ((await readText($, `${dir}/owner`, 64)) === token) await rm($, [dir])
      }
    }
    const st = await $.fs.stat(dir).catch(() => undefined)
    const aside = `${dir}.${token}.stale`
    if (st !== undefined && (await $.clock.now()) - st.mtimeMs > 10_000) (await run($, [MV, '-f', '--', dir, aside]).catch(() => undefined))?.exitCode === 0 && (await rm($, [aside]))
    else await pause($, 100)
  }
  return undefined
}

// One log file per session id; a fixed event and reason code, never free text. A repeat of the line just written is dropped.
export async function log($: any, sid: Sid, event: string, reason = ''): Promise<void> {
  const p = await path($, 'log', `${sid}.jsonl`)
  const key = `${sid}|${event}|${reason}`
  if (p === undefined || mem.logged === key) return
  mem.logged = key
  await ensureDir($, p.slice(0, p.lastIndexOf('/'))).catch(() => undefined)
  await run($, ['/usr/bin/tee', '-a', '--', p], { stdin: `${JSON.stringify({ t: new Date(await $.clock.now()).toISOString(), event, reason })}\n` }).catch(() => undefined)
}
// A refusal or fallback about a session: logged and queued as a `report` event for the session above it (RECEIVES gives it to a lead).
export async function report($: any, me: Sid, about: Sid, code: string): Promise<void> {
  mem.reports = [...mem.reports, { about, code, at: await $.clock.now() }].slice(-50)
  await log($, me, 'report', `${code}:${about}`)
}

// ---- the plugin's own turns ----
export function countDown(text: string): void {
  const m = mem.own.get(text)
  if (m !== undefined && m.n > 1) mem.own.set(text, { ...m, n: m.n - 1 })
  else mem.own.delete(text)
}
// The one sender of the plugin's own turns. real: the turn is work (a resume note); a ping, a nudge or a notice is not, and moves no stop clock of the keepalive.
export async function submitOwn($: any, text: string, real = true): Promise<void> {
  mem.own.set(text, { n: (mem.own.get(text)?.n ?? 0) + 1, real })
  mem.submits++
  staleView()
  try {
    await $.prompt.submit({ text })
  } catch (e) {
    countDown(text)
    throw e
  }
}
// The own text a turn.start carries: one submitted and not yet counted down, as it stands or framed; the longest wins.
export const ownTextOf = (startText: unknown): string | undefined =>
  typeof startText === 'string' ? [...mem.own.keys()].filter((t) => startText.includes(t)).sort((a, b) => b.length - a.length)[0] : undefined

// ---- the window, and the person's dialog ----
// The window as this process reads it, kept 10 s unless `fresh` (a dialog reads it anew); a failed read keeps the last good one (readWindow). The file is written by his typed command only.
export async function windowNow($: any, fresh = false): Promise<WindowReading> {
  const now = await $.clock.now()
  if (!fresh && mem.win !== undefined && now - mem.win.at < 10_000) return mem.win.w
  const p = await path($, 'unattended.json')
  let raw: unknown = 'unreadable'
  if (p !== undefined) {
    if (!(await $.fs.exists(p).catch(() => true))) raw = undefined
    else {
      const t = await readText($, p, 1024)
      try {
        raw = t === undefined ? 'unreadable' : JSON.parse(t)
      } catch {}
    }
  }
  const w = readWindow(raw, now, mem.win?.w)
  mem.win = { at: now, w }
  return w
}
// Whether an unattended window is on now, as the ask timeline takes it: a window that cannot be read is not on.
export async function awayNow($: any): Promise<boolean> {
  return (await windowNow($)).state === 'on'
}
// The dialog helper of the go and force-stop dialogs: it opens only while the window reads off, one at a time in this session, and records the open dialog's header and question until it ends (a dialog
// left on screen after its time limit stays recorded). Only the label a dialog offered is an answer; any other result is a reason.
export async function personDialog($: any, spec: DialogSpec, ms = 90_000): Promise<{ label: string } | { no: 'unattended' | 'busy' | 'timeout' | 'error' }> {
  if ((await windowNow($, true)).state !== 'off') return { no: 'unattended' }
  const key = `${spec.header}\n${spec.question}`
  if (mem.dialogs.size > 0) return { no: 'busy' }
  mem.dialogs.add(key)
  let late = false
  try {
    const asked = Promise.resolve($.ui.ask(spec.question, { options: spec.options.map((o) => o.label), header: spec.header }))
    const a = await Promise.race([asked.then((x) => ({ x })), $.clock.sleep(ms).then(() => 'timeout' as const)])
    if (a === 'timeout') {
      late = true
      asked.finally(() => mem.dialogs.delete(key)).catch(() => undefined)
      return { no: 'timeout' }
    }
    return typeof a.x === 'string' && spec.options.some((o) => o.label === a.x) ? { label: a.x } : { no: 'error' }
  } catch {
    return { no: 'error' }
  } finally {
    if (!late) mem.dialogs.delete(key)
  }
}
