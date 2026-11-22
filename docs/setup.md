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
working tree or the checkout's git store. Callboard (step 1) and the rule link (step 3) fetch nothing.

## Prerequisites

- macOS.
- Network access, for the usage watcher's installer (see above): its dry run fetches too.
- VS Code 1.90 or later with the Claude Code extension (`anthropic.claude-code`) installed: the panels extension
  depends on it. The patch of that extension is made for the versions named under
  [The Claude Code extension patch](#the-claude-code-extension-patch); its check says whether yours fits.
- [ai-toolkit](https://github.com/notitial/ai-toolkit) installed as the base (`/setup-claude`). Its status line
  writes the meter the usage watcher reads.
- node 22.18 or later, the `claude` CLI, `/usr/bin/python3` 3.9 or later (from the Command Line Tools) and `jq`.
- Claude Code 2.1.330 or later: the relay needs `$.agent.call` and its abort.
- The checkout sits outside the ai-toolkit checkout (see [ai-toolkit's setup and cleanup](#ai-toolkits-setup-and-cleanup)).

```
node --version && claude --version && /usr/bin/python3 --version && jq --version && xcode-select -p
```

## 1. Callboard

Details: [tools/callboard/README.md](../tools/callboard/README.md), Install. Design: [ADR 0002](adr/0002-callboard.md)
and [ADR 0003](adr/0003-symlinked-install.md).

Callboard has no installer. The plugin loads from `<checkout>/tools/callboard/plugin`, and the panels extension is a link
to `<checkout>/tools/callboard/extension`. Nothing needs sudo, and nothing is fetched.

### Link the panels extension (VS Code)

VS Code deletes, at each start, any extension folder its `extensions.json` doesn't list, so the script also registers
the link there, and it refuses to change anything while VS Code runs. The dry run changes nothing and is safe with VS
Code open:

```
/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py
```

For the apply, quit VS Code first (Cmd+Q) and run it in a plain Terminal, not in VS Code's own terminal. A Claude
session in a VS Code panel ends with VS Code, so start a new one afterwards:

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
- The script does not look for the extension's earlier id, `local.callboard-panels-*`. Such a copy answers every lane
  open too, so every lane opens twice. Check for one, and remove what it prints with VS Code quit:

```
ls ~/.vscode/extensions | grep -i local.callboard-panels
```

- Start VS Code afterwards, and check that it loaded the extension: in the Output panel (View, Output) pick "Callboard
  Panels". Its first line reads `callboard panels <version>, build <commit>`, and a `claude cwd patch:` line says
  whether the patch below is in. If the list has no such entry, the extension did not load: check the link, and that
  the Claude Code extension is installed and enabled.
- If you use Settings Sync, consider adding `"notitial.callboard-panels"` to
  `settingsSync.ignoredExtensions` by hand, so a removal of an old version isn't synced to another Mac; the script
  changes no setting.

### The Claude Code extension patch

Claude Code opens a new panel in a window's first folder, so a lane of another folder needs a window of its own, and
each window costs about 900 MB plus a webview. `patch-claude.py` patches the installed Claude Code extension so the
callboard panels extension can ask for a folder, and one multi-folder window then serves all its folders.

Without the patch callboard works with one VS Code window per repo: asks, goes, lanes of the window's first folder and
the manager all work. These need it:

- lanes and leads in the other folders of one window, and so a conductor whose repos share one window;
- the Run button on shell code blocks;
- the tier groups in the Session Manager list, and the archiving of a retired lane there;
- the session list of every folder of the window;
- the folder pill, the context ring, the wider composer and the restore fix.

It edits only the Claude Code extension's own folder, and nothing else: no setting and no
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

To take it out again (the original file comes back from its backup; `/patch-vs-claude undo` in a session in this checkout
runs the same command):

```
CHECKOUT='<checkout>'
EXT_DIR="$(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-* | sort -V | tail -1)"
/usr/bin/python3 -I "$CHECKOUT/tools/callboard/patch-claude.py" "$EXT_DIR" --undo
```

- The check prints `patched`, `outdated`, `unpatched-patchable`, `anchors-missing` or `leftovers` (a backup or marker
  from an earlier run that does not match the file: run `--undo`) and the extension's version, and changes
  nothing. `--apply` changes `extension.js` only when every one of its four anchors matches exactly once; otherwise it
  changes nothing and names the anchor that is missing. It keeps the original as `extension.js.callboard-orig` and writes
  `callboard-cwd-patch.json` (the marker the panels extension reads), both in the extension's folder. A second run says
  `already patched`.
- The same patch adds a style block to the page Claude Code builds for its panels, optional on its own: the panel width
  (the marker's `width` field), so the composer and its permission box use the panel's width (no 680 px cap, a smaller side
  margin). It goes in only when the page's font configuration tag is found and the shipped `webview/index.css` or
  `index.js` still carries the class prefixes it uses; otherwise the check and `--apply` print a warning line for it
  and the rest still applies. Its CSS is `WIDTH_CSS` at the top of `patch-claude.py`; the side-margin
  selector is a guess that only a rendered panel confirms, so tune it there after one look, then `--update`. `--undo` takes
  it out with the rest. The Remote Control chip is left as Claude Code draws it: an install made by an older script that hid it
  reads `outdated`, and `--update` takes the hiding out.
- The context pie (the marker's `pie` field) shows the composer's own context pie always, as one ring, in place of Claude
  Code's, which appears only when the context used passes its `claudeCode.contextUsageThreshold` setting (50 percent by default), in three fixed shapes, measured against the model's window.
  The ring is measured against the compaction point of your `autoCompactWindow` setting (`~/.claude/settings.json`, or
  `CLAUDE_CONFIG_DIR` of the VS Code process; project settings are not read; read each time a panel opens, so a reload picks up
  a changed value): full where Claude Code compacts. With no such setting it uses the model's window, as the stock pie does.
  The ring is 18px with 2px around it (the footer's own stylesheet sizes it to 26px, so the piece's style block sets the size too), and its arc is coloured by the tokens used: green below 200k, blue from 200k, amber from 300k, red from 400k (the theme's chart colours; fixed amounts, whatever your `autoCompactWindow`). Its hover text is a bold "Context" over `used / limit used · percent` in k (`126k / 200k used · 63%`, the limit being where the ring is full: your `autoCompactWindow` less about 33k); a click
  still compacts. It also edits `webview/index.js`, as the folder pill below does, in three places that must each match once (the check
  names the one that does not), and in two more for the hover text: when either of those does not match once, the hover text
  stays Claude Code's and the rest of the piece still goes in, without a warning. The shipped script is kept as
  `webview/index.js.callboard-orig`, and `--update` and `--undo` handle both files. After
  a Claude Code update the new folder starts unpatched; if the pie's code moved, the check and `--apply` warn that the pie is
  left out, and the other pieces still apply.
- The folder pill (the marker's `pill` field) puts a name for the session's folder, as plain text with no path and no tooltip,
  in a small pill next to the model name in the composer; it shrinks with an ellipsis in a narrow panel. The name is the
  first line of `<folder>/.archive/.folder` (trimmed, at most 40 characters) when that file holds one, else the folder's last
  part. The pill shows only in a window with more than one folder. Clicking it opens an input box with the current name:
  Enter writes `.archive/.folder` (creating `.archive`), an empty name deletes the file and returns to the folder's own name,
  Esc changes nothing, and the pill updates without a reload. It reads and writes only that one file, and only for a folder
  that is one of the window's folders or inside one (a worktree or other folder shows its own name, and a click does
  nothing), and never through a link: a `.folder` or `.archive` that is a link or a fifo is ignored. A name put in the file
  by hand, or a rename made in another panel on the same folder, shows when the panel is next opened. The
  piece needs two anchors that must each match once, one in `webview/index.js` and one in `extension.js` (the webview asks the
  extension through the connection it already has); when one does not, the check and `--apply` warn that the pill is left out
  and the other pieces still apply. An install made before it reads `outdated`, and `--update` brings it in.
- The run button (the marker's `run` field) puts a small play button before Copy on shell code blocks in a chat (no language, or
  sh, bash, zsh, shell, console) and runs the block on your click, then sends the command, its output and its exit status into
  the same chat as your message, so Claude answers it. A click opens VS Code's own modal with the folder's name and the whole
  command, and two buttons: "Run", which Enter presses too, and Cancel (Escape), which runs nothing. It runs `$SHELL -lc` in the session's folder, under a progress notice with its own Cancel and a
  2-minute limit, and keeps the first and last part of long output. When the output looks like it holds a secret, a second
  modal asks whether to send it masked (the default), as it is, or not at all; the scan is best effort. The run is yours, so
  it can do what Claude's own hooks block: read the command before you click Run. It needs the panels extension (it does the
  running) and three anchors that must each match once, two in `webview/index.js` and one in `extension.js`; when one does
  not, the check and `--apply` warn that the button is left out and the other pieces still apply. A panel reloaded during a run
  loses the output. An install made before it reads `outdated`, and `--update` brings it in. The decision is
  [ADR 0014](adr/0014-run-button.md).
- The patch also carries a restore fix, optional in the same way (the marker's `restore` field, a warning when an anchor is not
  found, one `--undo`): a Claude panel that VS Code restores at a window reload, or that Claude Code reopens (Reopen Closed
  Session), starts in the folder that holds its conversation instead of the window's first folder, so it resumes that
  conversation. The folder is found from the session's transcript (`projects/<folder>/<session id>.jsonl` under Claude's
  config folder, from the `CLAUDE_CONFIG_DIR` of the VS Code process, not from the `claudeCode.environmentVariables` setting), as no saved panel state names it. With no transcript yet, a one-folder window, a folder that is a
  sub-folder of a window folder or a very long path, the panel starts in the first folder as before.
- The group command is another piece, optional in the same way (the marker's `groups` field): it adds the command
  `callboard file session`, which the panels extension calls to file each callboard session in the Session Manager group
  of its tier: the manager in Manager, a conductor in Conductor, a lead in Lead and a lane in Lanes (a group of that name
  in any letter case, such as LEAD, is the same one; a missing one is created). These groups come first, in that order,
  and any other group after them. A session moves into its tier's group from wherever it sits, and again whenever its
  tier changes; one you move by hand stays moved until then. An install with the older `callboard assign group` reads
  `outdated`, and grouping waits until `--update`.
- The archive command is another piece (the marker's `archive` field): `callboard archive sessions` archives the sessions it is
  given that sit in the group it is given, as the sidebar's Archive item does. The panels extension names a lane in Lanes
  only after it saw the lane running and then saw it with no table row and no process, on two clean ticks. So a lane the
  extension never saw running, a parked lane while its row stays, a live lane, a lead you typed, a conductor and the
  manager are never archived. A lead a conductor made is archived the same way when it is retired; one that is closed
  or parked stays listed.
  The plugin drops a row on a retire, 24 hours after a lane died without one and 28 days after a park, so a lane in
  either of the last two cases is archived once its row goes; so is the old conversation of a lane whose session id
  changed (`/clear`). Unarchive in the sidebar brings any of them back.
- The list piece (the marker's `list` field): the sidebar lists the saved conversations of every folder of the window, not
  only the first, so a lead that runs in another repo stays listed after its tab is closed and a click reopens it there. The
  history of the window's other folders is listed too, as the first folder's already is. Each refresh scans those folders
  and reads the tail of each of their chats, so a window whose other folders hold thousands of old chats refreshes more
  slowly. A window with one folder is unchanged.
- An install that differs from what the current script builds shows `outdated` with a
  line saying what differs, or the old warning that a piece is not in. The check compares the installed file with what the current script
  builds from the backup original. `--update` (or `/patch-vs-claude`, which runs it) rebuilds the patch from the backup and
  swaps in `extension.js` and the marker, so no undo and apply by hand is needed; the backup is not touched, and a failed
  write puts the previous patch back. `--undo` stays the way out.
- Claude Code updates about daily, and an update is a new folder that starts unpatched: run the check and `--apply`
  again, or type `/patch-vs-claude` in a session in this checkout: it reports the version and whether the patch is in,
  applies it when it is missing and, when an update moved the code the patch hooks into, asks you before it repairs the
  script in a clone and again before it applies the repair, shows you the diff and opens a PR.
- With the patch, the `+ New session` buttons (the Session Manager's, and the one in a panel's header) in a window with
  several folders open VS Code's own folder list first and start the session in the folder you pick; Escape opens
  nothing. Callboard's own lane opens pass their folder and never ask. The palette's Open in New Tab, Open and an
  @-mention are bare calls that cannot be told from Claude Code's own internal ones: they never ask and start in the
  first folder.
- It serves the lanes of every folder of the window. A tab that Claude Code itself restores or reopens
  resumes in its conversation's folder through the restore fix; where that fix is not in or finds no transcript, it starts in
  the window's first folder.
- The patch is made for 2.1.327, 2.1.328 and 2.1.330; the context pie's anchors fit the code of 2.1.330 (an older script gets every other piece and a
  warning that the pie is left out). A later version may rename or restructure the code it hooks into; then
  `anchors-missing` is printed and nothing is touched, and the panels extension keeps its one-repo-per-window behavior.
- The marker lives in the Claude extension's own folder, so an update (a new folder) drops the
  patch and its marker together, and the panels extension counts the patch only when the marker's checksum matches the
  file beside it. Without the patch, open one VS Code window per repo and use callboard as before. If a patched open
  does not bring up its panel, it fails as the usual open timeout, once.

### Load it in every session

Add this line to the `env` block of `~/.claude/settings.json`, with `<checkout>` written as an absolute path:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "<checkout>/tools/callboard/plugin"
```

- Claude Code applies it to every session it starts: VS Code opened from the Dock, any terminal `claude`, peers and
  background workers. A list separates its entries with `:`, and a folder that does not exist is skipped with a warning.
- Settings ask rules do not gate the plugin's tools, so add none: their own checks are the gate, and `lane_terminate`
  asks for itself.
- If `env.CLAUDE_CODE_PLUGIN_DIRS` already holds another value, keep it and decide by hand. Callboard should be the
  only plugin on this variable: another plugin loaded in a session can run `/callboard` and may answer its dialogs
  (ADR 0002, Consequences).
- The callboard README, Default load (every session), has a one-line command that backs the file up, adds the key
  and shows the diff.

The first test below is the install check: it shows that your own typing changes settings and a model's does not.

### The manager's name and rules

Write the two per-machine files. The first holds the manager's session name, one line; it is what lets the plugin find
the manager, and `MANAGER` stays reserved beside it. On a second Mac use another name, because Remote Control lists every
machine's sessions. The second is optional: your standing rules for the manager in plain prose, up to 8 KB, shown at the
top of its `prompt_list` and in its briefing (a merge right for the sentinel goes here, as a line, and nowhere else).
The folder is one agents cannot write, so you do it:

```
MANAGER_NAME='MANAGER'
mkdir -p ~/.claude/callboard
printf '%s\n' "$MANAGER_NAME" > ~/.claude/callboard/manager-name
touch ~/.claude/callboard/manager-rules.md
```

### A Mac set up before the plugin

The plugin (`<checkout>/tools/callboard/plugin`, [ADR 0012](adr/0012-callboard-plugin.md)) is the only callboard build.
A Mac whose `CLAUDE_CODE_PLUGIN_DIRS` still names an earlier build (`/usr/local/libexec/callboard/mod` or
`<checkout>/tools/callboard/mod`; the checkout holds no `mod` folder) loads no callboard: replace that one entry by hand
with `<checkout>/tools/callboard/plugin`, and never list two callboard folders, because the second one does not load.
Remove an earlier root-owned install too (`sudo rm -rf /usr/local/libexec/callboard`). Then restart every session, VS
Code windows included: a reload is not enough, because the plugin list is read when a session starts, and a
conversation kept open across the change can keep the earlier build's tool definitions. Nothing of the earlier build's
state is read, so each lead takes its lanes back by name with `lane_adopt`, and you give goes again as needed.

### Optional: a conductor across repos

A conductor is one session that opens, starts and closes a lead in each of several repos, so you talk to one session
instead of one per repo ([ADR 0013](adr/0013-conductor.md)). In the conductor's session type:

```
/callboard conductor
```

The first time in a folder, the VS Code window shows a tick list: the window's other folders, ticked this first time, and the git repos
that sit beside the conductor's folder on disk, unticked. It works in a window with one folder. Tick the repos and
press Enter. Escape, or Enter with nothing ticked, changes nothing, and the list closes itself after 80 seconds. It
shows at most 100 rows and takes at most 32 ticks. Callboard saves what you ticked for that session's folder, so any
later conductor session in that folder types the same line and is asked nothing. To change the list, type the next
line: the list comes back with the saved repos ticked.

```
/callboard conductor pick
```

The list needs the panels extension in the window that holds the conductor's folder, as the window's first folder
unless [the patch](#the-claude-code-extension-patch) is applied. When no window takes the request, the
command says so after 30 seconds. Without the extension, type the real path of
each repo instead (at most 16); typed paths replace the saved list.

```
/callboard conductor /Users/x/code/repo-a /Users/x/code/repo-b
```

Only the repos saved are open to the conductor, and only your typed turn, with your own click in the list, changes them.

A repo can be saved before the window lists it, but a lead opens only in a folder the window lists.
Each lead it makes needs a window that answers for its folder: open the conductor's windows as one multi-folder
VS Code window that lists each repo folder exactly as the real path, with [the patch](#the-claude-code-extension-patch)
applied.

The conductor can write that window's workspace file for you. Ask it, with a name for the file, the repos, and the
launcher you open VS Code with when it is not plain `code`. It writes `.archive/NAME.code-workspace` in its own folder
(git ignores `.archive/`): a folder list only, the conductor's folder first, each folder by its real path, with no
settings block. It never overwrites a file that is there; it shows it and asks. Then it hands you one line to run, and
you open the window yourself:

```
code '/Users/x/code/conductor-repo/.archive/NAME.code-workspace'
```

The conductor's folder comes first because Claude Code keeps the session list and its groups under the window's
first folder. A workspace file is a folder list a session writes on your ask, not a settings file: callboard itself
writes none and edits no setting.

A window on a second Claude account works the same when it shares `~/.claude` (the same macOS login); callboard
reads only that folder. Check live, once: the second window's session shows in `/callboard lanes` of the conductor
after it opens, and a lead it makes there opens in its repo's folder within 30 seconds (else `lane_open` says the
window did not answer). [A VS Code per Claude account](#a-vs-code-per-claude-account) says what such a window needs.

To end it, tell the conductor "wrap up": it closes every lead and lane under it. `/callboard lead off` takes the
role away, and the saved list stays for the next time.

### A VS Code per Claude account

VS Code can be started with its own user data folder (`--user-data-dir`), for example by a launcher that keeps one such
folder per Claude account. Callboard does not make such launchers. What it needs from one:

- **The extensions folder is `~/.vscode/extensions`.** `link-extension.py` links and registers the panels extension
  only there, and the patch commands above look for the Claude Code extension there. Windows that share that folder
  share the one link and the one patch; a launcher with another extensions folder gets neither from these steps.
- **The same `~/.claude`.** The panels extension reads callboard's requests and its session table under the `.claude`
  folder of your macOS home, whatever the window's account.
- **The default profile.** Only the default profile's `extensions.json` gets the panels entry.
- **Groups are kept per user data folder.** The record of which sessions the extension has filed in the tier groups
  lives in VS Code's global state, under the window's first folder, so each account's VS Code files its sessions by
  itself and one account's record never marks another's sessions as filed.

### Manager setup: keep agents off the store (by hand)

Why, and what this line does not cover: [callboard README, Manager setup: keep agents off the store
(by hand)](../tools/callboard/README.md#manager-setup-keep-agents-off-the-store-by-hand). Do it now, by hand: an agent
must not edit permission settings, and the `/setup-claude` templates do not carry this line.

Add this line to `permissions.deny` in your global `~/.claude/settings.json` (an `Edit` rule covers the Write tool
too, so no `Write` line is needed; adding one only draws a warning):

```json
"Edit(~/.claude/plugins/store/callboard_*.json)"
```

It keeps an agent's Edit and Write tools off callboard's store file, which holds this machine's callboard settings;
it does not stop a shell write.

### Keep agents off the live checkout

No deny lines are needed for this. The live checkout feeds every session more than the plugin: the extension, the
always-on rule `rules/callboard.md`, `CLAUDE.md`, the skills under `.claude/` and the manager's `docs/`. Its `.git/`
decides what a pull brings and what git runs. ai-toolkit's protected-paths hook, with the `.protected-checkout` marker
in the checkout, denies an agent's writes to it. Agents never need to edit it: they work in `/tmp` clones, and `.archive/` (state,
reports) stays in the checkout. Set the hook and
the markers up as described in [Escalation is on by default once the protected-paths hook is in place](#escalation-is-on-by-default-once-the-protected-paths-hook-is-in-place).
The limits of the hook are listed there too.

### Escalation is on by default once the protected-paths hook is in place

A lead's or the manager's answer to an ask counts only while the guard is in place
([ADR 0012](adr/0012-callboard-plugin.md)): callboard checks at run time (every 60 seconds) that the settings wire a
`PreToolUse` command hook that runs `protected-paths-guard.sh` with hooks not disabled, and that
`~/.claude/callboard/.protected-checkout` exists. While either is missing it refuses every answer from a tier, so the ask
stays with you. The other two markers (`<checkout>` and `<toolkit>`) are the hook's own protection, which callboard does not check. Callboard holds no rule of its own about what an agent may write: no tier is
asked to judge an edit of the live checkouts, of `~/.claude/settings*.json` or of callboard's state folder, because
ai-toolkit's `hooks/protected-paths-guard.sh` denies those before any prompt exists. It never asks, so no prompt is
left for an agent to answer. Until the hook is in place:

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
Once the hook and the markers are in place, tier answers work by themselves. `touch ~/.claude/callboard/OFF` stops
every tier's answers at once; remove the file to allow them again. Do the probe (step 3) before you rely on it.

```
touch ~/.claude/callboard/OFF
```

### The first test

One round, once every session is restarted and the manager session runs ([4. Start the manager](#4-start-the-manager)).
Each step names what you should see; stop at the first one that differs and tell the manager session which.

1. In any new session type this and read the status page, a table of Role, Parent, Manager, Callboard, Keepalive,
   Unattended and Goes. A plain session reads Role `SESSION` and Callboard `ON`; its Parent and Manager name
   the manager session if one runs, else Parent reads `PERSON` and Manager `NONE`.

```
/callboard status
```

2. In the same session, check that your own typing changes settings. Type the first line and see "Callboard setting
   changed", then the second to put the default back (the plugin starts with its own settings, so 50 is the default).
   A model cannot run a `/callboard` command at all (the engine refuses it), and the plugin also refuses a form that
   changes what a session may do unless it came from your own typed turn.

```
/callboard config ping 45
```

```
/callboard config ping 50
```

3. In the manager session, type the status command and check that Role reads `MANAGER` and Parent reads `PERSON`:

```
/callboard status
```

   Then, in a second session that is not the manager and runs in manual permission mode, send this prompt and leave the
   permission card unanswered for a minute:

```
Run this exact command with the Bash tool and nothing else: touch /tmp/callboard-first-test
```

   The manager session gets a `[callboard] Check-in:` turn naming the ask, and its `prompt_list` shows it. Click Deny on
   the card yourself: your click always wins over a tier's answer.

4. Unattended mode: type these three in the manager session, one at a time. The first says no callboard dialog will open at you;
   the second shows the window; the third ends it.

```
/callboard unattended 30m
```

```
/callboard unattended
```

```
/callboard unattended off
```

5. A go: type this in the manager session, then send the prompt below and read the go back. End it at once.

```
/callboard go first test: nothing to do
```

```
Call go_status and read back every go it lists.
```

```
/callboard go off
```

6. A lead and a lane: in a session in a scratch repo type the first line, then send the second as a prompt. The lead
   creates, opens and starts the lane; the lane writes its report, signs it done and tells the lead, which retires it.

```
/callboard lead
```

```
Create a lane named TESTLANE in this folder with the brief "Write hello as the first line of your report, sign it done and stop" using lane_create, then lane_open and lane_start it. When it reports, read its report and call lane_retire on it.
```

7. Off wins: in the scratch session of step 6 type the first line (no pings, nudges, asks or notices, and it is nobody's parent or
   child), then the second to bring it back.

```
/callboard off
```

```
/callboard on
```

## 2. The usage watcher

Details: [tools/usage-watcher/README.md](../tools/usage-watcher/README.md), Install. What the manager does with its
summary: [docs/manager/usage-watch.md](manager/usage-watch.md).

- **It needs the network.** The installer fetches `main` over plain HTTPS from a fixed URL, with no credentials.
  Until it is installed the manager reports "usage summary never created; install pending" and acts on nothing.
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

Only when you are about to install this one: if an older usage-watcher job is loaded under
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

A session reads its rules when it starts, so make the link before you restart the sessions for the default load
(step 1), or restart them once more after it. If `~/.claude/rules/` holds an older keepalive rule from an earlier
setup, unlink it: this rule replaces it.

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
checkout, without `CLAUDE_CONFIG_DIR`, on Opus (`/model opus`), named with `/rename` to the name in
`~/.claude/callboard/manager-name` ([The manager's name and rules](#the-managers-name-and-rules)). The manager is the session that
carries that name, found by its registry name while it is live; there is no manager command and no grant to restore.

Callboard reserves `MANAGER` and the manager's own name. A manager on a second machine needs a different name, because Remote
Control lists every machine's sessions: write that name into `manager-name` on that machine.

## 5. Final check

| Part | Check | Good when |
|---|---|---|
| Live checkout | `git -C <checkout> --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false status -sb` | `## main...origin/main` and nothing else |
| Origin | `git -C <checkout> remote get-url origin` | `https://github.com/notitial/ai-manager.git` |
| Old install gone | `ls /usr/local/libexec/callboard` | No such file or directory |
| Old panels copy | `ls ~/.vscode/extensions \| grep -i local.callboard-panels` | it prints nothing |
| Panels extension | `ls -l ~/.vscode/extensions \| grep callboard-panels` | one link, to `<checkout>/tools/callboard/extension` |
| Panels entry | `/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py` | it prints `already linked` and no `DRY:` line |
| Panels loaded | in VS Code, Output > Callboard Panels | a first line `callboard panels <version>, build <commit>` |
| Claude Code patch | the check under [The Claude Code extension patch](#the-claude-code-extension-patch) | `patched` and no `warning:` line; `outdated` or `unpatched-patchable`: `/patch-vs-claude` |
| Default load | type `! echo $CLAUDE_CODE_PLUGIN_DIRS` in a new session | `<checkout>/tools/callboard/plugin` |
| Plugin loaded | type `/callboard status` in a session | it answers a table of Role, Parent, Manager, Callboard, Keepalive, Unattended and Goes |
| Manager name | `cat ~/.claude/callboard/manager-name` | the manager session's name |
| Deny line | read `permissions.deny` in `~/.claude/settings.json` | the store line is there |
| Protected-paths hook | `jq -e '[.hooks.PreToolUse[]?.hooks[]?.command] \| any(. == "/bin/bash -p \"$HOME/.claude/hooks/protected-paths-guard.sh\" \|\| exit 2")' ~/.claude/settings.json` (a rough pre-check: it finds the command the toolkit writes and does not look at the matcher, `disableAllHooks`, `env` or the entry's other fields), and `ls <checkout>/.protected-checkout <toolkit>/.protected-checkout ~/.claude/callboard/.protected-checkout` | `true`, and all three markers exist; a tier's answers count only while this holds |
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
VS Code. The patch of the Claude Code extension is built by the script in the checkout, so after a fast-forward run
its check ([The Claude Code extension patch](#the-claude-code-extension-patch)): on `outdated`, type `/patch-vs-claude`
(or run the script with `--update`) and reload each window. After an update of the Claude Code extension itself the new
folder starts unpatched: run the check and `--apply`, or `/patch-vs-claude`, again. Restart every session. Before
you turn unattended mode on, restart every session started before the update: a lane and a tier both on older code
can still relay a prompt to you. For the usage watcher, run its installer again with the new `--ref`.

## The guided way

Type `/setup-manager` in a session in this checkout. The skill
([.claude/skills/setup-manager/SKILL.md](../.claude/skills/setup-manager/SKILL.md)) runs the read-only checks and
the dry runs itself, the patch's check among them, shows you every `--apply`, settings edit, link and `launchctl
bootout` as an exact command to run, sends you to `/patch-vs-claude` for the patch, and ends with a status table.
