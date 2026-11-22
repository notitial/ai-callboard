# Changelog

The version stays fixed between these entries: a change to the code is an update of the checkout plus a window reload, not a new version.

## 1.8.0

- The status bar item that named the folder of the Claude panel in front is removed, and with it the patch's `callboard active session` command that only it used (the folder pill in the composer stays). An install patched before reads `outdated` until `/patch-vs-claude` brings it up to date.
- The earlier request files under `~/.claude/callboard/open/` (`<NAME>.open`, `.reopen`, `.close` and `.lead`), the lead records in `~/.claude/callboard/lead-records/` and the limits on opens (a gap per name, 8 live sessions per repo, 6 opens a minute) are gone. The extension reads one spool, `~/.claude/callboard/v2/open/`, with a JSON `<id>.req` per request. The entries from 1.0.0 to 1.4.0 below describe the earlier files as they were.
- The "Callboard Lanes" view and its command `callboardPanels.openLane` are removed. Claude Code's own Session Manager list takes its place: with the patch's group, archive and list pieces, callboard files its live sessions by tier, archives a retired lane, and keeps the closed sessions of every window folder listed. A lane's state and its lead are in `/callboard lanes`. The manifest loses `contributes.views`, so this version needs the quit, pull, `link-extension.py --apply` update.
- The record of which group each session was filed in, and the record of lanes seen running, are kept in the extension's global state under the window's first folder, where Claude Code keeps the groups themselves, in place of the workspace state. So a second account that shares the workspace state no longer reads sessions as filed while its own group list is empty. The old record is not read: after the update each live session is filed in its tier's group once more (one moved by hand goes back to its tier's group that one time), and a lane that was seen running before the update and is retired before the first tick after it is not archived.
- At window start the side bar switches to Claude Code's Session Manager, and the keyboard focus goes back to the editor. Claude Code shows that view only once it has started, so VS Code falls back to the Explorer at a restart; this brings it back. It runs in every window at every start and reload, opens a closed side bar, and does it once more 2 seconds later, which moves the keyboard focus to the editor from wherever it is then.
- A `pin` request on the spool (`pin.js`): when you type `/callboard lead`, `/callboard conductor` or a lead preset's command and it saves, the window that serves the folder pins the active tab, only when that tab is a Claude panel. It is not answered, and a request older than a minute is dropped. A window reload is enough; the manifest is unchanged.

## 1.7.0

- The "Callboard Lanes" view starts collapsed (`visibility: collapsed` on both view entries; VS Code applies it the first time the view appears). Its "Recent chats" groups show each chat's real title, read from the transcript the way Claude Code's own list reads it (the last rename, else the generated title), and leave out a chat with no readable title instead of showing an id. The package description no longer names the old mod. The manifest changes, so this version needs the quit, pull, `link-extension.py --apply` update.

## 1.6.0

- The lane view sits in Claude Code's Session Manager, below its session list, when that list is on (`claude-vscode.sessionsListEnabled`), and in the Explorer otherwise: two view ids for one tree. It lists only the sessions of the window's served folders, shows a waiting session as the live dot in orange, and puts a session whose lead chain comes back to it at the top. The groups are filed from the plugin's session table too. The folder badge finds the panel in front by its session id through the patch's session command (`callboard active session`), so an unnamed session shows its folder too; without that piece it matches the tab label as before. The manifest changes, so this version needs the quit, pull, `link-extension.py --apply` update.

## 1.5.0

- A "Callboard Lanes" tree in the Explorer lists every callboard session the records know, with its state, under the lead that owns it, and each window folder's recent Claude conversations; a click reopens one in its own folder. The manifest gains `contributes.views`, so this version needs the quit, pull, `link-extension.py --apply` update.

## 1.4.0

- A `<NAME>.reopen` request may name a lead, for a conductor's `lead_unpark`: when no lane carries the name, the lead records in `~/.claude/callboard/lead-records/` are read (with the rules the mod reads them by; one bad record refuses its whole file), the record must name the session id the request carries (`error sid-mismatch` otherwise) and be parked at most 28 days ago (`error not-parked` otherwise), and the lead's repo must be the window's first workspace folder. A lane of exactly that name comes first, so a lead record never blocks a lane's reopen; a lane of the name in another letter case makes it `error unknown-lane`. The same limits as a lane's reopen apply.
- An older extension answers a lead's reopen `error unknown-lane` at once; the mod then says this version is needed. Park, retire and force stop of a lead work with older versions.

## 1.3.3

- A lane's open answers with the session id its panel keeps: the new panel's registry row is followed by its pid until its session id has held for 2 s, in place of answering with the first id seen (a panel can rewrite its row with another id soon after it registers, and the first id then names no session). An id that has not held when the wait ends is a `timeout`, and the panel stays tracked as late. The lead's tab gets focus back as soon as the panel registers.
- A lane's open waits up to 20 s for its panel, in place of 5 s. The mod's wait for `lane_open` is 45 s with this version (it was 8 s), enough for one open queued behind another. While a lane's panel is being waited for the window handles no other request, as for a lead's panel.

## 1.3.2

- A `<NAME>.close` request may carry the lane's folder as a fourth line, and then needs no lane record: the tab of a retired or terminated lane closes even though the record is gone before the next scan. The three-line form still works while the lane is listed. The body limit is 1200 bytes.

## 1.3.1

- Docs only: the README and the package description say the extension also opens a new lead's panel for a conductor, and the README no longer shows the icon inline (it appeared broken on the details page).

## 1.3.0

- A `<NAME>.lead` request waits up to 45 s for its panel to register, in place of 5 s, so a slow cold window has room. A fast open still answers at once. Other requests keep their 5 s.
- While a lead's panel is being waited for (up to 45 s) the window handles no other request; they are handled once it ends.
- The answer to a `<NAME>.lead` request carries the request's nonce: `ok <sid> <nonce>`. Errors and the other requests are unchanged.
- Once this version is linked, restart every conductor session before it calls `lead_open`: a conductor still running the older mod refuses the answer with the nonce (the panel opens, but the conductor is told the open failed and the offer is voided).

## 1.2.0

- Handles `<NAME>.lead` requests from a conductor's `lead_open`: one line naming the repo, answered on `<NAME>.result` like an open. A window opens a panel only when the repo is its first workspace folder and its own real path; a request for another window's repo is left in place. The same limits as an open apply (a gap per name, 8 live sessions per repo, 6 opens a minute).

## 1.1.0

- Removes the commands `callboard.open`, `callboard.reopen` and `callboard.close` and the `close` function behind the last one. The mod never called them: it reaches the extension through the request files under `~/.claude/callboard/open/`, which are unchanged. Panels still open, reopen and close as before.

## 1.0.1

- Reads lanes only from the lane store. The root-owned lane list is gone.
- Installs as a link to the checkout (`link-extension.sh`) instead of a copy.

## 1.0.0

- Opens a lane panel on a lead's request and returns its session id.
- Reopens a parked lane's own conversation.
- Closes a finished lane's tab once its session has ended.
- Registers three commands (`callboard.open`, `callboard.reopen`, `callboard.close`), grouped under "Callboard" and hidden from the Command Palette. The mod does not call them (removed in 1.1.0).
