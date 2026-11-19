# Setup

From nothing to a working manager setup on one Mac: callboard loaded from your checkout in every session, the settings
that keep agents off its files, the usage watcher running, and the callboard rule linked.

You run every install step yourself. An agent never edits settings or permissions: where a step changes
`~/.claude/settings.json`, you make the edit. The `setup-manager` skill walks through the same steps (see
[The guided way](#the-guided-way)).

`<checkout>` below is your live checkout of this repo: the absolute path of one clone that stays on `main` and moves
only by a fast-forward to a reviewed commit of `main` after a merge ([Updating](#updating)). Callboard loads straight
from it, so that update is callboard's install. Agents never edit it: they work in their own clones under `/tmp`
(CLAUDE.md, Where agents edit).
`<commit>` is a full 40-character commit of `main` you have read, for the usage watcher.

The usage watcher's installer fetches `main` from the fixed URL `https://github.com/notitial/ai-manager.git` over
HTTPS, without credentials, into a fresh temporary repository, and installs from the commit there, never from your
working tree or the checkout's git store. So it installs only once the repo is public: while it is private the fetch
fails and nothing is installed. Callboard (step 1) and the rule link (step 3) work either way.

## Prerequisites

- macOS.
- The repo is public on GitHub, for the usage watcher's installer (see above), and the Mac has network access: its
  dry run fetches too.
- [ai-toolkit](https://github.com/notitial/ai-toolkit) installed as the base (`/setup-claude`). Its status line
  writes the meter the usage watcher reads.
- node 22.18 or later, the `claude` CLI, `/usr/bin/python3` 3.9 or later (from the Command Line Tools) and `jq`.
- The checkout sits outside the ai-toolkit checkout (see [ai-toolkit's setup and cleanup](#ai-toolkits-setup-and-cleanup)).

```
node --version && claude --version && /usr/bin/python3 --version && jq --version && xcode-select -p
```

## 1. Callboard

Details: [tools/callboard/README.md](../tools/callboard/README.md), Install. Design: [ADR 0002](adr/0002-callboard.md)
and [ADR 0003](adr/0003-symlinked-install.md).

Callboard has no installer. The mod loads from `<checkout>/tools/callboard/mod`, and the panels extension is a link
to `<checkout>/tools/callboard/extension`. Nothing needs sudo, and nothing is fetched.

### Link the panels extension (VS Code)

Quit VS Code first (Cmd+Q) and run these in a plain Terminal, not in VS Code's own terminal. VS Code deletes, at each
start, any extension folder its `extensions.json` doesn't list, so the script also registers the link there, and it
refuses to change anything while VS Code runs. Dry run, then apply:

```
/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py
```

```
/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py --apply
```

- It links `~/.vscode/extensions/notitial.callboard-panels-<version>` to `<checkout>/tools/callboard/extension`,
  with the version from `extension/package.json`, and writes one entry for it into
  `~/.vscode/extensions/extensions.json` (no `metadata`, which keeps VS Code from deleting through the link). It
  replaces this id's other entries, and clears this id's keys in `.obsolete`. The first old copy of each file is kept as
  `extensions.json.callboard.bak` and `.obsolete.callboard.bak` (delete a backup to have it written again).
- The extension's version stays fixed, so you run this once per machine, not at each update (see Updating). Run it
  again only when the version is bumped: it makes the new link and entry and removes the old ones.
- With VS Code open, the dry run says so and `--apply` refuses when something would change. A run with nothing to
  change is fine while VS Code is open. It also repairs a link that has no entry.
- It refuses, and names the entry, when a real folder or a link to anywhere else sits under a
  `notitial.callboard-panels-*` name: an old copy would shadow the link. Remove that entry yourself and run it again.
- It refuses, and names the file, when `extensions.json` or `.obsolete` is a link or is not valid JSON of the
  expected shape (a list, an object), or holds an entry of this id that points outside the extensions folder. Only the
  default profile gets the entry; a window on another profile has no panels.
- `--remove --apply` takes the links, the entries inside the extensions folder and the `.obsolete` keys off again (VS
  Code quit, as above).
- Start VS Code afterwards. If you use Settings Sync, consider adding `"notitial.callboard-panels"` to
  `settingsSync.ignoredExtensions` by hand, so a removal of an old version isn't synced to another Mac; the script
  changes no setting.

### Optional: one multi-folder window for several repos

Claude Code opens a new panel in a window's first folder, so a lane of another folder needs a window of its own, and
each window costs about 900 MB plus a webview. `patch-claude.py` patches the installed Claude Code extension so the
callboard panels extension can ask for a folder, and one multi-folder window then serves all its folders. It is opt-in:
without it nothing changes. It edits only the Claude Code extension's own folder, and nothing else: no setting and no
network. Run it as your user, in any terminal, then reload each VS Code window (Command Palette, Developer: Reload
Window). Check first, then apply:

```
CHECKOUT='<checkout>'
EXT_DIR="$(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-* | sort -V | tail -1)"
/usr/bin/python3 -I "$CHECKOUT/tools/callboard/patch-claude.py" "$EXT_DIR"
```

```
CHECKOUT='<checkout>'
EXT_DIR="$(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-* | sort -V | tail -1)"
/usr/bin/python3 -I "$CHECKOUT/tools/callboard/patch-claude.py" "$EXT_DIR" --apply
```

To take it out again (the original file comes back from its backup):

```
CHECKOUT='<checkout>'
EXT_DIR="$(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-* | sort -V | tail -1)"
/usr/bin/python3 -I "$CHECKOUT/tools/callboard/patch-claude.py" "$EXT_DIR" --undo
```

- The check prints `patched`, `unpatched-patchable` or `anchors-missing` and the extension's version, and changes
  nothing. `--apply` changes `extension.js` only when every one of its four anchors matches exactly once; otherwise it
  changes nothing and names the anchor that is missing. It keeps the original as `extension.js.callboard-orig` and writes
  `callboard-cwd-patch.json` (the marker the panels extension reads), both in the extension's folder. A second run says
  `already patched`.
- Claude Code updates about daily, and an update is a new folder that starts unpatched: run the check and `--apply`
  again, or type `/patch Claude` in a session in this checkout, which does both and, when an update moved the code the
  patch hooks into, repairs the script in a clone and asks you before it applies the repair.
- It serves the plugin build's lanes (the old mod keeps one repo per window), and covers only the open command: a tab
  that Claude Code itself restores at a window reload, or reopens, starts in the window's first folder.
- The patch is made for 2.1.327 and 2.1.328. A later version may rename or restructure the code it hooks into; then
  `anchors-missing` is printed and nothing is touched, and the panels extension keeps its one-repo-per-window behavior.

### Load it in every session

Add this line to the `env` block of `~/.claude/settings.json`, with `<checkout>` written as an absolute path:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "<checkout>/tools/callboard/mod"
```

- Claude Code applies it to every session it starts: VS Code opened from the Dock, any terminal `claude`, peers and
  background workers.
- Settings ask rules do not gate the mod's tools, so add none: their own checks are the gate, and `lane_terminate`
  asks for itself.
- If `env.CLAUDE_CODE_PLUGIN_DIRS` already holds another value, keep it and decide by hand. Callboard should be the
  only plugin on this variable: another plugin loaded in a session can run `/callboard` and may answer its dialogs
  (ADR 0002, Consequences).
- The callboard README, Default load (every session), has a one-line command that backs the file up, adds the key
  and shows the diff.

**Install check.** In a restarted session, type `/callboard config ping 45` once yourself, and once ask the model to
run it. First type `/callboard config` and note the ping value. The typed one must apply; the model-run one must be
refused with "Only you can change callboard settings". If the model-run one applies, report it (ADR 0002, Design
addition v13.2: keepalive pings and `/callboard config`). Then type `/callboard config ping <the value you noted>`. Do not use
`/callboard config reset` for this: it puts every callboard setting on this Mac back to its default.

### Manager setup: keep agents off the list file and the store (by hand)

Why, and what these lines do not cover: [callboard README, Manager setup: keep agents off the list file and the
store (by hand)](../tools/callboard/README.md#manager-setup-keep-agents-off-the-list-file-and-the-store-by-hand). Do it
now, by hand: an agent must not edit permission settings, and the `/setup-claude` templates do not carry these lines.

Add these two lines to `permissions.deny` in your global `~/.claude/settings.json` (an `Edit` rule covers the
Write tool too, so no `Write` line is needed; adding one only draws a warning):

```json
"Edit(**/.claude/callboard-conductor.json)",
"Edit(~/.claude/plugins/store/callboard_*.json)"
```

They keep an agent's Edit and Write tools off a conductor repo's list file and off the mod's store file, which holds
the saved grants and this machine's reserved names; they do not stop a shell write. A pattern without a leading `/`,
`~/` or `//` is relative to the session's folder, so the `**/` lines cover only sessions started in or above the
conductor repo: for each conductor repo, add the absolute form too
(`Edit(//Users/x/cond/.claude/callboard-conductor.json)`).

### Keep agents off the live checkout

No deny lines are needed for this. The live checkout feeds every session more than the mod: the extension, the
always-on rule `rules/callboard.md`, `CLAUDE.md`, the skills under `.claude/` and the manager's `docs/`. Its `.git/`
decides what a pull brings and what git runs. ai-toolkit's protected-paths hook, with the `.protected-checkout` marker
in the checkout, denies an agent's writes to it. Agents never need to edit it: they work in `/tmp` clones, and `.archive/` (state,
reports) stays in the checkout. Set the hook and
the markers up as described in [Escalation is on by default once the protected-paths hook is in place](#escalation-is-on-by-default-once-the-protected-paths-hook-is-in-place).
The limits of the hook are listed there too.

If you run a conductor repo: callboard refuses its `.claude` folder as unsafe when group or other may write it (as
under umask 002). Run this once:

```
chmod go-w <conductor repo>/.claude
```

### Escalation is on by default once the protected-paths hook is in place

Escalation, the switch for prompt answering ([ADR 0004](adr/0004-prompt-answering.md)), is on by default, but only
while the hook below is wired and all three markers exist: callboard checks them at run time (at most once a minute) and
stays off while one is missing; `/callboard status` names what is missing. Callboard holds no rule of its own about what an agent may write: no tier is asked to judge an edit of the
live checkouts, of `~/.claude/settings*.json` or of callboard's state folder, because ai-toolkit's
`hooks/protected-paths-guard.sh` denies those before any prompt exists. It never asks, so no prompt is left for an
agent to answer. Until the hook is in place, escalation stays off on that machine:

1. ai-toolkit carries the hook and your toolkit checkout is up to date. Run `/setup-claude` yourself: it links the
   hook into `~/.claude/hooks/` and wires it in `~/.claude/settings.json`, as `/bin/bash -p "$HOME/.claude/hooks/protected-paths-guard.sh" || exit 2`.
   Callboard counts that command as wired, with `$HOME`, `${HOME}` or the absolute path of the linked hook inside the quotes
   (a `~` inside the quotes does not count). Nothing else counts: not the bare link path (it lets a call through when the
   hook cannot start; an install from before the wrapper needs `/setup-claude` again), not another command (another
   interpreter, no `|| exit 2`, extra commands), not an entry with `async`, `if`, `args` or another field beyond `type`,
   `command`, `timeout`, `statusMessage` and `onFailure`, not a `timeout` under 10, and not a settings `env` that sets `HOME`. An agent never edits settings.
2. The hook protects a folder only when it holds a `.protected-checkout` file. The file is untracked, so only you
   make it. Run these once, with `<checkout>` your ai-manager checkout and `<toolkit>` your ai-toolkit checkout:

```
touch <checkout>/.protected-checkout
touch <toolkit>/.protected-checkout
mkdir -p ~/.claude/callboard && touch ~/.claude/callboard/.protected-checkout
```

3. Probe it: ask a session to write a scratch file inside `<checkout>`, and another inside `<toolkit>`. Both writes
   must be denied, and a write into a `/tmp` clone must go through.

The hook stops the file tools, the git server's tools and a shell line that names a protected path in a redirect or a
write verb. It does not read a script, an interpreter's program, `eval` or `bash -c`, a path built at run time, a `cd` to a
variable or a hard link; its header lists the limits. Without it, or without a marker, nothing in callboard stops
those edits: the rubric and auto mode's classifier are the only other layers, so install it first.
Once the hook and the markers are in place it turns on by itself, and the first time it does you get one toast. `/callboard escalation off`
turns it off and keeps it off; `touch ~/.claude/callboard/prompts/OFF` stops it at once. Typing `/callboard escalation` yourself
pins it on, with no guard. Do the probe (step 3) before you rely on it.

```
touch ~/.claude/callboard/prompts/OFF
```

## 2. The usage watcher

Details: [tools/usage-watcher/README.md](../tools/usage-watcher/README.md), Install. What the manager does with its
summary: [docs/manager/usage-watch.md](manager/usage-watch.md).

- **Only once the repo is public.** The installer fetches `main` over plain HTTPS from a fixed URL, with no
  credentials, so it fails while the repo is private. Until then the manager reports "usage summary never created;
  install pending" and acts on nothing.
- **The meter** comes from ai-toolkit's status line, which writes one file per account,
  `${USAGE_WATCHER_DIR:-~/.local/state/claude-statusline}/limits/readings-<fp>.json`, as a session renders. The
  watcher reads them as an optional input: without them the summary has no meter, and the per-session numbers still
  work. The launchd job does not see your shell's `USAGE_WATCHER_DIR`, so it reads the default path.
- **Other accounts** (optional). Give each account its own `CLAUDE_CONFIG_DIR`, `~/.claude-<name>/config`. The
  watcher scans those dirs too and tells the accounts apart by the account in each dir's `.claude.json` (it reads
  that one value, hashed, and nothing else from the file). To show a name instead of a fingerprint, or to scan a dir
  that is not named that way, write `~/.config/usage-watcher/accounts.json` (yours alone, not writable by others):
  `{"names": {"<fp>": "<name>"}, "dirs": ["<absolute path>"]}`. The fingerprints are in `meters.json` and in the
  summary's `accounts`. Details: the watcher README, Several accounts.

### An older watcher first

Only when you are about to install this one (the repo is public): if an older usage-watcher job is loaded under
another label, unload it first: `launchctl bootout gui/$(id -u)/<old label>`.
Then remove its plist from `~/Library/LaunchAgents/`, or it loads again at the next login. The data folder is shared
and kept. This repo's job is `io.notitial.usage-watcher`.

```
launchctl list | grep usage-watcher
```

```
launchctl bootout gui/$(id -u)/<old label>
```

### Dry run, apply, status

```
cd <checkout> && bash tools/usage-watcher/install.sh --ref <commit>
```

```
cd <checkout> && bash tools/usage-watcher/install.sh --ref <commit> --apply
```

```
cd <checkout> && bash tools/usage-watcher/install.sh --status --ref <commit>
```

`--apply` runs the commit's watcher tests, installs a copy under `~/.local/share/usage-watcher/`, writes the plist
and loads the job. `--status` is read-only.

### The retired SessionStart hook

An earlier watcher installed `account-stamp.sh`, a SessionStart hook, and told you to register it in
`~/.claude/settings.json`. It is retired: the installer no longer writes it, and says so when a copy is still there.
If you registered it, remove its entry from the `SessionStart` list by hand (the installer never edits a settings
file); `--uninstall --apply` removes the copy itself.

## 3. The callboard rule

[rules/callboard.md](../rules/callboard.md) is an always-on rule: how a session answers callboard's keepalive,
nudges and notices, and that none of them carries an approval. Link it into your global rules:

```
mkdir -p ~/.claude/rules && ln -s <checkout>/rules/callboard.md ~/.claude/rules/callboard.md
```

If `~/.claude/rules/` holds an older keepalive rule from an earlier setup, unlink it: this rule replaces it.

## ai-toolkit's setup and cleanup

ai-toolkit's `/setup-claude` and `/cleanup-claude` leave everything in this guide alone.

- **The rule link.** `/setup-claude` installs only ai-toolkit's own `rules/*.md`, so it never looks at
  `callboard.md`: it does not overwrite, remove or list the link. If the link dangles (the checkout moved), its rules
  step reports it as a conflict and still deletes nothing. `/cleanup-claude` unlinks only links that resolve into
  the ai-toolkit checkout, or dangle at a path through `/ai-toolkit/`. This link is neither, so it stays, and the
  cleanup report does not mention it. Keep this checkout outside the ai-toolkit checkout, or cleanup counts the link
  as the toolkit's. After moving the checkout, remove the old link (`rm ~/.claude/rules/callboard.md`) and run the
  `ln -s` again.
- **Settings.** `/setup-claude` never alters an `env` key outside its template and never removes a deny entry or a
  custom hook, and adds ask entries without ever removing one. `/cleanup-claude` removes only entries its template
  lists. So the `CLAUDE_CODE_PLUGIN_DIRS` line, the deny and ask lines and the SessionStart hook survive both.
- **Installed files.** Neither touches the panels extension link or the usage-watcher job. `link-extension.py
  --remove --apply` takes the link and its entry off.

## 4. Start the manager

Follow [docs/manager/README.md](manager/README.md), Starting and resuming. In short: a plain session in this
checkout, without `CLAUDE_CONFIG_DIR`, on Opus (`/model opus`), then type `/callboard manager [NAME]` yourself. With
no NAME the session is named `MANAGER`. The grant lives in memory and your yes saves it: the same conversation, started or resumed, asks whether to restore the manager (a compaction asks nothing; an unanswered question is asked again after the next prompt there).

The only name callboard reserves built in is `MANAGER`. A manager on a second machine needs a different name, because
Remote Control lists every machine's sessions. Reserve it on that machine first, typed yourself, then use it:

```
/callboard reserve BLUE
```

```
/callboard manager BLUE
```

The reserved list is kept per machine, in the mod's store: `/callboard reserve` shows it and
`/callboard reserve remove NAME` takes a name off. Only you can change it, from your own prompt or phone; a name a
lane or a live lead carries cannot be reserved. Details: callboard README, Commands (reserved names); design:
ADR 0002, Design addition v15.1: per-machine reserved names.

## 5. Final check

| Part | Check | Good when |
|---|---|---|
| Live checkout | `git -C <checkout> --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false status -sb` | `## main...origin/main` and nothing else |
| Origin | `git -C <checkout> remote get-url origin` | `https://github.com/notitial/ai-manager.git` |
| Old install gone | `ls /usr/local/libexec/callboard` | No such file or directory |
| Panels extension | `ls -l ~/.vscode/extensions \| grep callboard-panels` | one link, to `<checkout>/tools/callboard/extension` |
| Panels entry | `/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py` | it prints `already linked` and no `DRY:` line |
| Default load | type `! echo $CLAUDE_CODE_PLUGIN_DIRS` in a new session | `<checkout>/tools/callboard/mod` |
| Mod loaded | type `/callboard status` in a session | it answers a status table with a `Lane` row (`NONE`) and a `Lead` row (`OFF`) or similar |
| Reserved names | type `/callboard reserve` | the manager's name, when it is not `MANAGER`, is listed |
| Deny lines | read `permissions.deny` in `~/.claude/settings.json` | the two store and list-file lines are there |
| Protected-paths hook | `jq -e '[.hooks.PreToolUse[]?.hooks[]?.command] \| any(. == "/bin/bash -p \"$HOME/.claude/hooks/protected-paths-guard.sh\" \|\| exit 2")' ~/.claude/settings.json` (a rough pre-check: it finds the command the toolkit writes and does not look at the matcher, `disableAllHooks`, `env` or the entry's other fields), and `ls <checkout>/.protected-checkout <toolkit>/.protected-checkout ~/.claude/callboard/.protected-checkout` | `true`, and all three markers exist; escalation is on by default only while this holds (`/callboard status` is the authority and names what is missing) |
| Usage watcher | `bash tools/usage-watcher/install.sh --status --ref <commit>` | exit 0, the job loaded |
| Summary | `ls -l ~/.local/state/usage-watcher/usage-summary.json` | written in the last 5 minutes |
| Retired hook | read `hooks.SessionStart` in `~/.claude/settings.json` | no `account-stamp.sh` entry |
| Old watcher | `launchctl list \| grep usage-watcher` | only `io.notitial.usage-watcher` |
| Rule link | `ls -l ~/.claude/rules/callboard.md` | it points at `<checkout>/rules/callboard.md` |
| Tests | `bash tools/test-all.sh` | every suite passes or skips |

## Updating

First check where it pulls from: this must print `https://github.com/notitial/ai-manager.git`. Anything else: stop.

```
git -C <checkout> remote get-url origin
```

Then fetch `main` from the fixed URL, not from whatever the checkout's config names, and print the commit it
brought:

```
git -C <checkout> -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= fetch https://github.com/notitial/ai-manager.git +refs/heads/main:refs/remotes/origin/main
```

```
git -C <checkout> rev-parse refs/remotes/origin/main
```

That 40-character commit is `<commit>` below. It must be the merge commit GitHub shows for the pull request you are
installing; anything else: stop. Read exactly that diff, then fast-forward to exactly that commit, with no second
fetch. The flags keep git from running a hook, a file-system monitor, a pager, a diff driver or a credential helper
that a changed `.git/config` could name:

```
git -C <checkout> --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false log -p --no-textconv --no-ext-diff HEAD..<commit> | less
```

```
git -C <checkout> -c core.hooksPath=/dev/null -c core.fsmonitor=false merge --ff-only <commit>
```

Other settings in the checkout's own config still apply (for example a `url.<base>.insteadOf` that rewrites the
fetch), which is why the commit check and the read diff are the guard. The merge is callboard's update, and the rule
link follows the checkout too, so a change to `tools/callboard/` or `rules/` reaches every session: never install a
commit you haven't read. After a callboard update, reload each VS Code window (Command Palette, Developer: Reload Window): the
extension's version is fixed, so the link stays and the reload loads the new code from the checkout. Output > Callboard
Panels shows the build it loaded (the checkout's commit). Only when `extension/package.json` itself changed
(`activationEvents`, `engines`, `extensionDependencies`, `main`) is the version bumped, because VS Code caches the
manifest: then quit VS Code (Cmd+Q), merge as above, run `link-extension.py --apply` in a plain Terminal, then reopen
VS Code. After an update of the Claude Code extension itself, run the optional patch again if you use it (above). Restart every session, and restart every conductor session before it calls `lead_open`: from extension 1.3.0 the answer to a lead open carries a nonce, which a conductor still on the older mod refuses (the panel opens, but the conductor is told the open failed). Before
you turn unattended mode on, restart every session started before the update: a lane and a tier both on older code
can still relay a prompt to you. For the usage watcher, run its installer again with the new `--ref`.

## The guided way

Type `/setup-manager` in a session in this checkout. The skill
([.claude/skills/setup-manager/SKILL.md](../.claude/skills/setup-manager/SKILL.md)) runs the read-only checks and
the dry runs itself, shows you every `--apply`, settings edit, link and `launchctl bootout` as an exact command to
run, and ends with the status table above.
