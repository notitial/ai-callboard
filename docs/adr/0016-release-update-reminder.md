# 16. A weekly release reminder and an agent-run update

**Status:** proposed
**Date:** 2026-11-23

Scope: how a machine learns that a newer ai-manager release exists, and who moves the live checkout to it. It reuses
ai-toolkit's release check ([ai-toolkit ADR 0019](https://github.com/notitial/ai-toolkit/blob/main/docs/adr/0019-release-update-check.md))
and amends [ADR 0003](0003-symlinked-install.md): the live checkout, which callboard loads from, so far moved only by
a fast-forward the person ran.

## Context

Callboard loads from the live checkout, so an update is a fast-forward of it (ADR 0003). Nothing tells a machine that
there is something to pull, and v0.1.0 marks the first version worth moving to. ai-toolkit already ships a script
that asks GitHub for a repo's latest release once a week and prints a one-line reminder, takes the checkout and the
update command as arguments, and reads the repo from `origin`.

## Options Considered

- **Copy the script into this repo.** A second copy to keep in step, for a machine that has ai-toolkit anyway: it is the
  base install (`docs/setup.md`, Prerequisites). Rejected.
- **A reminder with no update skill.** The person would still type the pull by hand from `docs/setup.md`, Updating,
  and run `/setup-manager` after it. Kept as the fallback, and the way to install one specific reviewed commit.
- **The script from ai-toolkit plus an `/update-manager` skill: chosen.**

## Decision

- **The reminder is ai-toolkit's script, wired by a second `SessionStart` entry** that `/setup-manager` shows the
  person to add by hand, as it does for every settings change. Without ai-toolkit's script the step says so and
  skips. `/skip-update` and `/disable-update` are ai-toolkit's project skills and act on its checkout, so the docs give
  the script's `--skip` and `--toggle` commands for this one.
- **`/update-manager` pulls on the person's yes.** It checks the origin and a clean `main`, fetches, shows the commits
  and the changed files that come in, and asks once; on a yes it fast-forwards with the one pull form the
  protected-paths hook allows, shows what changed, runs `/setup-manager` and ends with the version and what is left
  to do. The yes stands in for the read of the diff that `docs/setup.md` asks for, and the full diff is one command
  away.
- **`/setup-manager` is no longer user-invoked only,** as ai-toolkit did for `/setup-claude`: it never writes a
  settings file or runs an apply, it shows each as a command for the person, so an agent running it changes nothing
  the person does not do. Its description says it runs only when the person asks for the setup or from
  `/update-manager`. *Amended 2026-11-23: ai-toolkit renamed `/setup-claude` to `/setup-toolkit` and `/update-claude`
  to `/update-toolkit`, with no aliases ([ai-toolkit #152](https://github.com/notitial/ai-toolkit/pull/152)).*

## Consequences

- One request per week and no network the rest of the time, as in ai-toolkit's ADR; a private repo would never
  notify, and this one is public.
- The checkout is the one place an agent moves a callboard install. A commit the person confirmed without reading
  still goes live in every session; the control is the person's yes, and the by-hand route stays for a commit they want
  to read in full first. The pull fetches again, so a commit pushed in the seconds between the yes and the pull comes
  in unseen. The skill compares the new `HEAD` with the commit it showed and, on a difference, lists the extra commits
  and stops before it runs `/setup-manager`, so nothing pulled runs unread; nothing loads until the person reloads the
  windows and restarts the sessions. The one pull form the guard allows cannot name a commit.
- The agent-run pull goes without the `core.hooksPath` and `core.fsmonitor` hardening that `docs/setup.md`, By hand,
  uses for its read-only diff: the one pull form the guard allows takes no other argument, so it cannot carry `-c`
  flags. It runs through git MCP under the protected-paths hook, which denies agent writes to the live checkout's
  `.git` (hooks and config included) while the `.protected-checkout` marker is in place.
- A checkout ahead of its last tag compares by that tag, so a reminder can name a release whose content it already has.
- Cutting a release stays a manual step for the owner.
