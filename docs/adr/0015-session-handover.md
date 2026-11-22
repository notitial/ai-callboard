# 15. A session hands itself over to a clear one

**Status:** proposed
**Date:** 2026-11-22

Scope: how a long-running session (a lane, a lead, a conductor, the manager or a loose session) replaces itself with a
clear conversation in the same panel and keeps its name, role, parent, children, goes and PR watches. It moves a lead's
or conductor's capability and a go's coverage from one session id to another, so it is on the risk list (permissions,
security controls). It amends [ADR 0012](0012-callboard-plugin.md) and [ADR 0013](0013-conductor.md).

## Context

A session that has run for hours carries a context it can no longer use well, and a compaction keeps a summary, not a
fresh start. The person wants the other choice too: end the conversation, start a clear one, and have everything callboard
keeps for the session carry on. Callboard keys every record to a session id, and `/clear` gives the same process (and
panel) a new id with no `session.start`. Today a typed `/clear` in a lead leaves its row keyed to the old id, which reads
not live: its lanes fall to the manager at once and the row ages out.

A spike on a scratch HOME showed that `$.command.run({ command: 'clear' })` from the plugin's timer runs `/clear` in about
a second, the process, the pid's registry row, the plugin's module memory and its timer live on, and the row takes the new
session id with the old `name` and `nameSource`. `/resume <old id>` brings the old conversation back into the same panel,
and `/rename NAME~1` is taken. `/model` and `/effort` survive `/clear`.

## Decision

**A session hands over only itself, by two triggers.** The session calls `request_handover` (a tool every session has, as
`request_compact`), or the person types `/callboard handover` in its panel, which owes the session one turn telling it to
write its state to a file under its own `.archive/` and call the tool. A parent asks its lane by an ordinary message; there
is no parent tool, and nothing lets one session hand over another. Nudges still ask for a compaction, never a handover.
A typed `/clear` is unchanged apart from the memory reset below.

**The tool shares `request_compact`'s body.** The same refusals (a subagent, not interactive, busy agents) and the same
request machinery: it is queued, armed by a turn that ends with an answer, dropped by any other end or by a prompt the
person types, and dropped after 15 minutes. It differs in four ways: no token floor, at most one handover per 30 minutes
(per process), the off session is refused, and a relay dialog open in the session refuses it. Its `file` is the session's
own note: an absolute path with no `..`, under `<its folder>/.archive/`, a plain file (no link on the way) of at most 256 KB.

**The old session's last tick refuses before it changes anything.** Once the session is idle, with an empty prompt box, the
plugin reads the registry and the table, the session's asks, every go file, its PR watch list and the handover record, and
checks the name `NAME~N` is free. Any doubt (a record that does not read whole, an ask of its own still open) is "did not
run" with the reason and nothing renamed or cleared. Then it writes a marker (`v2/handover/<old id>.json`, in the 0700 state
folder) and a counter entry (`v2/handovers.json`: per name the last number used, and the old sessions with their group and
folder), renames the session `NAME~N` and reads its own registry row back (a rename that does not land is undone), toasts, and
runs `/clear`. A name Claude generated is not given back: the session is renamed `<that name>~N` and restores none.

**The marker holds the old id as unknown, not gone.** While a marker under two minutes old names a pid and start time that a
live registry row still carries, the old id reads `unknown` once its row is gone. The codebase already treats `unknown` as "move
nothing": a parent's retire, park or stop of it is refused, a PR notice for it is held, an ask under it is kept, `tidy` stamps
no `goneAt` and copies no name into its row, and the `no-manager` toast is skipped. So its lanes stay under it through the gap.

**The new session takes over what the marker names, in the process that wrote it.** Each step is idempotent and retried at
the next tick: the table row moves to the new id under the name the session had, and every `under` that named the old id (a
`new:` row too) names the new one, in one locked write that never overwrites a row the new id already has; then the goes the old
id gave, its ask marks (`.up.<old>` to `.up.<new>`, unless the new id has one) and its PR watches (merged under both locks; an
entry the new id already has wins); then the session is renamed back to `NAME` (the registry holds `NAME~N`, because the name
belongs to the process, so this is always needed; the manager is found only by name and retries on every quiet tick); then the
session is owed one turn with the handover note and the continuation, naming any step that did not land, sent once it is quiet. A
loose session has no row: it is renamed only. The new session takes nothing else from the file system: a marker is read only from a
file named for its own old id, and only by the process that wrote it (its pid and start time, and the time its own handover began, which only that process's memory holds); once the table moved, only the session that moved it (named in the marker) finishes it.

**A takeover that cannot finish is undone, not left half done.** If the table write meets a row already keyed to the new id,
or fails for 30 seconds, the new session marks the handover for undo and runs `/resume <old id>`: the old conversation comes back with the old id, which still
owns every record (the table write is first), renames itself back to `NAME`, removes the marker and its counter entry and says
"did not run: the records could not be moved". If the resume does not land either, the new session moves nothing else (the records stay with the old id) and goes on with a
`table` failure in its note; should the resume land late, the old session finds a live id with a bound marker and undoes it the same way. If `/clear` never runs, the old session renames itself back after a minute. A marker whose process
is gone for 30 seconds, or that is ten minutes old, is removed by any session.

**Process memory.** The plugin's module memory outlives a `/clear`, so what belongs to the old id (owed turns, asks cache,
told and spent marks, the signed flag, the preset and self-name flags, the relay marks) is reset when a session ends with
reason `clear` or `resume`. This also fixes the carry-over after a typed `/clear`.

**The old conversation is archived.** The panels extension reads `handovers.json` beside the table: an old id in this
window's folders with no table row and no live process, on two clean ticks and no sooner than two minutes after the handover began, is filed in its group through `callboard file
session` and archived through `callboard archive sessions`, whatever the group, and remembered so it is archived once. A
retired lane or minted lead is archived the same way already. A loose session is renamed `NAME~N` and not archived.

## Amends

- **ADR 0012, "Tools follow capability":** six tools go to every session, `request_handover` the sixth.
- **ADR 0012, invariant 5:** a go covers the sessions under the one it was given in, and the session that took over from
  that session by a handover. The go file's giver is rewritten to the new id; nobody else gains coverage.
- **ADR 0012, invariant 6 ("Powers are granted, never inferred"):** the new id's power is not inferred. It is the same
  grant carried to the same work, by the plugin, on the session's own call or the person's typed command, from a marker only
  the process that wrote it takes. A session still cannot grant itself a lead's or conductor's capability.
- **ADR 0012, Consequences ("no lead takeover exists") and ADR 0002's note:** narrowly reopened for a session's own
  handover. A restart of the same conversation still keeps its session id.
- **ADR 0013, "Nothing here lets a session grant the conductor role":** a handover carries the flag to the session that
  continues the same conversation's work, and grants it to no other session.

## Equivalence with compaction, and the threat model

A compaction keeps the same session id and a summary its own call wrote; the work goes on under the same authority. A
handover keeps the same authority under a new id and a file its own call wrote, and the note says so: data, not an instruction,
no approval of its own, a go counts only if `go_status` lists it. What the session can do before and after is the same set.
A forged marker or counter entry is no stronger than a forged table or go file, which ADR 0012 already accepts for a process
of the same user: the state folder is 0700 and the protected-paths guard keeps agents' file tools off it. The takeover reads a
marker only for its own pid and start time and moves only what the marker's old id owned.

## Options Considered

- **An alias table, old id to new id, that every reader resolves.** No file is rewritten, but every reader of `under`,
  `giver`, ask marks and trackers must resolve it, and it never shrinks. Rejected.
- **A tool for a parent to hand its lane over.** The parent cannot write the lane's notes. Rejected; a parent asks by message.
- **Refuse a handover while the session has children.** It saves about three lines but not the unknown hold (a lane that hands
  over still needs its old id held), and a lead could hand over only after retiring every lane. Rejected.
- **Treat a typed `/clear` as a handover.** A typed `/clear` is a fresh start the person chose; it stays as it is.
- **A token floor shared with compaction.** It would stop a small-context lead from starting clean after a phase. None; busy
  agents and 30 minutes bound it.

## Consequences

- No model or effort is carried: both survive `/clear`, and `/effort` writes the person's own default, so the takeover never
  runs either.
- The 30-minute gap is held in the process (it survives `/clear`), not read back from `handovers.json`.
- A handover moves a lead's capability, so the pre-flight, the read-back of the rename, the undo and the marker's rules are
  the security-relevant code; the specs cover each refusal and each failure path on the fake host.
- A message sent to a name in the second or so between the rename and the takeover may not reach the new session. The
  briefing says so. Not measured in the spike (the gap is too short to time).
- The manager has no name in the gap: asks then go to the person's own dialog, as with no manager, and the relay resumes
  when the name is back.
- A prompt the person types in the seconds before the table write meets a loose session's briefing; the note itself is sent after.
- **Open until the person's live check of the built change in a VS Code panel:** whether the tools the plugin registered at
  session start (`request_compact`, the lead's tools) are still there in the session after `/clear`, whether a message to the name in the gap
  reaches the new session, whether the panel restores the new id after a window reload, and whether the patch's file and archive
  commands archive `NAME~1` (the extension's half of the archive; the plugin half is tested).
