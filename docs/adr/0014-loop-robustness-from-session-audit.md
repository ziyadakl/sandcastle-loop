# ADR 0014 — Sandcastle: loop-robustness fixes from the affinity-tracker session audit

**Status:** Accepted
**Date:** 2026-06-22

## Context

An overnight sandcastle run on a consumer repo (affinity-tracker) went badly and
was audited from the real transcript. Four faults were diagnosed, fixed locally
in the consumer, and verified on disk — but consumer-local fixes are overwritten
on the next `/sandcastle-update`. This ADR records porting them **upstream into
the template** so they survive updates and reach every consumer, with the
template treatment of each (some are stricter upstream than the local patch).

The four faults:

1. **Branch-base trap (worst firefight).** Worker worktrees are created with a
   plain `git worktree add`, which branches off the launch checkout's **current
   HEAD** — not the `--branch` feature base the run was given. When the launch
   checkout had drifted onto an old `work/next` snapshot, every worker built on a
   stale base; dependent issues HALTed (missing foundation code) or conflicted on
   merge. Nobody noticed until the dependent work failed. The loop already had a
   warning for one narrow variant (HEAD parked on `integration-candidate`) but no
   general guard.
2. **Credential contradiction.** `implement-prompt.md` tells the builder
   "Credentials are not blockers" and to reuse the project's `ADMIN_PASSWORD`
   test-credential pattern, while `review-prompt.md` flagged "credential leaks"
   with no carve-out. The reviewer therefore quarantined the exact line the
   builder was instructed to write — an unsatisfiable rule no retry can clear.
3. **Critique over-blocks on subjective findings.** The critique gate blocked on
   subjective copy/voice nitpicks ("reads procedural") and capped retries at 1,
   so shippable visual/copy slices repeatedly parked at needs-human.
4. **No post-mortem log.** When the loop died mid-issue, its stdout/stderr was
   ephemeral — there was no on-disk record to tell a hard crash from a graceful
   stop or to diagnose why it died. (`--log-file` existed as a CLI flag but was
   parsed and never used.)

## Decision

Land four changes in the template (`.sandcastle/` + `main.mts`), each test-locked.

1. **Branch-base preflight gate** (`preflight()` in `main.mts`). Add a refuse-to-
   launch check: resolve the launch checkout's `HEAD` and the tip of
   `--branch`; if both resolve and differ, error out and tell the operator to
   `git checkout <branch>` (or pass the `--branch` they meant). It skips safely
   when the branch ref doesn't resolve (brand-new branch / detached HEAD), so the
   no-`--branch` default case is unaffected. This promotes the existing easily-
   missed warning into a hard gate — the audit's top recommendation. The
   `preflight` `exec` helper was extended to capture stdout (the check compares
   `rev-parse` output); all other checks ignore it and pre-existing exec mocks
   stay inert.
2. **Reviewer credential carve-out** (`review-prompt.md`). The documented test-
   credential pattern (`process.env.ADMIN_PASSWORD ?? "<default>"` and siblings
   used uniformly across a project's e2e suite) is explicitly **not** a
   credential leak. Real secrets (production/live keys, tokens, a committed
   `.env` with live values) still block. A `prompt-contract` test asserts the
   carve-out exists **and** that `implement-prompt.md` still carries "Credentials
   are not blockers" — so the two prompts can never drift apart again (the
   root cause was a rule on one side without the other).
3. **Critique: objective-only blocking + 2 retries.**
   - `critique-prompt.md` now blocks (P0/P1) only on **objective, verifiable**
     defects — pinned to a loaded rubric rule or a measurable fact (a11y,
     contrast, hardcoded grays where tokens exist, breakpoint misalignment,
     `.impeccable.md` ban-list hits). **Subjective polish** (tone/voice/phrasing,
     taste-level spacing, icon-family mixing) is demoted to a non-gating NOTE
     (P2/P3) that keeps the `CRITIQUE_CLEAN` verdict.
   - The retry cap in `runCritique` is raised **1 → 2** via a named constant
     `CRITIQUE_MAX_RETRIES`: first-pass → retry → retry → quarantine. All
     existing verdict semantics are preserved (a `CRITIQUE_CRITICAL` at any point
     and a malformed retry verdict still fail closed immediately; `--no-retry`
     still quarantines without dispatching the implementer).
4. **Default run-log** (`buildDefaultDeps` / new `createRunLogAppender` in
   `main.mts`). The loop now tees every `log`/`logError` line to a known path —
   `<repoRoot>/.sandcastle/run.log` by default (already gitignored), overridable
   via the now-wired `--log-file`. The file is truncated once per run and each
   line is flushed with `appendFileSync` (no buffering) so a hard death loses
   nothing. Writes are best-effort: a non-writable path silently disables file
   logging and never throws (mirrors the status-store's non-fatal `onError`),
   so a logging failure can never take the loop down.

Two related operator-facing fixes ship in the sandcastle **skills**
(`sandcastle-status`, `sandcastle-stop`) rather than the template, because they
govern how the operator inspects/stops a run: status uses `status.json`
freshness + the `.loop.lock` as the canonical liveness signal instead of a
self-matching `pgrep`, and stop verifies the `stopped` write actually landed
(reporting a hard death otherwise). They are noted here for traceability but are
outside this repo's PR.

## Consequences

- A run launched from the wrong checkout now fails fast at preflight with an
  actionable message, instead of silently producing stale-base workers that fail
  downstream. The check is conservative: it only fires on a confirmed HEAD≠tip
  divergence, so it cannot false-block the common cases.
- The reviewer/critique gates ship fewer false quarantines, at the cost of one
  extra implementer+critique round per still-imperfect slice (bounded by
  `CRITIQUE_MAX_RETRIES`) and a slightly more permissive critique that trusts the
  objective/subjective split. The credential and critique rules are now locked by
  `prompt-contract` tests, so the warn→throw / one-sided-rule drift class fails in
  CI rather than in a live loop.
- Every consumer now gets a `.sandcastle/run.log` per run. It is gitignored and
  bounded (truncated per run), and the write path is non-fatal, so the cost is a
  single small file the operator can read after a crash.
- `runImplementer`'s `attemptNumber` was widened `1|2|3 → number` (it is used
  only in comparisons and the `ATTEMPT_NUMBER` prompt arg, never as an index)
  now that the retry count is cap-driven.

## Alternatives considered

- **Branch-base: rewire `createSandbox` to cut workers from the explicit
  `--branch` base ref** (instead of a preflight gate). This is the more thorough
  fix — it would make workers correct regardless of where the launch checkout
  sits — but it reaches into the SDK's worktree creation, a larger and riskier
  change. The preflight gate is contained, matches the audit's recommendation,
  and removes the trap in practice; cutting from the base ref remains a possible
  future hardening.
- **Critique retry cap as a CLI flag** rather than a constant. Deferred: a
  template default of 2 fixes the observed over-blocking for all consumers with
  no per-run tuning surface to misconfigure; a flag can be added later if a
  consumer needs it.
- **Run-log opt-in (only when `--log-file` is passed).** Rejected: the audit's
  pain was precisely that no log existed when one was needed, and operators won't
  pass the flag pre-emptively. The default path is already gitignored upstream
  (the maintainer anticipated it), so default-on is low-cost and high-value.
