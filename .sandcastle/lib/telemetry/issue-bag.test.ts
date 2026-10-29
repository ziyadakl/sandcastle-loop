/**
 * Tests for the per-issue telemetry bag and the run-scoped counters.
 *
 * TWO CONTRACTS drive nearly every case here:
 *
 * 1. NEVER THROW. These setters are called from inside `runIssuePipeline`
 *    (`main.mts:5737-6395`), the most control-flow-dense function in the loop.
 *    A telemetry exception there kills a paid overnight run. So every setter
 *    absorbs garbage — NaN, negative, Infinity, null, wrong types, out-of-enum
 *    strings — silently, leaving every OTHER field uncorrupted.
 *
 * 2. ABSENT ≠ ZERO. An omitted field means "not instrumented / not captured";
 *    a written `0` means "measured, and it was zero". Assertions therefore use
 *    `toHaveProperty` / `Object.keys`, NOT `toBeUndefined()` — the latter
 *    passes for both absent AND present-with-undefined, which would make this
 *    entire contract untestable.
 */

import { describe, expect, it } from "vitest";

import {
  IssueTelemetryRowSchema,
  MAX_CHANGED_FILE_PATHS,
  MAX_SCREEN_CHECK_ATTEMPT_VERDICTS,
  RunTelemetrySchema,
} from "../status/schema.js";
import { IssueTelemetryBag, RunCounters, type RunCounterKey } from "./issue-bag.js";

/** Every kind of garbage a `main.mts` call site could plausibly hand a setter. */
const GARBAGE = [
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  -1,
  "",
  "not-a-number",
  {},
  [],
  Symbol("nope"),
  { toString() { throw new Error("hostile"); } },
] as const;

/** The `issue`/`costUsd`/`wallMs`/`tokens` spine a bag row does NOT own. */
const LEDGER_SPINE = {
  issue: 218,
  costUsd: null,
  wallMs: 0,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
} as const;

describe("IssueTelemetryBag", () => {
  it("emits nothing at all before anything is noted", () => {
    expect(new IssueTelemetryBag().toRow()).toEqual({});
  });

  it("accumulates each counter independently", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerAttempt(1);
    bag.noteImplementerAttempt(2);
    bag.noteReviewerBlockers();
    bag.noteReviewerBlockers();
    bag.noteReviewerBlockers();
    bag.noteDeferral("TRANSIENT_ERROR");
    bag.noteDeferral("TRANSIENT_ERROR");

    expect(bag.toRow()).toEqual({
      implementerAttempts: 2,
      reviewerBlockers: 3,
      deferrals: 2,
    });
  });

  it("keeps two issues' bags fully independent", () => {
    const a = new IssueTelemetryBag();
    const b = new IssueTelemetryBag();
    a.noteReviewerBlockers();
    a.noteQuarantine("needs a human");
    b.noteRecovery();

    expect(a.toRow()).toEqual({ reviewerBlockers: 1, quarantined: true });
    expect(b.toRow()).toEqual({ recovery: true });
  });

  it("treats the implementer attempt as a monotonic ordinal, not a tally", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerAttempt(2);
    bag.noteImplementerAttempt(2); // double-noting is safe
    bag.noteImplementerAttempt(1); // a stale lower ordinal never regresses it
    expect(bag.toRow().implementerAttempts).toBe(2);
  });

  it("records the escalation model alongside the escalation flag", () => {
    const bag = new IssueTelemetryBag();
    bag.noteReviewerEscalated("claude-opus-5");
    expect(bag.toRow()).toEqual({
      reviewerEscalated: true,
      reviewerEscalationModel: "claude-opus-5",
    });
  });

  it("flags an escalation with no usable model id without inventing one", () => {
    const bag = new IssueTelemetryBag();
    bag.noteReviewerEscalated("");
    const row = bag.toRow();
    expect(row).toEqual({ reviewerEscalated: true });
    expect(row).not.toHaveProperty("reviewerEscalationModel");
  });

  it("records a measured zero diff as 0, distinct from an unmeasured one", () => {
    const measured = new IssueTelemetryBag();
    measured.noteDiff(0, 0);
    expect(measured.toRow()).toEqual({ changedLines: 0, changedFiles: 0 });
    expect(new IssueTelemetryBag().toRow()).not.toHaveProperty("changedLines");
  });

  it("takes the latest diff measurement, since a diff is re-measured not summed", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(10, 2);
    bag.noteDiff(31, 4);
    expect(bag.toRow()).toEqual({ changedLines: 31, changedFiles: 4 });
  });

  it("records the changed file paths, in order, when given", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(31, 3, ["a.ts", "b.ts", "c.ts"]);
    expect(bag.toRow().changedFilePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("omits changedFilePaths when noteDiff was called without a third argument", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(31, 3);
    expect(bag.toRow()).not.toHaveProperty("changedFilePaths");
  });

  it("records an explicitly empty path list as [], distinct from never measured", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(0, 0, []);
    const row = bag.toRow();
    expect(row).toHaveProperty("changedFilePaths");
    expect(row.changedFilePaths).toEqual([]);
  });

  it("truncates the path list beyond the cap but leaves changedFiles authoritative", () => {
    const bag = new IssueTelemetryBag();
    const paths = Array.from({ length: MAX_CHANGED_FILE_PATHS + 50 }, (_, i) => `f${i}.ts`);
    bag.noteDiff(9999, paths.length, paths);
    const row = bag.toRow();
    expect(row.changedFilePaths).toHaveLength(MAX_CHANGED_FILE_PATHS);
    expect(row.changedFilePaths).toEqual(paths.slice(0, MAX_CHANGED_FILE_PATHS));
    expect(row.changedFiles).toBe(paths.length);
  });

  it("drops non-string and empty-string path elements instead of coercing them", () => {
    const bag = new IssueTelemetryBag();
    const hostile = { toString() { throw new Error("hostile"); } };
    bag.noteDiff(5, 5, ["real.ts", "", 42, null, hostile, "also-real.ts"] as never);
    expect(bag.toRow().changedFilePaths).toEqual(["real.ts", "also-real.ts"]);
  });

  it("survives a path array whose iterator throws, leaving the field untouched", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(2, 2, ["good.ts"]);
    // Array.isArray() is TRUE for a Proxy wrapping an array, so the walk can be
    // re-entered by hostile traps. A setter this module promises cannot throw
    // must swallow that, and must not half-write the field either.
    const poisoned = new Proxy([] as string[], {
      get(_target, prop) {
        if (prop === Symbol.iterator) throw new Error("poisoned iterator");
        return undefined;
      },
    });
    expect(() => bag.noteDiff(3, 3, poisoned)).not.toThrow();
    expect(bag.toRow().changedFilePaths).toEqual(["good.ts"]);
  });

  it("copies the path array in, so a later caller mutation cannot rewrite recorded telemetry", () => {
    const bag = new IssueTelemetryBag();
    const paths = ["a.ts", "b.ts"];
    bag.noteDiff(2, 2, paths);
    paths.push("c.ts");
    paths[0] = "mutated.ts";
    expect(bag.toRow().changedFilePaths).toEqual(["a.ts", "b.ts"]);
  });

  it("copies the path array out, so a consumer mutating the row cannot reach into the bag", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(2, 2, ["a.ts", "b.ts"]);
    const first = bag.toRow();
    first.changedFilePaths!.push("intruder.ts");
    expect(bag.toRow().changedFilePaths).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps quarantine and outcome orthogonal", () => {
    const bag = new IssueTelemetryBag();
    bag.noteQuarantine("blocked on a human");
    expect(bag.toRow()).not.toHaveProperty("outcome");
    bag.noteOutcome("error");
    expect(bag.toRow()).toEqual({ quarantined: true, outcome: "error" });
  });

  it("accepts every in-enum ship path and outcome", () => {
    for (const path of [
      "first-pass-only",
      "critique-retry",
      "implementer-retry",
    ] as const) {
      const bag = new IssueTelemetryBag();
      bag.noteShipPath(path);
      expect(bag.toRow().shipPath).toBe(path);
    }
    for (const outcome of ["ok", "quarantined", "error", "deferred"] as const) {
      const bag = new IssueTelemetryBag();
      bag.noteOutcome(outcome);
      expect(bag.toRow().outcome).toBe(outcome);
    }
  });

  it("returns a fresh row each call, so a consumer cannot mutate the bag", () => {
    const bag = new IssueTelemetryBag();
    bag.noteReviewerBlockers();
    const first = bag.toRow();
    first.reviewerBlockers = 99;
    expect(bag.toRow().reviewerBlockers).toBe(1);
  });
});

describe("IssueTelemetryBag never-throw contract", () => {
  it("absorbs every kind of garbage argument without throwing", () => {
    const bag = new IssueTelemetryBag();
    for (const junk of GARBAGE) {
      const bad = junk as never;
      expect(() => bag.noteImplementerAttempt(bad)).not.toThrow();
      expect(() => bag.noteDeferral(bad)).not.toThrow();
      expect(() => bag.noteQuarantine(bad)).not.toThrow();
      expect(() => bag.noteReviewerEscalated(bad)).not.toThrow();
      expect(() => bag.noteDiff(bad, bad)).not.toThrow();
      expect(() => bag.noteDiff(bad, bad, bad)).not.toThrow();
      expect(() => bag.noteShipPath(bad)).not.toThrow();
      expect(() => bag.noteOutcome(bad)).not.toThrow();
      expect(() => bag.noteScreenCheck(bad)).not.toThrow();
      expect(() => bag.noteStopReason(bad)).not.toThrow();
      expect(() => bag.toRow()).not.toThrow();
    }
    // The third argument's ELEMENTS can individually be garbage too — a
    // hostile array is not the same failure mode as a hostile scalar.
    expect(() => bag.noteDiff(1, 1, GARBAGE as never)).not.toThrow();
    expect(() => bag.toRow()).not.toThrow();
  });

  it("drops an unusable implementer ordinal instead of clamping it to a lying 0", () => {
    for (const junk of [NaN, Infinity, -1, 0, 0.4]) {
      const bag = new IssueTelemetryBag();
      bag.noteImplementerAttempt(junk);
      expect(bag.toRow()).not.toHaveProperty("implementerAttempts");
    }
  });

  it("keeps a good implementer ordinal when a later bad one arrives", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerAttempt(2);
    bag.noteImplementerAttempt(NaN);
    bag.noteImplementerAttempt(-5);
    expect(bag.toRow().implementerAttempts).toBe(2);
  });

  it("drops an out-of-enum shipPath or outcome rather than poisoning the parse", () => {
    const bag = new IssueTelemetryBag();
    bag.noteShipPath("recovery-retry");
    bag.noteOutcome("QUARANTINED");
    const row = bag.toRow();
    expect(row).not.toHaveProperty("shipPath");
    expect(row).not.toHaveProperty("outcome");
  });

  it("leaves an already-valid enum intact when a bad one arrives after it", () => {
    const bag = new IssueTelemetryBag();
    bag.noteShipPath("implementer-retry");
    bag.noteOutcome("ok");
    bag.noteShipPath(null);
    bag.noteOutcome("done");
    expect(bag.toRow()).toEqual({ shipPath: "implementer-retry", outcome: "ok" });
  });

  it("does not corrupt sibling fields when one diff argument is garbage", () => {
    const bag = new IssueTelemetryBag();
    bag.noteDiff(120, 6);
    bag.noteDiff(NaN, 7);
    expect(bag.toRow()).toEqual({ changedLines: 120, changedFiles: 7 });
  });

  it("still emits every good field after a barrage of bad calls", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerAttempt(2);
    bag.noteReviewerBlockers();
    for (const junk of GARBAGE) {
      bag.noteImplementerAttempt(junk as never);
      bag.noteShipPath(junk);
      bag.noteOutcome(junk);
      bag.noteDiff(junk as never, junk as never);
    }
    bag.noteShipPath("implementer-retry");
    expect(bag.toRow()).toEqual({
      implementerAttempts: 2,
      reviewerBlockers: 1,
      shipPath: "implementer-retry",
      // noteReviewerEscalated is NOT called above, so the flag stays absent
    });
  });
});

describe("IssueTelemetryBag.noteScreenCheck — the observed half of the record (issue #912, Piece K)", () => {
  it("records a full, valid observation", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      screen: "/finance/reports?view=team",
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureLink: "issue-912/finance-reports.png",
      pictureStored: true,
    });
    expect(bag.toRow().screenCheck).toEqual({
      screen: "/finance/reports?view=team",
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureLink: "issue-912/finance-reports.png",
      pictureStored: true,
    });
  });

  it("records the four failure verdicts distinctly — never-settled, claim-mismatch, environment-fault and graded-mismatch never collapse into one another", () => {
    for (const verdict of ["never-settled", "claim-mismatch", "environment-fault", "graded-mismatch"] as const) {
      const bag = new IssueTelemetryBag();
      bag.noteScreenCheck({
        verdict,
        whenIso: "2026-08-04T13:00:00.000Z",
        rerun: false,
        pictureStored: false,
      });
      expect(bag.toRow().screenCheck?.verdict).toBe(verdict);
    }
  });

  it("omits pictureLink/screen when absent, without inventing empty strings", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "inconclusive",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: true,
      pictureStored: false,
    });
    const row = bag.toRow();
    expect(row.screenCheck).not.toHaveProperty("screen");
    expect(row.screenCheck).not.toHaveProperty("pictureLink");
  });

  it("drops the whole record on an out-of-enum verdict rather than recording a lie", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "sort-of-passed",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
    });
    expect(bag.toRow()).not.toHaveProperty("screenCheck");
  });

  it("drops the whole record when a required field is missing (no verdict, no whenIso, no pictureStored, no rerun)", () => {
    const cases = [
      { whenIso: "x", rerun: false, pictureStored: false },
      { verdict: "match", rerun: false, pictureStored: false },
      { verdict: "match", whenIso: "x", pictureStored: false },
      { verdict: "match", whenIso: "x", rerun: false },
    ];
    for (const c of cases) {
      const bag = new IssueTelemetryBag();
      bag.noteScreenCheck(c);
      expect(bag.toRow()).not.toHaveProperty("screenCheck");
    }
  });

  it("last write wins across a re-run — the FINAL harness attempt's record survives", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "never-settled",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
    });
    bag.noteScreenCheck({
      verdict: "match",
      whenIso: "2026-08-04T13:00:05.000Z",
      rerun: true,
      pictureStored: true,
      pictureLink: "issue-912/x.png",
    });
    expect(bag.toRow().screenCheck?.verdict).toBe("match");
    expect(bag.toRow().screenCheck?.rerun).toBe(true);
  });

  it("carries the attempt trail — BOTH runs' verdicts survive onto the row, in attempt order", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      // The exact disagreement `moreEvidencedVerdict` exists for: attempt 1
      // proved the figure wrong, attempt 2 hit a container hiccup and proved
      // nothing, and attempt 1 was kept. Without the trail a human reading
      // this row cannot see that the two runs said different things, let
      // alone audit which one was chosen.
      verdict: "graded-mismatch",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: true,
      pictureStored: false,
      attemptVerdicts: ["graded-mismatch", "inconclusive"],
    });
    expect(bag.toRow().screenCheck?.attemptVerdicts).toEqual([
      "graded-mismatch",
      "inconclusive",
    ]);
  });

  it("keeps a one-attempt trail — length 1 (no re-run was needed) is a real trail, not a broken one", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: true,
      attemptVerdicts: ["match"],
    });
    expect(bag.toRow().screenCheck?.attemptVerdicts).toEqual(["match"]);
  });

  it("leaves the trail ABSENT when none was supplied — never invented as []", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: true,
    });
    expect(bag.toRow().screenCheck?.verdict).toBe("match");
    expect(bag.toRow().screenCheck).not.toHaveProperty("attemptVerdicts");
  });

  it("drops a non-array trail WITHOUT dropping the observation it arrived on", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "claim-mismatch",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: true,
      pictureStored: false,
      attemptVerdicts: "graded-mismatch",
    });
    const row = bag.toRow();
    expect(row.screenCheck?.verdict).toBe("claim-mismatch");
    expect(row.screenCheck).not.toHaveProperty("attemptVerdicts");
  });

  it("drops the WHOLE trail when any entry is unusable — a partial trail reads as a shorter run, which is a lie", () => {
    for (const trail of [
      ["graded-mismatch", "sort-of-passed"],
      ["graded-mismatch", 7],
      ["graded-mismatch", null],
      [],
      // Over the cap: DROPPED WHOLE, never sliced — a truncated trail reads
      // as a run with fewer attempts.
      new Array<string>(MAX_SCREEN_CHECK_ATTEMPT_VERDICTS + 1).fill("match"),
    ]) {
      const bag = new IssueTelemetryBag();
      bag.noteScreenCheck({
        verdict: "graded-mismatch",
        whenIso: "2026-08-04T13:00:00.000Z",
        rerun: true,
        pictureStored: false,
        attemptVerdicts: trail,
      });
      const row = bag.toRow();
      expect(row.screenCheck?.verdict).toBe("graded-mismatch");
      expect(row.screenCheck).not.toHaveProperty("attemptVerdicts");
    }
  });

  it("copies the trail by value — neither the caller's array nor a handed-out row can rewrite what the bag holds", () => {
    const bag = new IssueTelemetryBag();
    const callersTrail = ["graded-mismatch", "inconclusive"];
    bag.noteScreenCheck({
      verdict: "graded-mismatch",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: true,
      pictureStored: false,
      attemptVerdicts: callersTrail,
    });
    callersTrail.push("match");
    bag.toRow().screenCheck?.attemptVerdicts?.push("never-settled");
    expect(bag.toRow().screenCheck?.attemptVerdicts).toEqual([
      "graded-mismatch",
      "inconclusive",
    ]);
  });

  it("stays separable from implementerCertification — the claimed half never merges with the observed half", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerCertification({
      e2eRequired: true,
      e2eActuallyRan: true,
    });
    bag.noteScreenCheck({
      verdict: "claim-mismatch",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
    });
    const row = bag.toRow();
    expect(row.implementerCertification).toEqual({
      e2eRequired: true,
      e2eActuallyRan: true,
    });
    expect(row.screenCheck?.verdict).toBe("claim-mismatch");
  });

  // -------------------------------------------------------------------------
  // `enforcement` is the field the schema itself calls load-bearing — a night
  // of watch-only verdicts has to be distinguishable from a night of enforced
  // ones when the owner reads the numbers to decide whether to flip the
  // switch (issue #916). Every OTHER field on this record was covered here;
  // this one shipped with no test at all (2026-08-04 review).
  // -------------------------------------------------------------------------

  it("carries `enforcement` end to end: schema -> bag -> row", () => {
    for (const enforcement of ["watch-only", "enforcing"] as const) {
      const bag = new IssueTelemetryBag();
      bag.noteScreenCheck({
        screen: "/finance/reports?view=team",
        verdict: "graded-mismatch",
        whenIso: "2026-08-04T13:00:00.000Z",
        rerun: false,
        pictureStored: false,
        enforcement,
      });
      expect(bag.toRow().screenCheck?.enforcement).toBe(enforcement);
      const parsed = IssueTelemetryRowSchema.safeParse({
        ...LEDGER_SPINE,
        ...bag.toRow(),
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("drops an unrecognised `enforcement` rather than letting it reach a validated snapshot", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
      enforcement: "sort-of",
    });
    expect(bag.toRow().screenCheck).not.toHaveProperty("enforcement");
  });

  it("omits `enforcement` entirely when the caller never said which mode ran", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
    });
    expect(bag.toRow().screenCheck).not.toHaveProperty("enforcement");
  });
});

// ---------------------------------------------------------------------------
// `checkWriterProofCarriedForward` — the same auditability question
// `enforcement` answers for the screen check, for the must-fail-first proof
// (2026-08-04 review). `checkWriterMustFailFirst: "red"` on a row says
// nothing about whether THIS run observed the red or inherited somebody
// else's observation of it.
// ---------------------------------------------------------------------------

describe("IssueTelemetryBag.noteCheckWriterProofCarriedForward", () => {
  it("is absent until noted, then true — never false", () => {
    const bag = new IssueTelemetryBag();
    expect(bag.toRow()).not.toHaveProperty("checkWriterProofCarriedForward");
    bag.noteCheckWriterProofCarriedForward();
    expect(bag.toRow().checkWriterProofCarriedForward).toBe(true);
  });

  it("sits alongside the proof's own verdict, and both survive the schema", () => {
    const bag = new IssueTelemetryBag();
    bag.noteCheckWriterOutcome("checks-written");
    bag.noteCheckWriterInherited();
    bag.noteCheckWriterProofCarriedForward();
    const row = bag.toRow();
    expect(row.checkWriterInherited).toBe(true);
    expect(row.checkWriterProofCarriedForward).toBe(true);
    const parsed = IssueTelemetryRowSchema.safeParse({
      ...LEDGER_SPINE,
      ...row,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("IssueTelemetryBag — the first-test fall-through counters (#1198 A)", () => {
  it("records nothing at all on an ordinary ticket — ABSENT is not ZERO", () => {
    // The overwhelming majority of tickets never fall through, and a row
    // carrying `firstTestFallThrough: undefined` beside one carrying a real
    // reason is how a person tells the two apart at a glance.
    const row = new IssueTelemetryBag().toRow();
    expect(row.firstTestFallThrough).toBeUndefined();
    expect(row.shippedWithoutFirstTest).toBeUndefined();
  });

  it("records WHICH of the three ways the first test failed, and the row validates", () => {
    const bag = new IssueTelemetryBag();
    bag.noteFirstTestFallThrough("weak-check");
    const row = bag.toRow();
    expect(row.firstTestFallThrough).toBe("weak-check");
    const parsed = IssueTelemetryRowSchema.safeParse({
      ...LEDGER_SPINE,
      ...row,
    });
    expect(parsed.success).toBe(true);
  });

  it("LAST WRITE WINS — a ticket that falls through twice reports the reason the builder was finally dispatched under", () => {
    const bag = new IssueTelemetryBag();
    bag.noteFirstTestFallThrough("run-fault");
    bag.noteFirstTestFallThrough("test-disagreed");
    expect(bag.toRow().firstTestFallThrough).toBe("test-disagreed");
  });

  it("DROPS an out-of-enum reason rather than writing a row the schema would refuse", () => {
    // Same discipline as `noteCheckWriterOutcome`. A bag that records a value
    // the schema refuses does not lose one field — it fails validation and
    // kills the whole telemetry line for that ticket.
    const bag = new IssueTelemetryBag();
    bag.noteFirstTestFallThrough("something-else-entirely");
    expect(bag.toRow().firstTestFallThrough).toBeUndefined();
  });

  it("shippedWithoutFirstTest is SEPARATE from the fall-through itself", () => {
    // A run where every fall-through ticket was then REFUSED by the reviewer
    // is a very different night from one where they all shipped, and one
    // field cannot tell those apart. The end-of-run report reads the ship
    // half, never the other.
    const refused = new IssueTelemetryBag();
    refused.noteFirstTestFallThrough("no-failing-check");
    expect(refused.toRow().firstTestFallThrough).toBe("no-failing-check");
    expect(refused.toRow().shippedWithoutFirstTest).toBeUndefined();

    const shipped = new IssueTelemetryBag();
    shipped.noteFirstTestFallThrough("no-failing-check");
    shipped.noteShippedWithoutFirstTest();
    expect(shipped.toRow().shippedWithoutFirstTest).toBe(true);
  });
});

describe("IssueTelemetryBag.noteStopReason — the five ways a ticket stops (issue #914, Piece H)", () => {
  it("records a label with no disagreement (four of the five stops)", () => {
    const bag = new IssueTelemetryBag();
    bag.noteStopReason({
      label: "stopped:already-built",
      detail: "reports/page.tsx already does this",
    });
    expect(bag.toRow().stopReason).toEqual({
      label: "stopped:already-built",
      detail: "reports/page.tsx already does this",
    });
  });

  it("records all five labels distinctly — none collapse into another", () => {
    const labels = [
      "stopped:no-failing-check",
      "stopped:already-built",
      "stopped:check-disagreement",
      "stopped:checks-tampered",
      "stopped:could-not-grade",
    ] as const;
    for (const label of labels) {
      const bag = new IssueTelemetryBag();
      bag.noteStopReason({ label });
      expect(bag.toRow().stopReason?.label).toBe(label);
    }
  });

  it("drops the whole record on an out-of-enum label rather than recording a lie", () => {
    const bag = new IssueTelemetryBag();
    bag.noteStopReason({ label: "stopped:something-made-up" });
    expect(bag.toRow()).not.toHaveProperty("stopReason");
  });

  it("carries both sides of a disagreement, and never which side was wrong", () => {
    const bag = new IssueTelemetryBag();
    bag.noteStopReason({
      label: "stopped:check-disagreement",
      detail: "the ladder ran out",
      disagreement: {
        checkDemanded: "team total = sum(agents)",
        builderProduced: "3 files, 40 lines",
        builderAccount: "reviewer certified ALL_CLEAR",
      },
    });
    const row = bag.toRow();
    expect(row.stopReason?.disagreement?.checkDemanded).toBe(
      "team total = sum(agents)",
    );
    expect(row.stopReason?.disagreement?.builderProduced).toBe("3 files, 40 lines");
    expect(row.stopReason?.disagreement?.builderAccount).toBe(
      "reviewer certified ALL_CLEAR",
    );
    // Owner ruling 12 (issue #1117): which side was wrong lives on the
    // GitHub ticket only, never in this file, because this file is
    // committed to git and a verdict here would need a pull request every
    // time. So nothing here may carry one.
    expect(row.stopReason?.disagreement).not.toHaveProperty("resolution");
  });

  it("drops a verdict smuggled into the durable record — its only home is the ticket", () => {
    const bag = new IssueTelemetryBag();
    bag.noteStopReason({
      label: "stopped:check-disagreement",
      disagreement: { resolution: "builder-wrong" },
    } as never);
    expect(bag.toRow().stopReason?.disagreement).toBeUndefined();
  });

  it("last write wins — a second stop in one pipeline run replaces the first", () => {
    const bag = new IssueTelemetryBag();
    bag.noteStopReason({ label: "stopped:no-failing-check" });
    bag.noteStopReason({ label: "stopped:checks-tampered" });
    expect(bag.toRow().stopReason?.label).toBe("stopped:checks-tampered");
  });

  it("stays separable from screenCheck — the stop label and the harness's observation never merge", () => {
    const bag = new IssueTelemetryBag();
    bag.noteScreenCheck({
      verdict: "graded-mismatch",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: false,
    });
    bag.noteStopReason({ label: "stopped:check-disagreement" });
    const row = bag.toRow();
    expect(row.screenCheck?.verdict).toBe("graded-mismatch");
    expect(row.stopReason?.label).toBe("stopped:check-disagreement");
    expect(row.stopReason).not.toBe(row.screenCheck);
  });
});

describe("IssueTelemetryBag schema round-trip", () => {
  it("passes IssueTelemetryRowSchema once padded with the ledger's spine", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerAttempt(2);
    bag.noteReviewerBlockers();
    bag.noteDeferral("TRANSIENT_ERROR");
    bag.noteRecovery();
    bag.noteQuarantine("human needed");
    bag.noteReviewerEscalated("claude-opus-5");
    bag.noteDiff(310, 12, ["a.ts", "b.ts"]);
    bag.noteShipPath("implementer-retry");
    bag.noteOutcome("quarantined");
    bag.noteScreenCheck({
      screen: "/finance/reports?view=team",
      verdict: "graded-mismatch",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: true,
      pictureLink: "issue-912/finance-reports.png",
      pictureStored: true,
    });
    bag.noteStopReason({
      label: "stopped:check-disagreement",
      detail: "the ladder ran out",
      disagreement: {
        checkDemanded: "team total = sum(agents)",
        builderProduced: "3 files, 40 lines",
        builderAccount: "reviewer certified ALL_CLEAR",
      },
    });

    const parsed = IssueTelemetryRowSchema.safeParse({
      ...LEDGER_SPINE,
      ...bag.toRow(),
    });
    expect(parsed.success).toBe(true);
  });

  it("passes the schema when the bag saw only garbage (an empty row)", () => {
    const bag = new IssueTelemetryBag();
    for (const junk of GARBAGE) {
      bag.noteShipPath(junk);
      bag.noteOutcome(junk);
      bag.noteImplementerAttempt(junk as never);
    }
    const parsed = IssueTelemetryRowSchema.safeParse({
      ...LEDGER_SPINE,
      ...bag.toRow(),
    });
    expect(parsed.success).toBe(true);
  });

  it("merges over a ledger row without clobbering the ledger's fields", () => {
    const bag = new IssueTelemetryBag();
    bag.noteOutcome("ok");
    const merged = { ...LEDGER_SPINE, costUsd: 1.23, ...bag.toRow() };
    expect(merged.costUsd).toBe(1.23);
    expect(merged.outcome).toBe("ok");
  });
});

describe("RunCounters", () => {
  it("emits nothing at all before anything is noted", () => {
    expect(new RunCounters().toRunTelemetry()).toEqual({});
  });

  it("never emits an empty counters or errorClasses sub-object", () => {
    const counters = new RunCounters();
    counters.bump("recoveries");
    const out = counters.toRunTelemetry();
    expect(out).toEqual({ counters: { recoveries: 1 } });
    expect(out).not.toHaveProperty("errorClasses");
  });

  it("accumulates each of the five run counters independently", () => {
    const counters = new RunCounters();
    counters.bump("reviewerBlockers");
    counters.bump("reviewerBlockers");
    counters.bump("implementerRetries", 6);
    counters.bump("recoveries", 3);
    counters.bump("quarantines");
    counters.bump("deferrals", 2);

    expect(counters.toRunTelemetry().counters).toEqual({
      reviewerBlockers: 2,
      implementerRetries: 6,
      recoveries: 3,
      quarantines: 1,
      deferrals: 2,
    });
  });

  it("keeps two runs' counters independent", () => {
    const a = new RunCounters();
    const b = new RunCounters();
    a.bump("quarantines");
    b.bump("deferrals", 4);
    expect(a.toRunTelemetry().counters).toEqual({ quarantines: 1 });
    expect(b.toRunTelemetry().counters).toEqual({ deferrals: 4 });
  });

  it("drops an unknown counter key without touching the known ones", () => {
    const counters = new RunCounters();
    counters.bump("quarantines");
    counters.bump("implementerAttempts" as RunCounterKey);
    counters.bump("" as RunCounterKey);
    counters.bump("__proto__" as RunCounterKey);
    counters.bump("toString" as RunCounterKey);
    expect(counters.toRunTelemetry().counters).toEqual({ quarantines: 1 });
  });

  it("absorbs a garbage bump amount without throwing or corrupting the total", () => {
    const counters = new RunCounters();
    counters.bump("deferrals", 2);
    for (const junk of GARBAGE) {
      // `undefined` is excluded deliberately: it is not garbage, it is the
      // documented `by = 1` default and MUST still bump.
      if (junk !== undefined) {
        expect(() => counters.bump("deferrals", junk as never)).not.toThrow();
      }
      expect(() => counters.bump(junk as never)).not.toThrow();
    }
    expect(counters.toRunTelemetry().counters).toEqual({ deferrals: 2 });
  });

  it("accumulates skill-discipline misses per role", () => {
    const counters = new RunCounters();
    counters.noteSkillMiss("implementer", 2);
    counters.noteSkillMiss("implementer", 1);
    counters.noteSkillMiss("reviewer", 1);
    expect(counters.toRunTelemetry().counters).toEqual({
      skillDisciplineMisses: { implementer: 3, reviewer: 1 },
    });
  });

  it("records a role measured at zero misses, distinct from an unmeasured role", () => {
    const counters = new RunCounters();
    counters.noteSkillMiss("critique", 0);
    const misses = counters.toRunTelemetry().counters?.skillDisciplineMisses;
    expect(misses).toEqual({ critique: 0 });
    expect(misses).not.toHaveProperty("reviewer");
  });

  it("never coerces a role key, so a hostile toString cannot throw", () => {
    const counters = new RunCounters();
    // Role keys are an OPEN record by design, so any non-empty string is a
    // legitimate role. What must never happen is coercing a NON-string into
    // one — `String(symbol)` and interpolating a throwing `toString` both throw.
    for (const junk of GARBAGE.filter((g) => typeof g !== "string")) {
      expect(() => counters.noteSkillMiss(junk as never, 1)).not.toThrow();
    }
    expect(() => counters.noteSkillMiss("", 1)).not.toThrow();
    counters.noteSkillMiss("implementer", 1);
    expect(counters.toRunTelemetry().counters).toEqual({
      skillDisciplineMisses: { implementer: 1 },
    });
  });

  it("absorbs a garbage miss count without throwing or corrupting the role", () => {
    const counters = new RunCounters();
    counters.noteSkillMiss("implementer", 2);
    for (const junk of GARBAGE.filter((g) => g !== undefined)) {
      expect(() => counters.noteSkillMiss("implementer", junk as never)).not.toThrow();
    }
    expect(counters.toRunTelemetry().counters).toEqual({
      skillDisciplineMisses: { implementer: 2 },
    });
  });

  it("counts a boolean error class as one occurrence and a false one as none", () => {
    const counters = new RunCounters();
    counters.noteErrorClass({ transient: true, outputCap: false });
    counters.noteErrorClass({ transient: true });
    const errorClasses = counters.toRunTelemetry().errorClasses;
    expect(errorClasses).toEqual({ transient: 2 });
    expect(errorClasses).not.toHaveProperty("outputCap");
  });

  it("counts every error class the loop distinguishes", () => {
    const counters = new RunCounters();
    counters.noteErrorClass({ stalled: true });
    counters.noteErrorClass({ noVerdict: 2 });
    counters.noteErrorClass({ outputCap: true });
    expect(counters.toRunTelemetry().errorClasses).toEqual({
      stalled: 1,
      noVerdict: 2,
      outputCap: 1,
    });
  });

  it("ignores an unknown error-class property and garbage values", () => {
    const counters = new RunCounters();
    counters.noteErrorClass({ bogus: 5, transient: true } as never);
    for (const junk of GARBAGE) {
      expect(() => counters.noteErrorClass(junk as never)).not.toThrow();
      expect(() =>
        counters.noteErrorClass({ stalled: junk } as never),
      ).not.toThrow();
    }
    expect(counters.toRunTelemetry().errorClasses).toEqual({ transient: 1 });
  });

  it("returns a fresh object each call, so a consumer cannot mutate the counters", () => {
    const counters = new RunCounters();
    counters.bump("recoveries");
    const first = counters.toRunTelemetry();
    first.counters!.recoveries = 99;
    expect(counters.toRunTelemetry().counters?.recoveries).toBe(1);
  });

  it("passes RunTelemetrySchema, populated and empty alike", () => {
    expect(RunTelemetrySchema.safeParse(new RunCounters().toRunTelemetry()).success).toBe(
      true,
    );
    const counters = new RunCounters();
    counters.bump("implementerRetries", 6);
    counters.bump("quarantines");
    counters.noteSkillMiss("implementer", 2);
    counters.noteErrorClass({ transient: true, outputCap: 3 });
    expect(RunTelemetrySchema.safeParse(counters.toRunTelemetry()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `checkWriterMarkerReconciled` (2026-09-10) — the check-writer closed a
// `UNIT_CHECK_WRITTEN` envelope with `CHECKS_WRITTEN` on its last line (or the
// reverse) and the host took the envelope's reading instead of stopping the
// ticket. Counted so the prompt fix that went in beside it can be measured.
// ---------------------------------------------------------------------------

describe("IssueTelemetryBag.noteCheckWriterMarkerReconciled", () => {
  it("is absent until noted, then true — never false", () => {
    const bag = new IssueTelemetryBag();
    expect(bag.toRow()).not.toHaveProperty("checkWriterMarkerReconciled");
    bag.noteCheckWriterMarkerReconciled();
    expect(bag.toRow().checkWriterMarkerReconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `siblingChecksAmended` (#1271) — how many of ANOTHER ticket's frozen test
// files this ticket's merge had to rewrite, on the run's own judge ruling,
// before it could ship. Written at the ship moment, beside the
// `shipped-with-sibling-check-amended` label going onto the issue.
// ---------------------------------------------------------------------------

describe("IssueTelemetryBag.noteOlderTestEditCount (#1271)", () => {
  it("records nothing on an ordinary ticket — ABSENT is not ZERO", () => {
    // The overwhelming majority of tickets never touch another ticket's
    // check. A row carrying `siblingChecksAmended: 0` beside one that never
    // reached the road would claim a measurement that never happened.
    expect(new IssueTelemetryBag().toRow()).not.toHaveProperty(
      "siblingChecksAmended",
    );
  });

  it("records how many sibling files were amended, and the row validates", () => {
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEditCount(1);
    expect(bag.toRow().siblingChecksAmended).toBe(1);
    const parsed = IssueTelemetryRowSchema.safeParse({
      ...LEDGER_SPINE,
      ...bag.toRow(),
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps the MAXIMUM, so a re-note at a second ship site cannot double it", () => {
    // Four ship-moment call sites read the same one `ctx.olderTestEditRecord`
    // record, and the bag is reused across a redispatch of the same issue
    // within one run. Summing would turn one amendment into two the first
    // time any of that fires twice.
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEditCount(2);
    bag.noteOlderTestEditCount(2);
    expect(bag.toRow().siblingChecksAmended).toBe(2);
  });

  it("a stale lower count never regresses a higher one", () => {
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEditCount(3);
    bag.noteOlderTestEditCount(1);
    expect(bag.toRow().siblingChecksAmended).toBe(3);
  });

  it("DROPS a zero — a ticket on this road that amended nothing is not a measurement", () => {
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEditCount(0);
    expect(bag.toRow()).not.toHaveProperty("siblingChecksAmended");
  });

  it("absorbs every kind of garbage without throwing and without recording", () => {
    for (const bad of GARBAGE) {
      const bag = new IssueTelemetryBag();
      expect(() =>
        bag.noteOlderTestEditCount(bad as unknown as number),
      ).not.toThrow();
      expect(bag.toRow()).not.toHaveProperty("siblingChecksAmended");
    }
  });

  it("leaves every other field uncorrupted when handed garbage", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerAttempt(2);
    bag.noteOlderTestEditCount(NaN);
    expect(bag.toRow().implementerAttempts).toBe(2);
  });
});

describe("IssueTelemetryBag.noteOlderTestEdits (spec #1334 SE — the run report's list)", () => {
  const edit = {
    issueNumber: 1058,
    path: "packages/api/src/__checks__/issue-1058/relist.test.ts",
    linesAdded: 4,
    linesRemoved: 2,
    namedInTicket: false,
  };

  it("hands back the edits it was given, and none on an ordinary ticket", () => {
    expect(new IssueTelemetryBag().olderTestEdits()).toEqual([]);
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEdits([edit]);
    expect(bag.olderTestEdits()).toEqual([edit]);
  });

  it("REPLACES rather than appends — four ship sites read the same record", () => {
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEdits([edit]);
    bag.noteOlderTestEdits([edit]);
    expect(bag.olderTestEdits()).toEqual([edit]);
  });

  it("stays in memory only — the telemetry row does not carry it", () => {
    const bag = new IssueTelemetryBag();
    bag.noteOlderTestEdits([edit]);
    expect(JSON.stringify(bag.toRow())).not.toContain("relist.test.ts");
  });
});
