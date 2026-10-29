import { describe, expect, it } from "vitest";

import type { IssueTelemetryRow } from "../status/schema.js";
import type { IssueTelemetryBagRow } from "./issue-bag.js";
import { buildReworkRecordInput } from "./rework-record-input.js";
import type { ReworkRecordInputSources } from "./rework-record-input.js";

/** The identifying spine every source needs, so each test states only the field
 *  it is about. */
function sources(
  over: Partial<ReworkRecordInputSources> = {},
): ReworkRecordInputSources {
  return {
    issueNumber: 412,
    status: "ok",
    shippedSha: "abc1234",
    runId: "run-1",
    hostId: "host-1",
    shippedAtIso: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** A ledger row's REQUIRED spine (`issue`/`costUsd`/`wallMs`/`tokens`). */
function ledgerRow(over: Partial<IssueTelemetryRow> = {}): IssueTelemetryRow {
  return {
    issue: 412,
    costUsd: 1.25,
    wallMs: 5_000,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ...over,
  };
}

describe("buildReworkRecordInput", () => {
  it("carries the identity spine through unchanged", () => {
    const rec = buildReworkRecordInput(sources());
    expect(rec.issueNumber).toBe(412);
    expect(rec.runId).toBe("run-1");
    expect(rec.hostId).toBe("host-1");
    expect(rec.shippedSha).toBe("abc1234");
    expect(rec.shippedAtIso).toBe("2026-08-01T00:00:00.000Z");
  });

  it("substitutes a placeholder for an empty runId / hostId", () => {
    // Both are `z.string().min(1)` in the store, so an empty one does not blur
    // a grouping key — it DROPS the whole record at the write boundary. A
    // mislabelled group loses one dimension; a dropped record loses everything.
    const rec = buildReworkRecordInput(sources({ runId: "", hostId: "" }));
    expect(rec.runId).toBe("unknown-run");
    expect(rec.hostId).toBe("unknown-host");
  });

  it("maps each terminal status onto the store's outcome vocabulary", () => {
    expect(buildReworkRecordInput(sources({ status: "ok" })).outcome).toBe(
      "shipped",
    );
    expect(
      buildReworkRecordInput(sources({ status: "quarantined" })).outcome,
    ).toBe("quarantined");
    // "error" — the pipeline could not even quarantine it, so it is parked for
    // a person. Same destination as a quarantine, different route.
    expect(buildReworkRecordInput(sources({ status: "error" })).outcome).toBe(
      "needs-human",
    );
  });

  // -------------------------------------------------------------------------
  // RETRIES, not attempts. The inversion this pins is the one `issue-bag.ts`
  // warns about at the other end: recording attempts would turn 18 clean first
  // passes into 18 phantom retries and invert the headline number the whole
  // store exists to produce. Asserted on the VALUE, so it stays red if
  // `implementerAttempts` changes meaning upstream — which the source-text grep
  // it replaces could not do.
  // -------------------------------------------------------------------------
  it.each([
    [1, 0],
    [3, 2],
    [0, 0],
  ])("turns %i implementer attempts into %i retries", (attempts, retries) => {
    const rec = buildReworkRecordInput(
      sources({ bagRow: { implementerAttempts: attempts } }),
    );
    expect(rec.retries).toBe(retries);
  });

  it("omits retries entirely when attempts were never recorded", () => {
    // ABSENT ≠ ZERO: "unknown retries" and "shipped first time" are different
    // facts, and `0` claims the second.
    const rec = buildReworkRecordInput(sources({ bagRow: {} }));
    expect(rec).not.toHaveProperty("retries");
  });

  it("omits wallMs when no role ever saw a timing sample", () => {
    // `IssueLedger.rows()` folds `sawTiming` away, so an un-timed row reports a
    // measured `wallMs: 0`. Taking it straight off the row would record that
    // fabricated zero.
    const rec = buildReworkRecordInput(
      sources({ ledgerRow: ledgerRow({ wallMs: 0 }) }),
    );
    expect(rec).not.toHaveProperty("wallMs");
  });

  it("keeps wallMs when a role DID see timing, including a genuine 0ms", () => {
    // Checking `wallMs > 0` would be wrong in the other direction — a genuinely
    // 0ms measurement is still a measurement.
    const rec = buildReworkRecordInput(
      sources({
        ledgerRow: ledgerRow({
          wallMs: 0,
          perRole: { implementer: { wallMs: 0 } },
        }),
      }),
    );
    expect(rec.wallMs).toBe(0);

    const timed = buildReworkRecordInput(
      sources({
        ledgerRow: ledgerRow({
          wallMs: 5_000,
          perRole: { implementer: { wallMs: 5_000 } },
        }),
      }),
    );
    expect(timed.wallMs).toBe(5_000);
  });

  it("preserves costUsd's three states", () => {
    // absent (no ledger row) / null (every model unpriced) / a figure. `null`
    // is NOT zero and must never be summed as $0.
    expect(buildReworkRecordInput(sources())).not.toHaveProperty("costUsd");
    expect(
      buildReworkRecordInput(sources({ ledgerRow: ledgerRow({ costUsd: null }) }))
        .costUsd,
    ).toBeNull();
    expect(
      buildReworkRecordInput(sources({ ledgerRow: ledgerRow({ costUsd: 1.25 }) }))
        .costUsd,
    ).toBe(1.25);
  });

  it("asserts `quarantined` only when a bag measured it", () => {
    // With no bag there is no measurement, and writing `quarantined: false`
    // would assert one — and could print `outcome: "quarantined"` beside
    // `quarantined: false`. Keyed on the bag, not on the value, so a bag that
    // really says `false` still records that fact.
    expect(buildReworkRecordInput(sources())).not.toHaveProperty("quarantined");
    expect(
      buildReworkRecordInput(sources({ bagRow: {} })).quarantined,
    ).toBe(false);
    expect(
      buildReworkRecordInput(sources({ bagRow: { quarantined: true } }))
        .quarantined,
    ).toBe(true);
  });

  it("omits the diff fields the bag never measured", () => {
    const rec = buildReworkRecordInput(sources({ bagRow: {} }));
    expect(rec).not.toHaveProperty("changedFiles");
    expect(rec).not.toHaveProperty("changedLines");
    expect(rec).not.toHaveProperty("changedFilePaths");
  });

  it("COPIES changedFilePaths instead of aliasing the caller's array", () => {
    // The bag row is live for the rest of the run and the store serialises
    // lazily, so an aliased array would let a later mutation rewrite a fact
    // already reported as recorded.
    const bagRow: IssueTelemetryBagRow = {
      changedFilePaths: ["a.ts"],
      changedFiles: 1,
      changedLines: 10,
    };
    const rec = buildReworkRecordInput(sources({ bagRow }));
    bagRow.changedFilePaths?.push("b.ts");
    expect(rec.changedFilePaths).toEqual(["a.ts"]);
    expect(rec.changedFiles).toBe(1);
    expect(rec.changedLines).toBe(10);
  });

  it("omits models when the run never resolved an identity", () => {
    expect(buildReworkRecordInput(sources())).not.toHaveProperty("models");
    const rec = buildReworkRecordInput(
      sources({
        models: { implementer: { default: "sonnet", escalations: ["opus"] } },
      }),
    );
    expect(rec.models).toEqual({
      implementer: { default: "sonnet", escalations: ["opus"] },
    });
  });

  it("never stamps schemaVersion — the writer owns that", () => {
    // `ReworkRecordInput` is `Omit<ReworkRecord, "schemaVersion">` precisely so
    // a call site cannot forget it or state it wrongly.
    expect(buildReworkRecordInput(sources())).not.toHaveProperty(
      "schemaVersion",
    );
  });

  it("copies the OBSERVED screenCheck record through from the bag row (issue #912, Piece K)", () => {
    const rec = buildReworkRecordInput(
      sources({
        bagRow: {
          screenCheck: {
            screen: "/finance/reports?view=team",
            verdict: "match",
            whenIso: "2026-08-04T13:00:00.000Z",
            rerun: false,
            pictureStored: true,
            pictureLink: "run/issue-412/finance-reports.png",
          },
        },
      }),
    );
    expect(rec.screenCheck).toEqual({
      screen: "/finance/reports?view=team",
      verdict: "match",
      whenIso: "2026-08-04T13:00:00.000Z",
      rerun: false,
      pictureStored: true,
      pictureLink: "run/issue-412/finance-reports.png",
    });
  });

  it("omits screenCheck when the bag row never noted one — never a manufactured default", () => {
    expect(buildReworkRecordInput(sources())).not.toHaveProperty("screenCheck");
  });

  it("copies screenCheck by VALUE — a later mutation of the caller's bag row cannot rewrite an already-built record", () => {
    const bagRow: Parameters<typeof buildReworkRecordInput>[0]["bagRow"] = {
      screenCheck: {
        verdict: "never-settled",
        whenIso: "2026-08-04T13:00:00.000Z",
        rerun: false,
        pictureStored: false,
      },
    };
    const rec = buildReworkRecordInput(sources({ bagRow }));
    // Mutate the source object the caller still holds a live reference to.
    (bagRow.screenCheck as { verdict: string }).verdict = "match";
    expect(rec.screenCheck?.verdict).toBe("never-settled");
  });

  it("copies the CLAIMED implementerCertification through from the bag row (issue #886)", () => {
    const rec = buildReworkRecordInput(
      sources({
        bagRow: {
          implementerCertification: {
            e2eRequired: true,
            e2eActuallyRan: true,
            testCommandUsed: "pnpm --filter @acme/nextjs e2e -- x.spec.ts",
          },
        },
      }),
    );
    expect(rec.implementerCertification).toEqual({
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm --filter @acme/nextjs e2e -- x.spec.ts",
    });
  });

  it("omits implementerCertification when the bag row never noted one", () => {
    expect(buildReworkRecordInput(sources())).not.toHaveProperty(
      "implementerCertification",
    );
  });

  it("copies implementerCertification by VALUE, not by reference", () => {
    const bagRow: Parameters<typeof buildReworkRecordInput>[0]["bagRow"] = {
      implementerCertification: { e2eActuallyRan: true },
    };
    const rec = buildReworkRecordInput(sources({ bagRow }));
    (bagRow.implementerCertification as { e2eActuallyRan: boolean }).e2eActuallyRan = false;
    expect(rec.implementerCertification?.e2eActuallyRan).toBe(true);
  });

  it("carries BOTH halves at once, as two distinct fields — the claim and the observation never merge", () => {
    const rec = buildReworkRecordInput(
      sources({
        bagRow: {
          implementerCertification: { e2eActuallyRan: true },
          screenCheck: {
            verdict: "graded-mismatch",
            whenIso: "2026-08-04T13:00:00.000Z",
            rerun: false,
            pictureStored: false,
          },
        },
      }),
    );
    expect(rec.implementerCertification).toEqual({ e2eActuallyRan: true });
    expect(rec.screenCheck?.verdict).toBe("graded-mismatch");
    // Not the same object, not one field named after both.
    expect(rec.implementerCertification).not.toBe(rec.screenCheck);
  });

  describe("stopReason — the five ways a ticket stops (issue #914, Piece H)", () => {
    it("copies the stop-reason record through from the bag row", () => {
      const rec = buildReworkRecordInput(
        sources({
          bagRow: {
            stopReason: {
              label: "stopped:already-built",
              detail: "reports/page.tsx already does this",
            },
          },
        }),
      );
      expect(rec.stopReason).toEqual({
        label: "stopped:already-built",
        detail: "reports/page.tsx already does this",
      });
    });

    it("omits stopReason when the bag row never noted one — never a manufactured default", () => {
      expect(buildReworkRecordInput(sources())).not.toHaveProperty("stopReason");
    });

    it("copies stopReason (and its nested disagreement) by VALUE, not by reference", () => {
      const bagRow: Parameters<typeof buildReworkRecordInput>[0]["bagRow"] = {
        stopReason: {
          label: "stopped:check-disagreement",
          disagreement: { checkDemanded: "team = sum(agents)" },
        },
      };
      const rec = buildReworkRecordInput(sources({ bagRow }));
      (
        bagRow.stopReason!.disagreement as { checkDemanded: string }
      ).checkDemanded = "mutated after the fact";
      expect(rec.stopReason?.disagreement?.checkDemanded).toBe(
        "team = sum(agents)",
      );
    });

    it("carries both sides of a disagreement plus an absent resolution — the loop never says who was wrong", () => {
      const rec = buildReworkRecordInput(
        sources({
          bagRow: {
            stopReason: {
              label: "stopped:check-disagreement",
              disagreement: {
                checkDemanded: "team total = sum(agents)",
                builderProduced: "3 files, 40 lines changed",
                builderAccount: "reviewer certified ALL_CLEAR on critique-retry",
              },
            },
          },
        }),
      );
      expect(rec.stopReason?.disagreement?.checkDemanded).toBe(
        "team total = sum(agents)",
      );
      expect(rec.stopReason?.disagreement?.builderProduced).toBe(
        "3 files, 40 lines changed",
      );
      expect(rec.stopReason?.disagreement?.builderAccount).toBe(
        "reviewer certified ALL_CLEAR on critique-retry",
      );
      // Which side was wrong is never recorded here — issue #1117 moved it
      // onto the GitHub ticket, because this file is committed to git.
      expect(rec.stopReason?.disagreement).not.toHaveProperty("resolution");
    });

    it("stopReason and screenCheck stay two distinct fields, never merged", () => {
      const rec = buildReworkRecordInput(
        sources({
          bagRow: {
            stopReason: { label: "stopped:could-not-grade" },
            screenCheck: {
              verdict: "never-settled",
              whenIso: "2026-08-04T13:00:00.000Z",
              rerun: false,
              pictureStored: false,
            },
          },
        }),
      );
      expect(rec.stopReason?.label).toBe("stopped:could-not-grade");
      expect(rec.screenCheck?.verdict).toBe("never-settled");
      expect(rec.stopReason).not.toBe(rec.screenCheck);
    });
  });
});
