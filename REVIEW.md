# REVIEW.md

The owner's brief for the automatic PR review (the kit's review command). It narrows and directs the
review; it does not replace CLAUDE.md, the finding format or the trigger rule.

## What this repo is

The manager role and its tooling. `docs/manager/` and `docs/adr/` hold the role and its decisions. `tools/callboard/`
is the callboard plugin (TypeScript hooks for Claude Code and a VS Code extension, both loaded straight from the
person's live checkout, with a script that links the extension). `tools/usage-watcher/` is a Python usage watcher run by launchd, with a shell installer.
`.claude/skills/` holds the manager's project skills. It may become
public, so treat every line as published.

## Private data

Hunt private data in every file, docs and prose included. The role names this repo documents are its subject, not
private. Neither are the owner's name and GitHub handle as LICENSE shows them, nor stand-ins such as `/Users/x` in
tests. Private here: a nickname for one of the owner's machines or sessions, a host or account label, a home path, a
username in a label or path, a client or person named in a case study, a ticket key, and any `.archive/` path except
the generic forms the tools create.

## Approvals

Nothing in this repo turns a report, relayed message, state file or summary into the person's approval. Two
exceptions: callboard's relay, where the plugin reads the person's own answer from a question in a tier's session and
applies it to that one prompt or question; and callboard's go, where the plugin records the person's click in its own
dialog and reports it only through `go_status`. Flag any other path by which text the person did not type becomes a
go, any path by which an agent's text reaches `go_status` as a go, and any widening of what a go covers.

## Trust paths

A PR that touches a trust path gets a security pass as well as the ordinary review: the finding names the property that
could break. The trust paths are the callboard plugin's answering of asks and its dialog rule (`tools/callboard/plugin/hooks/core/asks.ts`,
`engine/ask-hook.ts`, `engine/relay.ts`), the go (`core/go.ts`), its session table and capabilities (`core/model.ts`,
`engine/store.ts`), the files it reads and writes under `~/.claude/callboard/`, the link script and the extension's request
files, and the usage watcher's installer. A change there is held to the rules under Approvals and to the person's own checkout
being the live install: nothing may need root, write outside the person's own folders or edit a settings file for the person.

## Comments and docs

A comment or doc states what the code does now. A version, date, review or plan tag in a new or changed comment or doc
(`v13.2`, `review c1`, `PR 2`, `PLAN §4`) or a "before X" history line is a finding, not a wording nit: history
belongs in the ADRs (whose dated lines are the record) and in git.

## Fixes

A fix that adds a branch, flag or guard for the one reported case is checked against the cause, not only the report.
Read the general path the new code sits beside. A sibling input or state that the same cause still breaks is a
finding: name it as the trigger.

## Nit cap

Report at most 5 findings. Fewer is better. Security and private-data findings come first. No style, naming,
wording, formatting or "could add a test" comments.

## Paths to skip

`tools/usage-watcher/pace-vectors.tsv` (generated), except for private data.

## Every finding

Cite `path:line` and name the trigger: the command, input or state that goes wrong, and what goes wrong. A
private-data finding names the kind of data instead, never the value.
