# ADR 0017 — Sandcastle: no-verdict retry + defer for the pre-merge Haiku gates

**Status:** Accepted
**Date:** 2026-07-11

## Context

A `/sandcastle-feedback` audit of a consumer run (career-ops) found that issue #125
was **falsely quarantined** (`needs-human`) even though the code was fine. A small/fast
(Haiku) pre-merge gate ran out of turns and ended without emitting a verdict marker.

This is the pre-merge sibling of the post-merge failure fixed in ADR 0015. As there, the
SDK does not throw on turn-exhaustion — it returns partial output, so `extractMarker`
throws `MarkerNotFoundError`, which is **not** a `STALL_RE` match. But ADR 0015's retry
lives only in `runPostMergeReviewer`. The two **pre-merge** Haiku gates had no such
handling and collapsed the non-verdict straight into quarantine:

- `runReviewer` (pre-merge reviewer): `extractMarker` was unguarded → propagated → the
  generic pipeline-error path quarantined.
- `dispatchCritique` (critique-as-gate, ADR 0006): swallowed the error to `marker: null`,
  then treated null as `CRITIQUE_CRITICAL` → quarantine. A behavioral non-verdict was
  indistinguishable from a genuine P0 rejection.

## Decision

Extend the ADR 0015 pattern (`err instanceof MarkerNotFoundError` → retry once on the
same model, one-shot guard against recursion) to both pre-merge Haiku gates, plus add a
stronger fallback tier. Test-locked in `.sandcastle/main.mts`.

1. **`runReviewer`** gains a `retryOnNoVerdict = true` param; on `MarkerNotFoundError` it
   recurses once with `false`, then propagates. Strict one-shot.

2. **`dispatchCritique`** retries the dispatch once on `MarkerNotFoundError`; a persistent
   no-verdict now **propagates the `MarkerNotFoundError`** instead of collapsing to
   `marker: null`. The `marker: null → CRITIQUE_CRITICAL` fail-closed path is preserved
   only for genuinely malformed (non-`MarkerNotFoundError`) parses, so real P0 rejections
   are untouched. The retry applies to every dispatch, including the `CRITIQUE_NEEDS_FIXES`
   ladder leg.

3. **New fallback tier:** a no-verdict that survives its in-gate retry is routed in
   `runIssuePipeline`'s catch to the existing `deferred` category
   (`tryDefer(..., "NO_VERDICT")`, released to `ready-for-agent`), bounded by
   `MAX_DEFERRALS = 3`. Only after the defer budget is exhausted does it quarantine. This
   is stronger than ADR 0015's post-merge path (retry-once-then-quarantine): a pre-merge
   slice can be safely re-attempted next iteration, whereas a merged batch cannot. Routing
   is matched by error type (`instanceof MarkerNotFoundError`), so it cannot be swallowed
   by the `CritiqueCriticalError` / `MissingRequiredSkillsError` branches.

## Consequences

- A pre-merge Haiku gate that runs out of turns no longer quarantines clean code: it
  retries once, then defers for a later iteration, and only quarantines after three
  deferrals. Real `CRITIQUE_CRITICAL` / `HAS_BLOCKERS` verdicts and the escalation ladder
  are unchanged — the carve-out is by error type, not by widening any path.
- Cost is at most one extra gate pass per non-verdict turn (bounded at one), plus wasted
  implementer work on a deferred round (a cost, not a bug).
- Known cosmetic limitation: the `transientVerdict` / `outputCapVerdict` branches are
  computed from `errMsg` before the no-verdict branch. Because `MarkerNotFoundError`'s
  message embeds a preview of the agent's raw output, a non-verdict whose output happens
  to contain "rate limit" / "maximum output tokens" / "ETIMEDOUT" phrasing could defer
  under the wrong *diagnostic marker*. The terminal outcome (a bounded defer on the shared
  budget) is identical — only the logged cause label is wrong. Left as-is.

## Related / deferred

The same audit flagged a second hole: no gate ever runs the change's tests, so a reviewer
can approve a slice that ships a red test (#125 also did this). A host-side test-run gate
was prototyped but **deferred** — a correct implementation must execute in the per-issue
worktree (`sandbox.worktreePath`), not the base-branch launch tree (`ctx.args.repoRoot`),
and must survive the symlinked-`node_modules` `pnpm` abort
(`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Tracked separately; not in this ADR.

## Alternatives considered

- **Fail-closed (quarantine) on a persistent pre-merge no-verdict**, mirroring ADR 0015.
  Rejected in favor of `deferred`: a pre-merge slice is safe to re-attempt, so releasing
  it to `ready-for-agent` avoids a needless human hand-off; the `MAX_DEFERRALS` cap still
  guarantees eventual quarantine if it never resolves.
- **Retry on every throw, not just no-verdict.** Rejected (as in ADR 0015): a genuine hard
  fault should fail fast. The carve-out is matched by `instanceof MarkerNotFoundError`.
