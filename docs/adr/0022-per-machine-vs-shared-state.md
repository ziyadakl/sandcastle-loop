# ADR 0022 — Sandcastle: per-machine state vs. shared template state

**Status:** Accepted
**Date:** 2026-07-17

## Context

Two defects landed within days of each other and looked unrelated. They have one
root cause: **per-machine state and shared template state were living somewhere
that could not tell them apart.**

- **The `/sandcastle-*` skills existed only in `~/.claude/skills/`.** That
  directory is not a git repo, so every fix was local to the machine it was
  authored on. This Mac and the VPS drifted, and the same bug had to be found
  twice. It caused a real problem **three separate times** — most recently a
  `/sandcastle-update` bug whose fix existed on exactly one machine. The skills
  are shared product surface being stored as if it were per-machine state.
- **`.sandcastle/hosts.json` was tracked.** It holds `repoPath` values that are
  correct for *one* machine's checkouts and wrong for every other. Being tracked,
  it shipped in the template tarball, and `/sandcastle-update` copied **this
  repo's** `hub` entry (`repoPath: /home/deploy/dev/sandcastle-loop`) over each
  consumer project's registry. Every remote command then `cd`'d to the wrong
  repo — which surfaces later as a mysterious host failure, not as a bad update.
  Per-machine state being stored as if it were shared.

Each is the mirror image of the other. The fix in both directions is the same:
put each kind of state where its scope is a **structural property of the layout**
rather than something a tool has to remember to respect.

## Decision

### 1. Skills are version-controlled in `skills/`, symlinked to user scope

The nine `/sandcastle-*` skills now live in `skills/` in this repo and are
symlinked into `~/.claude/skills/` by `skills/install.sh` (idempotent; moves any
existing copy into a timestamped backup rather than deleting it). A fix now
travels the way code does: commit, push, `git pull`.

**They stay USER-level, not project-level.** Putting them in this repo's
`.claude/skills/` was rejected on scope grounds, not taste: these skills are
invoked **from consumer projects** — `/sandcastle-update` runs inside
affinity-tracker, not inside this repo — so project scope would make them visible
only in the one place they are least needed. Symlink-to-a-checkout is the only
layout that is **global and version-controlled at once**. This mirrors the
existing `~/.agents/mattpocock-skills` arrangement, which already runs ~21 skills
this way.

### 2. `hosts.json` is per-machine and untracked; `hosts.example.json` ships

`.sandcastle/hosts.json` is gitignored. `.sandcastle/hosts.example.json` ships in
its place, documenting each field and carrying deliberately non-functional
`REPLACE-ME` values so it can never be mistaken for a working config.

Nothing breaks in its absence: `loadHostsConfig`
(`.sandcastle/lib/hosts/registry.ts:169-180`) already falls back to a single
local host when the file cannot be read, so multi-host stays opt-in — the
fresh-clone state and the flag-off state are the same state.

The registry test previously read the tracked `hosts.json` as a fixture and would
have failed on a fresh clone. It now reads the example and asserts the example
contains only placeholder paths — the regression guard for this exact bug.

## Rejected alternatives

- **Keep `hosts.json` tracked and rely on `/sandcastle-update`'s skip rule.** The
  update skill can be taught not to overwrite it. Rejected: this makes
  correctness depend on a **skill behaving correctly** rather than on a
  structural guarantee. A raw copy, a `cp -r`, or any future code path stomps it
  again, and the failure is silent and delayed. Untracking makes the file unable
  to reach the diff at all — the guarantee holds without anyone remembering it.
- **Ship the skills into each project's `.claude/skills/`.** Rejected under
  Decision 1: project scope is invisible in the consumer projects these skills
  are actually invoked from, and it would fan one skill out into N drifting
  copies — the original disease with more hosts.
- **Auto-restore `hosts.json` from history in `install.sh`.** Tried, shipped, and
  **reverted**. The block restored the file from the deleting commit's parent so
  no human had to remember a ritual. Its gate was `[ ! -f hosts.json ]` — a
  condition a **fresh clone also satisfies**. So on a brand-new machine it
  "restored" another machine's `repoPath: /home/deploy/dev/sandcastle-loop` and
  announced "the pull had deleted it", which on a fresh clone is simply false:
  it wrote a wrong path onto a new host and reintroduced through the back door
  the exact defect this ADR records the removal of. Confirmed on a real clone.
  The flaw is not the gate but the premise — **the one case an auto-restore must
  not fire in is the one case it cannot distinguish from the case it must**, since
  both present identically as an absent file. Nothing on disk carries the
  difference; only the human knows. Deleted outright rather than gated, and the
  cost it was avoiding is accepted as manual: the content is always recoverable
  from git history, so the ritual it saved was never load-bearing, and a helper
  that is confidently wrong on a fresh machine is worse than no helper.

## Consequences

- **A `git pull` alone changes nothing about which skills a machine uses.** The
  pull updates the files in `skills/`; `install.sh` is what makes a machine's
  `~/.claude/skills/sandcastle-*` point at them. Until it has run on a machine,
  those are still private copies and an edit through that path propagates
  nowhere. Bringing an existing machine up to date is two commands, both
  required: `git pull`, then `bash skills/install.sh`.
- **One-time migration cost: pulling the untracking commit makes git DELETE the
  working `hosts.json`.** The gitignore rule only protects a file that is
  **already** untracked; it cannot save one git is removing in a tracked→deleted
  transition. This hit the Mac for real. It is one-time per machine, and it is
  **manual by design** (see Rejected alternatives): `install.sh` links skills and
  writes nothing else. When `hosts.json` is absent it prints guidance naming both
  recovery paths — `git show <del-sha>^:.sandcastle/hosts.json > .sandcastle/hosts.json`
  for a machine that had one, `cp .sandcastle/hosts.example.json .sandcastle/hosts.json`
  for a new machine — and leaves the choice to the human, who is the only party
  that knows which case they are in.
- **Consumer projects are unaffected by the deletion.** They receive files
  through `/sandcastle-update`, which only copies and never deletes; they simply
  stop receiving a `hosts.json` at all, which was the bug.
- **`~/.claude/skills/` remains un-version-controlled.** The layout removes the
  drift but not the footgun: editing a skill through that path on a machine where
  `install.sh` has not run still edits a private copy. Verifying the path is a
  symlink is the check (`skills/README.md` documents it).

## References

- ADR 0019 / 0020 / 0021 — the multi-host feature set whose `hosts.json` registry
  this ADR scopes. Multi-host remains opt-in behind their existing flags.
- `skills/README.md`, `skills/install.sh` — the install + migration path.
- `.sandcastle/hosts.example.json`, `.sandcastle/lib/hosts/registry.ts`,
  tests `tests/hosts-registry.test.ts`.
