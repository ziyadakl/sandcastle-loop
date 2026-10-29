/**
 * The completion-order breaker behind the loop's rolling worker pool (#902).
 *
 * The round loop this replaces tripped its failure/quarantine counters once
 * per ROUND, in round order. The rolling pool has no rounds — tickets finish
 * in whatever order their workers happen to settle — so the counters here are
 * mutated once per COMPLETION, in the order completions actually arrive, and
 * the trip is checked right after each one. The two counters keep their old
 * meaning (`failureLimit` a streak of `error` outcomes, `quarantineLimit` a
 * count of `quarantine` outcomes that resets on a `ship`); `defer` and `skip`
 * touch neither. The stall detector is kept, redefined as a streak of
 * consecutive stalled completions regardless of their outcome kind.
 *
 * A trip LATCHES: once set, it is never overwritten by a later completion
 * (even a `ship`) — the pool stops dealing new work and drains whatever is
 * already in flight, then exits with the first trip's code.
 */

export type CompletionKind =
  | "ship"
  | "quarantine"
  | "defer"
  | "error"
  | "skip";

export interface BreakerTrip {
  kind: "quarantine" | "failure" | "stall";
  count: number;
  limit: number;
  /** The CLI flag (or other lever) that controls this trip's limit. */
  flag: string;
}

export function createCompletionBreaker(limits: {
  failureLimit: number;
  quarantineLimit: number;
  stallLimit: number;
}) {
  let failures = 0;
  let quarantines = 0;
  let stalls = 0;
  let trip: BreakerTrip | undefined;
  return {
    /**
     * Record one completion, in the order it actually arrived. Returns the
     * latched trip if this (or an earlier) completion tripped the breaker.
     */
    note(
      kind: CompletionKind,
      opts: { stalled?: boolean } = {},
    ): BreakerTrip | undefined {
      if (kind === "skip") return trip;
      stalls = opts.stalled ? stalls + 1 : 0;
      if (kind === "ship") {
        failures = 0;
        quarantines = 0;
      } else if (kind === "quarantine") {
        quarantines += 1;
      } else if (kind === "error") {
        failures += 1; // "defer" touches neither counter.
      }
      if (trip === undefined) {
        if (stalls >= limits.stallLimit) {
          trip = {
            kind: "stall",
            count: stalls,
            limit: limits.stallLimit,
            flag: "(sandbox health)",
          };
        } else if (quarantines >= limits.quarantineLimit) {
          trip = {
            kind: "quarantine",
            count: quarantines,
            limit: limits.quarantineLimit,
            flag: "--quarantine-limit",
          };
        } else if (failures >= limits.failureLimit) {
          trip = {
            kind: "failure",
            count: failures,
            limit: limits.failureLimit,
            flag: "--consecutive-failure-limit",
          };
        }
      }
      return trip;
    },
    tripped: () => trip,
    counters: () => ({ failures, quarantines, stalls }),
  };
}
