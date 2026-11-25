# 17. Every piece of the Claude Code patch goes in on its own

**Status:** proposed
**Date:** 2026-11-25

Scope: how the patch script for the Claude Code VS Code extension decides what to write when an extension update moved
some of the code it hooks into, and how the panels extension learns whether the folder patch is in.

## Context

The patch started as one change, the folder patch: a lane of any folder of a multi-folder window opens there. Optional
pieces grew around it (the wider composer, the context pie, the folder pill, the Run button, the restore, tab group and
add-dir fixes, the Session Manager commands, the session list). Each optional piece had its own check, its own way of
being put in, and its own place in a builder that knew them by name. The folder patch stayed mandatory: when one of its
anchors moved, the whole patch was refused, even though every other piece still fitted. Claude Code updates about daily,
so one moved anchor took everything out until the script was repaired, and every new piece added another special case
to the builder, the update path and the undo path.

## Options Considered

- **Keep the folder patch mandatory and add pieces as before.** Each piece keeps costing a checker, an applier and a
  line in the builder, and one moved anchor of the folder patch still costs the person every piece. Rejected.
- **Make every piece optional, but keep a checker and an applier per piece.** It fixes the outage, but not the special
  cases. Rejected.
- **One table of pieces and one builder: chosen.**

## Decision

- **Every piece, the folder patch included, applies or is left out on its own.** A piece is a row of one table: its
  marker field, its name, the pieces it needs, and its parts: the edits (an anchor in the extension or the webview
  script, matched exactly once, and its replacement), the tokens the shipped files must hold (the members a command
  calls), and the names it adds, which must not be there already. One builder walks the table in order on copies of
  both files and keeps a piece only when all of its parts fit, so a piece goes in whole or not at all.
- **A piece that needs another names it.** The restore fix needs the folder patch, and the pie's hover text, now a
  piece of its own, needs the pie. A piece left out takes the pieces that need it with it, and nothing else.
- **Left out means a warning, not a refusal.** The check and the apply print one warning line per piece left out, with
  its reason, and write the rest. They refuse only when no piece fits; nothing is written then.
- **The marker records the folder patch as a field like the others,** and the panels extension counts the folder patch
  only when that field is not false. A marker written before the field existed always carried the folder patch, so no
  field still counts as in.
- **What it builds does not change.** On a version where every piece fits, the patched files are byte for byte the ones
  the earlier script built, and the marker gains only the new fields. A test pins that, and another breaks each anchor
  of a real install by one byte to show that only its piece and the pieces that need it are left out.

## Consequences

- A Claude Code update that moves one piece's code costs that piece, not the patch, and the person keeps the rest until
  the script is repaired. `/patch-vs-claude` offers the repair on a warning line as well as on a refusal.
- A new piece is one table row with its anchors and its replacement, and the builder, the update and the undo need no
  change.
- A window whose folder patch is left out keeps callboard's one-repo-per-window behaviour while the other pieces work.
