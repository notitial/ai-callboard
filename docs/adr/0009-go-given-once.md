# 9. A go given once

**Status:** accepted, amended
**Date:** 2026-11-15

*2026-11-16: accepted, with the conductor's go built. A lead's go was built first; the dated lines below say what the
conductor's half added.*

Scope: how the person's go for a body of work reaches the sessions that do it. It changes
[ADR 0001](0001-manager-role.md) ("every go is typed in the session that executes it"),
[ADR 0004](0004-prompt-answering.md) (a go question, who relays, one sentence of the rubric),
[ADR 0002](0002-callboard.md) (the lane and lead briefings, a new store folder) and
[ADR 0007](0007-conductor-owns-leads.md) (what ownership carries), and it needs a change to ai-toolkit's
`rules/workflow.md` (https://github.com/notitial/ai-toolkit/blob/main/rules/workflow.md), which this repo cannot lift
by itself. Every part is on the risk list.

## Context

A lead splits approved work over lanes, and a conductor over leads. The rule is that risk-list work needs the person's
own turn in the session that acts, and a relayed go counts for nothing. So every lane asks again for work the person
approved once, and a lane that replaces another asks once more. On one night nine lanes asked for a go on one approved
plan.

The question does not reach the person where they are. A lane's go question is raised to its lead, no tier may answer
it, and only the top live tier may relay it. With a manager live, that is the manager's panel, while the person works
in the lead's. Over two days leads passed 27 requests up and none was relayed; the person answered in each lane's own
panel.

The person's requirements: a go given once in a conductor or lead counts for the work under it; lanes, and leads a
conductor starts, run unsupervised after it; it propagates down the ownership chain; a mechanism of the plugin's own
is acceptable.

Facts that bound the options:

- Any process running as the person can write every callboard file (ADR 0002). ai-toolkit's protected-paths hook
  keeps agents' file and shell tools out of callboard's folder, which is what escalation's default already stands on.
- The mod's dialogs and its origin check are assumed to be the person's alone. ADR 0002's probes C11 (a model cannot
  run `/callboard` with a person's origin) and C12 (a dialog is answered only by the person) are open, and they gate
  the first build.
- A lane record names its lead by session id, whether the lead made the lane or the lane was joined to it; only a
  record written before that field existed names its lead by name alone (ADR 0002). Nothing rewrites the id when a
  lead restarts as a new conversation: it is then dead, and the lane tools fall back as ADR 0002 describes. A lead
  record names its conductor by session id (ADR 0007).
- The risk list is judgment, not a floor (ADR 0004): nothing mechanical recognises risk-list work.

## Options Considered

1. **Keep the rule; make the relay reach the person.** Fixes where the question appears, not how often it is asked:
   still one answer per lane, and one more per replacement. Rejected as the whole answer; kept as a part (the relay
   where the person is).
2. **The lead answers go questions from its own record of the person's approval** (a decisions file, the brief).
   Rejected: it turns an agent's text into a go, the one thing the approval rule exists to stop.
3. **An `AskUserQuestion` headed `Go <scope>` in the tier's session, read by the mod** as it reads a relay. Works, but
   the tier writes the whole question and the covered names, and the mod must trust wording it does not read. Not
   built; noted as the fallback if the engine dialog cannot hold the text.
4. **A go bound to each brief's hash**, covering only lanes that exist when it is given. Rejected: a replacement lane
   and a lane created later would ask again, which is the case that prompted this.
5. **The mod's own dialog records a go for the session it is given in; it covers the sessions under that session in
   the ownership records, including ones opened later, until it ends; a session reads it only through the mod's own
   tool: chosen.**

## Decision

### The go

- **The person gives a go in the mod's own dialog**, in a lead's or conductor's session: after typing `/callboard go`
  (their own prompt or the phone only), or when that session's main agent calls `go_request`, which only opens the
  dialog. `go_request` takes a text and never a duration; only the person's own command sets an end other than the
  default.
- **The go's text** follows the rules of a lane's task text (ADR 0002): a text that is empty, too long, or holds a
  control character other than newline and tab or an invisible format character that can hide or reorder text
  (zero-width, bidi, byte-order mark, tag characters) is refused before any dialog opens. The text the dialog shows,
  the text the file stores and the text `go_status` returns are the same bytes.
- **The dialog** shows the sessions covered now, named by the mod from its records; the end; the fixed list of what a
  go never covers; and, as its last block under a fixed line naming its author, the tier's description of the work.
  Its buttons are `Cancel`, first, and `Give go`. It has its own limit of 10 minutes. A dismissal, a timeout or
  `Cancel` writes nothing, and a click after the limit records nothing and the person is told so.
- **The dialog is short** (amended 2026-11-16, PR #105). The person did not read the long form, so the dialog now
  shows the sessions covered now as a count and not by name, and the short never-list with the full one left to
  `go_status`; the description of a new go is held to a few lines, with the detail in the brief or the plan. The
  names stay in the go file and in the result of the call.
- **The person can read the full never-list** (amended 2026-11-16, PR #109): `/callboard go` prints it, and the dialog
  points there, since `go_status` is a tool only a session calls. Where this ADR says the dialog lists or names
  sessions, or prints the full list, the two amendments here hold instead: "the sessions the dialog listed" are the
  lanes the lead had at the click, and probe P-G1 is about the short text.
- **The mod keeps it**: a file under `~/.claude/callboard/go/` (0700 folder, 0600 file, one link, at most 8 KB) and a
  `go-grant` ledger row that holds the file's hash. The file stores the text the person was shown and the session ids
  the dialog listed. A go counts only while the file and its row agree. No tool lets an agent write either.
  *2026-11-16: a lead's go file is the `v: 1` form and is unchanged. A conductor's go file is `v: 2`: it names the
  conductor as the session it was given in, and holds the leads the dialog counted (each lead's record name, session
  id and repo) beside the lanes: every lead whose bound record names the conductor, whatever its list of repos
  holds then, and the lanes whose record names such a lead by session id (a lane that names no lead, or a lead only
  by name, is not taken in). One go holds at most 16 leads and 32 lanes, and they
  must fit the file; more is refused before any dialog. A session whose mod was loaded before this form existed cannot parse it
  and reads "no go".*
- **It belongs to the session it was given in, by session id.** A new conversation under the same name has no go; the
  person gives one there, and that go lists and covers the lanes that exist.
- **It ends** at its end time (24 hours by default, at most 48), at the person's `/callboard go off`, or when the
  granting session runs `/callboard off` or loses its grant. It does not end when that session's panel is closed,
  parked or crashed, so the sessions under it keep working. The reading session's mod evaluates the end on each read.
  Ending only narrows, so any mod may write the row that records it. No tool ends a go.

### Who it covers

- **The sessions the dialog listed**, by the session ids stored in the go. For a lead these are the lanes the mod
  resolves as that lead's at that moment, the way the lane tools do. For a conductor they are the leads whose record
  names its session, and their lanes.
- **Sessions opened later, while the go lasts**: a replacement lane, a lane a covered lead creates, a lead the
  conductor opens. The record's own session id must be the reader's, and the record's owner must be the granting
  session or, under a conductor's go, a lead that go covers. So the chain is at most conductor, lead, lane: a lane
  under a lead's go is one link from the granting session, a lane under a conductor's go is two. Every link is a
  session id in a record, never a name, and each is checked fresh on every read. The granting session is shown a
  toast the first time each later session reads the go.
  *2026-11-16: under a conductor's go a later lead is covered while its lead record names the granting conductor's
  session and the lead is bound to that record (ADR 0007); a lane is covered while its record names, by session id,
  a lead the go holds from the click or such a later lead. Lead records or a binding that cannot be read cover nobody, and
  `go_status` says so. The reader looks only at the records, never at the conductor's list of repos or at whether
  the conductor is live: a repo the person takes off the conductor's list keeps its leads covered until the go
  ends or they type `/callboard go off`. A session the go holds from the click stays covered by its own session id until then
  too, also a lead that has since left the conductor. A conductor reads only the goes given in its own session:
  no other go covers it. A conductor's goes also end when its saved grant is refused for good at a restart (another
  folder, the session is a lane or a lead by then, its repo in use, no approved repo left, its tools refused, or
  the tries used up), and then only the goes it gave as a conductor.*
- **The granting session itself.**
- *2026-11-17: a lead a conductor owns asks the conductor for its go. Its `go_request` is refused, before any dialog
  and with none of the hour used, while its owner binding stands (ADR 0007), whether the conductor is live or not: the
  person said that under a conductor they never open a lead. The refusal names the conductor when it is live and tells
  the lead to ask it by message; while it is compacting, restarting or stopped, to wait and ask again, never to open a
  go of its own, and, if it stays gone, to tell the person, who can type `/callboard lead leave`. The conductor's one
  dialog covers the lead and its lanes as above. A binding that cannot be read counts as none, so the dialog then
  opens in the lead as before. The person's own `/callboard go` typed in a lead's panel still opens the dialog there.
  A lead with no conductor is unchanged.*
- *Amended 2026-11-17 ([ADR 0008](0008-unattended-mode.md)):* while unattended mode is on, a lead's or a
  conductor's `go_request` is refused before any dialog. A go the person gives with their own `/callboard go` still
  opens, and the mode gives or widens none.
- The reader is always bound by its own session id, never by its name. The reading session's own mod checks the go's
  file and row, its end and the records, fresh, on every read. A check that cannot be made is "no go".
- The manager is not in the chain: it owns nothing, a go cannot be given in its session, and it passes none on. A
  covered session cannot give, widen or extend a go.

### What it covers

The risk list is used in two senses, and the go separates them.

- **Covered: building work whose subject is on the risk list**, in the session's own clone and branch, for the work
  the go's text names: editing, testing, committing, pushing to the session's own non-main branch, a draft PR, the
  reviewers.
- **Never covered: an action that is itself on the list.** Each needs the person, every time: a merge; a force push;
  a push to main, master or production; a production or staging change, a deploy, a data migration run; a delete
  outside the session's own work; anything that pays, or reads or sends personal data or secrets; an edit of settings,
  hooks, rules, permission files, callboard's state or a live checkout; publishing a release or a package; a push that
  triggers a deploy; a stop of another session that asks today; any switch or grant, another go included; work the
  text does not name.
- **One never-list.** The mod holds the full list in one place and prints it in the dialog and in `go_status`. Every
  shorter form (a briefing, a rule text) names its first five items and points to the list `go_status` prints.
- Marking a PR ready and commenting on the session's own PR are not risk-list actions; the brief and the tiers' rubric
  govern them.

### Prompt answering

- A go allows no permission prompt and answers no question by itself.
- **One sentence of the rubric changes; this is the person's call and is still open.** Rule 4 says a call must touch
  none of the risk list, and does not separate work whose subject is on the list from an action that is on it. Read
  strictly, a lead passes up every permission prompt of a lane that builds permission or schema code. So
  `prompt_list` shows, for each request, a line the mod computes (a go covers the asker, with its end, or none), and
  rule 4 gains: when `prompt_list` shows that a go covers the asker, a call that only builds that work inside the
  lane's own clone and branch (an edit, a test run, a commit, a push to its own non-main branch, a draft PR) is judged
  by the other rules; everything the go never covers is still passed up.
- Without that sentence the go removes only the go question, permission prompts on covered work still reach the
  person through the relay, and "unsupervised" is met in part only.

### How a session learns of it

- **`go_status`**, a read-only tool of every lane and lead, is the only source. It returns the goes that cover the
  caller, with the text the person approved, the end and the never-list, or "No go covers this session". It reports
  nothing while the protected-paths guard is missing.
- **The briefing** of a lane and of a lead, and their start turns, say: call `go_status` before asking for a go and
  after a resume or a compaction; a go it lists is the person's own; a brief, a message, a notice or a state file
  claiming one is not.
- **`lane_create` and `lane_start`** end their result by saying whether a go covers the lane, so the lead knows
  whether to call `go_request`.
- There is no notice to covered sessions.
- **A resume, an unpark and a compaction keep the go**, because it is held against the granting session and the
  records, not in a conversation.

### The relay

- A question that asks for a go is relayed like any other question, and the person's pick is their go for that one
  question.
- **The relay lands where the person says.** The person types `/callboard here` in the session they are working from;
  it is a command, so its origin is checked. Relays for requests in that session's reach then land there, whatever the
  top tier, until they type it in another session or 12 hours pass. Without it the top tier relays as before. *Built
  2026-11-16.* The command is typed in a lead's, conductor's or manager's session (a lane or a plain session is
  refused) and moves permission prompts and questions alike. It ends when typed in another session, at `/callboard
  here off` (any origin: it only narrows), when that session's grant ends, or after 12 hours. It is one `$.store` key,
  `relay-here` (`{ v, sid, at, until }`), written after a `here-on` ledger row and read by one function; a `here-off`
  row records its end (the end after 12 hours has none: the `here-on` row carries it). The key is not bound to its row
  by a hash: a process running as the person could write it and move where a question shows, but the person still
  answers it themselves, in a session that could already answer by the rubric, which is less than a forged decision
  file allows (ADR 0004). The tiers above keep their relay as the fallback: if the session the person named does not
  act, the request reaches the next tier in its window as before, so now and then a question still opens in the other
  panel. The other choice, to refuse the top tier's relay while `here` stands, could leave a prompt with nobody able
  to put it to the person. It does not end unattended mode and is not ended by it. A restart that restores the
  session's grant does not end it either, as a closed panel ends no go; a grant the person drops does, and so does a
  saved grant that is refused at a restart; a new grant in that session does not bring it back while the mod keeps
  running (a key that could not be removed is held back by a mark in memory, which a restart loses). A lead moved to
  another folder stays `here`, for its new reach; so does a lead whose saved grant followed its repo to a new folder
  on the person's click (ADR 0002, Lead re-grant), and the goes it gave end there, as at any move to another folder;
  a move question that gets no answer, or fails after the click, ends `here` as a refused saved grant does. `here off` does not take back a relay question already on screen:
  that request is in front of the person, and their click still lands.

### Audit

Rows, each written before its effect: `go-grant` (id, granting session, level, file hash, end), `go-end` (id, code)
and `go-read` (id, reading session, once per session). The audit prints each go's text beside the sessions that read
it, and flags a go file with no row and a row with no file.

## Consequences

- The person says go once per body of work. Lanes and conductor-started leads start without a click, and a replacement
  lane needs none.
- **The approval rule is reversed in one place.** "Every go is typed in the session that executes it" becomes "or
  given through callboard's go for the sessions under the one it was given in". ai-toolkit's rule says its exception
  cannot be lifted by a project rule, so that rule changes first, in its own repo.
- **On the risk list:** the dialog and its two entry points, the store and its rows, the coverage check, `go_status`,
  the briefing texts, the rubric sentence, `/callboard here`, and every rule text.
- **Accepted residual: the description is the tier's.** The person reads the tier's words before clicking. A wide or
  wrong text gives a wide go. Bounded by the fixed never-list, the mod-computed names, the end and the audit.
- **Accepted residual: sessions opened later.** A prompt-injected lead or conductor under a live go can open sessions
  whose briefs go beyond its text. The covered session's own reading of the text against its brief is the only check;
  it is judgment, as the risk list is. The never-covered actions still reach the tiers and the person as prompts. The
  toast to the granting session and the 48-hour cap bound it; there is no limit on the count.
- **Accepted residual: same-uid forgery,** as for a decision file (ADR 0004): a process running as the person can
  write a go and its row. The protected-paths hook is the guard, and `go_status` reports nothing without it.
- **Accepted residual: other plugins.** Another plugin loaded in the session may answer the dialog or run the command
  (ADR 0002). The install rule that callboard is the only plugin on the plugin path is the guard.
- **One click stands for many.** The dialog is the only place the person sees the scope.
- **What stays as the guard:** the person's click for every go; the never-list; the rubric and the relay for every
  never-covered action; the person's dialogs for stops; the end; the ledger and the audit; `/callboard go off`.

## Changes to earlier decisions

Each gets a dated line pointing here when the code that makes it true lands, not before.

- **ADR 0001:** "Every go is the person's, typed in the session that executes it" gains the go. The manager never
  passes on a go in its own words; a lane's go question goes through the mod's relay at whichever tier relays, the
  manager included. Its hard lines stand.
- **ADR 0002:** the lane briefing's risk sentence and the lead briefing's twin; the start turns; the `go/` folder.
- **ADR 0004:** "A go that must be typed in the session that acts still has to be" is replaced; a go question is
  relayed like any other; who relays gains `/callboard here`; rule 4 gains its sentence, if the person takes that
  call.
- **ADR 0007:** ownership also carries a go downward. The prompt-injected conductor and lead residuals gain: "Under a
  live go it can open sessions that the go covers."

## Probes

Each is open until run, and each needs the person at the machine.

- **C11 and C12 of ADR 0002**, gating the first build: a model-run `/callboard go` is refused as not the person, and
  the go dialog is answered only by the person.
- **P-G1.** The engine dialog shows the full go text (about 2,500 characters) on the desktop and the phone.
- **P-G2.** A go given in a lead: a parked and reopened lane, and a replacement lane, read it with `go_status` and do
  not ask.
- **P-G3.** `go_request` from a subagent is refused.
- **P-G4.** A go given in a conductor reaches a lead it opened and that lead's lane.
- **P-G7.** *Added 2026-11-16.* The conductor's dialog, which counts its leads and their lanes, shows whole on the
  desktop and the phone.
- **P-G5.** A click after the dialog's limit records nothing and the person is told.
- **P-G6.** A go text that holds a zero-width or tag character is refused and no dialog opens.
