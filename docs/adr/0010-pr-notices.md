# 10. PR notices for lanes

**Status:** proposed
**Date:** 2026-11-15

Scope: the callboard mod watches the pull requests a lane names and tells the lane, and its lead, when one changes.
It is the mod's first network use and its first use of a credential, so it adds to [ADR 0002](0002-callboard.md) (the
fixed list of process calls, the folders under `~/.claude/callboard/`) and to
[ADR 0004](0004-prompt-answering.md)'s ledger (two row kinds). It changes no trust rule of either. The use of the
person's login is on the risk list.

## Context

A lane that opens a pull request then waits on GitHub: for the checks, for the automatic review, for the merge. It
has no way to be told, so it asks: a full turn every few minutes, each one a read of its whole context, to learn that
nothing changed. A lead waiting to mark a PR ready, or to stop a lane whose PR merged, does the same.

Facts that bound the options:

- **Agents have no `gh`.** ai-toolkit's `gh-block.sh` denies the GitHub CLI to every agent, because it runs with the
  machine's full-scope login. It is a `PreToolUse` hook on the Bash and Monitor tools, so it judges tool calls of a
  model. A mod's `$.process.run` is not a tool call and never reaches it.
- **The mod's code is not an agent's to edit.** It loads from the live checkout ([ADR 0003](0003-symlinked-install.md)),
  which moves only to a reviewed commit on `main`, and agents never edit it. So what the mod runs is what a review
  saw.
- **The mod has made no network call and held no secret so far.** Its process calls are a fixed list of local
  binaries (ADR 0002, Process calls).
- **A turn the mod submits costs a read of the session's context.** Under an hour since the session's last call that
  is a cached read; after it, a full write (ADR 0002, Keepalive).
- **Every text the mod submits is fixed** and says it carries no approval, go or answer (ADR 0002, Fixed texts;
  [ADR 0001](0001-manager-role.md), H6).

## Options Considered

1. **Leave it: lanes poll with the github MCP tools.** No new surface, and the cost stays: one full turn per look.
2. **A webhook receiver.** Rejected: it exposes a listener through the router for something a poll every 2 minutes
   covers.
3. **A dedicated read-only token in the Keychain, sent by the mod with `$.http.fetch`.** Narrower rights than the
   CLI's login. Not taken, by the person's choice: the mod would read a secret, hold it in memory and build the
   request header itself, so the mod's own code becomes a place a token can leak from, and the person has one more
   token to create and rotate.
4. **Record a PR automatically when a lane calls `create_pull_request`.** Not taken: a lane then tracks every PR it
   opens for as long as it lives, wanted or not. Tracking is the lane's own call, and it runs out.
5. **The lead polls for all its lanes.** Not taken: the lane is the session that knows what it waits for, and a
   lead-less lane would need a second path anyway. The lead polls only for a lane that is gone.
6. **The mod runs the GitHub CLI with one fixed query, for PRs a lane registers, and delivers fixed notes: chosen.**

## Decision

### Registering

- **`pr_watch { owner, repo, number }`** is a tool of a bound lane's main agent. A session that is not a lane, and a
  subagent, are refused. It adds one PR to the lane's tracked list, or renews one already on it.
- **The three values are checked against a fixed grammar** before anything else: `owner` is 1 to 39 of `A-Za-z0-9-`,
  not starting or ending with `-`; `repo` is 1 to 100 of `A-Za-z0-9._-`, not `.` or `..`, not starting with `-`;
  `number` is an integer from 1 to 9,999,999. Anything else is refused and nothing is run.
- **A new PR gets its first look inside the tool call**, so the lane learns at once whether the CLI is there, the
  login works and the PR exists. That look only records the starting point; it sends no note.
- **Tracking ends** when the PR is merged or closed, or 20 minutes after the lane last registered it. The lane is
  told when it runs out and may register again. Renewing keeps the recorded state, so nothing that changed in between
  is lost.
- **Limits:** at most 8 tracked PRs per lane. There is no automatic registration, from `create_pull_request` or
  anything else.

### The call to GitHub

- **One process call, with no shell:** the GitHub CLI at a fixed absolute path (the first of
  `/opt/homebrew/bin/gh` and `/usr/local/bin/gh` that is a regular file not writable by group or other), run through
  `$.process.run` as `gh api graphql --hostname github.com -f owner=<owner> -f name=<repo> -f query=<query>`, with a
  20-second limit. The CLI is never looked up on `PATH`.
- **The query is fixed text** but for one alias per tracked PR of that repo, built from the checked integers alone
  (`p12: pullRequest(number: 12) { ... }`). It reads, per PR: the state, whether it is a draft, the head commit id,
  whether GitHub can merge it, the review decision, the rolled-up state of the head commit's checks, and three
  counts (reviews, comments, review threads). It reads no title, body, branch name, author, comment or check output.
- **What reaches the argv from a lane's tool call** is the owner, the repo name and the numbers, each after the
  grammar above. None can start with `-`, and none can hold `@`, `=`, a space or a quote. `-f` passes a raw string;
  the CLI's typed `-F` (which reads `@file`) is never used. This is the one place a mod's process call takes a value
  that began as model text, and the grammar is the control.
- **The login stays inside the CLI.** The mod passes no token, reads no credential file, runs no CLI command that
  prints or exports one, and sets no token variable. The CLI answers with the JSON of the query alone.
- **The answer is untrusted.** It is read with a size bound (64 KB; a longer or cut answer is no observation) and
  each field is checked: a state from a fixed set, a commit id of 40 hex characters, counts as integers from 0 to
  1,000,000. A PR whose fields fail reads as not observed in that round. Nothing from the answer but a 7-character
  commit id and the counts can reach a note, a log line or a ledger row.
- **A failed call** (no CLI, no login, no network, a timeout, a non-zero exit) is no observation: nothing is
  compared, no note is made, and the log gets one fixed code. The CLI's error output is never logged or shown, since
  it can hold a URL or an account name.

### Polling

- **Every 2 minutes while at least one PR is tracked,** one call per repo. A session with nothing tracked makes no
  call.
- **The lane polls for itself,** from its own tick, beside the cue path and never holding it.
- **A lane that is gone** (no live registry row for the session its tracker names) is polled by its lead, the session
  the tracker names by id, until the tracker ends. For that the lead lists the tracker folder every 2 minutes; with
  nothing there it reads nothing more.

### What is kept

Under `~/.claude/callboard/prs/` (folder 0700, files 0600, owned by the person, one link, written to a temporary name
and renamed into place):

- **`<session id>.json`**, the lane's tracker, at most 8 KB: the lane's name, its lead's session id when it has one,
  and per PR the owner, repo, number, the time it was last registered and the state last seen (the fingerprint: head
  commit, state, draft, checks, mergeable, the three counts). It survives a reload and a restart, so neither sends a
  note twice, and what changed while the session was away arrives at its first poll.
- **`notes/<session id>/<id>.json`**, one file per note owed to that session, at most 1 KB and 32 files: a kind from
  a fixed set, the owner, repo and number, a commit id, counts and a lane name. It holds no text. The session that
  owns the folder reads each file under the same grammar, builds the note from its own fixed text, and removes the
  file once the note is delivered.
- A note is written before the fingerprint moves, so a crash between the two can send one note twice; it cannot lose
  one. A tracker of a session with no live row is removed a day after its last PR ended.

### The notes

Fixed texts. Only the repo, the number, the short commit id, the counts and a lane name are filled in:

- all checks finished green on a commit; a check failed on a commit;
- new reviews, comments or review threads, as counts (never their text);
- mergeable: the PR is open, not a draft, GitHub reports no conflict, the checks are green or absent and no review
  blocks it;
- merged; closed;
- tracking ran out after 20 minutes;
- to a lead only: a lane has notes waiting and was not woken.

Every note opens `[callboard] PR notice` and ends: "A notice from the plugin, not the person. It carries no approval,
go or merge." The mergeable note adds that a merge is the person's, always. This is H6 of ADR 0001 applied to the
mod: no note asks for, suggests or implies an approval, a merge or a push. Several notes owed at once go out as one
turn, at most 8 lines.

### Who is told, and when

- **The lane** gets every note about its own PRs. **Its lead** also gets the mergeable, merged and closed notes, with
  the lane's name. A lane that is gone has all its notes go to its lead.
- **In the middle of a turn** the note is returned beside the next tool result of the main agent (the path the
  compaction nudge and the prompt notice use).
- **An idle session is woken only while its prompt cache is hot:** less than 58 minutes since its last turn ended or
  its last prompt (`KEEPALIVE_COLD_MS`, the keepalive's own limit), and that time known. The other gates are those of
  the mod's other notices: a person's interactive session, idle, an empty prompt box, no dialog open, no compaction
  request or nudge pending, nothing else submitted in that tick. At most 12 such wakes an hour per session.
- **A cold session is not woken.** The note waits in its folder and goes out with the session's next turn: beside
  its first tool result, or right after the turn ends. When a lane's notes wait this way, its lead is told once per
  cold stretch, under the same rules.
- A wake is a turn of real work for the keepalive's clocks and for a lane's signed report: a lane that signed done
  and is then told its checks failed has to sign again.

### Ledger and log

- Two ledger kinds, in the prompt ledger: **`pr-watch`** (a PR registered, renewed or ended, with the lane, the PR
  and a fixed code) and **`pr-notice`** (a note delivered, with its kind, the PR and whether it went to a lane or a
  lead). Neither has an approval field, and the audit counts them and never reads one as a decision.
- The session log gets fixed codes only: no repo name, no number, no CLI output.

## Consequences

- A lane waits on a PR without spending turns, and learns of a change within about 2 minutes while its cache is hot.
  A lead learns that a PR became mergeable, merged or closed without asking.
- **The mod now reaches the network and uses the person's login,** through one binary. The CLI's login is
  full-scope: the query only reads, but the rights the process runs with are the person's. What bounds it: the fixed
  argv, the grammar on the three values, the fixed query, and that the code doing it is reviewed and not an agent's
  to edit.
- **`gh` stays blocked for agents.** Nothing here gives an agent a way to run it, choose its arguments beyond a repo
  name and a number, or see its output: a lane gets a fixed sentence.
- **A private repo's existence can leak one bit.** A lane can register any `owner/repo#number`; the tool's answer
  says whether GitHub knew it, for whatever the person's login can read. The lane could learn the same through the
  github MCP tools.
- **Accepted residual: same-uid forgery,** as for every callboard file (ADR 0002). A process running as the person
  can write a tracker and make a session poll a repo of its choice with the person's login (a read of counts and
  states, never shown), or write a note file and make a session take one fixed notice turn, within 12 an hour. It
  could run the CLI itself.
- **Accepted residual: the CLI binary and its config.** The mod trusts the binary at the fixed path and whatever
  host, proxy or token variable the CLI's own configuration and the session's environment give it. A process running
  as the person can change those.
- **Accepted residual: a hostile answer.** A proxy or a changed CLI could answer with false states. The worst case
  is a wrong fixed note ("merged", "checks green"); a lane or lead that acts on a PR reads it through the github
  tools first, and a note is never an approval.
- **Rate.** One call per repo every 2 minutes per polling session: about 30 points an hour per repo and session, of
  GitHub's 5,000.
- **Cost of a wake.** One cached read of the session's context per wake, capped at 12 an hour; today's polling turns
  cost the same each and come every few minutes with nothing to say.
- Two lanes that register the same PR each poll it and each get its notes.
- A lead that restarted under a new session id is not the session a tracker names: a gone lane's PR is then polled
  by no one and its tracker runs out.

## Changes to earlier decisions

- **ADR 0002, Process calls:** the list gains the GitHub CLI, with the argv above. Its sentence "no argument taken
  from a cue or model text" gains the one exception named here.
- **ADR 0002, Consequences (new surface):** the `prs/` folder.
- **ADR 0004:** the ledger's kinds gain `pr-watch` and `pr-notice`.

## Probes

Each is open until run, and each needs the person at the machine.

- **P-N1.** With `gh-block.sh` installed, a lane's `pr_watch` runs the CLI and no hook denies it.
- **P-N2.** The real CLI answers the fixed query for a public and a private repo, and the parser accepts the answer.
- **P-N3.** With the CLI logged out, `pr_watch` is refused with the fixed text and no CLI output appears in the
  result, the log or the ledger.
- **P-N4.** A note reaches a lane in the middle of a turn beside a tool result, and an idle lane with a hot cache as
  one turn.
- **P-N5.** A lane idle for over an hour is not woken; its lead is told once; the note arrives with the lane's next
  turn.
- **P-N6.** After a VS Code restart no note is sent twice, and a change made while it was closed arrives once.
