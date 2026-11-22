// A handover: the old session's last tick (`handoverBegin`) and the ticks of whichever session the process runs after it (`handoverTick`: takeover, undo, sweep). Trust rules held here:
// nothing changes unless every record that has to move reads whole; the marker (0700 folder) is the whole state between the two ids; the new session takes only what its marker names, in
// the process that wrote it; a table write that cannot land is undone, never left half-done.
import type { Sid, View } from '../core/model.ts'
import { givenName } from '../core/model.ts'
import type { Marker } from '../core/handover.ts'
import { CLEAR_WAIT_MS, MARKER_SWEEP_MS, TAKEOVER_MS, dropHandover, groupOf, handOver, historicName, nextNumber, recordHandover } from '../core/handover.ts'
import type { Request } from '../core/upkeep.ts'
import { ran } from './cue.ts'
import { log, toast } from './io.ts'
import { mem, staleView } from './mem.ts'
import { moveTracker, trackerOk } from './pr.ts'
import { getView, goesIntact, listMarkers, moveGoes, moveMarks, readAsks, readHandovers, readOwnRow, rmMarker, tableReadable, updateHandovers, updateTable, writeMarker } from './store.ts'
import { say } from './tools-any.ts'

// A marker whose process is not live is swept only once it is this old, so a registry file caught between two writes never costs a handover its marker.
const DEAD_MARKER_MS = 30_000
// The name a session had before it was renamed NAME~N: what it goes back to when the handover is undone.
const baseOf = (m: Marker): string => m.name ?? m.historic.slice(0, m.historic.lastIndexOf('~'))

// ---- the old session's last tick ----
// The marker and the counter entry of a handover that did not happen.
async function forget($: any, old: Sid): Promise<void> {
  await rmMarker($, old)
  await updateHandovers($, (h) => dropHandover(h, old))
  staleView()
}
// undefined: the handover may start. Else the reason it may not, with nothing changed.
async function preflight($: any, v: View, me: Sid): Promise<string | undefined> {
  if (v.rows === 'unknown' || v.manager === 'unknown') return 'the sessions could not be read'
  if (!(await tableReadable($))) return 'the session table could not be read'
  if ((await readAsks($)).asks.some((a) => a.asker === me)) return 'an ask of this session is still open'
  if (!(await goesIntact($))) return 'a go file could not be read'
  if (!(await trackerOk($, me))) return 'the PR watch list could not be read'
  if ((await readHandovers($)) === undefined) return 'the handover record could not be read'
}
const namesOf = (v: View): (string | undefined)[] => [...(v.rows === 'unknown' ? [] : v.rows.values()).map((r) => r.name), ...Object.values(v.table).map((r) => r.name)]
// Pre-flight, marker, counter, rename, `/clear`: `ok` once `/clear` has been asked for (the tick ends there), else the reason nothing changed.
export async function handoverBegin($: any, me: Sid, r: Request, now: number): Promise<{ ok: true } | { no: string }> {
  const v = await getView($, true)
  const own = v.rows === 'unknown' ? undefined : v.rows.get(me)
  if (own === undefined) return { no: 'the session could not be read' }
  const row = v.table[me]
  // The name to give back: the manager's is the manager-name file's line; any other is the one the session was given, or its row's. A name Claude generated is not given back.
  const name = v.manager === me ? (v.managerName as string) : (givenName(own) ?? row?.name ?? null)
  const base = name ?? (own.name ?? me.slice(0, 8)).replace(/~\d+$/, '')
  const n = nextNumber((await readHandovers($)) ?? {}, base, namesOf(v))
  const historic = historicName(base, n)
  const bad = await preflight($, v, me)
  if (bad !== undefined) return { no: bad }
  const marker: Marker = { old: me, pid: own.pid, procStart: own.procStart, name, historic, file: r.focus, continuation: r.continuation, phase: 'clearing', at: now, failed: [], ...(row?.brief === undefined ? {} : { brief: row.brief }) }
  const group = groupOf(v, me)
  const saved = (await writeMarker($, marker)) && (await updateHandovers($, (h) => recordHandover(h, base, n, group === undefined ? undefined : { sid: me, group, folder: own.folder, at: now })))
  const undo = async (reason: string) => (await forget($, me), { no: reason })
  if (!saved) return undo('the handover record could not be written')
  staleView()
  // `ran` cannot tell a failed rename from a slow one, so the registry decides: read again once before giving up.
  await ran($, 'rename', historic, 10_000)
  let held = (await readOwnRow($, me))?.name === historic
  if (!held) {
    await $.clock.sleep(2_000)
    held = (await readOwnRow($, me))?.name === historic
  }
  if (!held) {
    if (own.name !== undefined && (await readOwnRow($, me))?.name !== own.name) await ran($, 'rename', own.name, 10_000)
    return undo('the session could not be renamed')
  }
  mem.handedAt = now
  toast($, say({ msg: 'handover.start', p: {} }))
  await ran($, 'clear', '', 10_000)
  staleView()
  return { ok: true }
}

// ---- the ticks after it ----
// Back to its own name, then the marker and the counter entry go. The marker stays (and this is tried again) until the registry shows the name.
async function giveBack($: any, me: Sid, m: Marker, reason: string): Promise<void> {
  const base = baseOf(m)
  if ((await readOwnRow($, me))?.name !== base) await ran($, 'rename', base, 10_000)
  if ((await readOwnRow($, me))?.name !== base) return
  await forget($, me)
  mem.owed.push(say({ msg: 'handover.notRun', p: { reason } }))
  await log($, me, 'handover-undone')
}
// The takeover: the table, then the goes, marks and watches, then the name, then the note. Each step is idempotent and tried again at the next tick while the marker stands.
async function takeover($: any, me: Sid, m: Marker, v: View, now: number): Promise<void> {
  if (v.rows === 'unknown' || v.rows.has(m.old) || m.phase === 'undo' || (m.phase === 'bound' && m.nw !== me)) return
  if (mem.hand?.old !== m.old) mem.hand = { old: m.old, first: now, moves: 0, renames: 0, moved: false, noted: false }
  const h = mem.hand
  if (m.phase === 'clearing') {
    let clash = false
    const wrote = await updateTable($, (t) => ((r) => (r === 'clash' ? ((clash = true), t) : r))(handOver(t, m.old, me, m.name)))
    if (wrote && !clash) return void (await writeMarker($, { ...m, phase: 'bound', nw: me }))
    if (!clash && now - h.first < TAKEOVER_MS) return
    // The table could not be moved: the old conversation comes back, with the old id that still owns every record. If it cannot, this session says so and goes on.
    await writeMarker($, { ...m, phase: 'undo' })
    if (await ran($, 'resume', m.old, 10_000)) return
    // The old id still owns the row and the children: nothing else moves to this session.
    h.moved = true
    return void (await writeMarker($, { ...m, phase: 'bound', nw: me, failed: [...m.failed, 'table'] }))
  }
  let cur = m
  if (!h.moved) {
    const results = await Promise.all([moveGoes($, m.old, me), moveMarks($, m.old, me), moveTracker($, m.old, me)])
    h.moves++
    const bad = ['goes', 'marks', 'PR watches'].filter((_, i) => !results[i])
    if (bad.length > 0 && h.moves < 3) return
    h.moved = true
    cur = { ...m, failed: [...m.failed, ...bad] }
    await writeMarker($, cur)
  }
  // The registry already holds NAME~N for this session (the name goes with the process): the name is set back. The manager is found only by its name, so it keeps trying.
  if (cur.name !== null && (await readOwnRow($, me))?.name !== cur.name) {
    if (h.renames < 3 || v.managerName === cur.name) {
      h.renames++
      await ran($, 'rename', cur.name, 10_000)
      return
    }
    cur = { ...cur, failed: [...cur.failed, 'name'] }
  }
  // The note is owed like any typed command's turn: sent once the session is quiet.
  if (!h.noted) {
    h.noted = true
    mem.owed.push(say({ msg: 'handover.note', p: { name: cur.name ?? baseOf(cur), file: cur.file, continuation: cur.continuation, failed: [...new Set(cur.failed)], ...(cur.brief === undefined ? {} : { brief: cur.brief }) } }))
  }
  await rmMarker($, m.old)
  await log($, me, 'handover-in', m.old)
}

// Only the process that began the handover acts on its marker (its memory holds the time it began; a file that merely names the pid and start time is not enough).
// Every tick, in whichever session the process runs: a marker that is stale or whose process is gone is removed; the old session's own marker is undone when it is live again (the
// resume landed) or when its `/clear` never ran; the new session that wrote `bound` finishes its predecessor's.
export async function handoverTick($: any, me: Sid, now: number): Promise<void> {
  const markers = await listMarkers($)
  if (markers.length === 0) return
  const v = await getView($, true)
  if (v.rows === 'unknown') return
  const own = v.rows.get(me)
  for (const m of markers) {
    const live = [...v.rows.values()].some((r) => r.pid === m.pid && r.procStart === m.procStart)
    if (now - m.at > MARKER_SWEEP_MS || (!live && now - m.at > DEAD_MARKER_MS)) {
      await rmMarker($, m.old)
    } else if (own?.pid !== m.pid || own.procStart !== m.procStart || mem.handedAt !== m.at) continue
    else if (m.old === me) {
      if (m.phase !== 'clearing' || now - m.at >= CLEAR_WAIT_MS) await giveBack($, me, m, m.phase === 'clearing' ? 'the session could not be cleared' : 'the records could not be moved')
    } else await takeover($, me, m, v, now)
  }
}
