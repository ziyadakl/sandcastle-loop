/**
 * What a red screen check does: it is RECORDED, never a stop (spec #1334).
 *
 * ## There is no mode
 *
 * Until spec #1334 a switch (`SANDCASTLE_SCREEN_CHECK_ENFORCE`, issue #916)
 * chose between "watch-only" — a red check is recorded and the ticket ships —
 * and "enforcing" — a red check stops the ticket. Production never left
 * watch-only, and the enforcing arms only ever ran in tests, so the switch is
 * gone. A host `.env` that still sets the variable is inert: nothing reads it.
 *
 * Today every screen-check verdict that is not `match` goes to the issue
 * body's watch section and the telemetry row, and the ticket ships. The
 * reviewer's pass is the gate.
 *
 * ## What this does NOT relax
 *
 * The must-fail-first rule (`runCheckWriterStage`), the locked-file comparison
 * (the protected-path lock, issue #909: an edit is restored and the test
 * re-run), the observed-database fence (issue #1025, still a stop), and the
 * never-waived proof refusals (removed test coverage, an unmeasurable diff,
 * another ticket's locked check — handed to the fixer) all still apply. None
 * of them routes through here.
 *
 * ## What this file still decides
 *
 * Which verdicts raise the night's one alarm: see
 * {@link SYSTEMIC_SCREEN_CHECK_VERDICTS} and {@link createScreenCheckAlarmGate}.
 */

import type { HarnessVerdict } from "./verdict.js";

/**
 * The verdicts that are the NIGHT'S failure, not the ticket's (2026-08-04
 * review, blocker 1).
 *
 * ## Why a recorded verdict cannot be uniformly silent
 *
 * A red check routes through `reportScreenCheckWatch`, which writes a record
 * and raises no alarm on purpose — a flaky render or a badly-authored check
 * should not cost the owner a morning.
 *
 * That is wrong for the rest. "The app never booted" and "the practice database
 * did not clone tonight" are not per-ticket claims — they are one failure
 * repeating on every ticket until morning. The shape of that night: the dev
 * server fails to start, eight tickets ship, eight watch sections get written,
 * zero alarms fire, and the owner finds out the next day.
 *
 * ## Where the line is drawn, and why here
 *
 * SYSTEMIC — no usable evidence was produced AT ALL:
 *   - `never-settled` — the page never declared itself finished.
 *   - `environment-fault` — sign-in, navigation, an app 500, or a bare
 *     Playwright timeout failed before any graded assertion was reached.
 *   - `inconclusive` — the environment produced nothing even after the one
 *     allowed re-run.
 *
 * PER-TICKET — the app worked and something disagreed about content:
 *   - `graded-mismatch` — it settled, the claim matched, the figure did not.
 *   - `claim-mismatch` — it settled and declared which screen it was showing,
 *     and that was not the screen the address asked for. THE APP BOOTED,
 *     RENDERED, AND ANSWERED; what disagreed is which screen, which is as
 *     often a check-writer naming a route that redirects as it is a broken
 *     app. `mapHarnessVerdictToStopReason` folds it in with the ungradeable
 *     bucket for LABELLING purposes (one of five labels, no sixth), but for
 *     "is this the night or this ticket" it belongs on this side of the line.
 *
 * Every systemic verdict maps to a stop reason already in `LOUD_STOP_REASONS`
 * — pinned by a test, because that is the invariant that keeps this honest.
 */
export const SYSTEMIC_SCREEN_CHECK_VERDICTS: ReadonlySet<HarnessVerdict> =
  new Set<HarnessVerdict>(["never-settled", "environment-fault", "inconclusive"]);

/** See {@link SYSTEMIC_SCREEN_CHECK_VERDICTS}. */
export function isSystemicScreenCheckVerdict(verdict: HarnessVerdict): boolean {
  return SYSTEMIC_SCREEN_CHECK_VERDICTS.has(verdict);
}

export interface ScreenCheckAlarmDecision {
  /** Raise the alarm for this verdict. */
  readonly alarm: boolean;
  /** How many systemic verdicts this run has now suppressed after the first. */
  readonly suppressedCount: number;
}

/**
 * ONE alarm per run for the systemic verdicts, not one per ticket.
 *
 * A broken dev server produces the same verdict on every ticket of the night.
 * Forty pushes for one fact is how an alarm channel becomes the thing people
 * learn to ignore — the same reasoning `main.mts` already applies where it
 * refuses to alarm a never-settled verdict twice ("Raising it here as well
 * produced two alarms for one event"). The suppressed ones are still counted,
 * still logged, and still on every issue's own record; only the PUSH is
 * deduplicated.
 *
 * Per-run, not global: the gate is created once inside `buildDefaultDeps`, so
 * a fresh run always gets a fresh alarm.
 */
export function createScreenCheckAlarmGate(): (
  verdict: HarnessVerdict,
) => ScreenCheckAlarmDecision {
  let raised = false;
  let suppressed = 0;
  return (verdict) => {
    if (!isSystemicScreenCheckVerdict(verdict)) {
      return { alarm: false, suppressedCount: 0 };
    }
    if (!raised) {
      raised = true;
      return { alarm: true, suppressedCount: 0 };
    }
    suppressed += 1;
    return { alarm: false, suppressedCount: suppressed };
  };
}
