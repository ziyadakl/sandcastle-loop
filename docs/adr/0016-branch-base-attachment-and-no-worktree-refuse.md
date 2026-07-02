# 0016 — Close the branch-base SHA hole + refuse the no-worktree fast-forward

## Status

Accepted (2026-07-02). Refines [0014](0014-loop-robustness-from-session-audit.md).

## Context

ADR 0014 added a **branch-base preflight gate**: worker worktrees are cut from
the launch checkout's *current HEAD* (`git worktree add` branches off HEAD), not
from `--branch`, so a launch checkout parked on a stale base makes every worker
build on the wrong foundation. The gate resolved `HEAD` and the tip of `--branch`
and refused when the two **SHAs** differed.

A `/sandcastle-feedback` audit of the `scheduler` repo (2026-07-02) caught the
gate failing to fire while the exact trap it targets recurred: issue #40 re-did
#39's foundation. Root cause — a **hole in the SHA-only comparison**:

- `/sandcastle-run` created the run branch with `git branch <run> <base>` and
  **did not check it out**, on the (false) belief that the orchestrator bases
  worker worktrees on `--branch`. It does not — it bases them on HEAD, and the
  SDK's `WorktreeManager` runs `git worktree add -b <issue> <path> HEAD`
  (verified in `@ai-hero/sandcastle` `chunk-VOG34SRF.js`).
- So the launch checkout stayed **attached to `<base>`** while `<base>` and
  `<run>` shared a tip. `rev-parse HEAD == rev-parse refs/heads/<run>` → the SHA
  gate passed. **HEAD SHA == branch tip does not imply HEAD is attached to that
  branch.**
- `fastForwardIntegration(repoRoot, args.branch, …)` (`main.mts`) then advanced
  `<run>` via its **no-worktree fallback** — a bare `git update-ref` — because no
  worktree had `<run>` checked out. The ref crept forward while the launch
  checkout (on `<base>`) did not, and the next worker was cut from the stale
  `<base>`. Silent layering corruption — the very disk-drift the function's own
  doc-comment warns against.

## Decision

Two test-locked template changes, plus the consumer-side skill fix.

1. **Assert branch *attachment*, not SHA equality** (`preflight()` check 9). Run
   `git symbolic-ref --quiet --short HEAD`: when it resolves a branch name, refuse
   if it is not `--branch` (this closes the hole: HEAD attached to `<base>` at the
   same tip now fails); when it exits non-zero, HEAD is detached and we refuse
   (see Consequences). This is now the *whole* check — a single attachment model
   with no SHA-comparison fallback. 0014's original gate resolved and compared
   HEAD-sha vs `--branch`-tip-sha; that path had the same-sha-different-branch
   hole and, once detached is also refused, was reachable only by legacy exec
   mocks, so ADR 0016 removed it (the four SHA-based gate tests were replaced by
   attachment tests). The `else` case — `symbolic-ref` ok but no stdout — cannot
   occur with real git (the default `exec` captures stdout); it survives only as
   an inert no-op so the ~15 other preflight tests that mock `exec` as
   `() => ({ ok: true })` stay unaffected.

2. **Refuse the no-worktree fast-forward** (`fastForwardIntegration`). The bare
   `update-ref` fallback is removed; when no live worktree has the target branch
   checked out, log `fast-forward refused: …` and return `false`. With change 1
   in place the launch worktree is guaranteed on the run branch at boot, so this
   path is only reachable once the branch is already stranded — refusing converts
   silent corruption into a loud, actionable halt (matching the divergence
   no-worktree path, which already refused).

3. **Consumer skill (`/sandcastle-run`, local — not in this repo).** Create *and
   check out* the run branch in the launch worktree (`git checkout -b <run>
   <base>`, or `git checkout <run>` on reuse) so HEAD is attached to it. Also
   dropped `setsid` from the background launch (absent on macOS → double-launch)
   and made the API-key preflight mode-aware (default `claude`/`codex` need no
   `KIMI_API_KEY`). These live in `~/.claude/skills/` and don't round-trip
   through `/sandcastle-update`; recorded here so the propagation gap is visible.

## Consequences

- The gate now catches the common "created the branch but didn't check it out"
  mistake even when the branches share a tip — the case 0014 shipped blind to.
- A launch with a **detached HEAD is now hard-refused** at boot: a detached HEAD
  is attached to no branch, so `--branch` can't advance through the launch
  worktree and `fastForwardIntegration` (change 2) would refuse every promotion
  — a mid-run dead-end. Refusing in preflight turns that into a clear boot-time
  error. This makes the two gates consistent (both require an attached run
  branch) and closes the case a code review flagged: detached-*at-tip* passed
  the SHA check yet stalled the run. With detached now refused, the old SHA
  comparison had no remaining production role (real `symbolic-ref` either
  resolves or fails), so it was removed — leaving a single attachment model.
- `fastForwardIntegration` can no longer silently advance an unowned ref. If a
  future change legitimately needs a bare-ref fast-forward, it must re-introduce
  it deliberately with its own test — the removed test's expectation was flipped,
  not deleted, so the regression guard remains.
