/**
 * Issue #1216 — lifted verbatim out of `runIssuePipeline` in `main.mts`,
 * where reviewer attempt 1 marked HAS_BLOCKERS and the loop had to decide
 * retry vs quarantine. Behaviour preserved exactly: retry is possible only
 * when `--no-retry` was not passed AND both the implementer and reviewer
 * have at least one escalation model configured. When retry is not
 * possible, the `--no-retry` reason takes precedence over the missing-
 * escalation-model reason when both are true.
 */

export type RetryEligibility =
  | { canRetry: true }
  | { canRetry: false; why: string };

export function decideRetryEligibility(input: {
  retryEnabled: boolean;
  implementerEscalations: number;
  reviewerEscalations: number;
}): RetryEligibility {
  const canRetry =
    input.retryEnabled &&
    input.implementerEscalations > 0 &&
    input.reviewerEscalations > 0;

  if (!canRetry) {
    const why = !input.retryEnabled
      ? "retry disabled (--no-retry)"
      : "no escalation model available for implementer or reviewer";
    return { canRetry: false, why };
  }

  return { canRetry: true };
}
