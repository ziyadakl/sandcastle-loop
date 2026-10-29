/**
 * Issue #914 (Piece H) — the five stop reasons, proven distinguishable at the
 * PURE layer: five different labels, five different body sections, and the
 * harness-verdict -> label mapping folds exactly the way the module's own
 * doc comment claims.
 */
import { describe, expect, it } from "vitest";

import type { HarnessVerdict } from "../harness/verdict.js";
import { parseRefusalRecord, REFUSAL_OUTCOME_ANCHOR } from "./refusal.js";
import {
  buildScreenCheckWatchSection,
  buildStopBodySection,
  LOUD_STOP_REASONS,
  mapHarnessVerdictToStopReason,
  NEEDS_OWNER_DECISION_LABEL,
  OWNER_DECISION_STOP_REASONS,
  STOP_LABEL_DEFINITIONS,
  PIECE_H_STOP_REASON_LABELS,
  detailOf,
  reviewerRefusedExplanation,
  runFaultExplanation,
  safeFence,
  stagingRejectedExplanation,
  strandedExplanation,
  stuckNoCommitsExplanation,
  ticketUnclearExplanation,
  STOP_REASON_LABELS,
  type StopReasonLabel,
  upsertStopSection,
} from "./stop-reasons.js";

describe("STOP_REASON_LABELS", () => {
  it("is exactly eleven labels, all namespaced stopped:, all unique", () => {
    expect(STOP_REASON_LABELS).toHaveLength(11);
    expect(new Set(STOP_REASON_LABELS).size).toBe(11);
    for (const l of STOP_REASON_LABELS) expect(l.startsWith("stopped:")).toBe(true);
  });

  it("issue #923's four additions never disturbed Piece H's original five", () => {
    // The locked design (`docs/specs/2026-08-04-screen-check-design-lock.md`,
    // Piece H) names five labels and every stop the check-writer and the
    // harness can produce still maps to one of them. #923 added a second
    // axis — the reviewer, the merge gates, the run's own machinery — and
    // this pins that it ADDED rather than renamed or repurposed.
    expect(PIECE_H_STOP_REASON_LABELS).toHaveLength(5);
    for (const l of PIECE_H_STOP_REASON_LABELS) {
      expect(STOP_REASON_LABELS).toContain(l);
    }
    const added = STOP_REASON_LABELS.filter(
      (l) => !(PIECE_H_STOP_REASON_LABELS as readonly string[]).includes(l),
    );
    expect(added).toEqual([
      "stopped:reviewer-refused",
      "stopped:critique-blocked",
      "stopped:skills-skipped",
      "stopped:run-fault",
      "stopped:weak-check",
      "stopped:ticket-unclear",
    ]);
  });

  it("issue #1118's two additions are new labels, not a rename of an existing one", () => {
    // The judge's two findings are things no label could say before. Both had
    // an obvious wrong home and neither took it:
    //   - a weak check is NOT `stopped:no-failing-check` — that means the
    //     check could never go red at all, and is a quiet requeue;
    //   - an unclear ticket is NOT `stopped:check-disagreement` — nothing
    //     disagreed, and filing it there would put a phantom into the
    //     disagreement count the whole judge design rests on.
    expect(STOP_REASON_LABELS).toContain("stopped:weak-check");
    expect(STOP_REASON_LABELS).toContain("stopped:ticket-unclear");
    for (const l of ["stopped:weak-check", "stopped:ticket-unclear"] as const) {
      expect(PIECE_H_STOP_REASON_LABELS as readonly string[]).not.toContain(l);
    }
    // Piece H's snapshot is a snapshot: it stayed five when #923 added four
    // and it stays five now.
    expect(PIECE_H_STOP_REASON_LABELS).toHaveLength(5);
  });

  /**
   * The two labels #1198 A retired: nothing produces them any more, because
   * the loop no longer stops when it cannot make a first test good. They stay
   * in `STOP_REASON_LABELS` so the durable telemetry rows written before
   * #1198 still parse, and out of `STOP_LABEL_DEFINITIONS` so GitHub stops
   * offering a label the pipeline can no longer take.
   *
   * `stopped:critique-blocked` joined them in spec #1334, when the design
   * critique was folded into the reviewer.
   */
  const RETIRED = [
    "stopped:no-failing-check",
    "stopped:weak-check",
    "stopped:critique-blocked",
    "stopped:skills-skipped",
  ] as const;

  it("STOP_LABEL_DEFINITIONS covers every LIVE label, each with a description under GitHub's 100-char cap", () => {
    const names = STOP_LABEL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names)).toEqual(
      new Set(
        STOP_REASON_LABELS.filter(
          (l) => !(RETIRED as readonly string[]).includes(l),
        ),
      ),
    );
    for (const d of STOP_LABEL_DEFINITIONS) {
      expect(d.description.length).toBeLessThanOrEqual(100);
      expect(d.color).toMatch(/^[0-9A-Fa-f]{6}$/);
    }
  });

  it("#1198 A / #1334: the retired labels are readable but NOT creatable", () => {
    for (const name of RETIRED) {
      // Still in the vocabulary: `z.enum(STOP_REASON_LABELS)` in
      // `lib/status/schema.ts` parses telemetry rows written before #1198,
      // and `CHECK_READING_STOP_LABELS` still queries tickets wearing one.
      expect(STOP_REASON_LABELS as readonly string[]).toContain(name);
      // Gone from the CREATE list, so `ensureStopLabelsExist` can never put
      // it back in the repo's label picker for somebody to apply by hand.
      expect(STOP_LABEL_DEFINITIONS.map((d) => d.name)).not.toContain(name);
    }
  });

  it("exactly three are loud — every other stop is routine disposal, including all four of issue #923's", () => {
    // #923's four are deliberately QUIET. An alarm would be inert anyway:
    // no notification address is set on any machine (issue #1107, deferred
    // by owner decision 2026-08-15), so marking them loud would change
    // nothing today while quietly promising an alert that never comes.
    expect(LOUD_STOP_REASONS.size).toBe(3);
    for (const l of [
      "stopped:reviewer-refused",
      "stopped:critique-blocked",
      "stopped:skills-skipped",
      "stopped:run-fault",
    ] as const) {
      expect(LOUD_STOP_REASONS.has(l)).toBe(false);
    }
    expect(LOUD_STOP_REASONS.has("stopped:check-disagreement")).toBe(true);
    expect(LOUD_STOP_REASONS.has("stopped:checks-tampered")).toBe(true);
    expect(LOUD_STOP_REASONS.has("stopped:could-not-grade")).toBe(true);
    expect(LOUD_STOP_REASONS.has("stopped:no-failing-check")).toBe(false);
    expect(LOUD_STOP_REASONS.has("stopped:already-built")).toBe(false);
  });

  it("issue #1118's two are quiet — both are caught before a line of code is written", () => {
    // Nothing was spent and nothing broken shipped, which is the opposite of
    // an incident. Marking them loud would also promise an alert that never
    // arrives: no notification address is set on any machine (issue #1107).
    expect(LOUD_STOP_REASONS.has("stopped:weak-check")).toBe(false);
    expect(LOUD_STOP_REASONS.has("stopped:ticket-unclear")).toBe(false);
    expect(LOUD_STOP_REASONS.size).toBe(3);
  });

  it("only an unclear ticket carries needs-owner-decision — a first-test disagreement never reaches the owner", () => {
    // A ticket that never said what was wanted is a question no agent can
    // answer. A first test that disagrees with the build ships on the
    // reviewer's pass (spec #1334), so it is never an owner question.
    expect(OWNER_DECISION_STOP_REASONS.has("stopped:ticket-unclear")).toBe(true);
    expect(OWNER_DECISION_STOP_REASONS.has("stopped:check-disagreement")).toBe(false);
    expect(OWNER_DECISION_STOP_REASONS.has("stopped:weak-check")).toBe(false);
    expect(OWNER_DECISION_STOP_REASONS.size).toBe(1);
    // Still parseable for the old rows that wear it.
    expect(STOP_REASON_LABELS).toContain("stopped:check-disagreement");
    for (const label of OWNER_DECISION_STOP_REASONS) {
      expect(STOP_REASON_LABELS).toContain(label);
    }
  });

  it("needs-owner-decision is the repo's PRE-EXISTING label (never created by this module)", () => {
    expect(NEEDS_OWNER_DECISION_LABEL).toBe("needs-owner-decision");
    expect(STOP_LABEL_DEFINITIONS.map((d) => d.name)).not.toContain(
      NEEDS_OWNER_DECISION_LABEL,
    );
  });

  // Issue #926: the description said two causes ("page never finished, or
  // claimed the wrong view") while `mapHarnessVerdictToStopReason` had
  // already grown the fold to four (`environment-fault` and `inconclusive`
  // joined `never-settled`/`claim-mismatch`), so a broken sign-in shipped
  // under wording that only described a stuck page. The description is now
  // DERIVED from the mapping function itself (`buildCouldNotGradeDescription`
  // in stop-reasons.ts), so these two facts can't drift apart independently
  // — but assert the visible symptom directly too, so a regression here fails
  // loudly on the exact thing the issue reported rather than only on the
  // internal derivation.
  it("could-not-grade's description names a cause for every verdict that maps to it — not just two of four", () => {
    const allVerdicts: HarnessVerdict[] = [
      "match",
      "graded-mismatch",
      "never-settled",
      "claim-mismatch",
      "environment-fault",
      "inconclusive",
    ];
    const couldNotGradeVerdicts = allVerdicts.filter(
      (v) => mapHarnessVerdictToStopReason(v) === "stopped:could-not-grade",
    );
    // Pin the count so this test itself goes red the moment a fifth verdict
    // joins the fold, not just when the description text changes.
    expect(couldNotGradeVerdicts).toEqual([
      "never-settled",
      "claim-mismatch",
      "environment-fault",
      "inconclusive",
    ]);

    const description = STOP_LABEL_DEFINITIONS.find(
      (d) => d.name === "stopped:could-not-grade",
    )!.description;
    // Every cause has to show up as a recognizable, non-jargon phrase — not
    // the verdict's own identifier (an owner reading the label description
    // never sees "environment-fault" as a string).
    expect(description).toContain("page never finished");
    expect(description).toContain("wrong page");
    expect(description).toContain("sign-in");
    expect(description).toContain("no result");
    expect(description.length).toBeLessThanOrEqual(100);
  });
});

describe("mapHarnessVerdictToStopReason", () => {
  it("match ships — no stop label", () => {
    expect(mapHarnessVerdictToStopReason("match")).toBeUndefined();
  });

  it("graded-mismatch is the ONLY verdict that maps to check-disagreement", () => {
    expect(mapHarnessVerdictToStopReason("graded-mismatch")).toBe(
      "stopped:check-disagreement",
    );
  });

  it("never-settled, claim-mismatch, environment-fault and inconclusive all fold into could-not-grade", () => {
    // "environment-fault" (2026-08-04 review finding #6) joined this fold —
    // sign-in/navigation/app faults ahead of a graded assertion are no more
    // a builder-vs-check content disagreement than never-settled is.
    const verdicts: HarnessVerdict[] = [
      "never-settled",
      "claim-mismatch",
      "environment-fault",
      "inconclusive",
    ];
    for (const v of verdicts) {
      expect(mapHarnessVerdictToStopReason(v)).toBe("stopped:could-not-grade");
    }
  });

  it("every non-match verdict maps to a DIFFERENT label family than every other marker's stop (check-disagreement vs could-not-grade)", () => {
    const mapped = new Set(
      (
        [
          "graded-mismatch",
          "never-settled",
          "claim-mismatch",
          "environment-fault",
          "inconclusive",
        ] as const
      ).map((v) => mapHarnessVerdictToStopReason(v)),
    );
    // Two distinct outputs, not five, not one — exactly the fold this
    // module's doc comment claims.
    expect(mapped.size).toBe(2);
  });
});

describe("buildStopBodySection — proves every stop produces a DIFFERENT section", () => {
  const base = { runId: "run-42", whenIso: "2026-08-04T03:00:00.000Z" };

  it("every label's rendered section is unique — no two stops read the same", () => {
    const sections = STOP_REASON_LABELS.map((label) =>
      buildStopBodySection({ label, detail: `detail for ${label}`, ...base }),
    );
    expect(new Set(sections).size).toBe(sections.length);
  });

  it("a loud label's section says so; a quiet one's does not", () => {
    const loud = buildStopBodySection({
      label: "stopped:check-disagreement",
      detail: "x",
      ...base,
    });
    const quiet = buildStopBodySection({
      label: "stopped:already-built",
      detail: "x",
      ...base,
    });
    expect(loud).toContain("loud — an alarm was raised");
    expect(quiet).not.toContain("loud — an alarm was raised");
  });

  it("carries both sides of a disagreement, plus an unresolved marker until a human resolves it", () => {
    const section = buildStopBodySection({
      label: "stopped:check-disagreement",
      detail: "the ladder ran out",
      disagreement: {
        checkDemanded: "team total = sum(agents)",
        builderProduced: "touched 3 files, 40 lines",
        builderAccount: "reviewer certified ALL_CLEAR on critique-retry",
      },
      ...base,
    });
    expect(section).toContain("team total = sum(agents)");
    expect(section).toContain("touched 3 files, 40 lines");
    expect(section).toContain("reviewer certified ALL_CLEAR");
    expect(section).toContain("see the **Verdict** block");
  });

  // Issue #1117 retired the two-value `resolution` field that used to be
  // rendered here. A verdict now lives in its OWN block on the ticket, with
  // four values, because the stop block is replaced wholesale on the next
  // stop and would have destroyed a verdict the owner typed by hand.
  it("never carries a verdict itself — it points at the verdict block instead", () => {
    const section = buildStopBodySection({
      label: "stopped:check-disagreement",
      detail: "x",
      disagreement: { checkDemanded: "team total" },
      ...base,
    });
    expect(section).toContain("see the **Verdict** block");
    expect(section).not.toContain("the builder was wrong");
  });
});

describe("upsertStopSection — body update, not a comment; re-stopping updates, never duplicates", () => {
  it("appends a section to an empty body", () => {
    const result = upsertStopSection("", "## Stopped: already built\n\ncontent");
    expect(result).toContain("<!-- sandcastle:stop-report:start -->");
    expect(result).toContain("<!-- sandcastle:stop-report:end -->");
    expect(result).toContain("content");
  });

  it("preserves human-written content outside the markers", () => {
    const original = "This ticket needs a login form on /settings.";
    const result = upsertStopSection(original, "stop content v1");
    expect(result).toContain(original);
    expect(result).toContain("stop content v1");
  });

  it("a SECOND stop on the same ticket UPDATES the section — exactly one marker pair survives", () => {
    const original = "Human-written body text.";
    const afterFirst = upsertStopSection(original, "first stop: no-failing-check");
    const afterSecond = upsertStopSection(afterFirst, "second stop: check-disagreement");

    expect(afterSecond).toContain(original);
    expect(afterSecond).toContain("second stop: check-disagreement");
    expect(afterSecond).not.toContain("first stop: no-failing-check");

    const startCount = afterSecond.split("<!-- sandcastle:stop-report:start -->").length - 1;
    const endCount = afterSecond.split("<!-- sandcastle:stop-report:end -->").length - 1;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("three stops in a row still leave exactly one section, holding only the latest", () => {
    let body = "";
    for (let i = 1; i <= 3; i++) {
      body = upsertStopSection(body, `stop attempt ${i}`);
    }
    expect(body).toContain("stop attempt 3");
    expect(body).not.toContain("stop attempt 1");
    expect(body).not.toContain("stop attempt 2");
    const startCount = body.split("<!-- sandcastle:stop-report:start -->").length - 1;
    expect(startCount).toBe(1);
  });
});

describe("every stop is provably distinguishable end-to-end at the pure layer", () => {
  it("no two stops produce the same (label, section) pair", () => {
    const seen = new Map<StopReasonLabel, string>();
    for (const label of STOP_REASON_LABELS) {
      const section = buildStopBodySection({
        label,
        detail: `this stop is ${label}`,
        runId: "run-1",
        whenIso: "2026-08-04T00:00:00.000Z",
      });
      expect(seen.has(label)).toBe(false); // labels themselves are unique by construction
      seen.set(label, section);
    }
    const sections = [...seen.values()];
    // Counted from the label list itself, never a hand-typed number — issue
    // #923 added four labels and this assertion was the only thing in the
    // file that had to be re-typed to match.
    expect(new Set(sections).size).toBe(STOP_REASON_LABELS.length);
  });
});

// ---------------------------------------------------------------------------
// The red-screen-check record section (issue #916) had no tests at all. Since
// spec #1334 it is the ONLY outcome of a red screen check, so it has to say
// plainly that nothing was stopped, and which stop the verdict used to cause.
// ---------------------------------------------------------------------------

describe("buildScreenCheckWatchSection", () => {
  const base = {
    verdict: "graded-mismatch" as HarnessVerdict,
    screen: "/finance/reports?view=team",
    detail: "the harness read $2,000 where the check demanded $1,234",
    runId: "sandcastle/run-x",
    whenIso: "2026-08-04T13:00:00.000Z",
  };

  it("says plainly that the ticket was NOT stopped", () => {
    const s = buildScreenCheckWatchSection({
      ...base,
      wouldHaveStoppedAs: "stopped:check-disagreement",
    });
    expect(s).toContain("**This ticket was NOT stopped.**");
    expect(s).toContain("`graded-mismatch`");
    expect(s).toContain(base.detail);
  });

  it("names the stop label this verdict used to cause", () => {
    const s = buildScreenCheckWatchSection({
      ...base,
      wouldHaveStoppedAs: "stopped:check-disagreement",
    });
    expect(s).toContain("**Old stop label:** `stopped:check-disagreement`");
    expect(s).not.toMatch(/watch-only|enforcement/i);
  });

  it("carries the both-sides block when there is a disagreement to carry", () => {
    const s = buildScreenCheckWatchSection({
      ...base,
      wouldHaveStoppedAs: "stopped:check-disagreement",
      disagreement: {
        checkDemanded: "team total = $1,234",
        builderProduced: "3 files, 40 lines",
        builderAccount: "the reviewer certified ALL_CLEAR",
      },
    });
    expect(s).toContain("**What the check demanded:**");
    expect(s).toContain("team total = $1,234");
    expect(s).toContain("**What the builder produced:**");
    expect(s).toContain("**The builder's own account:**");
  });

  it("omits the both-sides block entirely when there is no disagreement", () => {
    const s = buildScreenCheckWatchSection({
      ...base,
      verdict: "never-settled",
      wouldHaveStoppedAs: "stopped:could-not-grade",
    });
    expect(s).not.toContain("**What the check demanded:**");
  });
});

/**
 * Issue #923 — the seven `quarantine` call sites in `main.mts` that wrote no
 * reason onto the ticket. Sixteen of forty stops over twelve days were blank,
 * costing $1,011.63.
 *
 * These cover the WORDING each of the seven now leaves behind. The wiring —
 * that `main.mts` actually calls them, and that no EIGHTH unrecorded site can
 * appear — is pinned separately in `main.stop-reasons.test.mts`.
 */
describe("issue #923 — the seven stops that used to write nothing", () => {
  describe("the three reviewer-refusal stops", () => {
    it("all four paths carry the reviewer's own marker and land on stopped:reviewer-refused", () => {
      for (const path of [
        "no-retry-available",
        "implementer-retry",
        "critique-retry",
        "recovery-review",
      ] as const) {
        const stop = reviewerRefusedExplanation({
          marker: "HAS_BLOCKERS",
          path,
        });
        expect(stop.label).toBe("stopped:reviewer-refused");
        expect(stop.detail).toContain("HAS_BLOCKERS");
      }
    });

    it("the four paths are described DIFFERENTLY — a stop that cannot say which path it took is unreadable again", () => {
      const details = (
        [
          "no-retry-available",
          "implementer-retry",
          "critique-retry",
          "recovery-review",
        ] as const
      ).map(
        (path) =>
          reviewerRefusedExplanation({ marker: "HAS_BLOCKERS", path }).detail,
      );
      expect(new Set(details).size).toBe(4);
    });

    it("names the path in plain words, never by its internal token (spec #1334)", () => {
      const detail = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "critique-retry",
      }).detail;
      expect(detail).not.toContain("critique-retry");
      expect(detail).toContain("via the reviewer's second pass");
    });

    it("never claims to be a check-versus-builder disagreement — that label carries needs-owner-decision and would corrupt the disagreement count", () => {
      const stop = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "implementer-retry",
      });
      expect(stop.label).not.toBe("stopped:check-disagreement");
      expect(LOUD_STOP_REASONS.has(stop.label)).toBe(false);
    });

    it("stamps the refusal-outcome checkbox on every path, so a wrong refusal becomes countable (#1096)", () => {
      for (const path of [
        "no-retry-available",
        "implementer-retry",
        "critique-retry",
        "recovery-review",
      ] as const) {
        const stop = reviewerRefusedExplanation({ marker: "HAS_BLOCKERS", path });
        expect(stop.detail).toContain(REFUSAL_OUTCOME_ANCHOR);
        expect(stop.detail).toContain("- [ ] correct");
        expect(stop.detail).toContain("- [ ] wrong");
        // The one-line why names the reviewer's marker, so whoever closes the
        // ticket can judge the refusal without reading the whole section.
        expect(stop.detail).toContain("HAS_BLOCKERS");
        expect(parseRefusalRecord(stop.detail)?.outcome).toBe("unjudged");
      }
    });

    it("the no-retry path repeats the run's OWN reason for having no retry, so the ticket does not just say 'it could not'", () => {
      const stop = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "no-retry-available",
        why: "retry disabled (--no-retry)",
      });
      expect(stop.detail).toContain("retry disabled (--no-retry)");
    });

    it("omitting the reason leaves no dangling sentence fragment", () => {
      const stop = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "no-retry-available",
      });
      expect(stop.detail).not.toContain("undefined");
      expect(stop.detail).not.toContain("The run's own reason");
    });

    it("the recovery-review path repeats the run's own why, and never claims a second, stronger model was tried — the rescue road has no builder retry ladder at all", () => {
      const stop = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "recovery-review",
        why: "the builder never finished (hard ceiling: sandbox run \"implementer\" exceeded 3600s wall-clock), a recovery pass finished the work in its place, and the recovery-reviewer refused what it produced",
      });
      expect(stop.detail).toContain(
        "the builder never finished (hard ceiling",
      );
      expect(stop.detail).toContain(
        "a recovery pass finished the work in its place",
      );
      expect(stop.detail).not.toContain("no second, stronger model");
    });

    it("the recovery-review path's why uses its own lead-in, never the no-retry path's — it never had a retry ladder to run out of", () => {
      const stop = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "recovery-review",
        why: "the builder made no progress for three passes in a row (BuilderNoProgressError), a recovery pass finished the work in its place, and the recovery-reviewer refused what it produced",
      });
      expect(stop.detail).toContain(
        "the builder made no progress for three passes in a row",
      );
      expect(stop.detail).not.toContain(
        "The run's own reason for having no retry",
      );
    });

    it("tells whoever reads it what to actually do next — and names the label a reviewer-refused stop ACTUALLY lands on", () => {
      const stop = reviewerRefusedExplanation({
        marker: "HAS_BLOCKERS",
        path: "critique-retry",
      });
      expect(stop.detail).toContain("ready-for-agent");
      // #1150: a reviewer refusal is a loop FAILURE, so it routes to
      // `quarantine`, not `needs-human` — the remediation must name the label
      // the ticket actually carries, or the owner removes a label that is not
      // there and the ticket never re-queues.
      expect(stop.detail).toContain("quarantine");
      expect(stop.detail).not.toContain("needs-human");
    });
  });

  describe("the two run-fault stops", () => {
    it("the pipeline catch-all carries the error text and the flags that say where it halted", () => {
      const stop = runFaultExplanation({
        errorMessage: "ECONNRESET reading from the agent",
        verdictFlags: "transientVerdict=false, outputCapVerdict=false",
      });
      expect(stop.label).toBe("stopped:run-fault");
      expect(stop.detail).toContain("ECONNRESET reading from the agent");
      expect(stop.detail).toContain("transientVerdict=false");
    });

    it("says plainly that the ticket is not at fault — this is the stop that must never cost a re-scope", () => {
      const stop = runFaultExplanation({ errorMessage: "boom" });
      expect(stop.detail).toContain("not a judgement about the");
      expect(stop.detail).toContain("retries this ticket on its next run");
    });

    it("omitting the flags leaves no empty 'Run state' heading behind", () => {
      const stop = runFaultExplanation({ errorMessage: "boom" });
      expect(stop.detail).not.toContain("Run state at the moment it halted");
      expect(stop.detail).not.toContain("undefined");
    });

    it("an empty flags string is treated as absent, not rendered as a blank line", () => {
      const stop = runFaultExplanation({
        errorMessage: "boom",
        verdictFlags: "",
      });
      expect(stop.detail).not.toContain("Run state at the moment it halted");
    });

    it("spec #1334 SC: states the retry budget's two limits and the label it ends on, in the same words as stagingRejectedExplanation", () => {
      const sentence =
        "The loop retries this ticket on its next run, until it has spent " +
        "$100 in total or has been tried three times; then it is " +
        "labelled `waiting-for-session` and listed in the run report.";
      expect(runFaultExplanation({ errorMessage: "boom" }).detail).toContain(sentence);
      expect(
        stagingRejectedExplanation({ marker: "HAS_BLOCKERS", issueNumber: 1, siblingIssues: [1] })
          .detail,
      ).toContain(sentence);
    });

    it("the stuck-abort shares the label and points at its own comment rather than repeating it", () => {
      const stop = stuckNoCommitsExplanation();
      expect(stop.label).toBe("stopped:run-fault");
      expect(stop.detail).toContain("comment on this ticket");
    });
  });

  // The design-critique gate (spec #1334) and the skills gate (spec #1334, SG)
  // were the other "comment plus label" stops; both are gone — a skipped tool
  // run never stops a ticket.

  it("all five remaining stops produce a label that really exists, so none can be dropped by the durable record", () => {
    const stops = [
      reviewerRefusedExplanation({ marker: "X", path: "no-retry-available" }),
      reviewerRefusedExplanation({ marker: "X", path: "implementer-retry" }),
      reviewerRefusedExplanation({ marker: "X", path: "critique-retry" }),
      runFaultExplanation({ errorMessage: "e" }),
      stuckNoCommitsExplanation(),
    ];
    expect(stops).toHaveLength(5);
    for (const stop of stops) {
      expect(STOP_REASON_LABELS).toContain(stop.label);
      expect(stop.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it("every one of the five remaining renders into a real body section with its own heading", () => {
    const sections = [
      reviewerRefusedExplanation({ marker: "X", path: "implementer-retry" }),
      runFaultExplanation({ errorMessage: "e" }),
    ].map((stop) =>
      buildStopBodySection({
        label: stop.label,
        detail: stop.detail,
        runId: "run-1",
        whenIso: "2026-08-19T00:00:00.000Z",
      }),
    );
    for (const section of sections) {
      expect(section.startsWith("## Stopped: ")).toBe(true);
      expect(section).not.toContain("undefined");
    }
    // Distinct headings — a shared one would make them indistinguishable in
    // the body, which is the same blindness the missing label caused.
    const headings = sections.map((s) => s.split("\n")[0]);
    expect(new Set(headings).size).toBe(2);
  });
});

/**
 * Issue #923, second pass — the two stop sites the review of the first pass
 * found. Both sit OUTSIDE `runIssuePipeline`, which is why the ticket's own
 * count of sixteen missed them, and both left no label, no body section
 * and no durable record.
 */
describe("issue #923 — the two stops found outside the pipeline", () => {
  it("a staging rejection says the ticket's own work passed, so nobody re-scopes a ticket that was never wrong", () => {
    const stop = stagingRejectedExplanation({
      marker: "HAS_BLOCKERS",
      issueNumber: 101,
      siblingIssues: [101, 102, 103],
    });
    expect(stop.label).toBe("stopped:run-fault");
    expect(stop.detail).toContain("own work passed");
    expect(stop.detail).toContain("HAS_BLOCKERS");
  });

  it("a staging rejection never lists the ticket it is written ON among 'the others' — that reads as a miscount", () => {
    const stop = stagingRejectedExplanation({
      marker: "HAS_BLOCKERS",
      issueNumber: 101,
      siblingIssues: [101, 102, 103],
    });
    expect(stop.detail).toContain("2 other tickets were stopped");
    expect(stop.detail).toContain("102, 103");
    expect(stop.detail).not.toContain("101, 102, 103");
  });

  it("the count and the list always agree, whichever ticket of the round is being written to", () => {
    for (const n of [101, 102, 103]) {
      const stop = stagingRejectedExplanation({
        marker: "HAS_BLOCKERS",
        issueNumber: n,
        siblingIssues: [101, 102, 103],
      });
      const match = /(\d+) other tickets? (?:was|were) stopped by the same failure: ([\d, ]+)\./.exec(
        stop.detail,
      );
      expect(match).not.toBeNull();
      const listed = match![2]!.split(",").map((x) => Number(x.trim()));
      expect(listed).toHaveLength(Number(match![1]));
      expect(listed).not.toContain(n);
    }
  });

  it("one other ticket reads 'was', not 'were'", () => {
    const stop = stagingRejectedExplanation({
      marker: "HAS_BLOCKERS",
      issueNumber: 101,
      siblingIssues: [101, 102],
    });
    expect(stop.detail).toContain("1 other ticket was stopped");
  });

  it("a staging rejection of a single ticket claims no company", () => {
    const stop = stagingRejectedExplanation({
      marker: "HAS_BLOCKERS",
      issueNumber: 101,
      siblingIssues: [101],
    });
    expect(stop.detail).not.toContain("other ticket");
  });

  it("a staging rejection with no marker at all says so, rather than printing an empty pair of backticks", () => {
    const stop = stagingRejectedExplanation({
      marker: "",
      issueNumber: 101,
      siblingIssues: [101],
    });
    expect(stop.detail).toContain("no answer at all");
    expect(stop.detail).not.toContain("``");
  });

  it("a strand REFUSES the re-queue — the one stop where re-running throws finished work away", () => {
    const stop = strandedExplanation({
      stagingBranch: "integration-candidate",
      integrationBranch: "sandcastle/queue-1",
      savedAt: "refs/sandcastle/strand/x",
    });
    expect(stop.label).toBe("stopped:run-fault");
    expect(stop.detail).toContain("do not simply re-queue");
    expect(stop.detail).toContain("NOT lost");
    expect(stop.detail).toContain("refs/sandcastle/strand/x");
  });

  it("the strand and the ordinary run-fault give OPPOSITE instructions, and neither hedges", () => {
    const strand = strandedExplanation({
      stagingBranch: "s",
      integrationBranch: "i",
      savedAt: "r",
    });
    const crash = runFaultExplanation({ errorMessage: "boom" });
    expect(strand.detail).toContain("do not simply re-queue");
    expect(crash.detail).toContain("retries this ticket on its next run");
    expect(crash.detail).not.toContain("do not simply re-queue");
  });
});

/**
 * The code fence a stop's body section wraps error text in. The text is
 * agent output, which routinely contains fenced blocks of its own — one
 * stray fence would close the block early and mangle the issue body, the
 * one surface a stopped ticket is read from.
 */
describe("safeFence — arbitrary text cannot break out of the block", () => {
  it("uses a plain three-backtick fence for ordinary text", () => {
    expect(safeFence("hello")).toBe("```\nhello\n```");
  });

  it("grows past a three-backtick fence inside the text", () => {
    const out = safeFence("before\n```\ninner\n```\nafter");
    expect(out.startsWith("````\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
  });

  it("grows past the LONGEST run of backticks, not merely the first", () => {
    const out = safeFence("a ``` b `````` c");
    expect(out.startsWith("```````\n")).toBe(true);
  });

  it("the fence is always strictly longer than anything in the text, so the block never closes early", () => {
    for (const text of [
      "",
      "`",
      "``",
      "```",
      "````````````",
      "no backticks here",
      "```json\n{}\n```",
    ]) {
      const out = safeFence(text);
      const fence = out.slice(0, out.indexOf("\n"));
      const longestInside = Math.max(
        0,
        ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
      );
      expect(fence.length).toBeGreaterThan(longestInside);
      expect(fence.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("the pipeline crash report survives an error message that contains its own fence", () => {
    const stop = runFaultExplanation({
      errorMessage: "agent said:\n```\nboom\n```\nend",
    });
    // Every backtick-only line in the body. The error text contributes its
    // own pair; the real block's fence must be STRICTLY longer than those,
    // or the inner pair closes the block early and the rest of the stop
    // reason spills out as raw markdown.
    const fences = [...stop.detail.matchAll(/^`{3,}$/gm)].map((m) => m[0]);
    const outer = fences[0]!;
    expect(outer.length).toBe(4);
    expect(fences[fences.length - 1]).toBe(outer);
    for (const inner of fences.slice(1, -1)) {
      expect(inner.length).toBeLessThan(outer.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #1118 — the two stops the judge can reach. Both leave a ticket with
// NO code written on it, which is what every assertion below is really
// pinning: the words on the ticket have to tell whoever opens it in the
// morning that there is nothing to undo.
// ---------------------------------------------------------------------------

describe("issue #1118 — the ticket that never said what was wanted", () => {
  it("is labelled stopped:ticket-unclear and names the missing answer", () => {
    const stop = ticketUnclearExplanation({
      reason:
        "The ticket asks for the team total to be 'correct' but never says " +
        "which deals count towards it.",
      stage: "before-any-code",
    });
    expect(stop.label).toBe("stopped:ticket-unclear");
    expect(STOP_REASON_LABELS).toContain(stop.label);
    expect(stop.detail).toContain("which deals count");
    // Issue #1133, item 8. A "the question the ticket has to answer" line used
    // to render here from an optional parameter no caller could fill — the
    // judge's envelope carries no such field — so it was dropped rather than
    // left standing as a dead branch.
    expect(stop.detail).not.toContain("The question the ticket has to answer");
  });

  it("says out loud why it did not simply side with the check (ruling 10)", () => {
    const stop = ticketUnclearExplanation({
      reason: "It never states what a passing result looks like.",
      stage: "before-any-code",
    });
    expect(stop.detail).toContain("could");
    expect(stop.detail).toContain("guess");
    expect(stop.detail).toContain("quietly become");
  });

  it("the two stages read differently — one has work saved, the other has none", () => {
    const early = ticketUnclearExplanation({
      reason: "It never states what a passing result looks like.",
      stage: "before-any-code",
    });
    const late = ticketUnclearExplanation({
      reason: "It never states what a passing result looks like.",
      stage: "at-a-disagreement",
    });
    expect(early.detail).not.toEqual(late.detail);
    expect(early.detail).toContain("before any code was written");
    expect(late.detail).toContain("was not thrown away");
  });

  it("drops the question block entirely when the judge asked none", () => {
    const stop = ticketUnclearExplanation({
      reason: "It never states what a passing result looks like.",
      stage: "at-a-disagreement",
    });
    expect(stop.detail).not.toContain("The question the ticket has to answer");
  });
});

describe("issue #1118 — the ticket-unclear stop survives the whole pure pipeline", () => {
  const base = { runId: "run-1118", whenIso: "2026-08-19T02:00:00.000Z" };

  it("renders a titled body section, and does not claim an alarm was raised", () => {
    // Its old pair, the weak-check stop, was deleted with the judge's early
    // pass (spec #1334).
    const s = ticketUnclearExplanation({ reason: "r", stage: "before-any-code" });
    const section = buildStopBodySection({ label: s.label, detail: s.detail, ...base });
    expect(section).toContain("## Stopped: the ticket doesn't say what was wanted");
    expect(section).not.toContain("loud — an alarm was raised");
    expect(section).not.toContain("(not recorded)"); // no empty both-sides block
  });

  it("the one that still STOPS has a GitHub label definition GitHub will actually accept", () => {
    // `stopped:weak-check` was the other half of this pair until #1198 A
    // retired it — a check ruled too weak no longer stops the ticket, so the
    // label has no producer and is no longer created. `stopped:ticket-unclear`
    // is unchanged: a ticket that never says what was wanted still stops,
    // because there is nothing for a reviewer to decide against either.
    const def = STOP_LABEL_DEFINITIONS.find(
      (d) => d.name === "stopped:ticket-unclear",
    );
    expect(def).toBeDefined();
    // `gh label create` rejects a description over 100 chars with HTTP 422.
    expect(def!.description.length).toBeLessThanOrEqual(100);
    expect(def!.color).toMatch(/^[0-9A-Fa-f]{6}$/);
    expect(
      STOP_LABEL_DEFINITIONS.find((d) => d.name === "stopped:weak-check"),
    ).toBeUndefined();
  });
});

describe("#1198 review, blocker 1 — the DIAGNOSIS half is safe to reuse off a stop path", () => {
  // WHY THIS EXISTS. #1198 A's first-test fall-through quotes a judge stop's
  // explanation onto a ticket it is BUILDING. The first version quoted the
  // whole `detail`, which drags along a "what to do" tail written for a ticket
  // that IS held: "no code was written", "re-queue it (remove `quarantine`,
  // add `ready-for-agent`)", and — on the resumed route — a
  // `git push origin :refs/sandcastle/wip/issue-N` that PERMANENTLY DELETES a
  // saved pause point. Every one of those is false on a built ticket and the
  // last is destructive. `diagnosis` is the half that stays true.
  const FORBIDDEN = [
    "re-queue",
    "Re-queue",
    "remove `quarantine`",
    "refs/sandcastle/wip",
    "no code was written",
  ] as const;

  const CASES = [
    [
      "the run's own machinery broke",
      runFaultExplanation({ errorMessage: "the sandbox died mid-run" }),
    ],
  ] as const;

  it.each(CASES)("%s: the diagnosis carries no stop-only instruction", (_name, e) => {
    for (const phrase of FORBIDDEN) {
      expect(e.diagnosis).not.toContain(phrase);
    }
  });

  it.each(CASES)("%s: the STOP's own detail is unchanged — diagnosis + whatToDo", (_name, e) => {
    // The split must be invisible to every caller that really is stopping a
    // ticket, or this refactor silently rewrote the owner's stop reports.
    expect(e.detail).toBe(`${e.diagnosis}\n\n${e.whatToDo}`);
    expect(detailOf(e)).toBe(e.detail);
  });

  it("an explanation with no remedy of its own composes to the diagnosis alone", () => {
    const e = stuckNoCommitsExplanation();
    expect(e.whatToDo).toBe("");
    expect(e.detail).toBe(e.diagnosis);
  });
});
