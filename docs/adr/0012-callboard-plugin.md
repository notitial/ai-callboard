# 12. Callboard as a plugin: one session model, one ask chain

**Status:** proposed
**Date:** 2026-11-19

Scope: how callboard decides what a session is, who answers its asks and what unattended mode changes. It replaces the
mod's kinds, grants and per-tier answering with one model, built beside the mod as a plugin (`tools/callboard/plugin`).
It changes who may answer a permission prompt and who may widen a session's powers, so it is on the risk list. It takes
effect when the person switches the one plugin entry over ([docs/setup.md](../setup.md), Switch to the plugin); until
then the mod and the ADRs it rests on stand, and they are marked at the cleanup that deletes the mod.

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
  with a repo allowlist, not a tier.
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

**Tools follow capability.** Five tools go to every session (`go_request`, `go_status`, `pr_watch`,
`request_compact`, `rest`); the thirteen that open, stop and list children and answer asks go only to a lead or the
manager, and each body checks the capability again. There is one cap on live children. A parent parks, resumes,
retires and opens its children with no dialog; only a force stop keeps one. A session compacts itself; a lead that
wants a lane compacted says so in an ordinary message. A lead takes a loose session by name with one tool, and any
ancestor acts on any descendant.

**Nine invariants hold for every session, an unknown one included.**

1. Managed by default. Off is per session, typed by the person, and wins over everything, unattended included. One
   machine-wide OFF file stops every tier's answers.
2. One parent, as above.
3. Every ask has an owner and a deadline (the timeline below).
4. Unattended mode changes timing and nothing else (below).
5. A go is only the person's own click or typed turn, for the work it names and the sessions under the one it was
   given in. Never a merge, a force push, a push to main, a production change or a delete outside the work.
6. Powers are granted, never inferred. An unknown session has none and is still managed. No carve-outs: a merge goes
   through the same chain as any ask.
7. Notices follow current relationships: a child's event goes once to the parent computed when it is sent. The manager
   is woken only by asks and expired asks; a lead is told every event about its own lanes.
8. When the plugin cannot decide, the result is the safe default and it is visible: logged and shown to the parent.
9. No idle waste: pings and compaction nudges follow fixed bounds.

**The ask timeline.** One timeline serves every kind of ask, a permission and a question alike. For the first 30
seconds the ask is hidden from every tier: the person's own dialog is the only thing open. Then the nearest parent
sees it and must allow, deny, answer or escalate. With no choice it reaches the manager at 5 minutes of awake time. At
15 minutes of awake time an unanswered ask is closed with an "expired" message that tells the session not to ask again
and to make the work manageable. A session asleep adds nothing, and a liveness that cannot be read never closes
anything early. An answer counts only if its author is above the asker now, it is built from the live tool input and
never from a file, and the protected-paths guard and its markers are in place; the person's click always wins. By day
an ask that reaches the person is a callboard pop-up in the manager's session, or the person tells the manager in words:
either is the person's own act on that one ask.

**Callboard never judges who may answer.** An ask a session cannot decide (a plan-mode exit, a malformed question, a
guard's own ask) is an ordinary ask that rises like any other; the rubric of the tier that reads it decides. What is
not an ask is what the person starts themselves, such as creating a lead or a lane and giving a go. Those are their own acts,
not requests to a tier: a tier never answers them, and none of them works while they are away.

**Unattended mode, final shape.** The behaviour is the one of a day with the person at their desk. Three reads of the one
flag remain. The first is in the one place that opens the person's dialog: while it is on, none opens (no relay pop-up,
and `go_request` is refused at once, since its dialog would not run). The second is a subagent's dialog: it is not an
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
  mod's size; the mod's tests, spool and audit script go at the cleanup after the switch has held.
- An unknown session is managed from its first turn. The cost is that a brand-new session that should be a lead needs
  the person's `/callboard lead` once.
- The person reaches everything through the manager. That needs the manager's account to be the one they can reach
  remotely, and the manager to be live: with none live a session's parent is the person, whose dialog is the same one
  they had before.
- The honest-mistakes model gives up today's proofs (ledger rows, nonces, presence pids). A same-uid process can write a
  go file or an answer file; the protected-paths guard keeps agents' file tools off the state folder, and a hook that
  fails leaves the dialog with the person with no deadline. The README's list of what callboard does not guard against
  says so.
- A restart of the same conversation keeps its session id, so no lead takeover exists, and [ADR 0002](0002-callboard.md)'s
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
and a second path. Decide it before the cleanup; until then the manager's rubric and rules file are the control.
