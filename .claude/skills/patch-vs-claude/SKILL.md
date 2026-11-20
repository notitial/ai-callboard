---
description: "Report whether callboard's patch of the Claude Code VS Code extension is in and current, apply it when it is missing, bring it up to date when an older version of the script built it, and, only after a question, repair the patch script when an update moved the code it hooks into. The patch has six pieces: the folder patch, which lets one multi-folder VS Code window open lanes in any of its folders and ask which folder a new session starts in; the panel width, a wider composer; the context pie, which shows the composer's context pie always, as one ring, against your autocompact level (it also edits webview/index.js); the restore fix, which makes a restored or reopened panel resume in its conversation's folder; the group command `callboard assign group`, with which the panels extension files a lead's and a lane's sessions in the Session Manager's Lead and Lanes groups; and the session command `callboard active session`, with which the folder badge finds the panel in front. Use on '/patch-vs-claude' after the Claude Code extension updated, and '/patch-vs-claude undo' to take the patch out."
disable-model-invocation: true
---

# /patch-vs-claude

Keeps `tools/callboard/patch-claude.py` applied to the person's Claude Code extension. The script is the only place that
knows what the patch is, how it is checked and how it is undone: read its header first, and never copy its logic here.
The person's own typed `/patch-vs-claude` is the go for the one apply or update in step 3 (the same one-file change
either way: `extension.js`, its backup and the marker in the extension's folder), and for the undo (it only puts the
original back, which step 5 may run on a doubtful result), and for nothing else. The argument is empty or `undo`; anything else, say what the skill does and stop.

Never touch `~/.claude/settings.json`, any VS Code setting, or callboard's state or ledger files. Say exactly what was
changed and where (the file, its backup and the marker) whenever something is changed.

**`/patch-vs-claude undo`:** do step 1, run the script with `--undo` and nothing else, say what it printed (the original
`extension.js` is back, the backup and marker are gone) and that each VS Code window needs Developer: Reload Window.
Callboard is then back to one repo per window. This is the person's way out at any time.

1. **Find the folder.** List `~/.vscode/extensions/anthropic.claude-code-*` with `ls -d` and take the newest version
   (`sort -V`). If two platform builds of the newest version exist, ask which one. `<checkout>` is this session's repo
   (`pwd -P`); it must match `^/[A-Za-z0-9._/-]+$` or stop. The folder must contain no single quote or newline, or stop.
2. **Check and report first.** Run `/usr/bin/python3 -I <checkout>/tools/callboard/patch-claude.py '<folder>'` (single
   quotes; no flag: changes nothing). Tell the person, before anything else: the extension version, whether it is patched
   (the first word of the output: `patched`, `outdated`, `unpatched-patchable`, `anchors-missing` or `leftovers`), whether the marker
   `callboard-cwd-patch.json` is in that folder, and, when the output has a `warning:` line, which optional piece (the panel width, the wider composer;
   the context pie and the folder pill, which also edit `webview/index.js`; the restore fix, which makes a restored panel resume in its folder; or the group command
   `callboard assign group`, which files lead and lane sessions in the Session Manager's groups; or the session command
   `callboard active session`, which lets the folder badge find the panel in front) is not in or would be left out while the folder patch still applies.
3. **`patched`:** is up to date (an older build reads `outdated`, below): say so, with the warning if there is one, and stop. **`outdated`:** an older version of the script
   built the patch. Say what the line after the colon says differs, then run the same command with `--update` (it rebuilds the
   patch from the backup original and swaps `extension.js` and the marker; the backup is not touched; a failed write puts the
   previous patch back), say what it printed and that each VS Code window needs Developer: Reload Window. If `--update`
   refuses, nothing was changed: report its message and stop. **`unpatched-patchable`:** run the same command with `--apply`, say the version and what
   was changed (`extension.js`, backup `extension.js.callboard-orig`, marker `callboard-cwd-patch.json`, and, when the pie or the pill went in, `webview/index.js` with its backup `webview/index.js.callboard-orig`, all in that
   folder), whether the width block, the context pie, the folder pill and the restore fix went in (a `warning:` line says which did not), and that each VS Code window needs Developer: Reload Window.
4. **The check or the apply refuses** (`anchors-missing`: an update moved the minified code; nothing was changed): ask once
   with AskUserQuestion whether you may diagnose it and repair the script. Recommend yes. A yes means: read the new
   `extension.js` read-only, change the script's patterns and its test in a /tmp clone, test on a copy of the extension
   folder, show a diff, and open a PR so the repair is kept for the next update. A no leaves callboard at one repo per window.
   Only on a yes:
   - Clone the repo to `/tmp/ai-manager-patch-<version>` (a plain clone, git MCP with `path`), on a branch `fix/claude-patch-<version>`.
   - Read the new `extension.js` (one huge line: use `grep -o` with a bounded context, never print the file) around the
     strings the missing anchors name: `createPanel(`, `setupPanel(`, `"claude-vscode.editor.open"`. Change only the anchor
     patterns: `ANCHORS` and the one each optional piece has beside it (`CSS_ANCHOR`, and any other `*_ANCHOR` or `*_ANCHORS`
     the script's header names), so each matches exactly once in the new file and still in the stand-in fixtures; add a
     stand-in variant to `test_patch_claude.py` for the new shape.
   - Run `/usr/bin/python3 -I tools/callboard/test_patch_claude.py`, then the repaired script on a COPY of the extension folder
     under /tmp (`cp -R`), and `node --check` on the patched copy's `extension.js`.
   - Show the person the diff and the result on the copy, then ask once more with AskUserQuestion: apply the repaired script to
     the real install (recommended when the copy checks out; the same one-file change as step 3), or leave it unpatched. Only on
     a yes, run the repaired script from the clone with `--apply`.
   - Push the branch and open a PR (title `fix: patch the new Claude Code extension`); the merge is the person's. Until it is
     merged, the live checkout's script still fails on that version.
5. **Never leave a half patch.** The script refuses to patch unless every anchor matches and puts the original back when a write
   fails. If anything is doubtful afterwards (a `leftovers` state, a failed write, a result you cannot explain), run `--undo`,
   report what it printed, and stop.
