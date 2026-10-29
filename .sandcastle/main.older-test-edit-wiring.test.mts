/**
 * ROT-GUARD (#1271, spec #1334) — the reviewer-refusal sites' WIRING inside
 * `.sandcastle/main.mts`, read as TEXT, plus the sibling-check pieces the
 * ship moment and the ship gate still carry.
 *
 * Spec #1334 (slice SF2) deleted the judge-era sibling repair dispatch
 * (`repairSiblingCheckAfterRefusal`); slice SH replaced it with a ship-gate
 * rule, `verifyOlderTestEdits`, whose allowed paths are the only thing that
 * opens `lockedCheckTouches`. `lib/pipeline/reviewer-refusal.test.ts` drives the
 * shared refusal sequence itself. What it cannot reach is the question this
 * file exists for: is the sequence actually PLUGGED IN at every site?
 *
 * That matters because `/sandcastle-update` overwrites the whole `.sandcastle/`
 * directory, and every piece of this road is re-grafted by hand afterwards. A
 * re-graft that drops the one shared reviewer-refusal sequence, or one of the
 * ship moments, does not error, does not fail a type check, and does not fail any
 * behavioural test — the missed site simply goes back to killing a correct
 * build the moment an OLDER ticket's check pins the rule the build changed,
 * which is the exact $-per-night failure the road was written to stop (#1235,
 * 2026-09-10: a builder and a reviewer paid for, then binned).
 *
 * So every pin here is a COUNT plus a CONTAINMENT check, and every count is
 * measured on today's `main.mts` rather than copied from a plan. A drifted
 * count is the signal to go read the sites before touching the number: either
 * a re-graft dropped one, or a genuinely new site was added and never wired.
 *
 * A failure here does not necessarily mean a bug — a call site's own variable
 * names can legitimately change. It means the needle no longer matches, which
 * is the signal to go re-verify the site before updating it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");

/** Every occurrence of `needle`, counted as OCCURRENCES rather than lines. */
function occurrences(needle: string): number {
  return SRC.split(needle).length - 1;
}

/**
 * The body of one named top-level function, ending at the next top-level
 * declaration. `export ` is part of the anchor a caller passes, because
 * some declarations are exported and some are not.
 */
function bodyOf(declaration: string): string {
  const idx = SRC.indexOf(declaration);
  expect(idx, `declaration not found in main.mts: ${declaration}`).toBeGreaterThan(
    -1,
  );
  const next = [
    SRC.indexOf("\nasync function ", idx + 10),
    SRC.indexOf("\nfunction ", idx + 10),
    SRC.indexOf("\nexport async function ", idx + 10),
    SRC.indexOf("\nexport function ", idx + 10),
  ]
    .filter((n) => n > -1)
    .sort((a, b) => a - b)[0];
  return SRC.slice(idx, next ?? SRC.length);
}

/**
 * Every `anchor` call, sliced from the anchor to its own matching closing
 * brace. Naive brace counting, which is sound here because the option
 * literals these anchors open carry no unbalanced brace inside a string.
 * Callers assert a POSITIVE CONTROL on each block, so a slice that came back
 * clipped or empty cannot pass a `not.toContain` for the wrong reason.
 */
function callBlocks(anchor: string): string[] {
  const out: string[] = [];
  for (let i = SRC.indexOf(anchor); i > -1; i = SRC.indexOf(anchor, i + 1)) {
    let depth = 0;
    let j = i + anchor.length - 1; // sits on the `{` the anchor ends with
    for (; j < SRC.length; j++) {
      if (SRC[j] === "{") depth++;
      else if (SRC[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    out.push(SRC.slice(i, j));
  }
  return out;
}

describe("spec #1334 — every reviewer refusal runs the same host-only sequence", () => {
  it("there is exactly 1 wrongCheckRewriteEligibility({ call and 1 rewriteFirstTestOnce( call — both inside runReviewRounds, which the builder and the fixer share", () => {
    // There used to be three sites (no-retry-available, first-pass, the
    // recovery reviewer). Spec #1334 SG put the builder's and the fixer's
    // review rounds behind ONE function, so one call now covers every road a
    // reviewer's HAS_BLOCKERS can arrive on. If this count moves, a second
    // refusal road was added — re-read the sites before touching any number
    // in this file.
    expect(occurrences("wrongCheckRewriteEligibility({")).toBe(1);
    expect(occurrences("await rewriteFirstTestOnce(sb, ctx, {")).toBe(1);
    const rounds = bodyOf("async function runReviewRounds(");
    expect(rounds).toContain("wrongCheckRewriteEligibility({");
    expect(rounds).toContain("await rewriteFirstTestOnce(sb, ctx, {");
  });

  it("it offers the first test's one rewrite, keyed on the ownership rule — without it a ticket would stop over a wrong first test", () => {
    const blocks = callBlocks("wrongCheckRewriteEligibility({");
    expect(blocks).toHaveLength(1);
    blocks.forEach((block, n) => {
      // POSITIVE CONTROL FIRST. An empty or clipped slice would pass a
      // `not.toContain` only by accident.
      expect(block, `eligibility call #${n} sliced empty`).toContain("reviewStdout:");
      expect(block).toContain("ownTest: ownFirstTestState(ctx,");
    });
    // The rewrite runs exactly when the eligibility answers `rewrite`.
    const rounds = bodyOf("async function runReviewRounds(");
    expect(rounds).toContain('eligibility.kind === "rewrite"');
    expect(rounds).toContain("reason: eligibility.reason,");
  });

  it("the judge-era sibling repair dispatch is GONE from every site, whole — no `repairSibling: (` callback and no `ship-sibling-repaired` arm left half-wired (SF2 deleted it; slice SH replaces it with a ship-gate rule)", () => {
    expect(occurrences("repairSibling: (")).toBe(0);
    expect(occurrences('"ship-sibling-repaired"')).toBe(0);
    expect(occurrences("judge: (")).toBe(0);
  });
});

describe("spec #1334 SH — the ship gate's older-test check and its allowlist", () => {
  it("verifyOlderTestEdits is defined once and called once, inside shipAfterMigrations, BEFORE its proofGateRefusal({", () => {
    expect(occurrences("async function verifyOlderTestEdits(")).toBe(1);
    expect(occurrences("await verifyOlderTestEdits(")).toBe(1);
    const ship = bodyOf("export async function shipAfterMigrations(");
    const call = ship.indexOf("await verifyOlderTestEdits(");
    const gate = ship.indexOf("proofGateRefusal({");
    // POSITIVE CONTROL FIRST.
    expect(call).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(call);
    // And its record reaches the ship moment through ctx.
    expect(ship).toContain(
      "ctx = { ...ctx, olderTestEditRecord: olderTestEdits.amendment }",
    );
  });

  it("exactly 1 of the 2 proofGateRefusal({ literals names authorizedOlderTestPaths, and it is INSIDE such a literal", () => {
    // One per-issue gate (the ship funnel, which the fixer ships through too)
    // plus the post-merge fixer's. Spec #1334 deleted the rescue ladder's
    // post-commit re-gate with the ladder, and SG deleted the rescue road's
    // own ship gate.
    // `lockedCheckTouches` refuses any diff touching another ticket's check
    // directory. An edit the older-test check allowed is the one exception,
    // and the allowlist is how the gate is told. A ship funnel that lost its
    // `authorizedOlderTestPaths` line refuses every allowed older-test edit
    // after the build and the review have both been paid for.
    expect(
      occurrences("authorizedOlderTestPaths: olderTestEdits.authorizedPaths"),
    ).toBe(1);

    const blocks = callBlocks("proofGateRefusal({");
    expect(blocks).toHaveLength(2);
    const carrying = blocks.filter((b) =>
      b.includes("authorizedOlderTestPaths: olderTestEdits.authorizedPaths"),
    );
    expect(carrying).toHaveLength(1);
    for (const block of carrying) {
      // POSITIVE CONTROL: a real gate literal always names the issue it is
      // measuring and the logger it reports through.
      expect(block).toContain("issueNumber:");
      expect(block).toContain("logError");
    }
  });

  it("postMergeFixerProofRefusal's gate call must NOT carry it — the fixer has no ctx and no ticket, so a sibling allowlist there would be an unowned hole", () => {
    // The other literal. `postMergeFixerProofRefusal` measures the
    // post-merge fixer's commits on `integration-candidate`, passes
    // `issueNumber: 0` as a sentinel and `pathLabel: " (post-merge fixer)"`,
    // and answers to no `PipelineCtx` at all. There is no amendment record to
    // read there, so an allowlist could only ever be a blanket one.
    const fixer = callBlocks("proofGateRefusal({").find((b) =>
      b.includes('pathLabel: " (post-merge fixer)"'),
    );
    // POSITIVE CONTROL FIRST — `find` returning undefined, or a clipped
    // slice, would make the refusal below pass for the wrong reason.
    expect(fixer, "the post-merge fixer's gate call was not found").toBeDefined();
    expect(fixer).toContain("issueNumber: 0");
    expect(fixer).toContain("changedFiles: diff.changedFiles");
    expect(fixer).not.toContain("authorizedOlderTestPaths");
  });
});

describe("#1271 — the ship moment records the amendment", () => {
  it("exactly 2 `await noteShippedWithOlderTestEdit(ctx)` calls, each immediately after a noteShippedWithoutFirstTest(ctx) — the two ship moments", () => {
    // Two: the staging and `--no-staging` branches of the one ship funnel,
    // which the fixer ships through too (spec #1334 SG deleted the recovery
    // ship's own pair). `noteShippedWithoutFirstTest` is the sibling landmark
    // because #1198 already proved that set complete and pinned it, so
    // pairing against it is how a NEW ship moment gets caught: it will carry
    // the first-test note and not this one.
    //
    // The two calls sit on adjacent lines at both sites, so the
    // 200-character window below is slack, not a guess.
    const A = "noteShippedWithoutFirstTest(ctx)";
    const B = "await noteShippedWithOlderTestEdit(ctx)";

    const aSites: number[] = [];
    for (let i = SRC.indexOf(A); i > -1; i = SRC.indexOf(A, i + 1)) aSites.push(i);
    const bSites: number[] = [];
    for (let i = SRC.indexOf(B); i > -1; i = SRC.indexOf(B, i + 1)) bSites.push(i);

    // POSITIVE CONTROL FIRST: the landmark itself must still be findable, or
    // the proximity rule below is vacuous.
    expect(aSites.length).toBeGreaterThan(0);
    expect(bSites).toHaveLength(2);
    // Two call sites plus one declaration each; `A` here is the bare call
    // shape, which the declaration line does not match.
    expect(aSites).toHaveLength(2);

    for (const b of bSites) {
      const prior = aSites.filter((a) => a < b).pop();
      expect(
        prior,
        `a sibling-amendment note at ${b} has no first-test note before it`,
      ).toBeDefined();
      expect(
        b - (prior as number),
        `a sibling-amendment note at ${b} drifted away from its ship moment`,
      ).toBeLessThan(200);
    }
  });
});

describe("#1271 — the label exists before anything tries to apply it", () => {
  it("ensureShippedWithOlderTestEditLabelExists({ is called exactly once, in the same run-start block as the first-test one", () => {
    // `markShippedWithOlderTestEdit` applies the label with
    // `gh issue edit --add-label`, which ERRORS on a label the repository does
    // not have, and its caller swallows that best-effort. Drop this create and
    // the one owner-visible signal that a merge rewrote an older ticket's test
    // vanishes silently on any fresh host — exactly the #1198 S4 failure, one
    // label along.
    expect(occurrences("ensureShippedWithOlderTestEditLabelExists({")).toBe(1);

    const first = SRC.indexOf("await ensureShippedWithoutFirstTestLabelExists({");
    const sibling = SRC.indexOf(
      "await ensureShippedWithOlderTestEditLabelExists({",
    );
    // POSITIVE CONTROL FIRST — both landmarks must exist before a distance
    // between them means anything.
    expect(first).toBeGreaterThan(-1);
    expect(sibling).toBeGreaterThan(first);
    // Measured today: 611 characters, the two `await` blocks back to back with
    // their doc comments. The window says "same run-start block", not "same
    // line".
    expect(sibling - first).toBeLessThan(2000);
  });
});

describe("spec #1334 SH — the reviewer is told its share of an older-test edit", () => {
  it("review-prompt.md carries the static older-test paragraph and no `{{SIBLING_CHECK_AMENDED}}` slot; runReviewer sends no such key", () => {
    const prompt = readFileSync(
      path.join(import.meta.dirname, "review-prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("**If the diff edits ANOTHER ticket's test**");
    expect(prompt).not.toContain("{{SIBLING_CHECK_AMENDED}}");
    const body = bodyOf("export async function runReviewer(");
    // POSITIVE CONTROL FIRST.
    expect(body).toContain("CHECK_WRITER_FALL_THROUGH:");
    expect(body).not.toContain("SIBLING_CHECK_AMENDED:");
  });

  it("runCheckWriter has no retarget option left — it only ever writes this ticket's own check", () => {
    const body = bodyOf("export async function runCheckWriter(");
    expect(body).toContain("ISSUE_NUMBER: String(ctx.issueNumber),");
    expect(body).not.toContain("opts.target");
    expect(body).not.toContain("check-writer-sibling-repair");
  });
});
