/**
 * ROT-GUARD (#1198 A) — the first-test fall-through's wiring inside
 * `runIssuePipeline` and the ship funnels, read as TEXT.
 *
 * `main.checkwriter.test.mts`, `main.first-test-advisory.scripted.test.mts`,
 * `main.checkwriter-selfheal.test.mts` and `main.harness.test.mts` all drive
 * the behaviour for real: the stage proceeds, the ship gates relax, the label
 * lands. What none of them can reach is `runIssuePipeline`, which is not
 * exported — and that function holds the two threads the whole feature hangs
 * from:
 *
 *   1. `ctx = checkStage.ctx`, which is how `withoutFirstTest` reaches the
 *      ship funnel. Delete the flag from `finishCheckWriterStage`'s returned
 *      ctx and every behavioural test above still passes, because they call
 *      `shipAfterMigrations` with a ctx they built themselves.
 *   2. the review rounds' `evidence()`, which is how the REVIEWER learns its pass is the
 *      only gate this ticket has. Drop that field and nothing errors: the
 *      reviewer simply reviews as though a ship-time harness run were still
 *      coming, which is the one way this change ships worse code than it means
 *      to.
 *
 * A failure here does not necessarily mean a bug — a call site's own variable
 * names can legitimately change. It means the needle no longer matches, which
 * is the signal to go re-verify the site before updating it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");

/** The body of one named function, up to the next top-level declaration. */
function bodyOf(declaration: string): string {
  const idx = SRC.indexOf(declaration);
  expect(idx, `declaration not found in main.mts: ${declaration}`).toBeGreaterThan(-1);
  const next = SRC.indexOf("\nasync function ", idx + 10);
  const next2 = SRC.indexOf("\nfunction ", idx + 10);
  const end = [next, next2].filter((n) => n > -1).sort((a, b) => a - b)[0];
  return SRC.slice(idx, end ?? idx + 12_000);
}

describe("#1198 A — the flag reaches the ship funnels via ctx", () => {
  it("finishCheckWriterStage puts `firstTestFellThrough` on the ctx it hands back", () => {
    const body = bodyOf("async function finishCheckWriterStage(");
    expect(body).toContain("firstTestFellThrough: fallThrough");
    // And the returned ctx is that one, not the un-flagged `nextCtx`.
    expect(body).toContain("ctx: outCtx");
  });

  it("runIssuePipeline adopts the stage's ctx, so the flag travels without a sixteenth positional parameter", () => {
    expect(SRC).toContain("ctx = checkStage.ctx;");
  });

  it("the one proof-gate call site on the per-issue path reads the flag off ctx", () => {
    // The ship funnel. There used to be a second, on the rescue road's own
    // ship gate; spec #1334 SG deleted that road — the fixer ships through
    // `shipAfterMigrations` too — so there is exactly one place left to
    // waive the demand-versus-offer half for a fall-through ticket.
    const occurrences = SRC.split(
      "firstTestFellThrough: ctx.firstTestFellThrough !== undefined",
    ).length - 1;
    expect(occurrences).toBe(1);
  });

  it("the ship-time harness is gated on the flag, not only on the check command", () => {
    expect(SRC).toContain(
      "checkWriterCheckCommand !== undefined &&\n    ctx.firstTestFellThrough === undefined",
    );
  });
});

describe("#1198 A — the reviewer is told its pass is the only gate", () => {
  it("the review rounds carry the fall-through into every one of their reviewer dispatches, read off ctx", () => {
    // Read off `ctx`, not the check stage: a first-test rewrite the reviewer
    // could not settle marks the ticket as having no first test MID-rounds,
    // and every later reviewer must be told its pass is the only gate.
    const rounds = bodyOf("async function runReviewRounds(");
    expect(rounds).toContain("checkWriterFallThrough: ctx.firstTestFellThrough");
    // All three of its reviewer dispatches spread that same evidence.
    expect(rounds.split("...evidence(),").length - 1).toBe(3);
  });

  it("spec #1334 SG: the FIXER's reviews are the same review rounds — they are told too", () => {
    // The old recovery-reviewer was a separate dispatch that had to be wired
    // by hand (#1198 second review, F2). The fixer has no reviewer of its own:
    // it runs `runReviewRounds`, so it inherits the notice by construction.
    const fixer = bodyOf("async function runFixer(");
    expect(fixer).toContain("await runReviewRounds(sb, ctx, {");
    expect(fixer).toContain('role: "fixer"');
    expect(fixer).not.toContain("runReviewer(");
  });

  it("#1198 second review, F2: EVERY runReviewer dispatch carries the fall-through, by spread or by name", () => {
    // The whole feature's failure mode is silent: a reviewer that was not
    // told still reviews, just as though a ship-time harness run were coming.
    // So count the dispatch sites rather than trusting a list.
    const sites: string[] = [];
    for (let i = SRC.indexOf("runReviewer("); i > -1; ) {
      // Skip the declaration itself and the recursive no-verdict re-ask's own
      // `return runReviewer(` — the latter forwards `...opts` verbatim.
      if (!SRC.slice(i - 30, i).includes("function ")) {
        sites.push(SRC.slice(i, i + 1600));
      }
      i = SRC.indexOf("runReviewer(", i + 1);
    }
    // Six today: the two first-test-rewrite re-reviews (proved, and without
    // a first test), the three rounds of `runReviewRounds` (shared by the
    // builder and the fixer since spec #1334 SG) — plus the re-ask that
    // forwards `...opts`. (The rescue ladder's own reviewer, the
    // sibling-amendment re-review and the recovery reviewer went with their
    // roads, spec #1334.)
    expect(sites.length).toBeGreaterThanOrEqual(6);
    for (const site of sites) {
      expect(
        /checkWriterFallThrough|\.\.\.evidence\(\)|\.\.\.opts/.test(site),
        `a runReviewer dispatch does not carry the fall-through:\n${site.slice(0, 300)}`,
      ).toBe(true);
    }
  });

  it("runReviewer renders it into CHECK_WRITER_FALL_THROUGH, empty on an ordinary ticket", () => {
    expect(SRC).toContain("CHECK_WRITER_FALL_THROUGH:");
    expect(SRC).toContain("firstTestFallThroughNotice(opts.checkWriterFallThrough)");
  });
});

describe("#1198 A — what the flag must NOT touch", () => {
  it("the implementer/reviewer retry ladder is unchanged — a refused fall-through ticket gets the ordinary fix rounds", () => {
    // The owner's rule is "build anyway and let the reviewer decide", not
    // "build anyway and ship". A reviewer that says HAS_BLOCKERS must send the
    // ticket back through the same ladder as any other, so the flag has no
    // business anywhere in the retry decision.
    const retryDecision = SRC.slice(
      SRC.indexOf("if (!retryEligibility.canRetry)"),
      SRC.indexOf("if (!retryEligibility.canRetry)") + 800,
    );
    expect(retryDecision).not.toContain("firstTestFellThrough");
  });

  it("the removed-test refusal is decided BEFORE the waiver, so no fall-through can reach it", () => {
    const gate = bodyOf("function proofGateRefusal(");
    const removalIdx = gate.indexOf("check-writer-test-coverage-removed");
    const waiverIdx = gate.indexOf("opts.firstTestFellThrough === true");
    expect(removalIdx).toBeGreaterThan(-1);
    expect(waiverIdx).toBeGreaterThan(removalIdx);
    // Same for the unmeasurable-diff and marker-cannot-ship refusals: a
    // broken worktree and a loop bug are not proof judgements, and neither is
    // waived by anything.
    expect(gate.indexOf("check-writer-proof-demand-unsatisfied")).toBeLessThan(
      waiverIdx,
    );
    expect(gate.indexOf("check-writer-marker-cannot-ship")).toBeLessThan(
      waiverIdx,
    );
  });

  it("#1198 second review, F1: another ticket's locked check is computed BEFORE the waiver, and gates it", () => {
    // The one never-waived refusal that sits BELOW the demand-versus-offer
    // comparison rather than above it, so ordering alone does not protect it.
    // A waiver that returned before `lockedCheckTouches` ran would let a
    // fall-through ticket MODIFY another issue's locked red-first check and
    // ship — deletion is caught upstream by `removedTestFiles`, modification
    // is caught nowhere else.
    const gate = bodyOf("function proofGateRefusal(");
    const lockedIdx = gate.indexOf(
      "const lockedChecks = lockedCheckTouches(",
    );
    const waiverIdx = gate.indexOf("opts.firstTestFellThrough === true");
    expect(lockedIdx).toBeGreaterThan(-1);
    expect(waiverIdx).toBeGreaterThan(lockedIdx);
    expect(gate).toContain(
      "opts.firstTestFellThrough === true && lockedChecks.length === 0",
    );
  });

  it("the ticket-unclear stop is still a stop — the #1143 target audit quarantines before any code", () => {
    // A ticket nobody can read gives the builder nothing to aim at and the
    // reviewer nothing to judge against. Since spec #1334 deleted the judge's
    // early pass, #1143's "No target, no dispatch" audit is the one producer
    // of `stopped:ticket-unclear`, and it must stay a stop.
    const audit = SRC.slice(
      SRC.indexOf("const targetAudit = auditServerTarget(ctx.issueBody);"),
      SRC.indexOf("sandbox = await ctx.deps.createSandbox({"),
    );
    expect(audit).toContain("const stop = ticketUnclearExplanation({");
    expect(audit).toContain("{ stopLabel: stop.label }");
    expect(audit).toContain('return { status: "quarantined"');
    expect(audit).not.toContain("buildAnywayWithoutFirstTest");
  });

  it("spec #1334 SG: disposeAlreadyBuilt never hands a ticket to the owner — already-built work goes to the reviewer", () => {
    // It used to quarantine `stopped:already-built` + `needs-human` on three
    // of its four roads. Now only the certified-on-staging close stops the
    // stage (`proceed: false`, an `ok` outcome); every other road proceeds,
    // with no build pass, to the reviewer.
    const body = bodyOf("async function disposeAlreadyBuilt(");
    expect(body).toContain("buildAnywayWithoutFirstTest(");
    expect(body).toContain("skipBuild: situation");
    expect(body).not.toContain("ctx.deps.quarantine");
    expect(body).not.toContain('"stopped:already-built"');
  });

  it("spec #1334: a check-writer whose last line contradicts its envelope builds anyway — it never quarantines or reaches the owner", () => {
    // It used to stop `stopped:check-disagreement` + `needs-human`. Owner
    // decision: a first-test problem never stops a ticket.
    const body = bodyOf("async function buildAnywayCheckWriterMarkerMismatch(");
    expect(body).toContain("buildAnywayWithoutFirstTest(");
    expect(body).toContain('marker: "NO_SCREEN_APPLIES"');
    expect(body).not.toContain("ctx.deps.quarantine");
    expect(body).not.toContain("stopped:check-disagreement");
  });

  it("#1198 review, S2: finishCheckWriterStage's unshippable-marker arm RETURNS, never throws", () => {
    // A throw out of `runCheckWriterStage` lands in `runIssuePipeline`'s
    // generic catch → the fixer, with no check-writer pass behind it — the
    // hole #914 closed. A caller bug must not be able to reopen it.
    const body = bodyOf("async function finishCheckWriterStage(");
    const armIdx = body.indexOf('case "TICKET_UNCLEAR": {');
    expect(armIdx).toBeGreaterThan(-1);
    const defaultIdx = body.indexOf("default: {", armIdx);
    expect(defaultIdx).toBeGreaterThan(armIdx);
    const arm = body.slice(armIdx, defaultIdx);
    expect(arm).not.toContain("throw new Error");
    expect(arm).toContain("ctx.deps.quarantine");
    expect(arm).toContain('status: "quarantined"');
    // The `never` default stays a throw: it is unreachable at COMPILE time,
    // so there is no ticket-safe behaviour to model for it.
    expect(body.slice(defaultIdx)).toContain("throw new Error");
  });

  it("#1198 review, S4: the `shipped-without-first-test` label is created at run start", () => {
    // `markShippedWithoutFirstTest` uses `gh issue edit --add-label`, which
    // errors on a label the repository does not have, and its caller swallows
    // that best-effort. Without the create, the one owner-visible signal
    // vanishes silently on a fresh host.
    expect(SRC).toContain("ensureShippedWithoutFirstTestLabelExists,");
    expect(SRC).toContain("await ensureShippedWithoutFirstTestLabelExists({");
  });
});
