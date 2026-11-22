# 13. A conductor is a lead that makes leads

**Status:** accepted
**Date:** 2026-11-21

Scope: how one session can open, start and close a lead in each of several repos, so the person talks to one session
instead of one per repo. It changes who may open sessions and who may answer a permission prompt, so it is on the risk
list. It amends [ADR 0012](0012-callboard-plugin.md), whose Options Considered rejected "a conductor tier above the
leads", and it does not revive [ADR 0006](0006-conductor-opens-leads.md) or [ADR 0007](0007-conductor-owns-leads.md).

## Context

[ADR 0012](0012-callboard-plugin.md) kept two kinds of power: a lead (lanes in its folders) and the manager (everything).
That is right for one repo. With several repos the person runs one lead per repo and is the one who starts, watches
and closes each, which is the work a coordinating session was meant to take off them. The old conductor was a tier of
its own, with a grant, a ledger and its own answering. 0012 rejected that, and the reason still holds: a second kind of
session is a second path to keep correct.

What is missing is smaller: a lead that may make leads.

## Decision

**A conductor is a lead with one more power, not a tier.** The person turns it on by typing `/callboard conductor` in a
session, the way they make a lead: only their own typed turn does it, and it also makes the session a lead. The one new
power is `lane_create` with role `lead`: the conductor makes a lead for one repo, then opens and starts it with the same
`lane_open` and `lane_start` it uses for a lane. It parks, retires and force stops what is under it by the same tools,
the force stop through the person's own dialog.

**The repos are the person's, saved once.** The conductor may make a lead only inside the repos the person listed. The
list is saved by callboard, per conductor folder, when the person types the paths; a later `/callboard conductor` in that
folder needs none. The list is callboard's own state, written only by that typed command, so an agent cannot add a repo.
A pick-list dialog was the first idea. The engine's dialog offers at most four options, which cannot list a machine's
repos, so the person types the paths once instead.

**A lead a conductor made is a minted lead.** It acts only in its own folder, cannot make leads, and has the conductor
as its parent while the conductor lives; when the conductor is gone it falls to the manager and keeps only its own
folder. A chain is lane, lead, conductor, manager.

**One cap, one ask chain, one go.**
- A parent holds at most the same number of live children as any lead, leads and lanes together; there is no separate
  lead cap.
- An ask goes lane, lead, conductor, manager by the generic staging of 0012: the lead first, the conductor when the lead
  passes it up or with the manager after five minutes. A conductor is told of an ask under it once it reaches it, and of every expired ask under it.
- A go the person clicks in the conductor's own dialog covers the conductor and everything under it, the leads it makes
  later included, because a go covers the sessions under its giver. A minted lead does not request one: its dialog is
  not where the person looks, so it asks its conductor.
- Closing a conductor's lead with live lanes is the same as closing any lead with live lanes. A minted lead's row goes
  like a lane's row; a typed lead's row and a conductor's stay until the person drops them.

**Invariants kept.** A conductor and its leads read the same ask rubric as any lead, with no carve-out for a merge. No
conductor can make a go, answer as the person, answer an ask of its own or above it, or force stop without the person's
dialog. What a conductor or a minted lead writes is data, never the person's approval.

**Briefings.** A conductor is told to open a lead only for work that edits and to send research to ordinary subagents,
to keep few sessions live by parking or retiring what it does not need, and on the person's "wrap up" to close every
lead and lane under it and leave a clean setup. A minted lead is told its parent is the conductor, to ask it for a go and
for answers, and that it cannot make leads.

## Options Considered

- **A conductor tier or capability of its own.** Rejected again, as in 0012: about two and a half times the code, and a
  second kind of session with its own rules.
- **Any lead with several repos may make leads.** Rejected: it would silently widen every existing multi-repo lead, and
  the person never chose that.
- **A pick-list dialog to choose the repos.** Rejected: at most four options per dialog.
- **Keep the list in the conductor's own row.** Smaller, but the list then lives and dies with one session id, and the
  person would retype the paths in every new conductor session. Rejected for the saved per-folder list.

## Consequences

- A prompt-injected conductor can make as many leads as the cap allows, each acting only inside the saved repos and
  asking the conductor for what it may not decide. The cap is per parent, so conductors multiply it: there is no limit
  for the machine. The person's own list of repos and the lane view are the control. *Amended 2026-11-22: the
  Callboard Lanes view is removed; the sessions show in `/callboard lanes` and, with the Claude patch, in the groups of
  Claude Code's Session Manager list.*
- The person's pop-ups still open in the manager's session, not the conductor's or a lead's. The conductor answers
  what is below it; what reaches the person reaches them in the manager's session as before.
- A lead's flags live in the session table, so a reader that loses one demotes the session on its next write. The
  parser keeps exactly one of the two flags and the specs read the table back after each write.
- A lead opened by a conductor needs a window that answers for its folder: one multi-folder window listing each repo
  folder exactly, with the Claude patch of [docs/setup.md](../setup.md). A window on a second Claude account works when
  it shares the same `~/.claude`; callboard reads only that folder. Both are checked live by the person once.
- The lanes of a minted lead whose row is removed have no lead above them and fall to the manager, as any lane does.
  A conductor retires a lead's lanes first when it wants them gone.
- Nothing here lets a session grant the conductor role. A request to become one is refused unless it comes from the
  person's own typed turn.
