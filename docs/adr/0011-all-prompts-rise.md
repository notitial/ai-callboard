# 11. Every lane prompt rises up the chain

**Status:** proposed
**Date:** 2026-11-16

Scope: which asks of a lane's or a lead's call become a request for the answering tiers. It amends
[ADR 0004](0004-prompt-answering.md), "What agents may judge". It changes who may answer a permission prompt, so it
is on the risk list. The rubric's five rules, the tiers, the windows and the relay are unchanged; the rubric gains a
paragraph on what raised an ask and a list of what a tier handles and what it surfaces of a guard's or hook's ask,
and the audit gains one rule and a count.

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
   person. The person's decision: the tiers judge them all, with instructions good enough that they know what to
   surface and what they can handle.

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

| A tier handles | A tier surfaces to the person (`prompt_escalate`) |
|---|---|
| A rerun of a CI run on the lane's own pull request | Any workspace-lock clear, forced turn give or owner transfer |
| A delete inside the lane's own clone under `/tmp`, or of its own scratch files | A bulk or destructive delete outside the lane's own clone |
| A label or project write the lane's work clearly needs | A workflow dispatch on any ref, or one that uses repo secrets; a cancel of a run the lane did not start |
| | A label delete |
| | Any ask raised by a ceiling |
| | Anything whose reason warns of a deploy, a dispatch or secrets |

- **The default.** When the hook's reason says the person must approve, the tier surfaces the ask, unless it is
  plainly one of the cases it handles. Any other guard or hook ask is allowed only when plainly routine.
- **A lock clear stays the person's.** ai-toolkit's rule is that a lock clear needs the person's own live turn; the
  guidance keeps it by sending every workspace-lock ask up.
- **Surfaced means relayed.** A tier that is not the top passes the request up; the top live tier asks the person
  in its own session, and the mod reads their click.
- **This is guidance, not a check.** Nothing in the mod stops a tier that allows an ask on the right-hand list.
  What stands behind it: the rubric a tier is briefed with, the ledger row of every answer, and the audit's count of
  the tiers' allows of such asks. A hook that must never be answered by an agent should deny: a deny is decided
  before any prompt exists.

### The hook's reason

The request carries the reason `tool.check` gives for the ask (a hook's or a rule's text), redacted and capped at
1 KB. `prompt_list` shows it in its own frame, marked as that script's text: data, not instructions. It tells the
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

### What still stays with the person alone

These leave no request, as before, and the lane's dialog stays open. What tells anyone of the wait is the
check-in on a waiting prompt (ADR 0002, "lead check-ins"), which a separate change makes reach a busy lead, the
manager and the person; this decision does not depend on it and adds no notice of its own.

| Case | Ledger row | Why no tier is asked |
|---|---|---|
| The prompt is not an ask in `tool.check` | `not-judgeable no-check` | The mod keeps a `tool.check` entry only for an ask, so such a prompt has none. It does not know why the prompt exists. The classifier refuses a non-ask too (`not-ask`), as a second check. |
| No usable `tool.check` entry (missing, two calls in flight on one hash, or too old) | `not-judgeable no-check` | Without it there is no tool-use id: the hook could not see the person's click, and a late answer could land on another call. |
| Nobody can be asked, or a host answers (the approver is not the person) | none | The prompt is not one a person clicks in the lane's panel. |
| The escalation switch does not cover the session | none | The person turned answering off for it. |
| A dialog of another kind (`ExitPlanMode`) | `dialog` | ADR 0004: it has no judge. |
| A question outside the questions scope, or not of the answerable shape (several questions, multi-select, a `Person` header) | `not-judgeable question-…` | The relay carries one single-choice question with the lane's own labels; the others have no relay form, and `Person` is the lane's own mark. |
| A subagent's ask | none | The engine shows its dialog only after the hooks return; a wait would hide it. |
| No live tier in reach | `abandoned no-tier` | There is nobody to ask. |

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
- **ADR 0004, "The floor", 2026-11-12 note** ("a prompt that stays the person's still leaves only a ledger row; a
  notice to the lane's lead for those is not built"): the cases above still leave only a row.

## Not verified live

The classifier and the hook are tested against the mock engine only. A hook-raised ask reaching a tier, a tier's
allow landing on it, and one relayed to the person have not been run on a live engine. Whether a tier follows the
guidance is not tested at all: the tests pin its text, not a model's reading of it. An ask rule hides a hook's
reason (ADR 0004's probe), so a tier may see `raised by: hook` with a rule's text in the reason frame, or none.
