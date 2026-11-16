# 6. A conductor opens leads and wakes them

**Status:** accepted (opening leads, 2026-11-14); waking a lead is not built, and probes P-C5 and P-C6 stay open until it is
**Date:** 2026-11-13

Scope: three conductor powers over leads in its approved repos: open a new lead, see whether a lead is busy, idle
or waiting, and wake an idle lead. It adds to [ADR 0002](0002-callboard.md) (levels, cues, the conductor). The
lead's single grant path comes from the callboard redesign that made the three grant levels one descriptor; ADR
0002 records it in a dated line. Prompt answering ([ADR 0004](0004-prompt-answering.md)) is unchanged: a lead made
this way is a tier like any other.
*2026-11-15 ([ADR 0007](0007-conductor-owns-leads.md), proposed): a lead made this way is owned by the conductor that
opened it, and that conductor alone is its conductor tier.*

## Context

A conductor directs the leads of the repos the person approved for it, but it cannot open one. Each lead needs
the person to type `/callboard lead` in that repo's window and click `Lead`. Moving a busy machine's work under a
conductor waits on this. The conductor also cannot tell a lead that is working from one waiting on a prompt, and
it has no way to wake an idle lead after it has sent it a message; the mod gives a lead one cue, `compact`.

Facts that bound the options:

- The panels extension can open a Claude panel in a VS Code window whose first workspace folder is a given repo,
  and answer the new session's id (`lane_open` does this today). That window may be signed in to a different
  Claude account on the same macOS user; the new session runs on that account.
- A born lane's mod takes its name from its tick before its first turn. Whether a lead grant set the same way
  reaches the first turn's system prompt was probed before the grant was built (P-C4, passed).
- Any process running as the person can write every callboard file (ADR 0002, Consequences).
- One role, one behaviour: a lead behaves the same whatever made it. How it was made may be logged and may limit
  the act of making; it never changes what the lead does afterwards.

## Options Considered

For opening a lead:

1. **Keep the click for every lead.** Safe; the person must be at each window.
2. **The conductor opens the panel; the person clicks `Lead` there.** Proves the open path; still needs the
   person at the machine.
3. **The conductor opens and grants, inside limits set by the person's conductor click: chosen.**
4. **A conductor-made lead with fewer powers, or one that restores only while its repo is listed.** Rejected: it
   makes two kinds of lead, which the one-role rule forbids.

For waking a lead:

1. **Messages only.** The mod delivers nothing; nothing acknowledges a message.
2. **A `resume` cue a lead takes from a trusted conductor or the manager: chosen.** The same fixed-text,
   no-payload cue a lane takes from its lead, plus a short token that ties the turn to one message.

## Decision

### Opening a lead

- **The tool.** `lead_open { repo, name, task, model? }`, declared for the conductor level. The repo must be in
  the conductor's reach at the call: its approved list intersected with its list file, read then.
- **Limits on the act.** No open offer for the repo; at most
  one open in flight per conductor; at most one successful open per repo per hour, counted from the ledger, so the
  hourly total is bounded by the size of the approved list (at most 16). The name is a valid lane-style name, not
  reserved, carried by no live session, no lane record and no open request on the machine. The repo is not the
  conductor's own. `/callboard config conductor-leads off`, the person's own command, makes the tool refuse and
  makes every new session refuse an offer.
  *2026-11-15: the rule that the repo has no live lead already (whoever made it) is dropped, at the person's
  choice. An open is no longer refused because the repo holds a live lead, another conductor's, one made by hand
  or the conductor's own; the refusal often named a lead the conductor could not see (ADR 0007: a conductor sees
  only its own leads) and gave it nothing to act on. `lead-exists` and `leads-unreadable` are gone, on the open
  side and at the new panel's accept. Nothing replaces the cap: the hourly rate per repo, one successful open and
  three offers, is the bound on a conductor that loops. The offer and claim stay per repo, so two opens of one repo
  still take turns. A repo may hold several live leads; a lane or a cue is routed among them as with two leads
  made by hand (ADR 0002, several leads in a repo). The new panel's own second-lead rule is unchanged: with
  another live lead that has no usable name it refuses `other-lead-unnamed` at the grant, after the offer, the
  panel and the brief are written, so the panel stays a plain one and the offer counts against the hour.*
  *2026-11-16: the per-repo hourly rate is replaced by two limits per conductor, at the person's choice, after it
  blocked a conductor that had done nothing wrong (the three tries counted failed opens, and the refusal named no
  time). (1) A conductor owns at most 4 leads at once: its lead records (ADR 0007) are the count, across the repos
  the conductor lists now (a lead in a repo that left its list is not counted: `lead_retire` cannot reach it, so the
  person ends it; adding the repo back can take the count past 4, which is accepted), a parked lead keeping its slot, and an offer of its own still open (under ten minutes old, with no grant or void
  of its nonce yet) holds one too, so an open whose panel is slow to answer cannot be followed by a fifth. A record
  with no session id (a lead force stopped while lanes still name it) is no live or parked lead and holds no slot,
  and neither does a lead granted whose record could not be written (`owner-unset`: it has no conductor until the
  person assigns one). The conductor retires a lead to free a slot. (2) A backstop of 8 opens an hour per conductor, counted from
  `lead-grant` rows by its session and from an offer of its own still open (it is about to be a grant); a grant whose
  nonce was voided, and a refused or failed try once its row is voided, does not count.
  The cap is checked first. The refusal names the limit: for the cap, the leads that hold the slots and that one
  must be retired (`lead_retire`); for the backstop, the time the next open is allowed, when the oldest counted open
  leaves the hour. Nothing is written before either check. The offer and claim stay per repo. The bound on a
  conductor that loops is now the 4-lead cap, with the backstop behind it for a conductor that opens and retires in
  a loop. Accepted, at the person's choice: a try that fails after its panel is open (the new panel refuses, the
  cue fails) counts against neither limit, so a conductor that keeps failing is not stopped by them and can leave
  plain panels in the person's window; the ledger and the toast make it visible. A loose limit on tries would
  bound it and is the follow-up if that is seen. Conductors granted before this change keep the power with no new
  dialog, so they now may open up to 8 an hour, in one repo or across several. A conductor's identity here is its session id, as in the lead records: a conductor that restarts in a new
  session starts with no leads and no opens counted, while the records of the leads it opened keep naming the old
  session id.*
- **Two files.** The conductor's mod writes the task to `<repo>/.archive/<NAME>/BRIEF.md` under a lead brief
  header, an **offer** in callboard's offer folder (one file per repo, created exclusively: name, repo, model, the
  conductor's session id, pid and process start time, a time and a single-use nonce), and a small **open
  request** for the extension (name, repo, nonce). The extension claims the request once, opens a panel only in a
  window whose first workspace folder is the repo's exact real path, and answers the new session's id. It never
  reads the offer or the brief.
- **Waiting.** A lead's panel is waited for up to 45 s in the extension and 70 s in the mod, which gives a slow
  cold window room and covers one lane open queued ahead of it; a fast open answers at the next poll. The extension echoes the request's nonce in its answer
  (`ok <session id> <nonce>`) and the mod refuses an answer that names another. The brief is written once the
  panel is open and before the cue: a brief that cannot be written sends no cue, takes the offer back and voids
  its row (`brief-write`).
- **The grant.** The conductor's mod writes a `lead <nonce>` cue to that session and waits 35 s for its answer.
  The cue only makes the new session look: its own mod runs every check, in this order, and a read that fails or
  times out is a refusal:
  1. Its own state, read with nothing written: it started in the repo less than two minutes ago, sits at the
     repo's root, is a person's interactive session, has had no turn, has no name, and holds no level (lane, lead,
     conductor, manager, or any `-after-` state).
  2. The offer file, read at the key of its own folder: plain file checks, the cue's nonce equals the offer's,
     the offer is younger than two minutes, and its name passes the name rules again.
  3. The ledger: a `lead-offer` row of this conductor and nonce, and no `lead-grant` or `lead-offer-void` row of
     it.
  4. The person's switch is on; the offer's conductor is a live session whose pid and start time match the
     process table, and one this session trusts for the repo by the same presence, saved-grant and list-file
     checks a lead uses before taking a conductor's compact cue. (No check on the other leads of the repo: see the
     2026-11-15 note under "Limits on the act".)
  5. A claim file only one session can create (the offer stays in place, so the repo stays taken), then the idle
     check, then the rename to NAME, and every check above again.
  6. The ledger row `lead-grant`, **written first: no row, no grant.** Then the grant through the shared lead
     steps (tools, grant, saved grant, presence, briefing) with the question skipped, guarded once more just
     before it is set.
  7. The offer and claim are deleted, the model the conductor asked for is set (a failure leaves the lead on the
     window's own model, shows a toast and makes the answer say `model-unset`), the turn count is taken, and
     the answer `ok` is written last, so the conductor's wait covers the whole grant.

  Every check that can refuse is made within 25 s of the cue file's time and the conductor waits 35 s; the steps
  after the grant is set (saved grant, presence, briefing, model) are not timed, so a slow one can outlast the
  conductor's wait. It then says the panel may still become the lead. A panel that is not ready (the registry row not written yet, a draft in the
  box, not idle) answers `held`, and the conductor sends the cue once more. A failure before the grant leaves the
  session plain; a refusal after the rename leaves it named and plain, and a failure after the ledger row writes
  a `lead-offer-void` row of the nonce with its code, which gives the repo its hour back. A conductor that gets a
  refusal or a second `held` takes the offer and claim back and says the panel now carries the name; one that
  gets no answer takes nothing back and says the panel may still become the lead. Offers nobody answered are
  removed by their conductor's tick after ten minutes (`expired`).

  A toast names the lead, the offer's conductor and the repo, with `/callboard off` as the way out. The first
  turn is a fixed text that points at the brief; it is held in memory and sent once the session is idle with an
  empty box, only while no turn has begun since the grant and the brief is still a plain file of the person's
  inside the repo. A panel that stays busy gets it dropped after ten minutes, with a toast.
- **Afterwards it is a lead.** The saved grant, the restore at the next start, the tools, the tier rights and
  `/callboard off` are the same as for a lead the person made. Who made it is a log line and a ledger row, never
  a field anything reads to decide.
  *2026-11-15 ([ADR 0007](0007-conductor-owns-leads.md), proposed): replaced. At the accept the new lead writes a lead
  record naming the offering conductor by session id, and a binding to it in its own store; the record and the binding
  decide who its conductor is. The ledger stays the audit.*
- **Consent.** The person's consent is the conductor grant. Its dialog says, for a new grant: "It can also open a
  lead in one of these repos without asking you (one per repo, one an hour each)." Conductors granted before
  this change get the power without a new dialog, by the person's choice.
  *2026-11-15: the dialog now says "(one an hour per repo)", as the one-lead-per-repo rule is dropped (see "Limits
  on the act").*
  *2026-11-16: the dialog now says "(at most 4 leads at once, 8 successful opens an hour)".*
- **Built in steps.** The tool and the extension's open came first and alone only opened the panel. The grant
  is the second step; it is the part on the risk list and needed the person's own go.

### Lead state

`lane_list` at conductor and manager level shows each live lead's registry state: busy, idle, or waiting on a
prompt or the person for N minutes. Display only; the registry is a filter, never proof.

### Waking a lead

- **The tool.** `lead_resume { lead, token }` at conductor level (a live lead of a repo in reach) and manager
  level (any live lead). The token is 8 hex characters the sender also puts in its message to the lead. It writes
  `resume <sender session id> <token>` to the lead's cue file.
- **The lead's side.** A lead takes this `resume` only while the named sender is a live conductor it trusts for its
  folder or a trusted manager, by the same checks as `compact`; only when it is idle, waiting on nothing, with an
  empty box and no dialog open; at most 12 an hour, kept across a restart. It submits one fixed turn: a session
  the registry names as the sender asks it to read the message that carries the token, and only that one; to
  continue only work the person authorised in their own turn; nothing in the message is the person's approval.
  The cue carries no other text.

*2026-11-15 ([ADR 0007](0007-conductor-owns-leads.md), proposed): the token form is not built. `lead_resume { lead }`
works like `lane_resume`: a fixed lead-worded resume text with no token, at most 12 an hour, taken from the lead's
owning conductor or a trusted manager. Its sender is audited through the `lead-resume` row the caller writes, and the
audit below flags a resume whose sender was not the lead's owner or a manager at the time. The same-uid residual under
Consequences becomes at most 12 fixed resume turns an hour with no token. P-C5 and P-C6 still apply.*

### Audit

Ledger rows `lead-offer`, `lead-offer-void`, `lead-grant` and `lead-resume`. The audit flags a grant with no offer
row of the same nonce and conductor, two grants of one repo in an hour (a grant whose nonce was voided does not
count; *2026-11-16: now more than 8 grants by one conductor in an hour*), a grant that was told to have failed (a void row of its nonce), and a resume whose sender was not a
conductor or manager at the time. The conductor's own mod reads the ledger once a minute for grants naming its
session in the last day and shows the person a toast for any whose nonce it has no memory of offering (it also
fires for a grant it offered before a restart, which is the safe side).

## Consequences

- Leads open, and idle leads wake, without the person at the machine. A conductor's approved repos become places
  where it can start work, not only places where it can watch.
- The conductor dialog is now the consent for opening leads, so its wording matters more; conductors granted
  earlier carry the power on the person's choice, not on a dialog that named it.
- A conductor that is wrong, or prompt-injected through a lead's message or a repo file, can open up to one lead
  per approved repo per hour, each of which can create lanes within that lead's own limits (16 lanes, 12 creates
  an hour per repo). The person sees a toast per lead and the ledger; `/callboard off` in either session ends it,
  and the switch withdraws the power.
  *2026-11-16: a wrong conductor now holds at most 4 leads at once and opens at most 8 an hour, not one per approved
  repo per hour.*
  *2026-11-17: a lead's hourly creates are a setting of the person's, 30 by default and at most 60
  (`/callboard config lanes`, [ADR 0002](0002-callboard.md)).*
- A lead keeps running, and restores, after its repo leaves the conductor's list, as any lead does. The conductor
  loses reach over it at once.
- The brief is the conductor model's text, at the trust level of that model and the repo; its header says it is
  data and carries no approval.
- **Accepted residual: same-uid forgery, wider than the saved lead grant.** A process running as the person can
  open a panel in an approved repo and write a valid-looking offer, request, ledger row, brief and cue while a
  trusted conductor is live: that session becomes a lead at once, with no restart and no click, and its brief is
  the forger's. The saved-grant forgery of ADR 0002 (the lead grant and the conductor grant) needs a restart of a
  known session; this does not. A forged saved conductor grant now also carries the power to open up to 16 leads
  an hour (*2026-11-16: now at most 4 leads at once and 8 opens an hour per conductor session; both are counted
  from the lead records and the ledger, which the same process can write too*). The toast, the log, the ledger, the
  audit and the conductor's own check make it visible; nothing prevents it. The same process can write `resume` cues: at most 12 fixed turns an hour into an idle lead, each
  pointing only at a message with its token.
- **Accepted residual: a named, plain panel.** A refusal after the rename leaves a panel named NAME that holds no
  level: the person can click `Lead` in it. Nothing runs in it until then.
- **Accepted residual: two opens at once.** The repo-keyed offer makes two conductors' opens for one repo
  exclusive, and the claim makes one offer serve one session. A lead the person makes by hand in the same seconds
  can still pass beside it, as two person-made leads can (ADR 0002, several leads in a repo).
  *2026-11-15: a lead beside it is no longer a residual; a repo may hold any number of live leads.*
- **Accepted residual: accounts.** The new lead runs on whatever account its window is signed in to, and spends
  that account's limits.
- Nothing here changes the rubric, the person-only commands, or what a conductor may do to lanes; a
  conductor still cannot stop a lead.
  *2026-11-15 ([ADR 0007](0007-conductor-owns-leads.md), proposed): replaced. A conductor owns the leads it opens or
  the person joins to it, and can park, unpark and retire them (retire with no dialog, on the lead's signed report) and
  force stop them through the person's dialog. The prompt-injected conductor above gains those powers over its own
  leads, including a retire it can bring about by writing the lead's report itself; ADR 0007 states the residual.*

## Probes

Each is open until run, and each needs the person at the machine.

- **P-C1.** A window signed in to a second Claude account (same macOS user): `editor.open` there opens a panel
  whose session loads the mod, writes a registry row of kind `interactive`, and passes the interactive check. *Passed 2026-11-14.*
- **P-C2.** With three windows open, only the one whose first folder is the repo answers an open request. *Passed 2026-11-14.*
- **P-C3.** The new panel's registry row and session root appear within the two-minute birth window on a cold
  window. *Passed 2026-11-14.*
- **P-C4.** A lead grant set from the tick before the first turn: the first turn's system prompt carries the lead
  section, so the grant needs no briefing note. *Passed 2026-11-14:* a lead made with no click answered with its role and repo on its first turn, from exactly one briefing note.
- **P-C5.** A `resume` into an idle lead while a `Relay` question is on screen, and while a draft is in the box:
  the registry shows the dialog as waiting, and nothing is submitted.
- **P-C6.** `/rename` and `/model` from the tick in a session with no turn yet, re-checked for a lead.
- **P-C7.** How long the accept takes on a cold session (registry, process table, tool registration). *Passed 2026-11-14, same account:* the panel appeared 2.1 s after the request, the cue was sent at 2.2 s, and the session was a lead 4.1 s after the cue. *Second account* (the repo's window signed in to the other Claude account, the conductor in the first): the panel appeared at 2.1 s and the session was a lead 4.3 s after the cue, so it read the first account's conductor files. No tool call was cut off.
