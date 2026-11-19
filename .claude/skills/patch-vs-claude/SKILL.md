---
description: "Report whether callboard's patch of the Claude Code VS Code extension is in and current, apply it when it is missing, and, only after one question, repair the patch script when an update moved the code it hooks into. The patch lets one multi-folder VS Code window open lanes in any of its folders and ask which folder a new session starts in. Use on '/patch-vs-claude' after the Claude Code extension updated, and '/patch-vs-claude undo' to take the patch out."
disable-model-invocation: true
---

# /patch-vs-claude

Keeps `tools/callboard/patch-claude.py` applied to the person's Claude Code extension. The script is the only place that
knows what the patch is, how it is checked and how it is undone: read its header first, and never copy its logic here.
The person's own typed `/patch-vs-claude` is the go for the one apply in step 3, and for the undo (it only puts the
original back), and for nothing else. The argument is empty or `undo`; anything else, say what the skill does and stop.

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
   (the first word of the output: `patched`, `unpatched-patchable`, `anchors-missing` or `leftovers`) and whether the marker
   `callboard-cwd-patch.json` is in that folder.
3. **`patched`:** say so and stop. **`unpatched-patchable`:** run the same command with `--apply`, say the version and what
   was changed (`extension.js`, backup `extension.js.callboard-orig`, marker `callboard-cwd-patch.json`, all in that
   folder), and that each VS Code window needs Developer: Reload Window.
4. **The check or the apply refuses** (`anchors-missing`: an update moved the minified code; nothing was changed): ask once
   with AskUserQuestion whether you may diagnose it and repair the script. Recommend yes. A yes means: read the new
   `extension.js` read-only, change the script's patterns and its test in a /tmp clone, test on a copy of the extension
   folder, show a diff, and open a PR so the repair is kept for the next update. A no leaves callboard at one repo per window.
   Only on a yes:
   - Clone the repo to `/tmp/ai-manager-patch-<version>` (a plain clone, git MCP with `path`), on a branch `fix/claude-patch-<version>`.
   - Read the new `extension.js` (one huge line: use `grep -o` with a bounded context, never print the file) around the
     strings the missing anchors name: `createPanel(`, `setupPanel(`, `"claude-vscode.editor.open"`. Change only the patterns in
     `ANCHORS`, so each matches exactly once in the new file and still in the stand-in fixtures; add a stand-in variant to
     `test_patch_claude.py` for the new shape.
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
