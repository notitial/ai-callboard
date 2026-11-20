---
name: ask-review
description: "MANAGER's regular look at the ask log for repeated read-only asks, ending in options for the person: a path-pinned allow with the script's hash, a standing line in their manager-rules file, or nothing. Read-only: it allows nothing and edits no settings or rules. Run by the manager about once a week, or when the person types /ask-review."
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
   comes from your record of scripts (below): an entry with a high `allowed` count, or what the asker's lead says its
   repeated checks are (`SendMessage` to the lead, one question).
3. **Judge each candidate** by rubric rules 1 to 5: it only reads, returns no personal data or secrets, touches
   nothing on the risk list, and its script was read whole (a recorded hash that `shasum -a 256 <path>` still matches
   shows it is unchanged, nothing more). Anything else is not offered.
4. **Bring the person options,** one AskUserQuestion, at most 4 questions, a named default first (default: change
   nothing), each option naming what it changes:
   - a path-pinned `allow` for that script in the repo's settings, with its sha256, and an `ask` on edits of the
     scripts folder so it cannot change unseen (a lead's PR, approved by the person);
   - a standing line in the person's own manager-rules file: allow an ask that only runs `<path>` at sha256 `<hash>`;
   - leave it as it is.
5. **Record it** in STATE.md under Put to the person (date, what was offered, their answer), so it is not asked again.

## Record of scripts

`.archive/manager/script-hashes.md`, plain ASCII, one line per script you read whole and judged read-only:
`<path> <sha256> <date> <what it does> allowed:<n>`. Check it as State files are checked (a symlink or a file over 16 KB
is not Read). It is history and never a grant: a matching hash only spares the re-read, and every ask still
meets the rubric. A script whose hash no longer matches is a new script: read it whole again.
