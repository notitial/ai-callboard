---
description: "Check the installed Claude Code VS Code extension for callboard's cwd patch, apply it when it is missing, and repair the patch script when an update moved the code it hooks into. The patch lets one multi-folder VS Code window open lanes in any of its folders. Use on '/patch Claude' after the Claude Code extension updated."
disable-model-invocation: true
---

# /patch Claude

Keeps `tools/callboard/patch-claude.py` applied to the person's Claude Code extension. The script is the only place that
knows what the patch is, how it is checked and how it is undone: read its header first, and never copy its logic here.
The person's own typed `/patch Claude` is the go for the one apply in step 3 and for nothing else. The argument must be
exactly `Claude`; anything else, say what the skill does and stop.

Never touch `~/.claude/settings.json`, any VS Code setting, or callboard's state or ledger files. Tell the person the
exact file, backup and marker whenever something is changed.

1. **Find the folder.** List `~/.vscode/extensions/anthropic.claude-code-*` with `ls -d` and take the newest version
   (`sort -V`). If two platform builds of the newest version exist, ask which one. `<checkout>` is this session's repo
   (`pwd -P`); it must match `^/[A-Za-z0-9._/-]+$` or stop.
2. **Check.** Run `/usr/bin/python3 -I <checkout>/tools/callboard/patch-claude.py "<folder>"` (no flag: changes nothing).
   The first word of its output is the state; show it with the version.
3. **`unpatched-patchable`:** run the same command with `--apply`. Say the version, that `extension.js` was changed with
   its backup `extension.js.callboard-orig` and marker `callboard-cwd-patch.json` in that folder, and that each VS Code window
   needs Developer: Reload Window.
4. **`patched`:** say so and stop.
5. **`anchors-missing`:** an update moved the minified code. Nothing was changed. Repair it in a clone, never in the live
   checkout:
   - Clone the repo to `/tmp/ai-manager-patch-<version>` (a plain clone, git MCP with `path`), on a branch `fix/claude-patch-<version>`.
   - Read the new `extension.js` read-only (it is one huge line: use `grep -o` with a bounded context, never print the file) around the
     strings the missing anchors name: `createPanel(`, `setupPanel(`, `"claude-vscode.editor.open"`. Change only the patterns in
     `ANCHORS`, so each matches exactly once in the new file and still in the old fixtures; add a stand-in variant to
     `test_patch_claude.py` for the new shape.
   - Run `/usr/bin/python3 -I tools/callboard/test_patch_claude.py`, then the repaired script on a COPY of the extension folder
     under `/tmp` (`cp -R`), and `node --check` on the patched copy's `extension.js`.
   - Show the person the diff of the script and the result on the copy, then ask once with AskUserQuestion: apply the repaired script
     to the real install (recommended when the copy checks out; the consequence is the same one-file change as step 3), or leave it unpatched
     (one repo per window as before). Only on a yes, run the repaired script from the clone with `--apply`.
   - Push the branch and open a PR with the repair (title `fix: patch the new Claude Code extension`); the merge is the person's. Until
     it is merged, the live checkout's script still fails on that version.
6. **Never leave a half patch.** The script refuses to patch unless every anchor matches and puts the original back when a write fails. If
   anything is doubtful afterwards (a state the check does not name, a `leftovers` state, a failed write), run `--undo`, report what
   it printed, and stop. `--undo` restores the original from the backup and removes the backup and the marker.
