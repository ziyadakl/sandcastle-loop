import { describe, expect, it } from "vitest";

import {
  CHECK_WRITER_MARKERS,
  CheckWriterOutputSchema,
  lastFenceMarkerOf,
  reconcileCheckWriterMarkers,
} from "./schema.js";

describe("CheckWriterOutputSchema — UNIT_CHECK_WRITTEN (issue #956)", () => {
  const valid = {
    marker: "UNIT_CHECK_WRITTEN",
    inherited: false,
    checkPackage: "packages/api",
    checkPath: "email-template-registry.test.ts",
  };

  it("accepts a well-formed unit check envelope", () => {
    const parsed = CheckWriterOutputSchema.parse(valid);
    expect(parsed.marker).toBe("UNIT_CHECK_WRITTEN");
    expect(parsed.checkPackage).toBe("packages/api");
  });

  it("rejects a unit check with no checkPath", () => {
    const { checkPath: _drop, ...noPath } = valid;
    expect(CheckWriterOutputSchema.safeParse(noPath).success).toBe(false);
  });

  it("rejects a unit check with no checkPackage", () => {
    const { checkPackage: _drop, ...noPkg } = valid;
    expect(CheckWriterOutputSchema.safeParse(noPkg).success).toBe(false);
  });

  it("rejects a .spec.ts path — that is the browser runner's extension", () => {
    // The two runners must never be able to borrow each other's file shape:
    // a `.spec.ts` under a package is collected by no vitest `include`, so it
    // would go green by being absent.
    expect(
      CheckWriterOutputSchema.safeParse({ ...valid, checkPath: "x.spec.ts" })
        .success,
    ).toBe(false);
  });

  it("rejects an unsafe checkPath at PARSE time, never merely at command-build time", () => {
    // Same reasoning as CHECKS_WRITTEN's own whitelist: an unusable checkPath
    // that parses lets `buildUnitCheckCommand` return undefined, which
    // downstream reads as "nothing to check" and skips the whole gate.
    for (const bad of [
      "../../../etc/passwd.test.ts",
      "/abs/x.test.ts",
      "has space.test.ts",
      "x.test.ts; rm -rf /",
      "$(whoami).test.ts",
    ]) {
      expect(
        CheckWriterOutputSchema.safeParse({ ...valid, checkPath: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects an app as the host package", () => {
    // A unit proof is strictly weaker than a photograph, and any apps/** touch
    // demands a photograph — so a unit check inside an app could never satisfy
    // the demand its own presence creates.
    expect(
      CheckWriterOutputSchema.safeParse({
        ...valid,
        checkPackage: "apps/nextjs",
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed checkPackage", () => {
    for (const bad of [
      "packages/api/src",
      "../packages/api",
      "packages/",
      "packages/API",
      "tooling/vitest",
      "packages/api; echo hi",
    ]) {
      expect(
        CheckWriterOutputSchema.safeParse({ ...valid, checkPackage: bad })
          .success,
      ).toBe(false);
    }
  });

  it("does not require a screen — there is nothing to name", () => {
    expect(CheckWriterOutputSchema.safeParse(valid).success).toBe(true);
  });
});

describe("CheckWriterOutputSchema — the four outcomes are distinct shapes", () => {
  it("accepts CHECKS_WRITTEN with checkPath + screen", () => {
    const parsed = CheckWriterOutputSchema.parse({
      marker: "CHECKS_WRITTEN",
      inherited: false,
      screen: "/finance/reports?view=team",
      checkPath: "team-cash-flow.spec.ts",
    });
    expect(parsed.marker).toBe("CHECKS_WRITTEN");
    expect(parsed.inherited).toBe(false);
  });

  it("rejects CHECKS_WRITTEN missing checkPath", () => {
    const result = CheckWriterOutputSchema.safeParse({
      marker: "CHECKS_WRITTEN",
      inherited: false,
      screen: "/finance/reports?view=team",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CHECKS_WRITTEN missing screen", () => {
    const result = CheckWriterOutputSchema.safeParse({
      marker: "CHECKS_WRITTEN",
      inherited: false,
      checkPath: "x.spec.ts",
    });
    expect(result.success).toBe(false);
  });

  it("accepts ALREADY_BUILT with evidence", () => {
    const parsed = CheckWriterOutputSchema.parse({
      marker: "ALREADY_BUILT",
      inherited: false,
      alreadyBuiltEvidence:
        "apps/nextjs/src/app/(finance)/finance/reports/page.tsx already renders the team total; shipped in #900.",
    });
    expect(parsed.marker).toBe("ALREADY_BUILT");
  });

  it("rejects ALREADY_BUILT with no evidence", () => {
    const result = CheckWriterOutputSchema.safeParse({
      marker: "ALREADY_BUILT",
      inherited: false,
    });
    expect(result.success).toBe(false);
  });

  it("accepts NEEDS_WORLD_DATA with a prose gap description", () => {
    const parsed = CheckWriterOutputSchema.parse({
      marker: "NEEDS_WORLD_DATA",
      inherited: false,
      worldDataNeeded:
        "needs a deal in Conditional status with a co-listing agent",
    });
    expect(parsed.marker).toBe("NEEDS_WORLD_DATA");
  });

  it("rejects NEEDS_WORLD_DATA with no description", () => {
    const result = CheckWriterOutputSchema.safeParse({
      marker: "NEEDS_WORLD_DATA",
      inherited: false,
    });
    expect(result.success).toBe(false);
  });

  it("has no field anywhere that could carry a proposed figure for NEEDS_WORLD_DATA", () => {
    // Structural enforcement, not convention: a NEEDS_WORLD_DATA envelope
    // carrying an extra, schema-unknown numeric field must still parse
    // (zod strips unknown keys by default) — proving the extra key could
    // never be READ back out of the parsed object, which is what actually
    // matters: nothing downstream can act on a figure the check-writer
    // tried to smuggle through.
    const withExtraFigure = CheckWriterOutputSchema.parse({
      marker: "NEEDS_WORLD_DATA",
      inherited: false,
      worldDataNeeded: "needs a lease deal with a referral fee",
      proposedAmount: 47300,
      seedRows: [{ price: 500000 }],
    });
    expect(withExtraFigure).not.toHaveProperty("proposedAmount");
    expect(withExtraFigure).not.toHaveProperty("seedRows");
    expect(Object.keys(withExtraFigure).sort()).toEqual(
      ["marker", "inherited", "worldDataNeeded"].sort(),
    );
  });

  it("accepts NO_SCREEN_APPLIES with a reason", () => {
    const parsed = CheckWriterOutputSchema.parse({
      marker: "NO_SCREEN_APPLIES",
      inherited: false,
      noScreenReason: "this ticket only edits .sandcastle/main.mts",
    });
    expect(parsed.marker).toBe("NO_SCREEN_APPLIES");
  });

  it("rejects NO_SCREEN_APPLIES with no reason", () => {
    const result = CheckWriterOutputSchema.safeParse({
      marker: "NO_SCREEN_APPLIES",
      inherited: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognised marker", () => {
    const result = CheckWriterOutputSchema.safeParse({
      marker: "SOMETHING_ELSE",
      inherited: false,
    });
    expect(result.success).toBe(false);
  });

  it("accepts inherited=true alongside CHECKS_WRITTEN", () => {
    const parsed = CheckWriterOutputSchema.parse({
      marker: "CHECKS_WRITTEN",
      inherited: true,
      screen: "/finance/reports?view=team",
      checkPath: "already-here.spec.ts",
    });
    expect(parsed.inherited).toBe(true);
  });

  it("parses a NEEDS_WORLD_DATA envelope that OMITS inherited, defaulting to false", () => {
    // The field's own doc-comment promises it "still parses (defaulting false)"
    // on the four non-CHECKS_WRITTEN markers. Before `.default(false)` this
    // omission was REJECTED, demoting a correct #1146/#1091 refusal ("can't
    // test — the real Follow Up Boss account isn't connected") to a
    // parse-error quarantine. An omitted flag must default, not fail.
    const parsed = CheckWriterOutputSchema.parse({
      marker: "NEEDS_WORLD_DATA",
      worldDataNeeded:
        "needs a team with a live Follow Up Boss connection (#1073 open)",
    });
    expect(parsed.inherited).toBe(false);
  });

  // issue #914 finding: an unsafe checkPath used to parse successfully (only
  // `z.string().min(1)`), silently fail to build a runnable command later,
  // and skip the WHOLE ship-time browser gate. It must now fail PARSING.
  describe("checkPath safety — validated at the schema boundary (issue #914)", () => {
    it("PROVES THE INSTRUMENT: a safe checkPath still parses fine", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      });
      expect(result.success).toBe(true);
    });

    it("PROVES THE INSTRUMENT: a nested-but-safe checkPath still parses fine", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "reports/team-cash-flow.spec.ts",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a checkPath containing a space — the exact case that used to reach buildCheckCommand and skip the browser gate silently", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team cash flow.spec.ts",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("checkPath"))).toBe(
          true,
        );
      }
    });

    it("rejects a checkPath attempting directory traversal", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "../../etc/passwd.spec.ts",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a checkPath not ending in .spec.ts", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.ts",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an absolute checkPath", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "/etc/passwd.spec.ts",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a checkPath carrying shell metacharacters", () => {
      const result = CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "x.spec.ts; rm -rf /",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("CheckWriterOutputSchema — no coverage list is demanded (spec #1334 SE)", () => {
  // Issue #1118's per-criterion coverage list had one reader, the judge,
  // which spec #1334 deleted. A written check no longer has to carry one.
  it("accepts both check-writing markers with no coverage list", () => {
    expect(
      CheckWriterOutputSchema.safeParse({
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      }).success,
    ).toBe(true);
    expect(
      CheckWriterOutputSchema.safeParse({
        marker: "UNIT_CHECK_WRITTEN",
        inherited: false,
        checkPackage: "packages/api",
        checkPath: "email-template-registry.test.ts",
      }).success,
    ).toBe(true);
  });

  it("an envelope that still sends one parses, and the list is dropped", () => {
    const parsed = CheckWriterOutputSchema.parse({
      marker: "UNIT_CHECK_WRITTEN",
      inherited: false,
      checkPackage: "packages/api",
      checkPath: "email-template-registry.test.ts",
    });
    expect(parsed).not.toHaveProperty("coverage");
  });
});

// ---------------------------------------------------------------------------
// `reconcileCheckWriterMarkers` — the last-line outcome marker versus the
// envelope's own `marker` field (2026-09-10). On 2026-09-10 #1249 and #1235
// both died `stopped:check-disagreement` with $0 of builder spend because the
// check-writer closed a `.test.ts` envelope (`UNIT_CHECK_WRITTEN`, carrying
// `checkPackage` + `checkPath`) with `CHECKS_WRITTEN` on its last line. Both
// markers mean "I wrote a check"; the envelope is the reading the ship gate
// actually consumes and the one the schema cross-validated against its own
// payload, so it wins that one disagreement. Every other pair still stops.
// ---------------------------------------------------------------------------

describe("reconcileCheckWriterMarkers — the two 'written' markers reconcile to the envelope, everything else still disagrees", () => {
  it("agrees when the two markers are the same string, whatever the last fence says", () => {
    for (const m of CHECK_WRITER_MARKERS) {
      expect(reconcileCheckWriterMarkers(m, m, m)).toEqual({ kind: "agree", marker: m });
      expect(reconcileCheckWriterMarkers(m, m, undefined)).toEqual({ kind: "agree", marker: m });
    }
  });

  it("a CHECKS_WRITTEN last line over a UNIT_CHECK_WRITTEN envelope resolves to the ENVELOPE (the #1249/#1235 shape)", () => {
    expect(
      reconcileCheckWriterMarkers("CHECKS_WRITTEN", "UNIT_CHECK_WRITTEN", "UNIT_CHECK_WRITTEN"),
    ).toEqual({
      kind: "reconciled",
      marker: "UNIT_CHECK_WRITTEN",
      lineMarker: "CHECKS_WRITTEN",
    });
  });

  it("the reverse pair resolves to the envelope too — the envelope is what carries the payload, whichever way round", () => {
    expect(
      reconcileCheckWriterMarkers("UNIT_CHECK_WRITTEN", "CHECKS_WRITTEN", "CHECKS_WRITTEN"),
    ).toEqual({
      kind: "reconciled",
      marker: "CHECKS_WRITTEN",
      lineMarker: "UNIT_CHECK_WRITTEN",
    });
  });

  it("EXHAUSTIVE: of the 30 unequal pairs, exactly the two written-versus-written pairs reconcile; the other 28 disagree", () => {
    const reconciled: string[] = [];
    const disagreed: string[] = [];
    for (const line of CHECK_WRITER_MARKERS) {
      for (const env of CHECK_WRITER_MARKERS) {
        if (line === env) continue;
        const r = reconcileCheckWriterMarkers(line, env, env);
        if (r.kind === "reconciled") reconciled.push(`${line}/${env}`);
        else if (r.kind === "disagree") disagreed.push(`${line}/${env}`);
        else throw new Error(`unequal pair ${line}/${env} must never "agree"`);
      }
    }
    expect(reconciled.sort()).toEqual([
      "CHECKS_WRITTEN/UNIT_CHECK_WRITTEN",
      "UNIT_CHECK_WRITTEN/CHECKS_WRITTEN",
    ]);
    expect(disagreed).toHaveLength(28);
  });

  it("a written line over a no-check envelope (the original finding #2 shape) still DISAGREES — that pair switches off both ship-time gates", () => {
    const r = reconcileCheckWriterMarkers("CHECKS_WRITTEN", "NO_SCREEN_APPLIES", "NO_SCREEN_APPLIES");
    expect(r).toEqual({
      kind: "disagree",
      lineMarker: "CHECKS_WRITTEN",
      envelopeMarker: "NO_SCREEN_APPLIES",
    });
  });

  // parseVerdict walks fenced blocks last-to-first and hands back the first
  // that passes the schema — so the envelope can be an EARLIER draft. The
  // reconcile must never trust one of those: only a written-versus-written
  // pair whose envelope IS the final block reconciles.
  it("STALE DRAFT: the written pair does NOT reconcile when the envelope did not come from the last fenced block", () => {
    // Last block said CHECKS_WRITTEN (and failed the schema, so parseVerdict
    // fell back to an earlier UNIT_CHECK_WRITTEN draft).
    expect(
      reconcileCheckWriterMarkers("CHECKS_WRITTEN", "UNIT_CHECK_WRITTEN", "CHECKS_WRITTEN"),
    ).toEqual({
      kind: "disagree",
      lineMarker: "CHECKS_WRITTEN",
      envelopeMarker: "UNIT_CHECK_WRITTEN",
    });
    // No readable last fence at all (malformed JSON) — same answer.
    expect(
      reconcileCheckWriterMarkers("CHECKS_WRITTEN", "UNIT_CHECK_WRITTEN", undefined).kind,
    ).toBe("disagree");
  });
});

describe("lastFenceMarkerOf — the marker of the block the agent ENDED on", () => {
  const block = (marker: string, extra = "") =>
    "```json\n" + `{ "marker": "${marker}"${extra} }` + "\n```\n";

  it("reads the LAST fenced block's marker, not the first", () => {
    const text = "draft:\n" + block("UNIT_CHECK_WRITTEN") + "final:\n" + block("CHECKS_WRITTEN") + "CHECKS_WRITTEN\n";
    expect(lastFenceMarkerOf(text)).toBe("CHECKS_WRITTEN");
  });

  it("returns undefined when the last block is not JSON, has no string marker, or there is no block", () => {
    expect(lastFenceMarkerOf(block("UNIT_CHECK_WRITTEN") + "```json\n{ not json\n```\n")).toBeUndefined();
    expect(lastFenceMarkerOf("```json\n{ \"marker\": 7 }\n```\n")).toBeUndefined();
    expect(lastFenceMarkerOf("```json\n[1, 2]\n```\n")).toBeUndefined();
    expect(lastFenceMarkerOf("no fence here\nCHECKS_WRITTEN\n")).toBeUndefined();
  });

  it("does not care whether the block would pass the envelope schema — only WHICH block it is", () => {
    // A CHECKS_WRITTEN block with no checkPath/screen/coverage fails the
    // schema, but it is still the block the agent ended on.
    expect(lastFenceMarkerOf(block("CHECKS_WRITTEN"))).toBe("CHECKS_WRITTEN");
  });
});
