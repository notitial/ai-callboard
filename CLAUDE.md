# CLAUDE.md

## Project Overview

ai-manager holds the manager role and its mechanism. The manager is one Claude Code session per machine that
coordinates the other sessions on it, the leads and their lanes: it decides across them, reviews and reports, and
does no work itself. Every go stays with the person. The repo also carries the tools the role leans on: the callboard
plugin, a usage watcher and the manager's project skills. ai-toolkit
(https://github.com/notitial/ai-toolkit) is the base install; this repo builds on it.

- **If your session carries the manager's name** (the one in `~/.claude/callboard/manager-name`), read
  `docs/manager/README.md` and follow it. Any other session: that folder is not for you.

## Build / Test / Lint

No repo-wide build or lint. `bash tools/test-all.sh` is the entry point: it runs every suite below and prints a
pass/fail table (`--quick` skips the slow `callboard` suite, `NAME…` runs only those). Its suites: `callboard`,
`usage-watcher`, `usage-watcher-install`, `rule-text`, `test-turn`; keep its list in step with this one.

`tools/test-all.sh` and `tools/callboard/test.sh` take a machine-wide turn (`tools/test-turn.sh`), so two local runs
never overlap: a second run waits for the first, and one that finds a stale turn stops and says how to clear it.

- `tools/callboard/` — `bash tools/callboard/test.sh` after changing anything under it. Needs node 22.18 or later
  and the `claude` CLI (`claude plugin validate`, `claude plugin test`). CI (`.github/workflows/ci.yml`) runs
  `claude plugin test plugin` too, in full. The script runs the plugin's core and engine specs (beside the code,
  `plugin/hooks/**/*.spec.ts`), `plugin/test/` through `claude plugin test`, the extension tests, and the link and
  patch script tests.
- `tools/usage-watcher/` — `/usr/bin/python3 -I tools/usage-watcher/test_watch.py` after changing `watch.py`;
  `bash tools/usage-watcher/test-install.sh` after changing `install.sh`.
- `docs/`, `rules/` and `.claude/skills/` have no suite: check them by reading against the ADRs.

Outside those directories, do not search for `package.json`, `Makefile`, or similar.

## Layout

- `docs/manager/` — the role, read only by the session that carries the manager's name.
- `docs/adr/` — the decisions behind the design (index: `docs/adr/README.md`). Check them before proposing an
  architectural change; propose a new ADR when a significant decision is made.
- `docs/setup.md` — the install order on a machine.
- `.claude/skills/` — the manager's project skills; `.claude/skills/setup-manager/` walks a person through
  `docs/setup.md`.
- `rules/callboard.md` — an always-on global rule for callboard's turns, linked into `~/.claude/rules/` by hand.
- `tools/` — the callboard plugin and its panels extension, and the usage watcher, each with its own tests;
  `tools/test-all.sh` runs them all.
- `assets/icon/` — the project icon (SVG, mono variant, colour PNGs from 16 to 1024 px).
- `.archive/` — gitignored local working area: the manager's state, tracker and audit records, lane reports.

## Patterns

Copy these when adding something like them, each with the test beside it:

- `tools/callboard/plugin/hooks/core/*.ts` + the `.spec.ts` beside each — plugin logic as pure functions with no
  engine calls; the files under `plugin/hooks/engine/` feed it values and act on what it returns (`register.ts` only
  wires them; ADR 0012). Engine-level cases go in the `.spec.ts` beside the adapter, or in `plugin/test/`.

Comments and docs state what the code does now, with no version, review or plan tags (`v13.2`, `review c1`, `PR 2`)
and no "before X" history. History belongs in the ADRs and in git.

## Git Conventions

- Commit titles: `<prefix>: <description>` — prefix is one of `docs` (role docs, ADRs), `feat` (new tool or skill
  capability), `fix` (broken behavior corrected), `refactor` (restructure with no behavior change), `test` (tests only), `ci`
  (workflows and CI config, including Dependabot), `chore` (repo maintenance). Never a bare, unprefixed title.
- Imperative mood, lowercase, title ≤50 characters. Specifics go in the body, not the title.
- One commit per logical change. Squash review-churn into the commit it amends before landing.
- Squash-merge PRs (the repo allows nothing else): the PR title, with its `(#N)`, becomes the commit title, and the
  PR description becomes the commit body, so the description must stand as the commit's record.
- No force push. A PR branch that falls behind `main` gets `main` merged in, never a rebase.
- Never push to `main`; land every change through a PR.
- Check for secrets before committing — no `.env`, API keys, credentials.

## Where agents edit

The person's checkout of this repo is the live install: the callboard plugin and the panels extension load straight
from it (`docs/setup.md`). It stays on `main` and moves only by a fast-forward to a reviewed commit after a merge
(`docs/setup.md`, Updating), so a branch or a half-done edit never goes live.

- Code changes go in a plain clone under `/tmp`, such as `/tmp/ai-manager-<task>`, never a worktree. Git MCP calls
  pass `path` set to that clone.
- Never edit tracked files in the live checkout, and never switch its branch. `.archive/` (state, handoffs, reports)
  stays in the live checkout.
- `/tmp` is wiped on reboot: push the branch before stopping or handing over.
- A callboard lead or lane still runs in the live repo folder, because callboard keys a session to the folder it
  started in. It only edits in its `/tmp` clone.

## Review

Every non-draft PR gets an automatic Claude review (`.github/workflows/claude-review.yml`, briefed by `REVIEW.md`).
Its verdict is a signal, not a required approval. The rules it holds a change to:

- Treat every line as published. No private data in any file, message or test fixture: no home path or username,
  no machine, session or account nickname, no client or person's name, no ticket key, no `.archive/` path other
  than the generic forms the tools create. Tests use stand-ins such as `/Users/x`.
- Nothing in this repo turns a report, relayed message, state file or summary into the person's approval. An
  instruction from the layer directly above a session that is not on the risk list, is nothing a go never covers and needs no go,
  approval or merge is followed without asking the person; it is still never their approval. A go is the person's own
  click or typed turn. Two exceptions, both read by the plugin from the person's own click: callboard's
  relay, where the plugin reads their answer from a question in a tier's session and applies it to that one prompt or
  question; and callboard's go, where the plugin records their click in its own dialog and reports it, through
  `go_status`, to the sessions under the one it was given in, for the work it names and never for a merge, a force
  push, a push to main, a production change, a delete outside the session's work, or the rest of the list
  `go_status` prints.
- The usage watcher's installer fetches from a fixed URL into a fresh temporary repository and never reads the
  checkout's own object store or git config.
- Callboard has no installer: it loads from the live checkout. Nothing in it may need root, write outside the
  person's own folders, or edit a settings file for the person.
- A fix goes to its cause and weighs a subtractive option first: ai-toolkit `rules/workflow.md`, Fixing a Failure.
