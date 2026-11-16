# callboard

callboard lets one Claude Code session run other sessions: it opens them, prompts them, keeps their cache warm,
asks them to compact, and stops them when their work is signed done. It is a mod for Claude Code plus a VS Code
extension that opens the panels. This file is a guide for the person who runs it. The decisions and their reasons
are in the ADRs (`docs/adr/`, start with [ADR 0002](../../docs/adr/0002-callboard.md)); limits, codes and the exact
texts are in the code, and `/callboard help` lists every command. Nothing loads this file into a session.

## Parts

| Path | What |
|---|---|
| `mod/` | The Claude Code mod. Pure logic is in `mod/hooks/core.ts` and its siblings; the engine side is in `mod/hooks/engine/` (layout: ADR 0005) |
| `extension/` | The VS Code extension that opens, reopens and closes lane panels. It has no commands of its own. What it does: [`extension/README.md`](extension/README.md) |
| `link-extension.py` | Links that extension into VS Code from this checkout, once per machine (Install) |
| `prompt-audit.mjs` | Read-only audit of prompt answering, from the machine-wide ledger and the files beside it (it reads no transcript). It runs from this checkout with node 22.18 or later; usage and exit codes are in its header comment |
| `test.sh` | The test entry point (Tests) |

## The roles

A session takes a role with one `/callboard` command and a confirmation dialog. A session holds one role at a time.

- **Lane.** A session that does one task in one repo. A lead makes it (`lane_create`, `lane_open`) or you join an
  existing session to a lead with `/callboard lane`. A lane does its work, writes its report, and signs it done: the
  last line of `<repo>/.archive/<LANE>/REPORT.md` is `status: done <its session id>`, appended, never overwritten.
  Only then can its lead retire it.
- **Lead.** `/callboard lead [NAME]` in the session that coordinates a repo's lanes. It gets the `lane_*` tools to
  create, open, name, start, prompt, compact, park, retire and stop lanes in that repo, and nothing outside it.
  A repo may have several leads; with more than one, each needs its own valid name. A lead can also hold a go
  (below).
- **Conductor.** `/callboard conductor [NAME]` in a small repo of its own. It reaches the leads it owns, in the repos
  listed in `.claude/callboard-conductor.json`: it lists their lanes, resumes, compacts, parks and retires those
  leads, and opens a new lead in a listed repo without asking you (`lead_open`). It holds at most four leads at
  once, and a parked lead keeps its slot until it is retired (ADR 0006). It never creates, starts or retires a lane
  itself, and a force stop of any lane or lead asks you.
- **Manager.** `/callboard manager [NAME]`: one per machine, reaching every lane and lead in any repo. It resumes and
  compacts lanes; every stop, every removal and every call to a lead asks you. Its role is in `docs/manager/README.md`.

What each tool may do at each level, and what is refused, is in ADRs 0002, 0006 and 0007 and in the tool
descriptions. A conductor or manager session that is already running when the mod gains tools gets them after
its mod reloads.

Three kinds of stop, from least to most final: `lane_park` closes the tab and keeps the conversation (`lane_unpark`
reopens it with its history); `lane_retire` ends a signed-done session and removes the lane (final); `lane_terminate`
is the force stop and always asks you. A conductor (for the leads it owns) or the manager stops a lead with
`lead_park`, `lead_retire` and `lead_terminate`. A stop that got its signal and did not finish (the session still
runs, or its record could not be removed or marked) is told to you in a toast, beside the tool's result for the
caller.

## A normal day

1. Start Claude Code in the repo (VS Code or a terminal), name the session with `/rename`, and type
   `/callboard lead` (or `/callboard lead NAME`). Confirm the dialog. When the same session starts again in the
   same folder it is lead again, until you run `/callboard off` (a saved grant lapses after 30 days). A role that
   could not be restored says why in a toast (When something is refused, below).
2. Ask the lead for work. It writes each lane a brief (`.archive/<LANE>/BRIEF.md` in the lane's folder, the repo root by default), opens a panel, names the
   session and starts it with the brief. In a terminal you start a `claude` yourself, type `/callboard lane NAME`,
   and the lead prompts it from then on.
3. The lanes work. When a lane waits on a permission prompt, the dialog stays in front of you; with escalation on,
   the lead (then the conductor, then the manager) may answer it, never in your first 30 seconds, and your click
   normally wins (a Yes that lands in a short gap can be missed: ADR 0004). Merges, force pushes, pushes to main or production and destructive deletes are always passed up
   to you. Every ask that `tool.check` reports for a lane's or a lead's own call rises this way, whatever raised it
   (a rule, a hook or guard, a setting, a plugin) and whatever the tool, a plan-mode exit included: the tier sees what raised it and
   the hook's reason, handles the routine cases its rubric names (a rerun of the lane's own CI run, a delete inside
   the lane's own clone) and passes the rest up, and the top live tier relays it to you. A request that no tier
   answers or relays is denied after 20 minutes, and the lane may ask again
   ([ADR 0011](../../docs/adr/0011-all-prompts-rise.md)). What cannot rise (a subagent's ask, a call with no usable
   `tool.check` entry, no live tier, a host's answer, a question with no answer form) stays in the lane's panel. A
   prompt that has waited 5 minutes and that no tier holds as a request is put in front of the lane's lead at once,
   in the middle of its turn if it is busy, and in front of the manager after 10 minutes; a prompt a tier already
   holds as a request was told by that request's own notice, so its check-in is skipped, and it comes back if the
   request ends (answered, withdrawn, denied) with the lane still waiting. You get one toast per wait in each window
   that watches the lane, held or not. That alert lets no one answer the prompt: it only says that one is waiting.
4. A lane that waits on a pull request registers it with `pr_watch` and is told when checks finish, reviews arrive
   or the PR is mergeable, merged or closed. A merge is still yours.
5. A big lane is asked to compact before it loses its notes, and a lead can order it to. You never type that.
6. A lane finishes, signs its report, and the lead retires it. The lead is told of a signature within a few minutes
   of going idle, without waiting for its check-in or the lane's own message; a lane whose session ends with the
   report unsigned shows a toast in the lead's window. A lane you may need again is parked instead.
7. Before a long stretch, give the lead one go for the whole body of work (`/callboard go TEXT`) so its lanes do
   not ask again for each step (it counts only while the protected-paths guard is in place). A go never covers a merge, a force push, a push to
   main or production, or a delete outside the lane's own work, and the rest of the list the dialog and `go_status`
   print (ADR 0009). `go_status` shows a session what covers it. A closed, parked or crashed panel ends no go; `go off`
   does.

A lead that you leave idle is told when a lane needs it (its session is gone, it waits on a prompt, it went
quiet without signing), unless you pause that with `/callboard checkin pause` (an hour, or the time you give;
`checkin resume` ends it). The toasts for a waiting prompt are shown even then.

## Commands

`/callboard help` prints the full table and is the authority: every form is listed once, with its help line, in
`COMMAND_TABLE` (`mod/hooks/core.ts`), and the help, the usage lines and the slash menu's hint are cut from it. The
prompt box completes from the same table: after `/callboard ` and the first letter of a word it offers the words
that fit, each with its help line. The families:

- **Look:** `status`, `lanes`, `config`, `reserve`, `help` (printed from any origin, with no model turn).
- **Roles:** `lead [NAME]`, `lead join [CONDUCTOR]`, `lead leave`, `lane [NAME]`, `lane off`, `conductor [NAME]`,
  `conductor add|remove NAME|PATH`, `manager [NAME]`, and `off` to drop whatever the session holds.
- **Settings:** `config SETTING VALUE`, `config reset`, `reserve [add] NAME`, `reserve remove NAME`,
  `checkin pause [Nm|Nh]`, `checkin resume`, `escalation [off]`, `rest` (or `/rest`), `go [TEXT]`, `go off [SHORT]`.

Anything that widens what a session may do (a role, a name, a setting, a reserved name, a go) needs your own prompt
or phone: from a plugin, another session or a script it is refused, or asks you first. `off`, `rest`,
`escalation off` and the prints take any origin; `off` from another origin asks you first; `go` and `go off` are your own prompt or phone only, with no
ask-first path.

`/callboard config` shows the settings with their defaults: keepalive, ping and stop times, the two compaction
levels, check-ins, whether conductors may open leads, and escalation. `config reset` restores the defaults.

Reserved names: the repo reserves `MANAGER` only. Run `/callboard reserve NAME` for each other name your rules or
manager trust (for example your manager session's own name); until you do, a lead may give a lane that name. The
list is per machine, in the mod's store.

## Install

Callboard has no installer ([ADR 0003](../../docs/adr/0003-symlinked-install.md)). The mod and the panels
extension load straight from your live checkout of this repo, which stays on `main` and moves only by a
fast-forward after a merge. Agents never edit that checkout; they work in clones under `/tmp`. Nothing needs sudo or
a fetch. `<checkout>` below is the clone's absolute path. The full order of steps is `docs/setup.md`.

Callboard reads the session list at `~/.claude/sessions` and supports sessions run under `~/.claude` (other
config folders: ADR 0002, the `CLAUDE_CONFIG_DIR` amendment).

### Default load (every session)

One line in the `env` block of `~/.claude/settings.json`, which Claude Code applies to every session it starts:
VS Code opened from the Dock, any terminal `claude`, peers and background workers.

```json
"CLAUDE_CODE_PLUGIN_DIRS": "<checkout>/tools/callboard/mod"
```

Add it yourself. If `env.CLAUDE_CODE_PLUGIN_DIRS` holds the earlier `/usr/local/libexec/callboard/mod`, replace it:
never list two folders that hold a `callboard` mod, or both load. If it holds anything else, keep it and decide by
hand. Otherwise this keeps a backup, sets the key and leaves every other setting as it was; fill in `<checkout>`
first, and the diff should show only that line (and a comma on the line before it, when the key is new):

```
cp ~/.claude/settings.json ~/.claude/settings.json.bak-callboard && /usr/bin/python3 -I -c "import json,os;p=os.path.expanduser('~/.claude/settings.json');d=json.load(open(p));d.setdefault('env',{})['CLAUDE_CODE_PLUGIN_DIRS']='<checkout>/tools/callboard/mod';open(p+'.tmp','w',encoding='utf-8').write(json.dumps(d,indent=2,ensure_ascii=False)+'\n');os.chmod(p+'.tmp',os.stat(p).st_mode&0o777);os.replace(p+'.tmp',p)" && diff ~/.claude/settings.json.bak-callboard ~/.claude/settings.json
```

Sessions pick it up when they next start. The mod stays dormant in a session until `/callboard lead` or a lane
binding, except the compaction nudge and the keepalive ping, which reach every interactive session. The mod warns
(one toast, log line `warn live-checkout-not-main`) when the live checkout is not on `main`. It never refuses to
load. Settings `ask` rules do not gate the mod's tools, so add none: their own checks are the gate.

A process running as you can repoint the variable by editing the settings file, and a launcher's clean start
(`env -i`, `--force-disable-user-env`) would not close that either.

### The panels extension

`link-extension.py` makes `~/.vscode/extensions/notitial.callboard-panels-<version>` a link to
`<checkout>/tools/callboard/extension` and registers it in VS Code's `extensions.json`. Without `--apply` it only
shows what it would do. Quit VS Code (Cmd+Q) first and run it from a plain Terminal:

```bash
/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py --apply
```

It refuses anything it would have to guess about (a real folder or a foreign link under a
`notitial.callboard-panels-*` name, a malformed `extensions.json`) and names the file; a refusal changes nothing.
`--remove --apply` undoes it. Details: `docs/setup.md` and `--help`.

The script does not look for the extension's earlier id `local.callboard-panels-*`. Such a copy would answer
`lane_open` as well and open every lane twice, so check for one yourself and remove it:

```bash
ls ~/.vscode/extensions | grep -i local.callboard-panels
```

The version is fixed, so an update is a fast-forward of the checkout plus a window reload (Command Palette,
Developer: Reload Window). Output > Callboard Panels shows the build it loaded. A change to
`extension/package.json` needs a version bump: quit VS Code, pull, run the script again, reopen VS Code.

A window answers `lane_open` only when the lane's folder is its first workspace folder, so open further windows from
inside VS Code (File, New Window).

### Manager setup: keep agents off the list file and the store (by hand)

Two `permissions.deny` lines in your global `~/.claude/settings.json` keep an agent's Edit and Write tools off
`.claude/callboard-conductor.json` and the mod's store file (`~/.claude/plugins/store/callboard_*.json`, which
holds the saved grants and the reserved names). `docs/setup.md` has the lines and the one-time `chmod go-w`. They
stop the file tools, not a shell write. The rest of `~/.claude/callboard/` (lane stores, lead records, requests) is
kept from agents by ai-toolkit's protected-paths hook and its marker file (`docs/setup.md`, Keep agents off the
live checkout), which stops the file tools and a shell line that names the path.

### Install check

After install, in a restarted session, type `/callboard config ping 45` yourself and once ask the model to run
it. The typed one applies; the model-run one must be refused with "Only you can change callboard settings". If it
applies, the origin check is no guard at all and only the bounds stand: report it. Put the ping value back
afterwards (`docs/setup.md`, Install check).

## How cost is kept down

A session's prompt cache lives an hour from its last call. An idle session pays about 1.25 times its context to
write that cache again, where a short turn inside the hour costs about 0.1 times. So the mod pings an idle session
just before its cache expires (about 50 minutes), stops 2 hours after the last real work (two pings, with the
defaults), and sends nothing while the Mac sleeps. A big session is asked to compact instead of being pinged again.
A lane signed done is never pinged, and the manager does not send its own keepalive, so a session never gets two.

A Mac that ever saved a `/callboard config` change keeps the stop time it stored then (3 hours, the earlier
default). `/callboard config stop 2` or `/callboard config reset` gives it the 2 hours.

Type `/rest` in a session you will not touch for hours: it stops the pings for that idle gap and the cache expires.
Its next real turn restores them. An agent can set the same rest for its own session with the `rest` tool, when you
tell it to go idle or it expects you to be away for hours; it asks nothing, because it only narrows, and a
subagent's call is refused. A rest stops pings only: a PR notice still wakes a lane that rests while it waits on CI,
and that turn ends the rest. `/callboard config keepalive off` stops pings for every session on this Mac.

A compaction asked for by the mod (a nudge, past 300k tokens by default, or a lead's order) is always the session's
own act: it writes where it is to its report or STATE file, calls `request_compact`, and carries on from its
continuation. The nudge levels and the ping times are settings.

## Where things live

Under `~/.claude/callboard/` (folders 0700, files 0600; nothing in a repo is trusted):

| Folder | Holds |
|---|---|
| `lanes/` | One lane store per repo, named by a hash of the repo's real path |
| `lead-records/` | Which conductor owns which lead |
| `leads/` | Short-lived presence files of live leads, conductors and the manager |
| `cue/`, `result/` | The one-line cues a mod acts on, and its answers |
| `open/`, `offers/` | Requests for the panels extension; a conductor's offer of a new lead |
| `log/` | One log per session: what the mod did and why it refused. First place to look |
| `usage/` | Each session's own figures, shown by `lanes` and `lane_list` |
| `prompts/` | Prompt-answering requests, decisions and the machine-wide ledger |
| `prs/` | PR notice trackers and notes |
| `go/` | The goes you gave |

The mod's own store (settings, saved grants, reserved names) is `~/.claude/plugins/store/callboard_*.json`. Lane
briefs and reports stay in the repo under `.archive/<LANE>/`.

## When something is refused

A lane tool's refusal reads `lane_<verb> refused: <reason>`, usually opening with a code. Retry only when the text
says to. The session's log in `~/.claude/callboard/log/` has the same code and what the mod checked.

| You see | Usually means |
|---|---|
| `no-answer`, or "has not read the cue" | The target has not answered. Look at its log; do not repeat the call while the text says the cue is still waiting |
| `not-idle` | The lane has to be idle for 30 seconds first; retry once as the text says |
| `report-stale`, `report-unknown`, `not-bound` (retire) | The lane must take a prompt and sign its report again; after a restart it must also bind again (`/callboard lane` offers Restore) |
| `lead-needs-name`, `name-in-use`, `lead-name-reserved` | A lead or lane needs a valid, unique, unreserved name: `/rename`, or pass NAME |
| `no-lead` | A lane answers only a live lead of its repo, a live manager (resume, compact, retire) or the owner of its lead (compact) |
| `record-changed` | The lane's record changed since it was bound. After a pull that adds a store field, restart the sessions that write the store (one still on the older mod drops the field) |
| `model-failed` | The lane's model could not be set, so it was not started. Set the model by hand and type into the panel, or remove and recreate the lane |
| `reopen-timeout` | No VS Code window has the lane's folder as its first folder. Resume it in a terminal in that folder instead, or retire it |
| `store-busy` | Two callboard processes wrote one store; retry |
| `target-is-lead`, `sid-mismatch` | A manager's or conductor's stop met a session or record it must not touch; read the text, the lane's lead or you can still stop it |
| `not-owner` | A conductor reached a lead it does not own |
| `lead-cap`, `open-backstop` (`lead_open`) | The conductor holds four leads already (the text names them; retire one), or it opened too many in the last hour (the text gives the time the next open is allowed) |

Other symptoms:

- **Nothing happens after a prompt.** Check `/callboard status` and `lanes`; escalation reads `ON (default)` only
  while the protected-paths hook and its `.protected-checkout` markers are in place (`docs/setup.md`). The hook
  counts only as ai-toolkit's wrapped entry, exactly as `docs/setup.md` shows it: a bare path to the hook (an
  install from before the wrapper), another command or an extra field reads as not wired, until ai-toolkit's
  `/setup-claude` rewrites the entry. Without the hook and the markers, or after `/callboard escalation off`, every
  prompt stays yours. Typing `/callboard escalation` yourself pins it on
  with no guard, and the status then reads `ON`.
- **To stop prompt answering at once**, `touch ~/.claude/callboard/prompts/OFF` (`docs/setup.md`, ADR 0004); remove
  the file to allow it again.
- **A role did not come back after a restart.** A restore that ends without restoring shows one toast with the
  reason ("Lead not restored: ...", "Conductor not restored: ...", "Manager not restored: ..."); run the role's
  command again by hand. A failure that can clear by itself is tried again first. The manager's restore asks you,
  and a question left unanswered is asked again after the next prompt in that session, three times in all; then a
  toast says to run `/callboard manager`. Your click in the dialog stays the only yes.
- **A prompt stays in the lane's panel and no tier sees it.** Some prompts cannot rise: a subagent's, one with no
  live tier in reach, a question that is not one single-choice question, and the others ADR 0011 lists. The
  waiting-prompt toast is what tells you. After a fast-forward of the checkout, reload the lead, conductor and
  manager sessions: one whose mod loaded earlier skips the requests it does not know, and they end in the
  20-minute deny.
- **A toast says a lane waits on a prompt.** Answer it in that lane's panel. The lead or the manager was told too,
  when it could be: one that sits in a long tool call, waits on background work or has a dialog open is not, and
  the toast is the alert that is left.
- **A stopped lane's tab stays.** Check the extension is linked and VS Code was started after the link.
- **A lane whose lead is gone** (ended, or turned off) shows under `NAME (not live)` in the manager's `lane_list`;
  the manager can clear it with `lane_retire` or `lane_terminate`.
- **A stop signalled the wrong moment.** A session's `ok` and the signal are about two seconds apart, so a draft
  started in that gap is lost (the transcript can be resumed). The check after your click reads the registry, so a
  `/clear` it does not show yet is not caught.
- **`/callboard` does nothing.** The mod loaded only if a session started after the Default load line was set.

## What callboard does not guard against

It guards against an honest mistake, not against code running as you: any such process can write the stores, the
cues, a saved grant, a forged lead record or reserve list, and a registry file. The bounds in the mod keep the worst
case small (ADR 0002, Consequences). Beyond that, specific to what you see:

- Messages between sessions carry no proof of who sent them.
- The extension knows only the name `MANAGER`, so it does not keep a panel with another reserved name from being
  closed. A forged reserve list can reserve a live lead's name; its lanes then refuse its cues until
  `/callboard reserve remove`.
- A PR notice's counts include the lane's own comments; a registration that gets no answer still uses one of the
  30 an hour; a lead that is closed leaves its gone lanes' trackers unpolled until they are swept (ADR 0010).
- What a tier handles and what it passes up is guidance in its rubric, not a check in the mod. A tier that misreads
  it, or is talked round by a lane's input, can allow what a guard or hook was written to put in front of you, or
  let a lane leave plan mode; you learn of it from the ledger, and the audit counts such allows by what raised
  them (ADR 0011, What this widens).
- The prompt audit reads the ledger and the files beside it, never a transcript. A hand-written `answered` row with
  its decision file passes, a decision that reached a session with no ledger row is not reported, and neither is
  a click lost in the short gap of ADR 0004.
- The `/callboard` typeahead is tested against the test kit only: how a terminal, a VS Code panel or a phone draws
  the rows is not checked against a live engine.
- A go dialog left open for 10 minutes inside a tool call may be cut off by the engine, and its text can run long with
  many lanes: unverified live (ADR 0009, probes).

## Tests

```bash
bash tools/callboard/test.sh
```

It runs the core logic tests, the prompt audit tests, the extension tests, `claude plugin validate`,
`claude plugin test` (the slow part, about 2 minutes) and the `link-extension.py` tests. CI runs all of it.
`CALLBOARD_SKIP_MOD_TESTS=1` skips only the mod tests for a quick local run. How the mod tests are written:
`CLAUDE.md`.

The script takes a machine-wide turn first (`tools/test-turn.sh`) and runs its steps at a lower priority, so two
local runs never overlap: while another run of it or of `tools/test-all.sh` holds the turn, it says so and waits.
A turn whose holder is gone is taken over at once. If the turn is older than 25 minutes and its holder is not
known to be gone, the script stops with exit 3. Check that no test run is still going, then clear it and run the
script again:

```bash
rm -r /tmp/ai-manager-fulltest.lock
```

The mod paths that act on cues, the restores and the compaction run only against mocks. Before a change reaches the
live checkout, try it in a lab VS Code (its own `--user-data-dir`, launched with `env -i`): rename, start, resume
and compact end to end, a real manager, several lanes at once, and the probes P1-P8, L1-L9 and C1-C13 of ADR 0002.

## Where the detail is

| Topic | ADR |
|---|---|
| The design, cues, lanes, park, check-ins, keepalive, manager, conductor level | [0002](../../docs/adr/0002-callboard.md) |
| Why it loads from a live checkout | [0003](../../docs/adr/0003-symlinked-install.md) |
| Prompt answering, tiers, the relay | [0004](../../docs/adr/0004-prompt-answering.md) |
| Module layout | [0005](../../docs/adr/0005-callboard-module-layout.md) |
| A conductor opens leads | [0006](../../docs/adr/0006-conductor-opens-leads.md) |
| A conductor owns leads | [0007](../../docs/adr/0007-conductor-owns-leads.md) |
| The go | [0009](../../docs/adr/0009-go-given-once.md) |
| PR notices | [0010](../../docs/adr/0010-pr-notices.md) |
| Every prompt rises, what raised it, what cannot rise | [0011](../../docs/adr/0011-all-prompts-rise.md) |
