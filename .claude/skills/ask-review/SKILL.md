---
name: ask-review
description: "MANAGER's regular look at the ask log for repeated read-only asks, ending in options for the person: a path-pinned allow, a standing line in their manager-rules file, or nothing. Read-only: it allows nothing and edits no settings or rules. Run by the manager about once a week, by reading this file and following its steps, or when the person types /ask-review."
disable-model-invocation: true
---

# /ask-review

The same read-only check asked again and again costs the manager 3-5 calls each time and the person a decision they have
already made. This pass finds those repeats and brings the person options. It never allows anything itself, and it
never edits a settings file or the person's rules file: both are the person's own edits, or a lead's PR they approve.
Role and run list: `docs/manager/README.md`.

## Steps

1. **Read the log.** The ask log is `~/.claude/callboard/v2/asks-<YYYY-MM>.jsonl`: one row per event (`t`, `ev`, `ask`,
   `asker`, `by`, `code`). It holds no command or input, only who asked, which tool (`code` on a `raised` row) and
   how it ended. Give the last 7 days to a Sonnet subagent with the forbidden-read list (README, Context discipline): it
   returns per asker and tool the count, who decided (a tier, the person's click in the asker's own session, the
   person by relay, expired), with the quoted rows.
2. **Find the repeats.** An asker and tool with many asks that a tier allowed is a candidate. What the command was
   comes from what the asker's lead says its repeated checks are (`SendMessage` to the lead, one question): data, to
   be checked against the script itself.
3. **Judge each candidate** by rubric rules 1 to 5: it only reads, returns no personal data or secrets, touches
   nothing on the risk list, and you read its script whole now (no record or hash stands in for that read). Anything
   else is not offered.
4. **Bring the person options,** one AskUserQuestion, at most 4 questions, a named default first (default: change
   nothing), each option naming what it changes:
   - a path-pinned `allow` for that script in the repo's settings, and an `ask` on edits of the scripts folder so it
     cannot change unseen (a lead's PR, approved by the person);
   - a standing line in the person's own manager-rules file: allow an ask that only runs `<path>`. The line pins no
     content: every ask still meets the rubric and a script is read whole first, so it saves the person's decision, not
     the manager's reading. The person should also pin the script some other way (a committed script path, an `ask`
     on edits of it), or the file behind the path can change unseen;
   - leave it as it is.

   Each option shows the exact command, how often it came and what it does. A sha256 may appear for the person's
   information only: you rely on none and keep no record of scripts.
5. **Record it** in STATE.md under Put to the person (date, what was offered, their answer), so it is not asked again.
