# Changelog

## 1.4.0

- A `<NAME>.reopen` request may name a lead, for a conductor's `lead_unpark`: when no lane carries the name, the lead records in `~/.claude/callboard/lead-records/` are read (with the rules the mod reads them by; one bad record refuses its whole file), the record must name the session id the request carries (`error sid-mismatch` otherwise), and the lead's repo must be the window's first workspace folder. A name a lane and a lead both carry, in any letter case, is answered `error unknown-lane`. The same limits as a lane's reopen apply.
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
