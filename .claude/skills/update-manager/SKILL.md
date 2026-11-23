---
description: "Update this machine to the newest ai-manager: fast-forward the live checkout after the person has seen what comes in, show what changed, then run /setup-manager. Run from the ai-manager checkout, usually when the session-start reminder announced a release. Use on '/update-manager'."
disable-model-invocation: true
---

# /update-manager

Callboard loads from the live checkout ([ADR 0003](../../../docs/adr/0003-symlinked-install.md)), so an update is a
fast-forward plus `/setup-manager`. This skill does both and shows what changed in between. It changes nothing when a
check fails, and it pulls only after the person has seen what is coming in.

Git calls go through the git MCP tools with `path` set to this checkout (the folder three levels above this skill).
The pull is `git_pull` with `fastForwardOnly: true` and no branch or remote, the one form
`hooks/protected-paths-guard.sh` lets through. It is the only change this skill makes to the checkout, and an
exception to `/setup-manager`'s rule never to pull there.

## Steps

1. **Note the old version.** `git_tag` list, then the highest plain version tag (`vX.Y.Z`) that `HEAD` contains: for
   each candidate from the highest down, `git_log` with `branch: "HEAD..<tag>"` and `maxCount: 1` must be empty (a
   fetch can bring newer tags that `HEAD` does not have yet). None qualifies: no old tag. Then `git_log` with
   `maxCount: 1`: the old `HEAD` sha.
2. **Check.** `git_remote` with `mode: "get-url"` and `name: "origin"` must give `https://github.com/notitial/ai-manager.git`, else stop. `git_status`:
   the first line must be `## main...origin/main` (the branch is `main` and tracks `origin/main`, which is what the
   pull follows), with no change or untracked file under it. `git_fetch` with `tags: true`, then `git_log`
   of `origin/main..HEAD` (the `branch` parameter takes the range): it must be empty, since a local commit means a
   fast-forward is impossible. `git_log` of `HEAD..origin/main` is what the pull brings: if it is empty too, say
   "ai-manager is already up to date." and stop. Any other failure ends the skill with the refusal below.
3. **Show what comes in, and ask.** `git_log` of `HEAD..origin/main` with `oneline: true` and `maxCount: 20`, then
   `git_diff` with `stat: true`, `source: "HEAD"`, `target: "origin/main"`. Say which commit `origin/main` is (the full
   sha) and that the full diff is one command away
   (`git -C <checkout> --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false log -p --no-textconv --no-ext-diff HEAD..origin/main`,
   the hardened form from docs/setup.md, By hand, with `HEAD..origin/main` as the range).
   A change under `tools/callboard/` or `rules/` reaches every session, so ask once: "Pull these commits?". Only a
   yes in the person's own turn goes on; anything else ends the skill with the refusal below (`Not updated: you did
   not confirm.`).
4. **Pull:** `git_pull` as above. If it fails, the refusal below. Then `git_log` with `maxCount: 1`: the new `HEAD`
   must be the sha named in step 3. If it is not (the pull fetched again and found a newer commit), stop here: do not
   run `/setup-manager`, which would follow the pulled skill text and scripts. List the extra commits (`git_log` of
   `<sha from step 3>..HEAD`, `oneline: true`) and end with the unseen closing below (`<new>` found as in step 5).
5. **Show what changed.** The new version: the highest plain version tag `HEAD` contains, found as in step 1. Then
   `git_diff` with `nameOnly: true`, `source: "<old sha>"`, `target: "HEAD"`: note whether any path starts with
   `tools/callboard/` or `rules/`. Print one line now, `Pulled ai-manager <old> -> <new>.`, because `/setup-manager`
   can ask the person to quit VS Code, which ends this session before step 7.
6. **Run `/setup-manager`** with the Skill tool and let it finish, including its questions to the person.
7. **Close.** Your last message is only the closing below, nothing after it. Pick the closing by how `/setup-manager`
   ended: the stopped one whenever it stopped early, failed or was declined, the others only when it finished.

## The closing

The last message is two or three lines and no more. Nothing follows it, not a summary and not an offer.

Read `/setup-manager`'s final status table as it stands: a row that is not ok, or a command it showed the person that
they have not run (the settings entry, `/patch-vs-claude`, the usage watcher's `--apply`, a link, a `touch`), is
something left.

If `/setup-manager` finished and nothing is left for the person:

```
Updated ai-manager <old> -> <new>. Setup done.
```

If something is left, list it in the second line, only what applies and in this order: each open item `/setup-manager`
showed, named in a few words (for example `run /patch-vs-claude`, `run the usage watcher --apply shown above`, `copy
the settings entry shown above`), then `reload each VS Code window and restart your sessions` (when step 5 found a path
under `tools/callboard/` or `rules/`):

```
Updated ai-manager <old> -> <new>.
Last step: <the actions, joined with "then">.
```

If `/setup-manager` stopped before it finished (a missing prerequisite, a failed check, a stop the person declined),
the checkout has already moved, so say that and not "done":

```
Pulled ai-manager <old> -> <new>, but /setup-manager did not finish: <reason>.
Fix that, then run /setup-manager.
```

If step 4 found commits that were not shown (nothing else runs after it):

```
Pulled ai-manager <old> -> <new>, but <N> commits came in that you did not see: <their titles>.
Read them, then run /setup-manager.
```

A version with no tag is its short sha (the first 7 characters), also when `HEAD` is ahead of its last tag: write
`<tag> (<sha>)` then. A refusal (step 2, 3 or 4) is one line saying what blocked it and one line saying
what to do, for example `Not updated: the checkout has uncommitted changes.` and `Commit or stash them, then run
/update-manager again.` (For a declined step 3 the second line is `Run /update-manager again when you want to
update.`) A refusal and the stopped closing never end on a success line.
