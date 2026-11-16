# 8. Unattended mode: the manager decides while the person is away

**Status:** proposed
**Date:** 2026-11-16

Scope: what callboard does with a lane's prompts and questions, and with a tier's own, while the person is away. It
builds on [ADR 0004](0004-prompt-answering.md) (the tiers, the rubric, the relay),
[ADR 0011](0011-all-prompts-rise.md) (every ask rises) and [ADR 0009](0009-go-given-once.md) (the go), and it widens
the exception [ADR 0001](0001-manager-role.md) makes for prompt answering. It changes who is asked, when, and when
the person stops being asked, so every part is on the risk list. The mode is built in small steps with its switch
last; until the switch lands nothing here is in force, and ADR 0001 and ADR 0004 get their dated lines with it.

## Context

Escalation sends what no tier may settle to the person through the relay. When they are away, the relay waits and
lanes stall. Worse, the tier that asked stands still with its question: one night a lead's own question held a whole
run for seven hours.

The person asked for a mode they turn on themselves, in which the manager decides without asking them, and which
never touches the risk list. They ran it by prompt on three nights. Nothing mechanical stopped a relay or a question,
and the only record was the manager's notes.

Facts that bound the options:

- Every ask of a lane or a lead is a request the tiers judge by one rubric, which says what a tier handles and what
  it surfaces to the person (ADR 0011).
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
   lane stands still until then. Rejected for the same reason as the relay.
6. **A window the person opens, in which nothing is put to them and what needs them is parked: chosen.**

## Decision

- **A window on one machine.** The person opens it with their own command and one dialog, for a bounded time with a
  default length. It needs escalation on for everything, a live manager and check-ins on. It counts only while its
  ledger row and its stored value agree.
- **Nothing is put to the person.** No tier relays, and a relay that slips in is taken back. A tier's own question is
  refused by its mod, failing closed; so is a prompt of its own that no tier can answer. The tier takes the safe
  default and notes the open decision where the person will see it.
- **What a tier may allow does not change.** The manager parks what the rubric sends to the person and whatever a go
  never covers. Anything else it would have passed up it denies with a reason the lane can act on, or parks. Only the
  manager parks, and only inside a window.
- **A park closes the prompt.** The lane is told that the item waits for the person and to reach it no other way, and
  it goes on with its other work. The person finds the item in the list, not as an open dialog.
- **Questions.** The manager answers by the question rubric. One the rubric leaves to the person stays open in the
  lane's panel or, for a lane in the default permission mode only, gets the most cautious option, marked provisional.
  A risk-list, approval or go question is never answered.
- **Nobody answers.** With no live manager the window stays on. A prompt no tier answered is held for the person, with
  the same instruction to the lane as a park.
- **A limit on lanes.** A lead opens only a few live lanes while the window is on. Lanes already live are left alone.
- **Ending it.** Any origin may end it, from any session. The person tells the manager they are back, and the manager
  ends it with a tool that can only end it. It also ends at its time and when escalation is surely off. A read that
  fails ends nothing: the narrowing rules stay in force and a park waits. It never resumes by itself.
- **The record.** Every request and decision of a window carries the window's mark in the ledger. The person's own
  command lists the window: how it ended, and what was parked, held, left waiting, denied and allowed.
- **The go.** The mode gives and widens no go. A lead cannot open the go dialog while it is on; the person can still
  give one themselves. The manager follows the rubric as it stands when it judges a request, so a change to what a go
  lets a tier allow is decided in ADR 0009, not here.
- **Not an armed run.** It pre-authorises nothing and does not satisfy ai-toolkit's arming.
- **ADR 0001.** The exception that lets the manager answer prompts through the mod (ADR 0004) also covers a park and
  a provisional answer. The manager still never allows a risk-list prompt. Stop dialogs stay the person's.

## Consequences

- Lanes keep moving while the person is away, and risk-list work waits for them.
- The manager's judgment runs unchecked until the person reads the list, with no relay as an exit for a borderline
  call. The list is their review; the audit script is a check they may run, not a control.
- Only what asks is seen: a lane in a mode that raises no prompt, or a call an allow rule lets through, is never
  parked. The dialog says so each time.
- A provisional answer is acted on before the person reviews it.
- A denied or parked call is not replayed. The list shows its pattern, not the call; the lane's report holds the
  rest.
- No tier can ask the person anything while the mode is on, even with them at its panel: they end the mode to be
  asked.
- A question nobody may answer keeps its lane stopped. So does what cannot rise at all (ADR 0011), such as a
  subagent's ask.
- An agent can end the mode. That only narrows, but it brings the relays back while the person is away, so the work
  stops on the first question to them. The record names who ended it.
- With no live manager every unanswered prompt costs its lane the full wait.
- A process of the same user that writes both the ledger row and the stored value opens a window. The go rests on
  the same trust in the person's origin and the mod's dialog.
- Sessions on older code must be restarted before the mode is used: an old lane and an old tier together can still
  relay.
