# 11. Every lane prompt rises up the chain

**Status:** proposed
**Date:** 2026-11-16

Scope: which asks of a lane's or a lead's call become a request for the answering tiers. It amends
[ADR 0004](0004-prompt-answering.md), "What agents may judge" and its rule that a dialog of another kind is never
answered. It changes who may answer a permission prompt, so it
is on the risk list. The rubric's five rules, the tiers, the windows and the relay are unchanged; the rubric gains a
paragraph on what raised an ask and a list of what a tier handles and what it surfaces of a guard's or hook's ask,
a line for a setting's, plugin's or ceiling's ask and one for a plan-mode exit; the audit gains one rule and a count
and loses its rule against a request for a plan-mode exit.

## Context

ADR 0004 let the tiers judge three kinds of ask: one raised by a rule, the mode's own, and one named guard
(ai-toolkit's GitHub guard) on four tools. Any other ask raised by a hook, and anything raised by a setting, a plugin
or an organisation ceiling, stayed the person's: the hook wrote a `not-judgeable` ledger row, no request and no
notice, and the dialog waited in the lane's panel.

That rule was written for a person who sits beside the lanes. It fails when they do not:

- A lane's rerun of failed CI jobs (`mcp__github__actions_run_trigger`, asked by the GitHub guard outside its four
  tools) waited 13 minutes with nobody told. It happened three times in one night, to three lanes.
- Nothing in `prompt_list` showed it, because there was no request, and the one alert (the lead's check-in) waited
  for an idle lead.
- An unattended run stalls on the first such prompt until the person comes back. The person's words: "Make all
  requests rise up the chain. Otherwise, there's no point in making an unattended mode at all."

Facts that bound the options:

- `tool.check` says why an ask exists (`rule`, `hook`, `setting`, `plugin`, `ceiling`). It names the event and the
  reason, never the script (ADR 0004, Context).
- The risk list is judgment, not floor: the rubric's rule 4 already sends a merge, a force push, a push to main and
  a delete outside the lane's work up to the person, whatever raised the ask (ADR 0004).
- A hook that must stop a call denies it. A deny is decided before any PermissionRequest hook and never reaches a
  tier (ADR 0004, Context). ai-toolkit's protected-paths hook works this way.
- The relay puts any request the tiers will not allow in front of the person, in the session of the top live tier.

## Options Considered

1. **Add the tool to the guard's list.** `actions_run_trigger` would join the four tools. It fixes one tool, and the
   next hook-raised ask stalls a lane the same way.
2. **Relay only.** A hook-, setting-, plugin- or ceiling-raised ask becomes a request a tier may deny or pass up but
   never allow; the top tier relays it. Authority does not widen. The person still answers every such call, so a
   rerun of a flaky job at night waits for them.
3. **Every ask is judged by the rubric.** One rule for all asks. The person's go for this work reads: such prompts
   "become requests that the lead, conductor and manager judge by the same rubric, and the top live tier relays them
   to the person". Taken alone it lets a tier allow what an installed guard asks the person about by design: a clear
   of another session's workspace lock, a delete, a workflow dispatch.
4. **Option 3 with a floor.** Every ask rises and is judged by the rubric, except a fixed list of asks (a ceiling's,
   the workspace-lock guard's, the destructive-command guard's, most GitHub writes a hook asks about) that rise the
   same way and that no tier may allow. It was built and then dropped: the list matches guards by their reason text
   and tool names, so it follows ai-toolkit's wording, and it stops a tier from handling the routine case (a delete
   in the lane's own clone, a label the work needs) the same as the dangerous one.
5. **Option 3 with written guidance: chosen.** Every ask is the tiers' to judge. The rubric says, in a short list
   a tier can check a request against, which of a guard's or hook's asks it handles and which it surfaces to the
   person. The person's decision (2026-11-16): the tiers judge them all, with instructions good enough that they know what to
   surface and what they can handle. And, the same day: no prompt stays the person's alone by the mod's own
   rule; a hook or a deny rule denies a call, or its prompt rises.

## Decision

**Every ask of a lane's or a lead's call becomes a request, whatever raised it.** The classifier no longer decides
who may judge. It records what raised the ask (`ceiling`, `setting`, `plugin`, `hook`, the named `guard`, `rule` or
`mode`; the widest source when several stand behind one ask). The request file carries it, `prompt_list` shows it
to the tier as `raised by` for a permission prompt (a question's line does not show it), and the ledger's
`requested` row keeps it as `raised`, so the audit can count the tiers' allows of such asks after the request file
is gone. The rubric says what each value means, and that a guard's or hook's ask is allowed only when the call is
plainly the routine case. A question behind a rule, hook, setting, plugin or ceiling is classified the same way; the questions scope
and the question shape still apply to it.

### A guard's or hook's ask: what a tier handles and what it surfaces

The mod keeps no list of asks from the tiers. The rubric carries the guidance, in every tier's briefing and at the
end of every `prompt_list` result, so a tier reads it whenever escalation is on and a request is open. The rubric's
five rules hold for both lists.

*2026-11-16 (#108): the rubric is now at the end of every `prompt_list` result that lists a request, and nowhere
else; a tier's briefing no longer carries it (ADR 0004, Generic judgment). "The rubric a tier is briefed with", below,
now means the rubric `prompt_list` delivers.*

| A tier handles, after the check named | A tier surfaces to the person (`prompt_escalate`) |
|---|---|
| A rerun of a CI run, once the tier has looked the run up and its head branch is the lane's pull request branch | Any workspace-lock clear, forced turn give or owner transfer |
| A delete whose every path argument lies inside the lane's own clone: the `/tmp` path its brief or report names | A delete with a path outside the lane's own clone, or whose paths the tier cannot list |
| A label or project write the lane's work clearly needs, a label delete excepted | A workflow dispatch |
| | A cancel of a run the lane did not start (the tier looks up the run's actor and branch) |
| | A label delete |
| | An ask with no reason shown, with a reason that is not the guard's own (an ask rule hides it), or with a cut reason, unless the tool and method are plainly a case the tier handles |
| | Anything else whose reason warns of a deploy, a dispatch or secrets, or says the person must approve |

- **The left column wins.** ai-toolkit's GitHub guard puts a redeploy warning on every rerun, so a rule that sent
  every deploy warning up would send every rerun up: the case that started this. A rerun is handled with that
  warning standing, once the tier has checked the run's branch itself.
- **Checked by the tier, not read from the reason.** A guard's reason may quote the lane's own input (a repo, a
  ref, a path), so it proves nothing about the call. The tier goes by the tool, its method and its input, and looks
  up what the input does not show (a run's branch and actor) with read tools.
- **Any other guard or hook ask** is allowed only when plainly routine.
- **A setting's, a plugin's or a ceiling's ask is surfaced.** None has been seen live, and none has a routine case.
- **A lock clear stays the person's.** ai-toolkit's rule is that a lock clear needs the person's own live turn; the
  guidance keeps it by sending every workspace-lock ask up.
- **Surfaced means relayed.** A tier that is not the top passes the request up; the top live tier asks the person
  in its own session, and the mod reads their click.
- **This is guidance, not a check.** Nothing in the mod stops a tier that allows an ask on the right-hand list.
  What stands behind it: the rubric a tier is briefed with, the ledger row of every answer, and the audit's count of
  the tiers' allows of such asks. A hook that must never be answered by an agent should deny: a deny is decided
  before any prompt exists.

### The plan-mode exit

`ExitPlanMode` is a request like any other. ADR 0004 kept it as the one call no agent answers; that rule is lifted.
The tier reads the lane's plan in the request. The rubric's line: allow it only when the plan is the work the lane
was given and nothing in it is on the risk list, and surface it otherwise. The hook's early return, the apply check,
`prompt_answer`'s refusal and the audit's rule against a request for it are removed.

### The hook's reason

The request carries the reason `tool.check` gives for the ask (a hook's or a rule's text), redacted and capped at
1 KB. A longer reason keeps its head and its last 200 bytes, since a guard may put its warning after fields the lane
sets, and `prompt_list` marks it cut outside the frame. `prompt_list` shows it in its own frame, marked as that script's text: data, not instructions. It tells the
tier what the guard saw; it decides nothing.

### The audit

- A `requested` row whose `raised` is not a known source is an anomaly.
- The count of the tiers' allows of hook-, setting-, plugin- and ceiling-raised asks includes their answers to a
  question behind one. It is a note, not an anomaly: the audit cannot tell a routine allow from one the guidance
  sends up.

Nothing else moves:

- **The rubric's five rules are the same, for every tier.** A tier allows only what it knows the reason for, that reads or stays
  inside the lane's own branch and repo or is easily undone, that cannot return personal data or secrets, that
  touches nothing on the risk list, and that it has seen whole. Otherwise it passes the request up.
- **Risk-list calls still go to the person.** No tier allows one. The top live tier relays it, and the person's
  click decides.
- **`GO_NEVER`, the strictest-tier rules, the 30-second head start, the windows, the comment cap and the truncation
  rule are unchanged.**
- **Callboard's `tool.check` still only observes.** A deny rule or a hook's deny stands; no prompt exists for it.

### What cannot rise

No rule of the mod keeps a prompt for the person now. These cases still leave no request, each for a mechanical
reason, and the lane's dialog stays open. What tells anyone of the wait is the check-in on a waiting prompt
(ADR 0002, "lead check-ins"), which a separate change makes reach a busy lead and the manager, with a toast for the
person; this decision does not depend on it and adds no notice of its own.

| Case | Ledger row | Why it cannot rise | What covers it |
|---|---|---|---|
| No usable `tool.check` entry: none, two calls in flight on one hash, or too old. A prompt that is not an ask in `tool.check` has none either. | `not-judgeable no-check` | Without it there is no tool-use id: the hook could not see the person's click, and a late answer could land on another call. The classifier refuses a non-ask too (`not-ask`), as a second check. | The check-in and the toast |
| A subagent's ask | `subagent-denied`, or none | The engine shows its dialog only after the hooks return; a wait would hide it. | With a tier in reach it is denied with a message; else the check-in and the toast |
| The request file or its ledger row cannot be written | `abandoned hook-failed` | Without the file no tier can read the request, and without the row no decision could pass the ledger check. | The check-in and the toast |
| No live tier in reach (since 2026-11-17: for 30 minutes, see the note below) | `abandoned no-tier` | There is nobody to ask. | The toast |
| Nobody can be asked, or a host answers (the approver is not the person) | none | The prompt is not one a person clicks in the lane's panel. | Nothing is waiting on the person |
| A question of a shape with no answer form: several questions, multi-select, a `Person` header | `not-judgeable question-…`, then `question-denied question-…` when it is ended | The relay carries one single-choice question with the lane's own labels; `Person` is the lane's own mark. | With a tier in reach it is ended with a message, a `Person` header excepted; else the check-in and the toast |

Two cases are the person's own switch, not a limit:

- **The escalation switch does not cover the session**: no row. The person turned answering off for it.
- **A question outside the questions scope**: `not-judgeable question-scope`. The person has not turned question
  answering on for that lane.

A subagent's ask and a question with no answer form could instead be denied with a message that tells the lane how
to ask again in a form that rises. That is not built here.

*2026-11-16: built. Both denials happen only while the switch covers the session and a live tier is in reach, so
that the call or question, asked again, can rise; with none in reach nothing changes. Each is a fixed text with
nothing of the lane's in it, is no decision on the call or the question, never allows anything, and writes a row
of its own kind before it lands (no row, no denial).*

- *A subagent's ask is denied at once, after the chain beneath: the message tells the main session to run the call
  itself. Its dialog never opens, so the person does not see that prompt; they see the main session's. The row is
  `subagent-denied`.*
- *A question of several parts, multi-select, or with fewer than two or more than four usable options is ended
  after the person's first 30 seconds of awake time with the card open: the message tells the lane to ask again as
  one single-choice question with two to four short options. A click, the switch going off or a failed pause in
  those 30 seconds leaves it the person's. Its `not-judgeable` row is written first, as for any such question;
  the denial adds a `question-denied` row with the shape's code. A call with any question headed `Person` is
  never denied, whatever its shape: the header is the lane's mark that the question is the person's.*
- *Limit: a subagent's ask has no `tool.check` entry, so the hook cannot tell one a host would answer from one
  the person would click. Both are denied.*
- *A subagent's question (`AskUserQuestion`) is never denied.*
- *The escalation dialog's two sentences on these cases are reworded to say so (ADR 0004, "A subagent's ask is the
  person's", now holds only with no tier in reach).*

*2026-11-17: no live tier in reach now holds rather than ends at once. The person's words: an ask that found no tier
(a tier compacting) rises once one is back. The hook writes `no-tier` and keeps the dialog open for up to 30 minutes
of awake time, reading the reach again every 30 seconds (the lane's lead included). Once a tier is in reach, the ask
rises as a request from that moment: its windows, its 30-second head start, its 20-minute deny and its expiry run
from the rise. A click, the switch going off or failed pauses during the hold leave the dialog the person's, as does
no tier within the 30 minutes; each writes `abandoned no-tier`. A question with no answer form holds the same way and,
once a tier is in reach, is ended with its message; the hold counts as the person's first 30 seconds. A switch
scoped to one lead (an older stored value: `/callboard escalation` writes `all`) covers a lane only while that lead is
found, so with the lead away the ask stays the person's, with no hold, as before. Inside an unattended window a
lead's own prompt with no tier is still denied at once (ADR 0008), with no hold.*

A truncated copy is a request, as before: a tier may deny it and never allow or relay it (ADR 0004, Limits), so it
ends in the 20-minute deny.

## Consequences

- **Easier:** a guard's ask no longer stalls a lane. A routine one (a rerun of failed jobs on the lane's own PR) is
  answered by the lead; any other reaches the person through the relay, in the session they are in.
- **Harder:** a hook, a setting, a plugin or a ceiling that asks is no longer a wall in front of agents. Its ask is
  one more request under the rubric.
- **Such a prompt can now end in the 20-minute deny.** Before, it waited for the person with no limit. As a request
  it follows the request's rules: with a live tier that neither answers nor relays it, it is denied with a message
  after 20 minutes, and the lane may ask again.
- **Sessions on the earlier code do not see these requests.** A tier whose mod was loaded before this change reads
  only the three earlier `raised by` values and skips a request with a new one, so the request ends in that deny.
  Tier sessions need a reload after the checkout moves.
- **An ask a tier surfaces waits for the person only while a tier relays it.** With a live top tier that passes it
  up, the person is asked in that tier's session. With tiers that do nothing, it ends in the 20-minute deny.

### What this widens: plainly

- **A tier can let a lane leave plan mode.** Plan mode is the person's way to read a plan before work starts; a
  tier that allows the exit stands in for that reading.
- **A tier can allow what a guard was written to put in front of the person.** That includes a workspace-lock
  clear, a delete, a workflow dispatch and a ceiling's ask. The rubric tells the tier to surface those; a tier that
  misreads it, or is talked round by a lane's input, allows one, and the person learns of it from the ledger.
- **A forged decision file now buys hook-, setting-, plugin- and ceiling-raised calls too.** ADR 0004 already said
  a forged file buys everything above the floor. The same guards remain: the input hash, expiry and nonce, a live
  tier in reach, the 30 seconds with the dialog open, the ledger and the audit. The audit prints a count of the
  tiers' allows of such asks, by what raised them.
- **`setting`, `plugin` and `ceiling` have never been seen filled live** (ADR 0004, Probes). They are classified by
  the same rule and are untested against a live engine.
- **The tier reads another script's text.** The hook's reason is shown framed as data, with `<` and line breaks
  escaped, so it cannot close its frame or pose as the mod's text. It can still mislead a tier that trusts it; the
  rubric says it is data.

### Changes to earlier decisions

- **ADR 0004, "What agents may judge":** replaced by this decision. The named guard keeps its own `raised by` value
  and nothing else; its tool list no longer decides who may judge.
- **ADR 0004, "One rule stays in the mod: a dialog of another kind is never answered":** lifted. The `dialog`
  ledger kind is no longer written; the audit still reads one from an older ledger.
- **ADR 0004, "The floor", 2026-11-12 note** ("a prompt that stays the person's still leaves only a ledger row; a
  notice to the lane's lead for those is not built"): the cases above still leave only a row.

## Not verified live

The classifier and the hook are tested against the mock engine only. A hook-raised ask reaching a tier, a tier's
allow landing on it, and one relayed to the person have not been run on a live engine. Nor has a hook's allow of
a plan-mode exit: whether the engine takes it is unknown. Whether a tier follows the
guidance is not tested at all: the tests pin its text, not a model's reading of it. An ask rule hides a hook's
reason (ADR 0004's probe), so a tier may see `raised by: hook` with a rule's text in the reason frame, or none.
