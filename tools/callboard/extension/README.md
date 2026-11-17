# Callboard Panels

Callboard Panels is the VS Code side of **callboard**, the Claude Code mod that lets one session (a *lead*) run other sessions (*lanes*) in the same repo. The mod handles the cues. This extension opens and closes the Claude Code panels the lanes live in, and opens the panel of a new lead for a conductor.

## What it does

- **Opens a lane.** A lead's `lane_open` writes a request under `~/.claude/callboard/open/`. The window whose first folder is that lane's folder opens one Claude Code panel, finds its session id by diffing the session registry (one open at a time) and answers with it. The lead then names it and starts it.
- **Opens a new lead.** A conductor's `lead_open` writes `<NAME>.lead` (one line naming the repo). The window whose first folder is that repo opens a panel the same way and answers on `<NAME>.result`, with the request's nonce.
- **Reopens a parked lane.** For `lane_unpark`, it answers `<LANE>.reopen` (the saved session id, one line) by reopening that exact conversation as a panel, but only when the lane's record names that session id.
- **Reopens a parked lead.** For a conductor's `lead_unpark`, it answers `<NAME>.reopen` the same way when no lane carries the name: the lead's record under `~/.claude/callboard/lead-records/` must name that session id, and the lead's repo must be the window's first folder.
- **Closes finished panels.** Every 2 seconds it checks the panels it opened and closes a panel's tab once that session's registry entry is gone and its process is dead. It closes one matching Claude tab only and never a panel with a reserved name. The conversation history stays.
- **Closes the tab of a stopped lane.** After `lane_retire`, `lane_park` or `lane_terminate` (or a conductor's `lead_park`, `lead_retire` or `lead_terminate`) sent the signal, the lead's mod also writes `~/.claude/callboard/open/<LANE>.close` (session id, pid and lane name, three lines). The window that has the lane folder open adds that panel to the same sweep, so the tab of an attached lane, or one resumed by hand, closes too, under the same rules. Nothing is answered and nothing happens in a terminal. A request is written only when the signal exited 0, and an adopted panel that no registry entry shows within 5 minutes is dropped.

It doesn't touch the terminal, any setting or the network. It reads and writes request files under `~/.claude/callboard`, reads `~/.claude/sessions` and the lane store under `~/.claude/callboard/lanes`, and runs `/bin/ps` to check a session's process.

## Requirements

- The **Claude Code** extension (`anthropic.claude-code`). It's declared as a dependency.
- The **callboard mod**, loaded from your checkout of the ai-manager repo. This extension is a link into the same checkout, made once by callboard's `link-extension.py`. It isn't on the Marketplace.

## Things to know

- **One repo per window.** Claude Code opens a new panel in the window's *first* folder, so a window answers only for lanes in that folder. In a multi-root workspace, lanes of the other folders need their own window.
- **Limits.** At most 6 panels a minute. A lane made by a lead is refused when its repo already has 8 live sessions. A lane that already has a live session is refused.
- **Focus stays put.** A panel it opens doesn't keep focus: the tab you were on comes back.
- **A closed lane is not left unread.** Claude Code marks a session unread, and counts it as active in its session list, when its last turn ended in a tab that was not showing. Before it closes a stopped lane's tab that is hidden, this extension shows that tab for a moment (about a third of a second), then closes it and puts the tab you were on back in front. For that moment the keys you type go to the closing tab, and if you were in a terminal or a side bar, focus ends in the editor tab that was in front. A tab you closed yourself before that keeps its mark: use Mark as read in the session list.

## Updating

The version is fixed, so an update is a pull of the checkout plus a window reload (Developer: Reload Window). Output > Callboard Panels shows the build the window loaded. Only a change to this folder's `package.json` needs a version bump: then quit VS Code (Cmd+Q), pull, run callboard's `link-extension.py --apply` from a plain Terminal, and reopen VS Code.

More in the callboard README in the [ai-manager repo](https://github.com/notitial/ai-manager).
