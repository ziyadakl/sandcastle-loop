/**
 * Read as pure functions: **did a rewritten first test prove itself, or is it
 * a weakened one?** (issue #1118; since spec #1334 the rewrite is bought by a
 * reviewer's `GROUNDS: WRONG-CHECK`, not by a judge. Under `lib/judge/` for
 * the reason `check-freeze.ts`'s header gives.)
 *
 * ## What the proof asks
 *
 * A first test the reviewer called wrong may be rewritten once and the ticket
 * finished the same night. What stops that from becoming the failure the
 * design lock warned about is one measurement, and only one: the rewrite must
 * **fail against the state the builder was handed** and **pass against the
 * state it produced**. A check that passes on everything, the broken state
 * included, is a WEAKENED check, and letting one through is the single failure
 * the first test exists to stop.
 *
 * ## Where the two halves come from
 *
 * Both are runs THIS PROCESS executed and graded, and neither is anything an
 * agent said about itself:
 *
 *   - **The RED half** is the rewritten check run inside `withWorktreeAt`,
 *     against the code the builder was handed, graded against an expectation
 *     of RED. {@link readPostBuilderRedProof} reads it.
 *   - **The GREEN half** is the same check run against the finished code,
 *     graded against an expectation of GREEN. {@link readPostBuilderGreenProof}
 *     reads it.
 *
 * Both vocabularies are one character from certifying a weakened check, and
 * both have an inversion trap in them, which is why neither is read at the call
 * site:
 *
 *   - A check that ERRORS exits non-zero exactly as a red one does. Reading a
 *     throw, a timeout or an ungraded run as "red" would certify a check that
 *     cannot run at all. `"inconclusive"` is therefore never a proof.
 *   - The replay's own {@link WorktreeReplayResult} has an `ok` branch that is
 *     the only one carrying a reading. {@link readReplayFailure} narrows past
 *     every other branch before anything is believed.
 *
 * Pure and total, so every branch is exercised in a unit test rather than
 * discovered at 3am on the one night the restore fails.
 */
import type { WorktreeReplayResult } from "../paths/worktree-replay.js";

/** One run of a check, in the check runner's own words. `pass` means THE
 *  EXPECTATION THE RUN WAS GRADED AGAINST WAS MET — so what `pass` proves
 *  depends entirely on which expectation was handed to the runner. */
export interface CheckRunReading {
  readonly status: "pass" | "fail" | "inconclusive";
  readonly reason: string;
}

/**
 * Did this half of ruling 4 come off? `proved: false` is every other answer,
 * and the caller may not continue the ticket on any of them.
 */
export type RepairProof =
  | { readonly proved: true }
  | {
      readonly proved: false;
      /** Plain words for the ticket, naming what actually happened. */
      readonly because: string;
      /**
       * The worktree may still be sitting on pre-builder code. Nothing
       * measured after this means anything and NOTHING MAY SHIP — a different
       * and louder statement than "the proof did not come off".
       */
      readonly worktreeUnsafe: boolean;
    };

/**
 * Narrow a replay down to its answer, refusing every branch that carries none.
 *
 * The replay wraps ONE THING: the host running the rewritten check against the
 * code the builder was handed. No agent is inside it, so every branch below is
 * a failure of a measurement rather than of an agent — but a measurement that
 * did not happen is never an answer, and none of them may be read as one.
 */
export function readReplayFailure<T>(
  replay: WorktreeReplayResult<T>,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Extract<RepairProof, { proved: false }> } {
  switch (replay.kind) {
    case "ok":
      return { ok: true, value: replay.value };
    case "dirty-at-entry":
      return {
        ok: false,
        failure: {
          proved: false,
          // THE WORKTREE IS NOT SAFE, and this used to say it was. The replay
          // refused to start BECAUSE the worktree holds tracked edits that are
          // in no commit — that is the literal definition of this branch. Any
          // uncommitted tracked file blocks the run's final promotion and can
          // strand a whole night's tickets, so the loud flag is the accurate
          // one. It is a different hazard from a failed restore (the tree is
          // the finished code, not pre-builder code) and the same answer: say
          // so where a person will see it, and ship nothing.
          worktreeUnsafe: true,
          because:
            `the builder left tracked edits that are in no commit, so the code ` +
            `it was handed cannot be stood back up without destroying them: ` +
            `${replay.dirtyPaths.join(", ")}. The working copy is left holding ` +
            `them, which blocks this run's final promotion.`,
        },
      };
    case "revert-failed":
      return {
        ok: false,
        failure: {
          proved: false,
          worktreeUnsafe: false,
          because:
            `the code the builder was handed could not be stood back up, so ` +
            `the check was never rewritten against it — ${replay.error}. That ` +
            `is no proof either way, and it must not be read as one.`,
        },
      };
    case "fn-threw":
      // THE INVERSION TRAP, refused explicitly. Everything inside the replay
      // exits non-zero when it goes wrong, exactly as a red check does; reading
      // that as red would certify a rewrite nobody measured.
      return {
        ok: false,
        failure: {
          proved: false,
          worktreeUnsafe: false,
          because:
            `the repaired check produced no reading against the code the ` +
            `builder was handed — it errored instead: ${replay.error}. A ` +
            `check that cannot run is not a check that proved itself.`,
        },
      };
    case "restore-failed":
      return {
        ok: false,
        failure: {
          proved: false,
          worktreeUnsafe: true,
          because:
            `the worktree could not be proved to be back where it started ` +
            `after the repaired check was run against the pre-builder code — ` +
            `${replay.error}` +
            (replay.dirtyPaths.length > 0
              ? ` (still disagreeing about: ${replay.dirtyPaths.join(", ")})`
              : "") +
            `.`,
        },
      };
  }
}

/**
 * RULING 4, FIRST HALF — **and it is the host's own reading now, never the
 * agent's.**
 *
 * ## What changed, and why it had to
 *
 * This used to read `CheckWriterResult.mustFailFirst`: a field the check-writer
 * stage filled in from a proof run inside a rewound worktree, with the
 * check-writer itself dispatched in that window. Two faults rode on that
 * shape. The proof ran whatever check the rewind happened to leave on disk,
 * which was for a while the ORIGINAL one — so it came back red essentially
 * always and certified every rewrite, weakened or not. And even once that was
 * fixed, the value being read was still produced by the stage that had just
 * dispatched an agent, rather than by the caller that needed the answer.
 *
 * Microsoft's .NET MAUI team shipped this exact two-run gate and their agent
 * FABRICATED the second run's result. Their fix is the shape used here: run
 * the gate from a process the agent cannot substitute, and read its EXIT CODE
 * rather than its prose. So this function now takes a {@link CheckRunReading}
 * from a run `proveFirstTestRewrite` (main.mts) executed itself, graded against an
 * expectation of RED.
 *
 * `pass` — the run was graded against RED and matched — is the only answer
 * that proves anything. `fail` means the rewrite went GREEN against the code
 * the builder was handed, which is the weakened check this whole design exists
 * to refuse. `inconclusive` is refused too: a check that merely ERRORS also
 * exits non-zero, and reading that as red would certify a rewrite that cannot
 * run at all.
 */
export function readPostBuilderRedProof(reading: CheckRunReading): RepairProof {
  if (reading.status === "pass") return { proved: true };
  return {
    proved: false,
    worktreeUnsafe: false,
    because:
      reading.status === "fail"
        ? `the repaired check PASSED against the code as it stood before the ` +
          `builder ran (${reading.reason}). A check that is green on the ` +
          `broken state is green on everything, which is a weakened check, ` +
          `not a corrected one.`
        : `the repaired check could not be graded against the code as it stood ` +
          `before the builder ran (${reading.reason}), so there is no proof it ` +
          `can fail at all.`,
  };
}

/**
 * RULING 4, SECOND HALF. The repaired check, carried out of the replay and
 * written onto the finished code, run there and graded against an expectation
 * of GREEN.
 *
 * `inconclusive` is a refusal and not a pass, for the same reason the red half
 * refuses it: a check that could not be graded has proved nothing, and the
 * ticket's whole claim to ship rests on this run.
 */
export function readPostBuilderGreenProof(reading: CheckRunReading): RepairProof {
  if (reading.status === "pass") return { proved: true };
  return {
    proved: false,
    worktreeUnsafe: false,
    because:
      reading.status === "fail"
        ? `the repaired check STILL fails against the finished code ` +
          `(${reading.reason}), so the work does not satisfy the criterion the ` +
          `ticket asked for.`
        : `the repaired check could not be graded against the finished code ` +
          `(${reading.reason}), so there is no proof it passes there.`,
  };
}
