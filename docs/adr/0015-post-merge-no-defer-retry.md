# ADR 0015 — Sandcastle: post-merge reviewer no-defer rule + no-verdict retry

**Status:** Accepted
**Date:** 2026-06-23

## Context

On a consumer run (affinity-tracker, `sandcastle/marketing+deal-intake-20260621`,
iter 5), issue #475 was **false-quarantined** (`needs-human`, integration branch not
advanced) even though the merged code was clean. Independent verification in the
staging worktree confirmed it: typecheck clean, lint 0 errors, the new test 6/6, and
the full `@acme/api` suite **2087 passed / 0 failed**.

The sole cause was the **post-merge reviewer deferring instead of verdicting**. It
ended its single turn with *"I've set up a blocking waiter; it'll notify me when the
api suite completes. Standing by for that result before issuing the verdict."* — and
emitted no marker. `extractMarker(..., { mode: "contains" })` correctly threw
`MarkerNotFoundError` (no marker exists anywhere — the earlier prose-wrapped-marker
fix from ADR 0014's bundle, commit `8d352ee`, cannot help when there is no marker at
all). Because a missing verdict is **not** a stall, the `STALL_RE`-gated single-retry
in `runPostMergeReviewer` (ADR-less hardening for the #197 stall case) did not fire →
straight to quarantine.

This is a distinct, behavioral variant of the post-merge false-quarantine family. The
#197 fix retries on *environmental* non-verdicts (SDK idle timeout, hard ceiling); this
one is a *behavioral* non-verdict — the reviewer ran fine but chose to wait instead of
deciding. The reviewer was incentivized to defer because it is made responsible for
*running* the slow (~5 min) combined test suite within its one turn.

## Decision

Two paired changes in the template, test-locked. Prompt prevents the defer; code
survives it once if it still happens.

1. **`post-merge-review-prompt.md` — no-defer rule.** A new first bullet in the
   `# DO NOT` section forbids deferral explicitly: the reviewer gets EXACTLY ONE turn
   (`maxIterations=1`), must run every check synchronously to completion in that turn,
   must never set up a background/async "waiter" or end its turn waiting on a result,
   and — if a check genuinely cannot finish — must emit `POST_MERGE_ISSUES_FOUND` with
   the reason rather than ending silently. It states the consequence plainly: ending
   without a marker quarantines every merged issue as if it failed, even on clean code.
   The bullet sits outside any `<!-- variant:... -->` region, so it survives variant
   assembly (`lib/variant-assembly.ts`) for all profiles — no variant override needs
   the same edit.

2. **`main.mts` — `runPostMergeReviewer` no-verdict retry.** Broaden the single-retry
   condition so it also fires on a no-verdict `MarkerNotFoundError`, not only on
   `STALL_RE`-matching stalls. The error reaches the catch raw, so the class is
   matched canonically with `err instanceof MarkerNotFoundError` (the symbol is
   added to the existing `./lib/verdicts` import — no cast, rename-safe, no new
   import statement). The recursive call keeps
   `retryOnStall=false`, so the retry stays single-shot: a reviewer that fails to
   verdict twice still falls through to quarantine. The log line distinguishes
   `emitted no verdict` from `stalled` for diagnosis.

## Consequences

- A post-merge reviewer that defers once no longer destroys a clean integration: the
  loop retries it once on the same model, and the prompt rule makes a defer unlikely in
  the first place. If it ever still happens, the operator sees
  `post-merge review emitted no verdict … retrying once` in the log instead of a silent
  quarantine.
- The single-retry cap is preserved — no infinite loop, and a genuinely broken
  integration (two non-verdicts) still quarantines. A real `POST_MERGE_ISSUES_FOUND`
  verdict is untouched: this path only triggers when *no* marker was produced.
- Cost is at most one extra reviewer pass per non-verdict turn, bounded at one.

## Alternatives considered

- **Harness runs the deterministic suite itself** (capture exit code) and passes the
  result into the reviewer, leaving the LLM to judge only the non-deterministic parts
  (conflict resolution, spec coverage). This removes the incentive to "wait for the
  suite" entirely and is the more thorough fix, but it is a larger change to the
  orchestration and the reviewer contract. Deferred as a possible future hardening; the
  prompt+retry pair removes the observed failure now.
- **Retry on every throw, not just stall + no-verdict.** Rejected: a genuine SDK auth
  error (`401`) or other hard fault should fail fast, not burn a second reviewer pass.
  The existing test "non-stall throw → no retry, single attempt" pins this, and the
  no-verdict carve-out is matched by error type (`instanceof MarkerNotFoundError`)
  rather than widening to all errors.
