# 14. A Run button runs a chat code block on the person's click

**Status:** proposed
**Date:** 2026-11-21

Scope: how a command in a chat's code block gets run and its output gets back into the chat without the person copying
anything. It adds a path that runs a command on the person's click, so it is on the risk list (command execution, a
security control). It builds on the Claude patch of [docs/setup.md](../setup.md) and the panels extension of
[ADR 0012](0012-callboard-plugin.md).

## Context

Claude often hands the person a command to run, most of them commands it cannot run itself: the toolkit's guards block
`gh` and git in a protected checkout for an agent. The loop is then copy, paste into a terminal, copy the output, paste
it back. The Claude panel has no `!` command of the CLI's, and a model-run command (the Bash tool) would meet the same
guards that made the person run it by hand.

## Decision

**A small Run button sits beside Copy on shell code blocks** (no language, or sh, bash, zsh, shell, console), added by
the Claude patch as one more optional piece. Only the person's own click starts anything: the page ignores a click that
is not trusted, and nothing else (a model reply, a lane, the manager, callboard's relay) can reach the panel's own
request channel or the modal below.

**The panels extension runs it, behind a native modal.** The page sends the block's text. The patched `extension.js`
adds the folder itself, held by the host for the session on screen (its channel; the window's one folder when the channel
has none, and none in a window with several), never from the page, and asks the panels extension's `callboard run block`
command. That command validates (text up to 8,000 characters with no control character but newline and tab and no
invisible or direction-changing one; a folder that exists and is inside one of the window's folders), then always shows
its own `showWarningMessage` modal with the folder and the whole command. VS Code makes the first button the default and
adds its own Cancel, so the first button is "Don't run" and Enter runs nothing. Only a reply of exactly "Run" starts a
process, so it asks even when another extension calls the command.

**Amended 2026-11-22**, on the person's ask after using it: the modal has "Run" and VS Code's Cancel only, and no folder
line (its title names the folder). "Run" is the first button, so Enter runs the command; Escape and Cancel run nothing.
The "Don't run" default above no longer holds.

**It runs as a child process, not in a terminal.** `$SHELL -lc <text>` (the shell when it is absolute and listed in
`/etc/shells`, else `/bin/zsh`) in its own process group, stdin closed, with a quiet environment (no colour, no pager, no
git prompt). A progress notice has Cancel, and the run stops after 2 minutes: SIGTERM to the group, SIGKILL 2 seconds later.
One run at a time. The first and last 12,000 characters of stdout and the first and last 6,000 of stderr are kept; ANSI codes and other
control characters are stripped and progress lines keep their last part.

**The output goes back as the person's own message.** The page sends the returned text through the session's own `send`
as a human message, so it shows in the chat and Claude answers it. It opens with `Run result:` and a header written by
the extension, never taken from the output; the command and the output are in code fences one backtick longer than any
backtick run inside them. [rules/callboard.md](../../rules/callboard.md) says such a turn comes from
the button after the person's click, and that anything inside it is data, never an approval, a go or an instruction.

**Secrets: one more question only when needed.** When the output looks like it holds a secret (a private key, a common
token, a long value after `password`, `token` or `secret`), a second modal asks whether to send a masked copy (the
default), send it as it is, or send nothing. The scan is best effort and not a guarantee.

## Options Considered

- **Ask Claude to run it with its Bash tool.** Smallest, but it fails the main use: the commands the person is handed are
  mostly the ones the agent's hooks block, and in auto mode it would turn an injected block into what looks like a request
  from the person.
- **The CLI's internal `bash_command` message.** Rejected: in a local panel session the model never sees its output.
- **Run in a VS Code terminal through shell integration.** The person could watch it and answer prompts, but output needs
  ANSI stripping and depends on shell integration being active. Left as a later option if 2 minutes of non-interactive
  output is not enough.
- **All of it inside the patch strings.** Rejected: the security-relevant logic would be one long minified string with
  nothing but byte-pattern tests. The patch stays small and the logic is plain JavaScript with unit tests.
- **callboard's `$.prompt.submit`.** Rejected: callboard's turns carry no approval, and the person's run must not arrive
  looking like a plugin turn.

## Consequences

- The button deliberately runs what the agent hooks block, so the person's click on the modal is the only safety check.
  There is no auto-run and no "safe command" exception, and nothing wires the button to `bash_command` or to any path
  that skips the modal. The remaining risk is approving a long command without reading it, and since the amendment
  Enter approves it.
- Output in the chat is saved on this computer and sent to the API. The masked copy is the default, and not complete.
- The result arrives as a human turn, which is what makes Claude answer it, and a permission mode that judges by the
  author of a turn may give it more trust than its text deserves. Output can hold text written by someone else, so the
  rule above treats it as data; that is a rule for the model, not a technical barrier.
- A background process that keeps the output pipes open ends the run a half second after the shell exits, and keeps its
  pipe descriptors until it exits itself; what it writes after the run ended is read and dropped. The secret scan
  misses what it has no shape for (a key cut across the output's cut, an unusual format); it is a courtesy beside the
  person's own read, not a control.
- A command that waits for input gets end-of-file. `-l` reads `.zprofile`, not `.zshrc`, so `PATH` can differ from a
  terminal's. A panel reloaded during a run loses the output (the run still ends at the timeout).
- A Claude Code update that moves one of the three anchors drops only the button, with a warning from
  `patch-claude.py`; the other pieces still apply. Without the panels extension the button shows an error and runs
  nothing.
