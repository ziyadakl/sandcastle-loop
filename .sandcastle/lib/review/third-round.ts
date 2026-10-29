/**
 * Issue #1216 — lifted verbatim out of `runIssuePipeline` in `main.mts`,
 * where reviewer attempt 2 still says HAS_BLOCKERS and the loop had to
 * decide whether to grant a third implementer+reviewer pass, and on which
 * basis. Behaviour preserved exactly: grant when EITHER `round1Cleared`
 * (round 1's categories were resolved) OR `freshLatestFinding` (round 1
 * named nothing readable but round 2 named a fresh finding, issue #1211)
 * is true. When both are true, `round1Cleared` wins the basis string —
 * the two are meant to be mutually exclusive by construction, since
 * `freshLatestFinding` requires round 1 to carry no finding at all, but
 * the basis pick still needs an explicit tie-break.
 */

export type ThirdRoundDecision =
  | { grant: true; basis: string }
  | { grant: false };

export function decideThirdRound(input: {
  round1Cleared: boolean;
  freshLatestFinding: boolean;
}): ThirdRoundDecision {
  const grant = input.round1Cleared || input.freshLatestFinding;
  if (!grant) return { grant: false };
  return {
    grant: true,
    basis: input.round1Cleared
      ? "round-1 categories resolved"
      : "round 1 named no readable finding but round 2 did (issue #1211)",
  };
}
