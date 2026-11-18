# 8. Unattended mode: the manager decides while the person is away

**Status:** proposed
**Date:** 2026-11-16

Scope: what callboard does with a lane's prompts and questions, and with a tier's own, while the person is away. It
changes [ADR 0004](0004-prompt-answering.md) (the relay, a tier's own prompt, what the manager does with a request it
will not allow, a prompt nobody answers, questions), [ADR 0011](0011-all-prompts-rise.md) (what happens to an ask a
tier surfaces), [ADR 0009](0009-go-given-once.md) (who may open the go dialog), [ADR 0002](0002-callboard.md) (how
many lanes a lead opens) and [ADR 0001](0001-manager-role.md) (the exception for prompt answering). It changes who is
asked, when, and when the person stops being asked, so every part is on the risk list. Nothing here is in force until
the code that makes it true lands.

## Context

Escalation sends what no tier may settle to the person through the relay. When they are away, the relay waits and
lanes stall. Worse, the tier that asked stands still with its question: one night a lead's own question held a whole
run for seven hours.

The person asked for a mode they turn on themselves, in which the manager decides without asking them, and which
never touches the risk list. They ran it by prompt on three nights. Nothing mechanical stopped a relay or a question,
and the only record was the manager's notes.

Facts that bound the options:

- Every ask of a lane or a lead that can rise is a request the tiers judge by one rubric, which says what a tier
  handles and what it surfaces to the person (ADR 0011).
- A question a tier puts to the person has no time limit. Neither has a permission prompt of a session with no tier
  above it.
- The mod sees only what asks. A lane in a permission mode that raises no prompt, or a call an allow rule lets
  through, never reaches a tier.
- A lead and the manager are already told of a lane that waits on a prompt, also in the middle of a turn, when
  check-ins are on.
- A go is the person's click in the mod's own dialog, and it never covers a merge, a push to main or the rest of its
  list (ADR 0009).

## Options Considered

1. **The manager told by hand.** It works while every model follows its prompt, and it records nothing.
2. **A wider allow rubric while the person is away.** Rejected: what an agent may allow must not grow because nobody
   is watching.
3. **Let the manager deny a risk-list call with a safer variant.** Rejected: a variant can reach the effect the
   person kept for themselves.
4. **End the mode when the manager is gone.** Rejected: the relays would come back to an absent person.
5. **Keep a parked prompt's dialog open until the person is back.** It keeps the exact call for their click, but the
   lane stands still until then. Rejected: the mode exists to keep lanes moving.
6. **A window the person opens, in which nothing is put to them and what needs them is parked: chosen.**

## Decision

- **A window on one machine.** The person opens it with their own command and one dialog, for a bounded time with a
  default length. The dialog expires: a late click turns nothing on and says so. To open, it needs escalation on for
  everything, a live manager and check-ins on. It counts only while its ledger row and its stored value agree.
- **Nothing is put to the person.** No tier relays, and a relay that slips in is taken back. A tier's own question is
  refused by its mod, failing closed; so is a prompt of its own that no tier can answer. The tier takes the safe
  default and notes the open decision in its own state or report, for the person's return.
- **What a tier may allow does not grow.** The manager allows only what the rubric lets it allow by day, with one
  exception (the 2026-11-18 amendment: the repo's own Claude review). What it would have passed up, it now settles
  another way:
  - what the rubric sends to the person, and whatever a go never covers, it **parks** (the same exception aside);
  - anything else it denies with a reason the lane can act on, or parks. Such a deny is the manager's, not the
    person's, and the lane is told so.
  Only the manager parks, and only inside a window.
- **A park closes the prompt.** The lane is told that the item waits for the person and to reach it no other way, and
  it goes on with its other work. The person finds the item in the list, not as an open dialog.
- **Questions.** The manager answers by the question rubric. One the rubric leaves to the person, a design choice
  they kept included, stays open in the lane's panel or, for a lane in the default permission mode only, gets the
  most cautious offered option, marked provisional: the lane takes only steps it can undo on it, and the person
  reviews it. A risk-list, approval or go question is never answered.
- **Nobody answers.** A window stays on when its manager is gone. A prompt no tier answered is then **held** for the
  person: closed like a park, with the same instruction to the lane.
- **A limit on lanes.** A lead opens only a few live lanes while the window is on. Lanes already live are left alone.
- **Ending it.** Any origin may end it, from any session. The person tells the manager they are back, and the manager
  ends it with a tool that can only end it. It also ends at its time, and when a read shows for certain that
  escalation was switched off. It never resumes by itself.
- **A read that fails ends nothing.** While the window cannot be read, what it forbids stays forbidden (the relay, a
  tier's own question, the go dialog), and what only a window permits (a park, a provisional answer) is not done
  until the read succeeds. A failed read must not hand the questions back to an absent person, and must not let a
  park through either.
- **The record.** Every request and decision of a window carries the window's mark in the ledger. The person's own
  command lists the window: how it ended, and what was parked, answered provisionally, held, still open, denied, allowed
  and asked again after a deny, park or hold of the same pattern. When a window
  ends the person is shown a toast with the counts, and an unread mark stays until they run that command, which then
  lists every window since they last read it. A tier held back by its notice cap in a window leaves a row.
- **The go.** The mode gives and widens no go. No session, a lead or a conductor, can open the go dialog while it is
  on; the person can still give one themselves. The manager follows the rubric as it stands when it judges a
  request. The person took the question ADR 0009 left open: under a go, a tier allows the edits and test runs on the
  risky code the go names, by day and inside a window, while a merge and the rest of the go's list still go to the
  person. ADR 0009 is amended by the PR that builds it, not here.
- **Not an armed run.** It pre-authorises nothing and does not satisfy the arming of an unattended run in ai-toolkit
  (https://github.com/notitial/ai-toolkit/blob/main/rules/workflow.md).

## Consequences

- Lanes keep moving while the person is away, and risk-list work waits for them.
- The manager's judgment runs unchecked until the person reads the list, with no relay as an exit for a borderline
  call. The list is their review; the audit script is a check they may run, not a control.
- Only what asks is seen: a lane in a mode that raises no prompt, or a call an allow rule lets through, is never
  parked. The dialog says so each time.
- A provisional answer is acted on before the person reviews it. The default mode does not make the lane's later
  calls ask: one an allow rule lets through runs unasked, so there the answer's "reversible steps only" text is the
  only control.
- A denied or parked call is not replayed. The list shows its pattern, not the call; the lane's report holds the
  rest.
- No tier can ask the person anything while the mode is on, even with them at its panel: they end the mode to be
  asked.
- A question nobody may answer keeps its lane stopped. So does what cannot rise at all (ADR 0011), such as a
  subagent's ask.
- An agent can end the mode. That opens no window and allows nothing, but it brings the relays back while the person
  is away, so the work stops on the first question to them. The record names who ended it.
- With no live manager every unanswered prompt costs its lane the full wait.
- Waits count awake time. While the machine sleeps, a prompt can stall past the point where it would be held, and a
  window whose time passed during sleep ends only at the first read after the wake.
- A process of the same user that writes both the ledger row and the stored value opens a window. The go rests on
  the same trust in the person's origin and the mod's dialog.
- Sessions on older code must be restarted before the mode is used: an old lane and an old tier together can still
  relay.

## Changes to earlier decisions

Each gets a dated line pointing here when the code that makes it true lands, not before.

- **ADR 0001:** the exception that lets the manager answer prompts through the mod also covers a park and a
  provisional answer. The manager still never allows a risk-list prompt, and stop dialogs stay the person's.
- **ADR 0004:** inside a window no tier relays. A tier's own question, a conductor's or manager's own prompt, and a
  lead's own prompt with no tier in reach, is refused where it was the person's. The manager denies or parks what it
  would have passed up, where a tier denied only when certain. A prompt that reached a tier and that none answered
  is held: closed for the person's return, where the lane was told to ask again. A lane's prompt with no tier in
  reach still stays in its panel. A question the rubric leaves to the person may get a provisional answer.
- **ADR 0011:** inside a window an ask a tier surfaces is parked or held, not relayed. What rises, and what a tier
  may handle, stand.
- **ADR 0009:** neither a lead nor a conductor can open the go dialog inside a window.
- **ADR 0002:** its limits on lanes stand; inside a window a lead's live lanes get a lower one.

## Amendments

- **2026-11-17: the turn-on is short.** The dialog is six short lines (the end; what the manager decides and parks; that a
  tier's own question is refused; that only calls that ask are seen; the live lanes and the lead's limits; the
  manager's mode), each said once, in the pattern of ADR 0009's short dialog. A span
  or a time alone turns it on: `/callboard unattended 1h`, `45m`, `17:30`, or `/unattended` with the same words,
  which is the same handler with the same person-only origin gate and the same dialog. The `on`, `on for` and
  `on until` forms stand. A span under 30 minutes, or over 14 hours, is refused with the nearest end that fits.
  The mod sees a permission mode only on a permission event, never as a session's state, so the dialog carries a
  fixed line that the manager must be in auto mode (in another mode its own prompts are refused unless a rule already allows
  them, its board write too); no turn-on is refused over a mode.
- **2026-11-18: the dialog and this ADR say the same.** The dialog's two lines that the short form had left to the docs are back in a few words: a
  lane's question the manager cannot settle stays in its panel unless the lane is in the default mode, where it may get the most cautious option; and a
  prompt nobody answers is held for the person after 20 minutes. The list the person reads says when more windows wait than it shows (it keeps to one
  size, and the windows left out stay unread) and when the unread mark is full, so an older window that ended may be missing; a window's items are
  cut at a size, and the cut is said.
- **2026-11-18: the repo's own Claude review.** Marking a PR ready starts the paid automatic review in a repo that has
  `.github/workflows/claude-review.yml`, and the merges wait on it, so parking it stopped a whole chain overnight. The
  person asked that the mode be able to do this unattended. It is a narrow exception that exists only inside a window,
  to the clauses "allows only what the rubric lets it allow by day" and "whatever a go never covers, it parks". It
  is not a wider rubric: by day the manager decides a mark-ready by judgment and the comment by `SPECIFIC_CALLS`, and
  in a window three texts would still park both (rule 1, rule 2 with the go's list, and the rubric's paragraph on a
  guard's ask), so the manager's block says it overrides them for two calls and no others:
  - **A mark-ready** (`update_pull_request` with `draft` false and nothing else in the input), on a draft in the
    lane's own repo, only when the checks on the head are present and none is pending or failed, the head holds main's
    tip, and no changed file is under `.github/` or is the review command (a mark-ready runs the PR's own copy of the
    workflow with its secrets). The manager looks these up with the GitHub tools: a check made by judgment, not by the
    mod, which sees only the call. A mark-ready not ready yet is denied with a why that starts `Not yet: `; that
    manager's deny of that tool is the one further deny (besides the cleaner-command deny) `repeatOf` does not count, so the retry after the fix is judged and
    not parked as a repeat.
  - **An `@claude review` comment** (`add_issue_comment`, body exactly the command, with or without `--comments`),
    inside the cap the mod already enforces at `prompt_answer`: 2 `--comments` and 1 full review per PR. Past it the
    manager parks it.
  A mark-ready does not count against the cap: it is the automatic run, which the workflow gives once per PR. A PR can
  so reach four paid runs: the automatic one, one full review and two follow-ups. Every other paid call, and a
  `create_pull_request` that is not a draft, stays parked.
  - **The go's list is unchanged**, here and in ADR 0009: the exception belongs to the manager's block alone, which
    only the manager reads, and `go_status` still prints "anything that pays".
  - **Residual risk.** A wrong allow costs one paid review run, with no data and no merge. A lane may set a PR back to
    draft with no ask and an allowed mark-ready is never a repeat, so a toggle loop is bounded only by the workflow's
    once-per-PR gate, which fails open on an API error. The allow lands up to 20 minutes after the manager's look, keyed
    on the call and not the head. Checks and main are the manager's reading, so a model that is steered can allow a
    mark-ready it should not; the person's list shows it, with its why. A mark-ready held at 20 minutes is a repeat when
    asked again, as for any call, so a busy manager can still stall one. A repo whose checks never run on a draft is
    parked, not looped on `Not yet:`.
- **2026-11-18: the mod's own dialogs pass, and a window's requests get no head start.**
  - The mod's own dialog (the go dialog that the person's typed `/callboard go` opens, the turn-on dialog, a stop
    dialog) is not a tier's own question. The engine may show it through the permission hook as a question. Such a
    call, with exactly one question whose header and text match a dialog that this session's mod has open now, gets
    no decision from the mod or from any hook beneath it, so only the person answers it. A subagent's question never
    matches. It gets one log line (`passed own-dialog`) and no row.
  - This is the likely cause of a go dialog, typed in a window, that closed as cancelled. The log line shows
    whether the engine routes the mod's dialog that way.
  - While one of its dialogs is open, the mod submits no turn that could close it. A compaction nudge, a
    lanes-changed notice and a lead's resume wait until the dialog closes. The notice for a refused compaction
    becomes a toast for the person, and the session that asked is not told.
  - A request raised while a window is on carries that window's mark. While the same window is on, the request
    gives the person no 30-second head start: the first tier is told and may answer at once, a pass-up opens the
    next tier at once, and the hook applies a decision at its next poll. The person is away, so the head start only
    delayed every answer. A request raised by day or in another window keeps its 30 seconds. So does every request
    once its window has ended or cannot be read.
  - go_request's refusal in a window says that the person can type `/callboard go` in the lead's session
    themselves, without ending the mode.
