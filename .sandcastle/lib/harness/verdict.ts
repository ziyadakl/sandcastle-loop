/**
 * The harness-run browser check's verdict classifier (issue #912, Piece F of
 * docs/specs/2026-08-04-screen-check-design-lock.md — "The harness opens the
 * browser, not the robot").
 *
 * Once the check-writer (#911) has produced a real `CHECKS_WRITTEN` check,
 * `.sandcastle/main.mts`'s `shipAfterMigrations` runs it ONE more time — on
 * the FINISHED code, in the harness's own hands, never the builder's. That
 * run must come out as exactly one of these distinctly-wired verdicts:
 *
 *   1. "Graded, number wrong"    — the page settled, the claim matched the
 *      address, and `gradeScreenText` itself ran and its figure did not
 *      match. An ordinary failure.
 *   2. "Never settled"           — the page never declared itself finished
 *      (or finished without ever saying what it was showing). Could not
 *      grade — the app is broken for everyone that night, not this
 *      ticket's fault.
 *   3. "Claim disagrees"         — the page settled and said what it was
 *      showing, and what it said does not match what the address asked
 *      for. An APP FAULT, distinct from both of the above.
 *   4. "Environment fault"       — 2026-08-04 review finding #6: something
 *      failed BEFORE the check ever reached a graded assertion at all —
 *      sign-in, navigation, an app 500, a Playwright test-level timeout.
 *      Maps to the SAME `stopped:could-not-grade` bucket as #2/#3 (loud,
 *      but no per-ticket owner decision demanded) rather than #1's
 *      `stopped:check-disagreement` — there is no real builder-vs-check
 *      content disagreement to arbitrate when the check never got that
 *      far. See `GRADED_FIGURE_SENTINEL`'s own doc comment for the exact
 *      failure this replaced: EVERY one of these used to fall through to
 *      #1 by default (no sentinel present = assumed "reached grading and
 *      failed"), which on a systemic environment failure (e.g. the
 *      practice database failing to clone) woke the owner once per queued
 *      ticket to break a tie that never existed.
 *
 * This module is the PURE half: given a raw process observation (exit code,
 * timeout/spawn flags, combined output), decide which of these — or
 * "inconclusive" (the check could not even be proven to have run at all) —
 * actually happened. `run-harness-check.ts` is the impure half that
 * actually executes the command and applies the one-allowed-re-run rule.
 *
 * The failure verdicts are told apart by grepping the RAW OUTPUT for
 * sentinel-prefixed messages that `apps/nextjs/e2e/lib/graded-screen-
 * check.ts` throws/embeds — see that file's own doc comment for why
 * hand-rolled waits/assertions in a check-writer spec would make this
 * classifier blind. The sentinel strings are duplicated here (rather than
 * imported — `.sandcastle` never imports `apps/nextjs` module code, the
 * same boundary `LINT_CERT_TOKEN`/`TEST_CERT_TOKEN` in `main.mts` already
 * draws for cross-boundary string contracts) and pinned by
 * `./sentinel-contract.test.ts`, which reads `graded-screen-check.ts`'s
 * source TEXT (the module itself can't be imported across the boundary)
 * and asserts every literal value still matches — a comment claiming this
 * pin existed here before that test did was itself the design's own named
 * failure class (Piece L): a claim with nothing behind it.
 *
 * ## Two runners, one classifier (issue #956)
 *
 * Since #956 this grades BOTH kinds of check — a Playwright browser check and
 * a vitest unit check — because everything about the red-first rule except
 * the runner is deliberately identical across the two. The {@link CheckKind}
 * is therefore a REQUIRED parameter, never an optional one defaulting to
 * `"browser"`: a call site that forgot it would silently grade a vitest run
 * by Playwright's rules, and the compiler is the only thing that reliably
 * notices. The evidence each runner's output must carry lives in
 * `./tally-signals.ts`, not here — see that module for why a hand-kept second
 * copy of it was the liability #956 names.
 */

import type { CheckKind } from "../checkwriter/check-kind.js";
import { CHECK_KIND_RUNNER_NAME } from "../checkwriter/check-kind.js";
import { stripAnsi } from "../testing/test-verification.js";
import { parseGradeMark, parseSettledMark } from "./grade-mark.js";
import { readRunEvidence } from "./tally-signals.js";

/** Mirrors `NEVER_SETTLED_SENTINEL` in `apps/nextjs/e2e/lib/graded-screen-check.ts`. */
export const NEVER_SETTLED_SENTINEL = "SCREEN_CHECK_VERDICT:NEVER_SETTLED";
/** Mirrors `CLAIM_MISMATCH_SENTINEL` in `apps/nextjs/e2e/lib/graded-screen-check.ts`. */
export const CLAIM_MISMATCH_SENTINEL = "SCREEN_CHECK_VERDICT:CLAIM_MISMATCH";
/** Mirrors `GRADED_FIGURE_SENTINEL` in `apps/nextjs/e2e/lib/graded-screen-check.ts`
 *  — see that constant's own doc comment (finding #6) for why its ABSENCE,
 *  not its presence, is what changed behavior here. */
export const GRADED_FIGURE_SENTINEL = "SCREEN_CHECK_VERDICT:GRADED_FIGURE_MISMATCH";
/** Mirrors `SCREEN_SETTLED_SENTINEL` in `apps/nextjs/e2e/lib/graded-screen-check.ts`
 *  — the one SUCCESS line `waitForGradableScreen` prints once the page settled
 *  and its claim matched (issues #1160/#1161). Deliberately NOT in
 *  {@link SCREEN_CHECK_SENTINELS} below: that list means "the helper ran and
 *  REFUSED", and folding a success mark into it would let a GREEN run with no
 *  grade mark through `classifyCheckRun`'s browser gate — reopening the very
 *  hole issue #925 closed.
 *
 *  HUMAN-DIAGNOSTIC ONLY since 2026-09-01: it is a plain `console.log` from
 *  the agent-authored check, so NO verdict reads it any more — a check could
 *  print the literal without opening a page. The load-bearing settled
 *  evidence is the nonce-keyed record `writeSettledMark` appends to the mark
 *  file, relayed by the host epilogue and read via `parseSettledMark`
 *  (`./grade-mark.ts`). The constant stays exported (and pinned by
 *  `./sentinel-contract.test.ts`) so the two sides cannot drift while the
 *  printed line still exists for people. */
export const SCREEN_SETTLED_SENTINEL = "SCREEN_CHECK_VERDICT:SCREEN_SETTLED";

/**
 * All three FAILURE sentinels, as ONE list.
 *
 * Every one of them means the same thing to a reader that does not care WHICH
 * failed: the check's own helper in `graded-screen-check.ts` was REACHED and
 * REFUSED. `classifyCheckRun` needs exactly that reading and nothing finer —
 * see its browser gate, issue #925 build step 3 — and a further FAILURE
 * sentinel added to this module must join this list rather than leave that
 * gate reading three. {@link SCREEN_SETTLED_SENTINEL} stays out on purpose:
 * it is a success mark, not a refusal — see its own doc comment.
 */
export const SCREEN_CHECK_SENTINELS: readonly string[] = [
  NEVER_SETTLED_SENTINEL,
  CLAIM_MISMATCH_SENTINEL,
  GRADED_FIGURE_SENTINEL,
];

export type HarnessVerdict =
  | "match"
  | "graded-mismatch"
  | "never-settled"
  | "claim-mismatch"
  | "environment-fault"
  | "inconclusive";

export interface HarnessRunObservation {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  readonly output: string;
  /**
   * The nonce THIS run's command was built with — see
   * `CheckRunObservation.nonce` (`../checkwriter/verify-checks.ts`), which
   * carries the same field for the same reason on the must-fail-first half of
   * the identical rule.
   */
  readonly nonce: string;
}

export interface HarnessVerdictResult {
  readonly verdict: HarnessVerdict;
  readonly reason: string;
}

/**
 * Which of the four browser FAILURE verdicts a proven-red Playwright run is,
 * told apart ONLY by which sentinel `graded-screen-check.ts` embedded in the
 * output.
 *
 * This is the one place a browser verdict still reads free text, and it is
 * deliberately kept: a check that printed a sentinel could only ever move
 * itself between four ways of STOPPING the ticket — `never-settled`,
 * `claim-mismatch`, `graded-mismatch` and `environment-fault` all stop it, and
 * none of them is `match`. It cannot manufacture a pass, a red or a green,
 * because those come from {@link readRunEvidence} before this is ever called.
 *
 * `output` arrives ALREADY stripped of ANSI, which is why this stays private.
 *
 * `nonce` (2026-09-01) keys the settled-evidence read on the no-sentinel arm
 * — see the comment there.
 */
function classifyBrowserFailure(
  output: string,
  nonce: string,
): HarnessVerdictResult {
  if (output.includes(NEVER_SETTLED_SENTINEL)) {
    return {
      verdict: "never-settled",
      reason: "the page never declared itself finished (or never published a claim)",
    };
  }
  if (output.includes(CLAIM_MISMATCH_SENTINEL)) {
    return {
      verdict: "claim-mismatch",
      reason:
        "the page settled and claimed to be showing something other than " +
        "what the address asked for — an app fault, not a wrong number",
    };
  }
  if (output.includes(GRADED_FIGURE_SENTINEL)) {
    return {
      verdict: "graded-mismatch",
      reason: "the page settled, the claim matched, the figure did not",
    };
  }
  // NO refusal sentinel, yet a test really did fail. Two different facts can
  // look like this, and since 2026-09-01 the nonce-keyed settled record tells
  // them apart:
  //
  //   - The record is PRESENT: `waitForGradableScreen` provably settled the
  //     screen, and the red came from a plain assertion after that — a
  //     GENUINE failing check. This is exactly the settled-then-red shape the
  //     proof gate (`classifyCheckRun`'s third arm) admits at
  //     must-fail-first time, so reading it as an environment fault at SHIP
  //     time filed that same check's real red as the app or the
  //     environment being broken — pass early, misfiled late.
  //     `graded-mismatch` routes it down the disagreement/judge road, which
  //     is what a real red deserves.
  //   - The record is ABSENT: finding #6's original case — something failed
  //     before the check ever reached its screen (sign-in, navigation, an
  //     app 500, a bare Playwright test-level timeout). Not a builder-vs-
  //     check content disagreement, so never that label.
  const settled = parseSettledMark(output, nonce);
  if (settled !== undefined && settled.count > 0) {
    return {
      verdict: "graded-mismatch",
      reason:
        "the check provably reached its screen (nonce-keyed settled record " +
        "present) and then failed a plain assertion before any graded " +
        "helper spoke — a genuine failing check, not an environment fault",
    };
  }
  return {
    verdict: "environment-fault",
    reason:
      "the check failed with no sentinel present and no settled record — " +
      "something failed before a graded assertion was ever reached " +
      "(sign-in, navigation, an app fault, or a bare Playwright timeout), " +
      "not a builder-vs-check content disagreement",
  };
}

/**
 * Pure. Turns one raw subprocess observation into a {@link HarnessVerdict}.
 *
 * Decision order, IDENTICAL for both runners until the last step:
 *   1. `spawnFailed` / `timedOut` — the ENVIRONMENT failed to produce
 *      evidence, not the check. `inconclusive`. Piece G's "genuine absence
 *      of proof" case: no picture is even attempted for this verdict — the
 *      caller must not treat it as "the page rendered, just badly".
 *   2. {@link readRunEvidence} against this run's nonce. It returns one of
 *      three things, and each maps to exactly one rung of
 *      {@link HARNESS_VERDICT_EVIDENCE_RANK}:
 *        - `no-evidence`     → `inconclusive` (rank 0). Nothing attributable
 *          to the runner arrived: no host evidence line (a killed `docker
 *          exec` client manufacturing exit 0 with truncated output lands
 *          here), no report, or a report whose counters this host cannot
 *          read.
 *        - `graded-nothing`  → `environment-fault` (rank 1). The runner
 *          demonstrably ran and reported, and NO assertion was graded — a
 *          collection failure, a bad import, a `describe` with no `it()`, a
 *          filter that matched no file, an all-`it.skip`'d file (which exits
 *          ZERO), or counters that contradict the exit code. Proof of a run,
 *          no proof of a result. Never a builder-vs-check disagreement, so it
 *          never wakes the owner for a tie that does not exist (finding #6's
 *          reasoning, now applied to both runners by construction).
 *        - `proved: "green"` → `match`. THE ONE VERDICT THAT SHIPS. It
 *          requires the runner's own report to record at least one PASSED
 *          test beside a zero exit — never the exit code alone.
 *   3. `proved: "red"` — a test body really executed and its assertion really
 *      disagreed. For `unit` that IS the verdict (`graded-mismatch`). For
 *      `browser` it is only the start: {@link classifyBrowserFailure} then
 *      decides WHICH failure it was from the sentinels
 *      `apps/nextjs/e2e/lib/graded-screen-check.ts` embeds.
 *
 * ## Why none of this greps the runner's prose any more (2026-08-06)
 *
 * Step 2 used to be a regex over the combined output: `\b\d+\s+passed\b`
 * ANYWHERE for Playwright, `^\s*Tests\s+…` for vitest. The check file is
 * agent-authored and its own `console.log` lands in that same stream, so a
 * check could print the sentence that constituted its own proof — `1 passed`
 * turned an all-skipped run into a `match`. `./tally-signals.ts` carries the
 * reproduction, the fix and what remains open.
 *
 * The browser-only sentinels are not consulted on the unit path at all.
 * `never-settled` and `claim-mismatch` describe a PAGE; neither is a possible
 * reading of a vitest run, and a unit check's own assertion message is free to
 * contain any string it likes — including those.
 *
 * ## Why `unit` reuses `graded-mismatch` rather than getting its own verdict
 *
 * A real unit-test failure maps onto `graded-mismatch` because that IS,
 * precisely, "the check ran and disagreed" — and it is already wired
 * downstream to `stopped:check-disagreement` + `needs-owner-decision`, which
 * is exactly the handling a unit disagreement wants. Adding a fifth verdict
 * value would ripple into `ScreenCheckVerdictSchema`, the telemetry bag and
 * the stop-reason machinery for no behavioural gain, and every one of those
 * hops is a place the two runners could drift apart — which is the ONE thing
 * #956's design forbids ("only the runner changes"). `never-settled` and
 * `claim-mismatch` simply become unreachable for `unit`; an unreachable
 * member of a shared union is cheaper than a fifth member every consumer has
 * to learn.
 */
export function classifyHarnessRun(
  kind: CheckKind,
  obs: HarnessRunObservation,
): HarnessVerdictResult {
  // Stripped before ANY matching, for BOTH kinds. The evidence line is
  // line-anchored and the sentinels are substrings, and both runners colorize
  // even under `CI`/`NO_COLOR` — the escapes land mid-line and defeat an
  // anchor. A guard that silently switches itself off when a tool ignores an
  // env var is not a guard; see `stripAnsi`'s own doc comment for the time
  // this exact defect killed `SUITE_COMPLETED_SIGNALS` outright.
  const output = stripAnsi(obs.output);
  if (obs.spawnFailed) {
    return {
      verdict: "inconclusive",
      reason: "process could not be spawned — no browser was ever opened",
    };
  }
  if (obs.timedOut) {
    return {
      verdict: "inconclusive",
      reason: "did not complete — the bound fired or the process was killed",
    };
  }
  const reading = readRunEvidence(output, obs.nonce);
  if (reading.kind === "no-evidence") {
    return {
      verdict: "inconclusive",
      reason: `${CHECK_KIND_RUNNER_NAME[kind]}: ${reading.reason}`,
    };
  }
  if (reading.kind === "graded-nothing") {
    return {
      verdict: "environment-fault",
      reason: `${CHECK_KIND_RUNNER_NAME[kind]}: ${reading.reason}`,
    };
  }
  if (reading.colour === "green") {
    // Issue #925, build step 4. A green browser run is only a `match` once
    // something proves the screen was actually GRADED. Before this, `match`
    // was reachable on the runner's exit code alone: a `gradeScreenText` call
    // the run never reached — behind `if (false)`, after an early `return`,
    // inside a function nobody calls — exits 0 with a real report and no
    // sentinel, and shipped a wrong figure behind a green tick. The run's
    // source-text search cannot tell a call that is PRESENT from a call that
    // is REACHED, which is why this reads a runtime mark instead.
    //
    // Browser only: a unit check has no screen to grade, so demanding a mark
    // there would refuse every unit check for a screen it was never asked
    // about.
    //
    // `environment-fault`, not a disagreement label: the builder and the
    // check did not disagree about anything — the check never formed an
    // opinion. That bucket is loud and demands no per-ticket owner ruling,
    // which is the honest reading of "this check proved nothing".
    if (kind === "browser") {
      const marks = parseGradeMark(output, obs.nonce);
      if (marks === undefined || marks.count === 0) {
        return {
          verdict: "environment-fault",
          reason:
            marks === undefined
              ? "the check exited clean but no grade mark reached the host at " +
                "all — nothing says whether the screen was ever graded, so " +
                "this pass is not trusted"
              : "the check exited clean having graded NO screen — the " +
                "grading call was never reached, so a wrong figure on the " +
                "page would have passed unnoticed",
        };
      }
      return {
        verdict: "match",
        reason:
          `${CHECK_KIND_RUNNER_NAME[kind]}: ${reading.evidence.passed} test(s) ` +
          `recorded as passed, and ${marks.count} screen(s) graded — ` +
          "the check passed",
      };
    }
    return {
      verdict: "match",
      reason:
        `${CHECK_KIND_RUNNER_NAME[kind]}: ${reading.evidence.passed} test(s) ` +
        "recorded as passed in the runner's own report, beside a zero exit — " +
        "the check passed",
    };
  }
  if (kind === "unit") {
    return {
      verdict: "graded-mismatch",
      reason: `a test body ran and its assertion disagreed (${reading.evidence.failed} failed)`,
    };
  }
  return classifyBrowserFailure(output, obs.nonce);
}

/**
 * How far into the check ONE run is proven to have got, highest = furthest.
 *
 * This is not a severity ranking and not a preference about which outcome is
 * nicer — it is "how much of the check actually happened, and how do we
 * know". Each step's precondition strictly contains the step below it, which
 * is what makes the order honest rather than a taste call:
 *
 *   0 `inconclusive`      Nothing proves the check ran AT ALL — the process
 *                         could not spawn, it timed out, or its output
 *                         carries no host-generated evidence line and no
 *                         readable runner report. Zero positive evidence, by
 *                         construction.
 *   1 `environment-fault` The runner demonstrably RAN and reported, and
 *                         either graded nothing at all or failed with no
 *                         sentinel, so nothing inside `graded-screen-check.ts`
 *                         was ever reached. Proof of a run, no proof of a page.
 *   2 `never-settled`     The check's own helper ran far enough to say the
 *                         page never declared itself finished. The helper
 *                         was reached and spoke.
 *   3 `claim-mismatch`    Strictly further than 2: the page DID settle and
 *                         DID publish a claim — that claim just disagreed
 *                         with the address.
 *   4 `graded-mismatch`   Strictly further than 3: the page settled, the
 *                         claim matched, AND `gradeScreenText` itself ran.
 *                         Only the figure was wrong.
 *   5 `match`             Everything in 4, plus the figure matched. The one
 *                         run that observed the whole check succeed end to
 *                         end — the most-evidenced observation available.
 *
 * These are exactly the six outcomes `classifyHarnessRun` can return, in the
 * order its own decision list establishes them; the numbers restate that
 * file's documented semantics rather than inventing a new opinion.
 */
const HARNESS_VERDICT_EVIDENCE_RANK: Readonly<Record<HarnessVerdict, number>> = {
  inconclusive: 0,
  "environment-fault": 1,
  "never-settled": 2,
  "claim-mismatch": 3,
  "graded-mismatch": 4,
  match: 5,
};

/**
 * Pure. Of two runs of the SAME check against the SAME commit, return the one
 * whose observation got further into the check — see
 * {@link HARNESS_VERDICT_EVIDENCE_RANK} for the ladder and why it is ordered
 * that way.
 *
 * WHY THIS EXISTS. `runHarnessScreenCheck` re-runs a non-matching check once,
 * and used to take the second run's verdict as final unconditionally, in both
 * directions. Re-running cannot change reality — it can only re-observe it —
 * so a second run that observed LESS than the first must not overwrite what
 * the first proved. The failure that motivated this: attempt 1 comes back
 * `graded-mismatch` (positive proof, via `GRADED_FIGURE_SENTINEL`, that
 * grading ran and the figure was wrong), attempt 2 hits a container hiccup
 * and comes back `inconclusive`. Taking the second stopped the ticket as
 * `stopped:could-not-grade`, whose issue body says "This is the app broken
 * for everyone tonight, not this ticket's fault" — a false statement — while
 * also dropping the owner-decision flag and, on the rescue path, forfeiting
 * the retry round the ticket had earned.
 *
 * TIES GO TO `b` (the later attempt), which is what preserves the original
 * "the re-run's result is final" behaviour everywhere the re-run actually
 * observed as much as the first did — including the case the whole re-run
 * rule exists for, a first failure that comes back `match` on re-run.
 */
export function moreEvidencedVerdict(
  a: HarnessVerdictResult,
  b: HarnessVerdictResult,
): HarnessVerdictResult {
  return HARNESS_VERDICT_EVIDENCE_RANK[b.verdict] >=
    HARNESS_VERDICT_EVIDENCE_RANK[a.verdict]
    ? b
    : a;
}
