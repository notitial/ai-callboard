# 12. Callboard as a plugin: one session model, one ask chain

**Status:** accepted
**Date:** 2026-11-19

Scope: how callboard decides what a session is, who answers its asks and what unattended mode changes. It replaces the
mod's kinds, grants and per-tier answering with one model, built as a plugin (`tools/callboard/plugin`). It changes who
may answer a permission prompt and who may widen a session's powers, so it is on the risk list. It is built and live:
the person switched the one plugin entry over ([docs/setup.md](../setup.md), A Mac set up before the plugin) and the mod is
deleted.

It supersedes [ADR 0006](0006-conductor-opens-leads.md), [ADR 0007](0007-conductor-owns-leads.md) and
[ADR 0011](0011-all-prompts-rise.md), and amends [ADR 0001](0001-manager-role.md), [ADR 0002](0002-callboard.md),
[ADR 0004](0004-prompt-answering.md), [ADR 0005](0005-callboard-module-layout.md),
[ADR 0008](0008-unattended-mode.md), [ADR 0009](0009-go-given-once.md) and [ADR 0010](0010-pr-notices.md).

## Context

The mod grew four kinds of session (manager, conductor, lead, lane), a grant, a presence file and a ledger row for
each, and a separate path for every case that did not fit. Each repair added a path. The failures it kept repeating
were of one shape: a notice that reached a session late or about a session that had changed, an ask that nobody owned
and so waited for hours, unattended mode as a second program with its own answers, and a power one session gained
because another session's file said so.

The person's aim is that the manager handles the whole Mac: every session is handled unless callboard is off for it,
and a request to the person never waits on a tier that cannot act. The threat model is honest mistakes, not a hostile
process: state is plain files, and a process that runs as the person can write any of them ([ADR 0002](0002-callboard.md),
Consequences).

## Options Considered

- **Keep the mod and patch it.** Rejected: each earlier repair is the evidence. The mod's kinds and special cases are
  what the failures came from.
- **A conductor tier above the leads.** Rejected: the need is one project lead over several repos, which is a lead
  with a repo allowlist, not a tier. *Amended 2026-11-21 ([ADR 0013](0013-conductor.md)):* a lead with one more power,
  making leads inside repos the person saved, is allowed; the tier stays rejected.
- **Rules per tier, judged by code.** Rejected: which ask a lead may answer is a judgment (a rubric the tier reads),
  not a table. Code enforces the timing and who may write an answer, never the judgment.
- **Unattended mode as its own set of rules** (a manager that answers or parks, a lane cap, a return list).
  Rejected: it is the same path with the person absent. Anything else is a second program to keep correct.
- **Rebuild beside the mod, switch once, switch back if needed** (chosen). The plugin is a pure core (no I/O, no text),
  adapters that feed it and act on what it returns, a texts table keyed by message id and one UI module.

## Decision

**One session model.** A session has an id, a folder, a name, a parent and a capability: none, lead or manager. Lane is
not a kind: it is any session with a lead or the manager above it. A lead may hold a repo allowlist, set only by the
person with `/callboard lead PATH`. The sentinel's merge right is a lead plus an MCP server plus a line in the
manager's rules file; callboard has no case for it. Rows bind by session id, so a rename keeps the lane and a restart of
the same conversation keeps its id. Only the manager is found by name: a per-machine file the person writes once names
it, and `MANAGER` is reserved.

**The parent is computed, never stored.** It is the session's lead if that is live, else the manager if live, else the
person. A parent that is compacting or inside a question is still live and still owns the ask until its deadline.
The manager is the one session found by registry name (a residual, in [ADR 0002](0002-callboard.md)).

**Tools follow capability.** Six tools go to every session (`go_request`, `go_status`, `pr_watch`,
`request_compact`, `request_handover`, `rest`; *amended 2026-11-22, [ADR 0015](0015-session-handover.md)*); the thirteen that open, stop and list children and answer asks go only to a lead or the
manager, and each body checks the capability again. There is one cap on live children. A parent parks, resumes,
retires and opens its children with no dialog; only a force stop of a live lane keeps one. A session compacts itself; a lead that
wants a lane compacted says so in an ordinary message. A lead takes a loose session by name with one tool, and any
ancestor acts on any descendant.

**Nine invariants hold for every session, an unknown one included.**

1. Managed by default. Off is per session, typed by the person, and wins over everything, unattended included. One
   machine-wide OFF file stops every tier's answers.
2. One parent, as above.
3. Every ask has an owner and a deadline (the timeline below).
4. Unattended mode changes timing and nothing else (below).
5. A go is only the person's own click or typed turn, for the work it names and the sessions under the one it was
   given in, or the session that took over from it by a handover ([ADR 0015](0015-session-handover.md)). Never a merge, a force push, a push to main, a production change or a delete outside the work.
6. Powers are granted, never inferred (a handover carries a grant to the session that continues the work, by the plugin, on
   the session's own call or the person's typed command: [ADR 0015](0015-session-handover.md)). An unknown session has none and is still managed. No carve-outs: a merge goes
   through the same chain as any ask.
7. Notices follow current relationships: a child's event goes once to the parent computed when it is sent. The manager
   is woken only by asks and expired asks; a lead is told every event about its own lanes.
8. When the plugin cannot decide, the result is the safe default and it is visible: logged and shown to the parent. *Amended 2026-11-22: the `report()` helper that was to queue a refusal for the parent was never called and is gone, with its notice kind. A fallback is logged, and a refusal says its reason to its caller.*
9. No idle waste: pings and compaction nudges follow fixed bounds.

**The ask timeline.** One timeline serves every kind of ask, a permission and a question alike. For the first 30
seconds the ask is hidden from every tier: the person's own dialog is the only thing open. Then the nearest parent
sees it and must allow, deny, answer or escalate. With no choice it reaches the manager at 5 minutes of awake time. At
15 minutes of awake time an unanswered ask is closed with an "expired" message that tells the session not to ask again
and to make the work manageable. A session asleep adds nothing, and a liveness that cannot be read never closes
anything early. An answer counts only if its author is above the asker now, it is built from the live tool input and
never from a file, and the protected-paths guard and its markers are in place; the person's click always wins. By day
an ask that reaches the person is put to them as a dialog callboard raises in the manager's session, or the person tells
the manager in words: either is the person's own act on that one ask.

*Amended 2026-11-22 (faster asks while away).* While an unattended window is on, nobody is at the person's panel, so a
30-second head start and a 5-minute wait only delay a decision the tiers can make. The two steps shorten to 5 seconds
(wall time) for the parent and 30 seconds of awake time for the manager. The 15-minute close, an escalation moving the
ask on at once and the daytime times are unchanged. The engine reads the window and passes one flag to the timeline
(`StageIn.away`); the timeline itself stays pure. A window never read successfully counts as not on, so the
daytime times apply; a read that fails after a good one keeps that reading until its window ends, and a missing file
means off. The check-in turn that tells a parent of a new ask comes from a list kept 10 seconds, so it can arrive some
seconds after the 5; `prompt_list` and `prompt_answer` read the ask fresh and are exact.

*Amended 2026-11-20 (escalation round).* The relay offers a call of 2 to 4 questions too, with one combined answer;
a session still answers only a single question. How the dialog is shown and closed is the 2026-11-21 amendment below. The person's pick reaches the asker with a plugin note that it is their settled choice
(only a pick made in the dialog carries it: the plugin cannot tell the manager's own `prompt_answer` after a typed turn
from the manager's own decision, so that answer keeps `answered by <manager>, not the person`). The manager's check-in
also carries a short digest, "since your last check-in", of asks that ended in an asker's own panel (a click or an interruption), lanes done
or gone and gos that ended: log data, no command text, never a wake-up by itself. The dialog for a tool ask the manager escalated with a note shows that note
(stored in its `up` mark, never in the log) first, under a fixed label, with Allow, Show the command and Deny: the person may allow on the note. Show the command opens the
ask's own dialog with the whole raw command (Allow and Deny; Deny only when the command is cut or too large to print: a cut ask skips the note, and a command too large to print leaves the note without Allow).
With no note it is that second dialog alone.

*Amended 2026-11-21 (native relay).* The relay dialog is an AskUserQuestion that callboard calls in the manager's
session itself (`$.agent.call`), no longer a `$.ui.ask` pop-up: a pop-up raised from a timer cannot be closed, and one
left on screen after its ask was decided elsewhere misled the person. A call a plugin makes passes through that plugin's
own hooks again, so `tool.check` and PermissionRequest know the dialog by its origin and its first question and pass it
through untouched: callboard's hooks neither hold nor answer it. Its abort signal is the plugin's handle.
Each tick first closes the open dialog, before every other gate and so also while the manager is busy, once its ask is
decided, closed or expired elsewhere, or once the window is not off. A dialog closed so writes nothing; one closed by a
window is put again once the window is off. One dialog is open at a time. A question ask shows the asker's own questions
in one dialog, each opened with the asker's name and every text escaped; a typed answer in place of a pick is the
person's deny with what they typed as its note. A tool ask is a question that names the call, as above. A dialog whose
text is not shown whole, or whose escaped labels or questions come out alike, offers Deny and Leave it, which writes
nothing. Only a dialog that callboard's PermissionRequest hook saw go to the person, with no hook beneath deciding it,
is theirs: a result or a refusal without that writes nothing, and a dismissal after it is their deny. A hook above
callboard's that refuses the dialog after that is read as a dismissal too; it can only deny. A dialog that closed by
itself while the person was idle writes nothing and is put again. `answerAsk` reads the ask again, so a pick on a
closed ask writes nothing and a toast says so. A keyed OS notification that names the asker (a plain name, else its
id) and the tool, never the command, stands beside the open dialog and is taken back when it closes. This replaces the pop-up per question, the line under a stale pop-up
and the out-of-date toast.

*Amended 2026-11-22 (plain dialog text).* The tool shows no markdown, and the person may read the dialog on a phone, so
every relay dialog is plain text with no code quotes or fences. Names are a plain session name, else the session id.
The command is the ask's JSON, whose strings carry every line break as an escape, so no line of it reads as the
dialog's own. The manager's note sits whole on one line after a short label that names the manager ("NAME's
summary:"), so none of it reads as the plugin's or the person's. The note itself is a short plain sentence on the
command's concrete effect (what it reads, writes, sends or changes, and where), then one on its risk, with nothing on
why it was escalated. The escapes and the look-alike check stay.

*Amended 2026-11-22 (native Bash dialog).* A Bash ask is put as the engine's own permission dialog for that command,
called in the manager's session, when the ask is shown whole, its input holds no key beyond the command, its
description, a timeout and the background flag, and the command holds no character that could hide text, no blank
line, no more than 20 lines and no redaction. It is sent
the command as the ask shows it and the description "Relayed from NAME", never the asker's own description, which
that dialog would show as its own line; the manager's note is on the dialog's reason line, which the terminal dialog
does not draw. Every other ask keeps the
question form. Callboard's `tool.check` turns that call into an ask, which the engine puts to the person, and
`tool.judge` keeps auto mode's classifier off it. The person's Yes reaches the command's `tool.run`, which the engine
fires after whoever settled an ask, and callboard's hook there stops it, matched on Bash and that description so no
other run of Bash loses its background or live output: nothing runs in the manager's session, and the Yes is their
allow. Their No (or Esc) is their deny, and what they typed under "what to do instead" is its note; any other deny
after the dialog reached them writes nothing. A Yes on a command they changed first writes nothing, says so, and is
not put again: the ask goes on along its own timeline. A refusal before the dialog reached them puts the question
form in its place. The dialog is used only after a self-test, once per process at the manager's first idle tick: the
command `true`, sent the same way but allowed with no dialog, must be stopped at its run. That shows the hook is wired
in this process; the path through a dialog is the engine's documented order. A relayed command whose run was not
stopped anyway turns the dialog off until callboard restarts, says so, and puts the question form. The description is
the relay's alone: any other Bash whose description starts "Relayed from" is refused in every session, at its check
and at its run, so no dialog in the manager's session that runs a command can pass for the relay's. What tells the
relay's dialog from a look-alike the check does not know is the engine's own mark in its title, "from the callboard
plugin", which a model's call cannot set; the reason line ("Your click decides this ask only." and the manager's note)
is not drawn by the terminal dialog. A description counts as the relay's when it reads as "Relayed from" after normalising, keeping
letters and digits only and folding the common look-alikes (Cyrillic, Greek and a few more letters, the digits 0 and 1,
`i` and `|`); a description in another script is no match, and the marks right-to-left text carries are dropped first.
One that holds the reason line's sentence, or a character that shows as blank or turns the text round, is refused as
well, with a text of its own. A Bash of this plugin's goes down the permission chain with its permission suggestions
emptied. Checked live on 2026-11-22 (Claude Code 2.1.330, the terminal, a scratch home, the plugin from this branch):
the relayed dialog reads "Bash command · from the callboard plugin", "Relayed from NAME", the command and "Do you want
to proceed?" with only "1. Yes" and "2. No". The manager's own Bash dialog in the same session offers "Yes", "Yes, and
always allow access to <dir> from this project", "Yes, and switch to auto mode" and "No". A Yes ran the lane's command and
a No refused it, and no rule or setting was written. The VS Code panel draws its dialog from the same permission
suggestions; it was not run. A run the hook holds comes back to the caller as the engine's error result carrying the held
text, not as `{ deny }`, so a run counts as stopped only for a `{ deny }`, or for exactly that text when proxyRun heard the run; any other error result
(a command that ran and failed, or another hook's refusal) reads as a run that was not stopped. These two are the exceptions to ADR 0004's observing `tool.check`; neither lifts a deny. The
relay needs Claude Code 2.1.330 or later.

**Callboard never judges who may answer.** An ask a session cannot decide (a plan-mode exit, a malformed question, a
guard's own ask) is an ordinary ask that rises like any other; the rubric of the tier that reads it decides. What is
not an ask is what the person starts themselves, such as creating a lead or a lane and giving a go. Those are their own acts,
not requests to a tier: a tier never answers them, and none of them works while they are away.

**Unattended mode, final shape.** The behaviour is the one of a day with the person at their desk, apart from the shorter
ask times of the amendment above. Three more reads of the one flag remain. The first is in the two places that open the person's dialog, the dialog helper and the relay: while it is
on, none opens (the relay raises none and closes an open one, and `go_request` is refused at once, since its dialog would not run). The second is a subagent's dialog: it is not an
ask, so nothing times it out, and left alone it would sit on the person's screen for as long as they are away. While the
flag is on it is denied with "run it yourself", as it is when a lead is above the session, and the main session's own
ask rises to the manager and closes at 15 minutes like any other. The third is the manager's own dialog: nobody is
above it to rise to, and its turn answers every ask below it, so a 15-minute wait would stall them all. While the flag
is on it is denied at once with a message that the person is away; a flag that cannot be read closes nothing, and a
lane's ask is never closed early. Everything else is the manager's
instructions: because every blocking ask rises to the manager and the person is away, the manager closes an ask it may
not or cannot decide by replying to it at once (a deny, or an answer, with a note that the person is away and the session
must not ask them), and it never asks them. The 15-minute close stays the backstop for an ask nobody answers. There is no
separate cap, no answer-or-park mode, no return list (the ask log records every closed ask) and no tool to end the mode:
turning it off is the person's typed command.

## Consequences

- One path replaces four, and a record of a gone or changed session routes nothing. The plugin is a fraction of the
  mod's size; the mod's tests, spool and audit script are deleted.
- An unknown session is managed from its first turn. The cost is that a brand-new session that should be a lead needs
  the person's `/callboard lead` once.
- The person reaches everything through the manager. That needs the manager's account to be the one they can reach
  remotely, and the manager to be live: with none live a session's parent is the person, whose dialog is the same one
  they had before.
- The honest-mistakes model gives up today's proofs (ledger rows, nonces, presence pids). A same-uid process can write a
  go file or an answer file; the protected-paths guard keeps agents' file tools off the state folder, and a hook that
  fails leaves the dialog with the person with no deadline. The README's list of what callboard does not guard against
  says so.
- A restart of the same conversation keeps its session id, so no lead takeover exists (a session's own handover to a clear one, [ADR 0015](0015-session-handover.md), is the one exception), and [ADR 0002](0002-callboard.md)'s
  line on a lead restarting under a new session id is marked out of date there.
- Nothing crosses the switch: the plugin starts with new state, and going back to the mod finds its own state as it was.

## Open questions

**A dialog that is not an ask.** The engine's permission check reports a verdict for each dialog. With the person-only
case gone, a dialog whose verdict is not "ask" (a plan-mode exit, and possibly a prompt the engine forces) is an ordinary
ask that a lead or the manager may allow, and the manager's rubric decides it; the mod kept such prompts for the person.
Which dialogs carry a verdict other than "ask" is not confirmed from the repo. If one of them should stay the person's,
the remedy is a refusal of `allow` for that verdict, not a second path. Decide it after the switch has run on real
sessions.

**A guard's ask.** Can an eligible lead decide an ask the guard raised? The core records what raised an ask (a rule, a hook, a setting, a
plugin, an organisation ceiling, or the GitHub guard) and shows it to the tier, but it does not use it to decide who may
answer, because callboard must not judge. So today a lead can allow a pull-request call that ai-toolkit's GitHub guard
asked the person about. The alternative is that an ask raised by a guard rises only to the manager, which is a carve-out
and a second path. It stays open: the manager's rubric and rules file are the control.
