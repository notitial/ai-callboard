# 11. Every lane prompt rises up the chain

**Status:** proposed
**Date:** 2026-11-16

Scope: which asks of a lane's or a lead's call become a request for the answering tiers. It amends
[ADR 0004](0004-prompt-answering.md), "What agents may judge". It changes who may answer a permission prompt, so it
is on the risk list. The rubric, the tiers, the windows, the relay and the audit are unchanged.

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
3. **Every ask is judged by the rubric: chosen.** One rule for all asks. The person chose it with the go for this
   work: such prompts "become requests that the lead, conductor and manager judge by the same rubric, and the top
   live tier relays them to the person".

## Decision

**Every ask of a lane's or a lead's call becomes a request, whatever raised it.** The classifier no longer decides
who may judge. It records what raised the ask (`ceiling`, `setting`, `plugin`, `hook`, the named `guard`, `rule` or
`mode`; the widest source when several stand behind one ask), the request file carries it, and `prompt_list` shows
it to the tier as `raised by`. A question behind a rule, hook, setting, plugin or ceiling is classified the same
way; the questions scope and the question shape still apply to it.

Nothing else moves:

- **The rubric is the same, for every tier.** A tier allows only what it knows the reason for, that reads or stays
  inside the lane's own branch and repo or is easily undone, that cannot return personal data or secrets, that
  touches nothing on the risk list, and that it has seen whole. Otherwise it passes the request up.
- **Risk-list calls still go to the person.** No tier allows one. The top live tier relays it, and the person's
  click decides.
- **`GO_NEVER`, the strictest-tier rules, the 30-second head start, the windows, the comment cap, the truncation
  rule and the audit are unchanged.**
- **Callboard's `tool.check` still only observes.** A deny rule or a hook's deny stands; no prompt exists for it.

### What still stays with the person alone

These leave no request, as before. Each keeps the lane's dialog open, and the waiting-prompt alert (ADR 0002,
amended 2026-11-16) tells the lead, then the manager, and the person in a toast.

| Case | Ledger row | Why no tier is asked |
|---|---|---|
| The prompt is not an ask in `tool.check` | `not-judgeable not-ask` | The mod does not know why the prompt exists, so a tier would judge a call the engine described differently. |
| No usable `tool.check` entry (missing, two calls in flight on one hash, or too old) | `not-judgeable no-check` | Without it there is no tool-use id: the hook could not see the person's click, and a late answer could land on another call. |
| A dialog of another kind (`ExitPlanMode`) | `dialog` | ADR 0004: it has no judge. |
| A question outside the questions scope, or not of the answerable shape (several questions, multi-select, a `Person` header) | `not-judgeable question-…` | The relay carries one single-choice question with the lane's own labels; the others have no relay form, and `Person` is the lane's own mark. |
| A subagent's ask | none | The engine shows its dialog only after the hooks return; a wait would hide it. |
| No live tier in reach | `abandoned no-tier` | There is nobody to ask. |
| A truncated copy | a request, as before | A tier may deny it and never allow or relay it (ADR 0004, Limits). It ends in the 20-minute deny. |

## Consequences

- **Easier:** a guard's ask no longer stalls a lane. A routine one (a rerun of failed jobs on the lane's own PR) is
  answered by the lead; any other reaches the person through the relay, in the session they are in.
- **Harder:** a hook, a setting, a plugin or a ceiling that asks is no longer a wall in front of agents. Its ask is
  one more request under the rubric.

### What this widens: plainly

- **A tier can allow what a guard was written to put in front of the person.** The rubric is the only check. A
  guard whose ask must never be answered by an agent has to deny, not ask.
- **A forged decision file now buys hook-, setting-, plugin- and ceiling-raised calls too.** ADR 0004 already said
  a forged file buys everything above the floor; this removes the last class it did not reach. The same guards
  remain: the input hash, expiry and nonce, a live tier in reach, the 30 seconds with the dialog open, the ledger
  and the audit.
- **`setting`, `plugin` and `ceiling` have never been seen filled live** (ADR 0004, Probes). They are classified by
  the same rule and are untested against a live engine.
- **The tier does not see the hook's reason.** `tool.check` gives one, but it is another hook's text and the request
  does not carry it. The tier judges the call itself, as it does for a rule's ask.

### Changes to earlier decisions

- **ADR 0004, "What agents may judge":** replaced by this decision. The named guard keeps its own `raised by` value
  and nothing else; its tool list no longer decides who may judge.
- **ADR 0004, "The floor", 2026-11-12 note** ("a prompt that stays the person's still leaves only a ledger row; a
  notice to the lane's lead for those is not built"): the cases above still leave only a row, and the
  waiting-prompt alert is that notice.

## Not verified live

The classifier and the hook are tested against the mock engine only. A hook-raised ask reaching a tier, and a
tier's allow landing on it, have not been run on a live engine.
