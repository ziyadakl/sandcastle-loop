/**
 * Repair 3 of issue #871 — the verdict envelope must carry the UI-vs-backend
 * distinction as the DIFF decided it, and the driver must act on it.
 *
 * ## The hole this closes
 *
 * The implementer's certification says `storyType` ("ui" | "backend-only" |
 * "infra") and `e2eRequired` (a bare boolean) — both SELF-REPORTS. Until this
 * module, nothing in the driver ever set them beside what the FINISHED DIFF
 * actually touched. `COMMIT_TOUCHED_UI`, `SPEC_REQUIRES_PLAYWRIGHT` and
 * `e2eRequired` appeared zero times in `main.mts`: the driver computed none of
 * them, so a well-formed "backend-only, no e2e required" envelope parsed clean
 * and shipped even when the commit changed a `.tsx` file. The cash-flow bug
 * (#868) is exactly that shape — a change that redraws a screen, certified as
 * backend-only.
 *
 * ## The rule
 *
 * `requiredProofForDiff` (`../checkwriter/proof-demand.ts`) already answers, as
 * a pure function of the finished diff, whether any changed file "can put
 * different pixels in front of a person" — `demand === "browser"`. That IS
 * `COMMIT_TOUCHED_UI`. When the diff touched UI, Playwright is required
 * (`SPEC_REQUIRES_PLAYWRIGHT`), regardless of what the story called itself — so
 * the certification MUST carry `e2eRequired === true`. A certification that
 * touched UI in its diff but reported `e2eRequired === false` is a self-report
 * the diff contradicts, and {@link decideUiClaimVsDiff} is that contradiction,
 * made a value the driver can stop on.
 *
 * The check is deliberately narrow — it fires ONLY when the diff DEMANDS a
 * browser proof (the strongest, UI-touching case) and the certification denies
 * e2e was required. A backend-only diff (demand `unit`/`none`) never fires; a
 * UI diff whose certification honestly says `e2eRequired: true` never fires. It
 * catches exactly the misclassification #871 names and nothing else.
 *
 * Pure by construction — no IO, no clock, no state — so it can be reproduced
 * against the cash-flow diff shape in a unit test.
 */

import { requiredProofForDiff } from "../checkwriter/proof-demand.js";
import type { StoryType } from "../types.js";

/** The slice of the certification this decision reads. */
export interface UiClaimCertification {
  readonly storyType: StoryType;
  readonly e2eRequired: boolean;
}

/** A certification whose UI claim the finished diff contradicts. */
export interface UiClaimVsDiffViolation {
  /** `true` — the diff touched a rendered surface. The wired `COMMIT_TOUCHED_UI`. */
  readonly commitTouchedUi: true;
  /** What the story CALLED itself. */
  readonly claimedStoryType: StoryType;
  /** What the certification claimed about whether e2e was required. */
  readonly claimedE2eRequired: boolean;
  /**
   * The exact files that put pixels in front of a person — the evidence the
   * diff touched UI, so a stop message can name it rather than gesture at the
   * diff. Straight from `requiredProofForDiff(...).screenOrFlowTouches`.
   */
  readonly screenOrFlowTouches: readonly string[];
  readonly message: string;
}

/**
 * Whether this finished diff touched a rendered surface — the driver-computed
 * `COMMIT_TOUCHED_UI`, straight from the proof router. Exported so the driver
 * can stamp it onto the certification envelope (the distinction the envelope
 * could not previously express) regardless of whether a violation follows.
 */
export function commitTouchedUi(changedFiles: readonly string[] | null): boolean {
  if (changedFiles === null) return false;
  return requiredProofForDiff(changedFiles).demand === "browser";
}

/**
 * Decide whether the certification's UI claim survives the finished diff.
 *
 * Returns `null` when there is no contradiction — the diff did not touch UI, or
 * it did and the certification honestly carried `e2eRequired === true`. Returns
 * a {@link UiClaimVsDiffViolation} when the diff touched UI but the
 * certification denied Playwright was required — the case the driver must act
 * on.
 *
 * `changedFiles === null` (git could not measure the diff) returns `null`: an
 * unmeasurable diff is handled by the proof gate's own fail-closed branch, and
 * this narrower check has nothing to add to it.
 */
export function decideUiClaimVsDiff(args: {
  readonly changedFiles: readonly string[] | null;
  readonly certification: UiClaimCertification;
}): UiClaimVsDiffViolation | null {
  const { changedFiles, certification } = args;
  if (changedFiles === null) return null;
  const proof = requiredProofForDiff(changedFiles);
  if (proof.demand !== "browser") return null;
  // The diff touched UI. Playwright is required. The only clean certification
  // is `e2eRequired === true`; anything else is the self-report the diff
  // contradicts.
  if (certification.e2eRequired === true) return null;
  return {
    commitTouchedUi: true,
    claimedStoryType: certification.storyType,
    claimedE2eRequired: certification.e2eRequired,
    screenOrFlowTouches: proof.screenOrFlowTouches,
    message:
      `story-type-vs-diff-mismatch: the finished diff changed ` +
      `${proof.screenOrFlowTouches.length} file(s) that put different pixels in ` +
      `front of a person (${proof.screenOrFlowTouches.join(", ")}), so a browser ` +
      `check is required — but the implementer certified ` +
      `storyType="${certification.storyType}", e2eRequired=false. A story cannot ` +
      `call itself exempt from Playwright when its own diff touched a rendered ` +
      `surface; the diff decides, not the label.`,
  };
}
