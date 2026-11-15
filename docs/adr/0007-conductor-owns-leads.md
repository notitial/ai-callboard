# 7. A conductor owns its leads

**Status:** proposed
**Date:** 2026-11-15

Scope: who a lead belongs to, what its conductor and the manager may do to it, and who hears from it. It changes
[ADR 0002](0002-callboard.md) (levels, the conductor, the manager's stops), [ADR 0004](0004-prompt-answering.md) (the
conductor tier) and [ADR 0006](0006-conductor-opens-leads.md) (who made a lead decides nothing, a conductor cannot stop
a lead, the token form of `lead_resume`), and the manager's hard line H2 in [ADR 0001](0001-manager-role.md); each
carries a dated line. Every part except the manager's table is on the risk list (see Consequences).

## Context

A lane belongs to one lead: its record names that lead, only that lead resumes, parks or stops it, and its prompts go
to that lead first. A lead belongs to nobody. Every conductor whose approved list holds a repo watches every lead
there, the first four of them get every prompt from those repos, and no conductor can stop a lead. With five
conductors over one list of repos, a lead's prompt goes to whichever four sort first, which need not include the
conductor that directs it; each conductor's list shows every lead of every repo; and a conductor that opened a lead can
neither park nor retire it when the work is done.

The person's requirement: a conductor owns a lead the same way a lead owns a lane. Every lead has a conductor, a lead
that is already open can be attached to one, and a conductor opens, closes, parks and resumes its own leads. Everything
works as it does for lanes.

Facts that bound the options:

- Conductor names are not reserved (ADR 0002, conductor residuals), so a name alone can be borrowed. A conductor that
  comes back as the same conversation keeps its session id (its saved grant is `conductor:<sid>`).
- A lead's name can change, and a new session can take the name of a lead that has ended.
- Any process running as the person can write every callboard file (ADR 0002, Consequences).
- The lane machinery exists and is tested: records, the lane's binding to its record, the target's own checks for
  retire and park, the force-stop dialog, the tab close and the reopen. A lead form reuses it.
- One role, one behaviour (ADR 0006): how a lead came to have its conductor never changes what the lead does.

## Options Considered

1. **Leave leads ownerless and fix only the prompt tier**, for instance by picking the conductor that opened the lead
   from the ledger. Rejected: it covers only leads a conductor opened, reads the ledger to decide (ADR 0006 keeps the
   ledger an audit), and gives no park, retire or stop.
2. **Owners in the lane store**, a list of leads beside a repo's lanes. Rejected: the lane store parses all or nothing,
   so a bad lead entry would void the repo's lanes, and the writers that rebuild a lane store would drop it.
3. **A conductor takes a lead with a tool.** Rejected: it would change who answers a lead's prompts with no click from
   the person.
4. **The owner named by the conductor's name.** Rejected: names are not reserved, and a new conversation under the same
   name would inherit the leads.
5. **A lead record per repo naming its conductor by session id, bound into the lead, set only by the conductor's own
   open or the person's click: chosen.**

## Decision

### The model

- **A lead has a record that names its conductor**, as a lane's record names its lead. The lead holds a binding to that
  record, as a lane does to its own, so a record alone never makes a session obey a conductor.
- **The conductor is named by its session, not its name.** A conductor that comes back as the same conversation still
  owns its leads. A new conductor conversation, even under the same name, owns nothing until the person joins leads to
  it.
- **A conductor gets a lead two ways**, as a lead gets its lanes: it opens one (`lead_open`, ADR 0006), or the person
  attaches an open lead to it. The conductor cannot take a lead by itself.
- **The conductor runs its leads with the lane tools' twins**: `lead_resume`, `lead_compact`, `lead_park`,
  `lead_unpark`, `lead_retire` and `lead_terminate`. The manager gets over leads the subset it has over lanes.
- **Only the owner hears from a lead.** The lead's prompts go to its own conductor, then the manager; its compaction
  goes through its own conductor, or the manager on the lead's own request. Other conductors that list the repo get nothing about it. This replaces "the first
  four conductors that list the repo" and the cap of four.
- **A lead with no conductor, or whose conductor is gone,** works as a lane whose lead is gone: it keeps running, its
  prompts skip the conductor tier and go to the manager, and the manager can resume it, compact it on its own request,
  and retire or stop it.
- **The approved list still fences everything.** A conductor reaches a lead it owns only while that lead's repo is in
  its approved list and its list file. Ownership narrows reach; it never widens it.

### The lead record and the binding

- **The record.** `~/.claude/callboard/lead-records/<sha256 of the repo's real path>.json`, beside the lane stores and
  in its own folder: 0700 folder, 0600 file, one link, at most 16 KB and 16 records, parsed all or nothing with the
  lane names' rules (valid, not reserved, no duplicate). Each record holds the lead's name, how it got its conductor
  (`made` or `joined`), the conductor's session id, the conductor's name at the time of writing (display only), the
  offer nonce for a made lead, the lead's session id and a parked time. Its lock and lock folder are its own, so a lead
  record and the lane store of the same repo never wait on each other.
- **The hash** covers the repo, how, the conductor's session id and the nonce; not the lead's name, the lead's session
  id, the parked time or the conductor's name, which change without changing ownership. The record's identity is the
  lead's session id and the name follows a rename, as for an attached lane record (ADR 0002, the stuck-lanes hash), so
  a rename never makes a bound lead refuse its owner.
- **The binding.** The lead keeps, in its own `$.store` under `owner:<sid>`, the record's repo and hash and its
  conductor's session id, and no name. Its record is the one in that repo's file whose session id is its own, under
  whatever name. It takes an owner's cue only while that record still matches the binding. A
  restore of the same conversation keeps the binding. A session that later carries the lead's name inherits nothing.
- **One writer of ownership.** Only the lead's own mod creates a record or changes its conductor, after its grant is
  set (a stop's caller only removes a record or sets its parked time): at the accept of a conductor's
  `lead_open` (from the offer the lead already checked) and after the person's Join click. A failed write at the accept
  leaves the lead unowned: a toast, a log line, and the conductor's answer says `owner-unset`, so the conductor tells
  the person to join it by hand. The grant is not undone. A refused accept leaves no record.
- **One name space.** A name is a lane record, a lead record or neither, machine-wide in any letter case. Every way a
  name is taken checks both: `lane_create`, `/callboard lane`, `lead_open`, `/callboard lead` (a record of that name
  bound to another session refuses `name-in-use`), the Join and a rename.
- **The session id and a rename.** The lead's mod writes its own session id into the record in the same write that
  creates it or changes its conductor, so a record always names its lead's session. A lead whose registry name changes
  moves its record's name under the record lock, then its lanes follow by the existing lane rename carry. That move is
  one write: the name is in neither the hash nor the binding, so the binding is not rewritten and a move that fails or
  is cut short leaves the lead bound, under its old name, and the next look moves the name again. A new name held by
  another record or lane refuses the move: the old name stays in the record, the lead stays bound, and a toast tells
  the person. No conductor rename carry is needed, since ownership is by session id.
- **Leaving.** `/callboard lead leave` and `/callboard off` in the lead remove its record and its binding. The lead
  stays a lead (after `leave`) with no conductor.
- **Orphans.** A lead that ends without a stop (a crash, a closed window) leaves its record with a dead session id. It
  holds the name and counts toward the 16 until its conductor or the manager removes it with `lead_retire`, or the
  session comes back. The table shows it as `no session`.

### Attaching a lead

- **`/callboard lead join [CONDUCTOR]`**, typed by the person in the lead's panel or from the phone only, with a dialog
  headed `Lead Owner`. The candidates are the live conductors the lead trusts for its repo (the same presence, saved
  grant and list-file checks a lead uses today), with no cap; a conductor whose name another live session also carries
  is left out. With several candidates a picker shows four, then `More…`. The picker and the dialog show each
  candidate's name, home folder and the first 8 characters of its session id. The lead must have a usable name
  (`lead-needs-name`). Every check runs again after the click. A dismissed or timed-out dialog changes nothing.
- **Moving a lead.** A Join in a lead whose conductor is live moves it; the dialog names the old and the new conductor,
  each with its short session id. The person's click is the consent either way.
- **A lead the person makes by hand.** After the person's `Lead` click in a repo that a live conductor reaches, the mod
  asks "Which conductor runs this lead?", listing those conductors and "None for now". A dismissal is "None for now":
  the lead stays unowned until the person types `/callboard lead join`.

### The lead tools

| Tool | Owning conductor | Manager | Works like its lane twin, except |
|---|---|---|---|
| `lead_resume { lead }` | yes | yes, when the lead itself asked for it | A lead-worded fixed resume text (continue only work already authorised); the lead's own counters, at most 12 an hour. No token |
| `lead_compact { lead }` | yes, an order | yes, only on the lead's own on-cue request | `lane_compact` with a lead's name stays as an alias. The owner's order works as a lead's order to a lane (ADR 0002, the order), with a lead-worded deadline notice that names `lead_terminate` |
| `lead_park { lead }` | yes | no | Refused while any lane of the lead has a live session (`lead-has-live-lanes`, naming them), checked by the conductor before the cue and by the lead before it confirms. The saved lead grant is kept. Refused when that saved grant would expire before the unpark limit (28 days from the park) |
| `lead_unpark { lead }` | yes | no | The reopened conversation restores its lead grant from its saved grant, keeps its owner and clears the parked mark. Refused 28 days after the park (`park-expired`): the saved grant lasts 30 days, and the conversation would reopen as a plain session |
| `lead_retire { lead }` | yes, **no dialog** | yes, behind its dialog, never unattended | Refused while any lane record names the lead (`lead-has-lanes`). The target confirms with a lane's checks, including `status: done <its session id>` as the last line of `<repo>/.archive/<LEAD>/REPORT.md`. Removes the record, the saved lead grant and the binding once the process has ended. A record with no live session is removed directly, with the same refusal |
| `lead_terminate { lead }` | yes, behind the dialog | yes, behind the dialog | `Force stop`/`Cancel` every time, naming the lead, repo, short session id and pid and how many of its lanes are live and keep running; never unattended. Deletes the saved lead grant and the binding. The record is removed only when no lane record names the lead; otherwise it stays with no session, so its lanes stay in the conductor's tree, and `lead_retire` removes it later |
| `lane_list` | its leads (live, parked, no session) and their lanes | every lead and lane (the table below) | |

The conductor's `lead_retire` asks the person nothing, as a lead's `lane_retire` asks nothing: the lead's signed report
and its own mod's confirmation are the gate. The residual this leaves is under Consequences.

The conductor still never creates, opens, starts, resumes, parks or retires a **lane** (`conductor-tool`), and its
`lane_terminate` on a lead's name still refuses `target-is-lead`. The manager still has no park or unpark.

**Target checks.** Before any dialog or cue, after the dialog, and right before the signal, each time from a fresh read:
the record's session id is the target session's; the target holds a live lead presence file for exactly the record's
repo (a check that cannot be made refuses); for a conductor, the record's conductor is the caller's own session and the
repo is in its reach; the name is in exactly one place, one lead record machine-wide and no lane record. A Join that
re-points the lead while a call waits ends the call with `grant-changed`. The manager reaches a live lead with no record
by its registry name and presence file, as it does today.

**The lead's side of a cue.** A lead takes from its owner `resume`, `compact` (the order), `park` and `retire`; the
owner is the binding's conductor, the record still matching the binding (`record-changed` otherwise), and that session
passing the lead's conductor checks for its repo. From a trusted manager it takes `resume`, `compact` (its own on-cue
request only) and `retire`. Anything else, or a conductor that is not its owner, is `not-eligible`. As for lanes, the
cue carries no sender: the lead checks that an eligible sender is live, and a signal follows only from the owner's own
mod waiting on the answer with the cue's inode. The lead briefing gains the sign-off line a lane's briefing has: when
done, append `status: done <session id>` to `.archive/<NAME>/REPORT.md`.

### Routing follows ownership

- **The prompt tier** of a lane's request is the live owner of the lane's lead; of a lead's own request, its own live
  owner; none for an unowned lead. The owner counts only while it is live, passes the lead's conductor checks for the
  repo, and its lead is bound to it. The cap of four conductors is removed.
- **The lead's conductor section** in its briefing names its owner only, and none when it has none. It says the owner
  can park and retire it, and force stop it with the person's click, and that the lead's own mod confirms a park or
  retire, not the model.
- **A lane whose lead is gone** takes `compact` from its lead's live owner (no longer from any conductor listing the
  repo); `resume`, `compact` and `retire` from the manager as today.
- **A conductor's reach** over lanes is the lanes of the leads it owns, and legacy lanes (records naming no lead) of a
  repo where it owns the only lead record. A conductor with no ownership information owns nothing (fail closed).
- **Check-ins for the owner.** A conductor gets a lead's `gone` and `prompt` check-ins and a leads-changed notice, as a
  lead does for its lanes. `quiet` fires only when the lead has no live lane, since an idle lead with live lanes is
  usually waiting for them.

One conductor check replaces up to four in a tier lookup or a cue check, so the once-a-minute look no longer grows with
the number of conductors.

### The manager's table

`lane_list` at manager level groups leads by owner. A lead whose owner is live and reaches its repo sits in that
conductor's box; one whose repo has left its owner's reach sits there marked `(no reach)`; one whose owner is not live
sits under `NAME (gone)`, named from the record; a live lead with no record sits under `No conductor`. Lanes follow
their lead; a legacy lane follows the only lead record of its repo, else `No conductor`. A parked lead, or one with no
session and no lanes, is drawn too. Display only.

### Leads and conductors that exist on the day

- **Leads a conductor opened.** The lead's own mod, seeing no record and no binding, looks in the ledger for its own
  `lead-offer` and `lead-grant` pair of one nonce and conductor, naming its own session and its current name, with no
  void row and no `/callboard off` or new grant since. It then asks the person once in its own panel, with the Join
  dialog filled in for that conductor ("NAME opened this lead. Make NAME its conductor?"), default no conductor.
  Nothing is written without the click. A ledger that cannot be read asks nothing and logs it once. A conductor that
  restarted as a new conversation does not match its rows.
- **Every other lead** stays unowned until the person types `/callboard lead join` in it.
- **No stopgap.** An unowned lead is never treated as owned by the one conductor that lists its repo. From the step
  that ships routing, a lead not yet joined has no conductor tier and no conductor reaches its lanes; the manager still
  does. The order below joins the leads before that step, so the gap covers only leads still unjoined then.
- **Conductors granted before this change** gain the powers over the leads they own with no new dialog, by the person's
  choice: every lead they own needs the person's Join click or their own `lead_open` first. A new conductor grant's
  dialog says the conductor can also park and retire the leads it owns and force stop them with the person's click.

### Built in steps

1. Records and attach: the record, the binding, the Join and leave, the question after a `Lead` click, the questions
   for existing leads, the ownership ledger rows and the manager's table. Nothing routes by ownership yet, so it can be
   set up and seen first.
2. The person answers the questions and joins the remaining leads.
3. Routing: tiers, the lead's conductor section, cue acceptance, the lane fallback, the reach narrowing and the removal
   of the cap.
4. The lead tools, with the lead briefing's sign-off, the order for a lead, the extension's reopen of a lead record
   and the stop ledger rows.
5. The owner's check-ins and leads-changed notice.

Each step except the last is on the risk list and needs the person's own go.

### Audit

Ledger rows, each written before its action: `lead-owner` (made, joined, left or migrated; old and new conductor
session id; nonce), `lead-stop` (verb, caller and target session id, dialog yes or none) and `lead-resume` (caller
session id). The audit flags a stop or resume by a session that was not the record's owner or a manager at the time,
and a record change with no `lead-owner` row.

## Consequences

- Each conductor sees, and is seen with, only its own leads; a lead's prompt reaches the conductor that directs it; a
  conductor can end the leads it opened when their work is done.
- Once routing ships, a lead still not joined has no conductor tier and its lanes are in no conductor's reach until
  the person joins it. The manager keeps all of them.
- **On the risk list:** the record and binding (a new store that routing and stops trust as a filter), the questions
  for existing leads (ownership created from ledger rows, with the person's click), the Join and leave (who answers a
  lead's prompts and who may stop it), routing (ADR 0004's tier model; ADR 0006's "never a field anything reads to
  decide" reversed), park, retire, terminate and unpark of a lead (ADR 0002's "a conductor cannot stop a lead" and the
  manager's `target-is-lead` reversed), resume and the compaction order into a lead, and the powers given to existing
  conductors with no new dialog.
- **Accepted residual: a prompt-injected conductor, with only its tools.** ADR 0006 bounded it to opening leads. Over
  the leads it owns it can now park any idle lead with no live lanes (undone by `lead_unpark`; the saved grant is
  kept), send up to 12 fixed resume turns an hour into each, and order a compaction. **It can also retire an owned lead
  with no dialog.** The retire's gate is the lead's signed report, and the conductor can write that report itself:
  through its shell, or its file tools wherever its permissions allow a write outside its own repo. The lead's session
  id is in the record, and no deny rule covers `<repo>/.archive/<LEAD>/REPORT.md`. An appended `status: done <sid>`
  line is newer and larger than the report was at the start of the lead's last turn, so the lead's own check passes
  once it is idle. So a prompt-injected conductor can end any of its idle leads that has no lane records, and the retire deletes the saved
  lead grant: the conversation stays on disk and the person can resume it and type `/callboard lead` again, but
  `lead_unpark` cannot bring it back. This is the same exposure a lead already has over its lanes, whose reports it can
  write. `lead_terminate` always asks. A conductor cannot reach a lead it does not own: ownership needs the person's
  Join or the accept of its own offer.
- **Accepted residual: a prompt-injected lead.** Its shell can rewrite its own record or the lane records to steer its
  prompts to another approved conductor, inside ADR 0004's bound (the same shell can forge a decision file). It cannot
  make a conductor obey it.
- **Accepted residual: same-uid forgery, wider than before.** A process running as the person can write a record and
  the binding, and so make any approved, live conductor a lead's owner, with its prompts and its stop powers. It could
  already send the signal itself (ADR 0002). New: the owner it picks can then park or retire that lead with no dialog,
  and terminate it with the person's click. Because the lead's name is out of the hash, a record whose name such a
  process changes still matches its binding (a changed conductor or session id does not); the name only says what the
  owner and the manager call the lead, and the target checks still need it in exactly one place.
- **Closed: inheritance by name.** A new session under an old lead's name, a `/rename`, or the named plain panel of a
  refused offer gets no owner: the binding is missing, and `/callboard lead` refuses a name bound to another session.
- **Orphan records** hold a name and a slot until a stop removes them.
- **The panels extension** must find a lead record to reopen a parked lead; an older extension answers
  `reopen-timeout`, and the text names the version needed.
- **What stays as the guard:** the person's grant and approved list for every conductor; the person's dialog for every
  terminate and every manager retire; the person's click for every Join and every record made for an existing lead; the
  binding; the target's own mod checks for retire and park; presence checks on the owner at every cue and tier lookup;
  the ledger, the log and `/callboard off`.

## Changes to earlier decisions

Each carries a dated line pointing here; they apply as each step is built.

- **ADR 0001:** the manager's tools gain the four `lead_*` tools above; H2's exception for a stop covers `lead_retire`
  and `lead_terminate` too, each behind its own dialog, never unattended; H3, H5 and the closed list of what it may run
  follow.
- **ADR 0002:** the levels table (a conductor reaches its leads and their lanes); the conductor section ("cannot stop a
  lead", "no check-ins", the lead's side naming any trusted conductor, the dialog text); the manager's stops, which
  refuse a presence holder except a lead targeted by `lead_retire` or `lead_terminate`; the cue rule of a lane whose
  lead is gone; the new store and binding with their residuals; the manager's table.
- **ADR 0004:** the conductor tier is the owning conductor of the request's lead, none for an unowned lead.
- **ADR 0006:** the record and the lead's binding decide who a lead's conductor is (the ledger stays the audit); a
  conductor can park, retire and stop the leads it owns; the prompt-injected conductor gains the powers above;
  `lead_resume` is built in the lane form, with no token, and its sender is audited through the `lead-resume` row.

## Probes

Each is open until run, and each needs the person at the machine.

- **P-O1.** `lead_park`, then `lead_unpark`, on a live lead: the reopened panel is a lead again with no click, keeps
  its owner and reaches its lanes; a reopened panel whose name registers late still restores.
- **P-O2.** The tab close after `lead_retire` and `lead_terminate` closes the lead's tab.
- **P-O3.** `/callboard lead join` from the phone: the dialog shows and the click lands. With it, C11 (ADR 0002): a
  model-run `/callboard lead join` is refused as not the person.
- **P-O4.** Five conductors over one list of repos: after the questions for existing leads, each conductor's box holds
  only its leads, and a lead's prompt reaches only its owner. The lead's once-a-minute look is timed before and after.
- ADR 0006's P-C5 and P-C6 apply to `lead_resume` and stay open.
