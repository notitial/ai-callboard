# Architecture Decision Records

The significant design decisions for this repo, with their context and consequences. Check them before proposing a
change to something they cover.

## Format

Each ADR is a numbered file, `NNNN-short-title.md`, in this folder. The template is the streamlined MADR variant
recorded in ai-toolkit ADR 0002 (https://github.com/notitial/ai-toolkit/blob/main/docs/adr/0002-streamlined-madr-template.md):

- **Status:** proposed, accepted, deprecated or superseded, plus ", amended" when the ADR carries an amendment;
  the index repeats it
- **Date:** when the decision was recorded, plus an optional **Accepted** date when it was accepted later
- **Context:** the forces at play and why a decision is needed
- **Options Considered:** the alternatives evaluated, so a settled choice is not proposed again
- **Decision:** what was chosen and why
- **Consequences:** what becomes easier, harder or constrained

An ADR records what was decided at the time. A later change gets a dated amendment line or a new ADR, not a silent
rewrite.

An ADR is amended only when a decision, an option it rejected or a trust rule changes. The amendment is one dated
line that says what changed and cites the PR. A change of detail leaves every ADR alone: a limit, a timeout, a
count, a refusal code, a file name or format, a log line or the wording of a text. That detail lives in the code and
its specs, and the guide in `tools/callboard/README.md` does not restate it. A new ADR gives its context, the options,
the decision and the consequences in a page or so, with no constants, paths or texts: those change with the code and
the ADR would then be wrong. An ai-toolkit decision is cited as "ai-toolkit ADR NNNN" with its URL; a bare "ADR NNNN" always means this
repo's.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| 0001 | The manager role (`0001-manager-role.md`) | accepted, amended | 2026-10-21 |
| 0002 | Callboard (`0002-callboard.md`) | accepted, amended; partly superseded by 0012 | 2026-10-24 |
| 0003 | Callboard loads from a live checkout (`0003-symlinked-install.md`) | accepted, amended | 2026-11-06 |
| 0004 | Prompt answering (`0004-prompt-answering.md`) | accepted, amended | 2026-11-06 |
| 0005 | Callboard's module layout (`0005-callboard-module-layout.md`) | superseded by 0012 | 2026-11-12 |
| 0006 | A conductor opens leads and wakes them (`0006-conductor-opens-leads.md`) | superseded by 0012 | 2026-11-13 |
| 0007 | A conductor owns its leads (`0007-conductor-owns-leads.md`) | superseded by 0012 | 2026-11-15 |
| 0008 | Unattended mode: the manager decides while the person is away (`0008-unattended-mode.md`) | accepted, amended; built in the plugin per 0012 | 2026-11-16 |
| 0009 | A go given once (`0009-go-given-once.md`) | accepted, amended | 2026-11-15 |
| 0010 | PR notices for lanes (`0010-pr-notices.md`) | accepted, amended | 2026-11-15 |
| 0011 | Every lane prompt rises up the chain (`0011-all-prompts-rise.md`) | superseded by 0012 | 2026-11-16 |
| 0012 | Callboard as a plugin: one session model, one ask chain (`0012-callboard-plugin.md`) | accepted, amended | 2026-11-19 |
| 0013 | A conductor is a lead that makes leads (`0013-conductor.md`) | accepted, amended | 2026-11-21 |
| 0014 | A Run button runs a chat code block on the person's click (`0014-run-button.md`) | accepted, amended | 2026-11-21 |
| 0015 | A session hands itself over to a clear one (`0015-session-handover.md`) | proposed; amends 0012 and 0013 | 2026-11-22 |
