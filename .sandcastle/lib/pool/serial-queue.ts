/**
 * The one-at-a-time merge lane behind the loop's rolling worker pool (#902).
 *
 * Before this, merging happened inside each build worker's own turn, so a
 * ticket's slot stayed occupied through its whole merge/rework pipeline even
 * though nothing about landing a ticket needs to run on the worker that built
 * it. Moving merges into a separate serial lane frees a worker's slot the
 * instant its build finishes, so the dealer (`dealer.ts`) can hand it a fresh
 * ticket right away instead of it idling behind its own merge.
 *
 * `SerialQueue` is a plain FIFO of async jobs that never overlap — the exact
 * guarantee a merge lane needs, since staging resets and fast-forwards must
 * never interleave with each other or with a rework commit.
 */

export interface SerialQueue {
  /** Appends `job` to the lane; resolves once `job` has run (and settled). */
  enqueue(job: () => Promise<void>, label?: string): Promise<void>;
  /** Resolves once every job enqueued so far has settled. */
  drain(): Promise<void>;
  /** How many jobs are enqueued or running right now. */
  pending(): number;
}

export function createSerialQueue(opts: {
  logError: (line: string) => void;
}): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    enqueue(job, label = "job") {
      pending += 1;
      const run = tail
        .then(job)
        .catch((err) =>
          opts.logError(
            `[merge-lane] ${label} threw: ${(err as Error).message}`,
          ),
        )
        .finally(() => {
          pending -= 1;
        });
      tail = run;
      return run;
    },
    drain: () => tail,
    pending: () => pending,
  };
}
