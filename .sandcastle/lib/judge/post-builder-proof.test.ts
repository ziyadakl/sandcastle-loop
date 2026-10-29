/**
 * Issue #1118, ruling 4 — the ONE test separating a corrected check from a
 * weakened one, read here as pure functions so every way it can go wrong is
 * exercised without standing a git worktree up.
 *
 * The single most dangerous mistake this file exists to pin: something that
 * ERRORED is not something that went RED. Both exit non-zero, and reading the
 * first as the second certifies a check that cannot run as a correction.
 */
import { describe, expect, it } from "vitest";

import {
  readPostBuilderGreenProof,
  readPostBuilderRedProof,
  readReplayFailure,
} from "./post-builder-proof.js";
import type { WorktreeReplayResult } from "../paths/worktree-replay.js";

/** The whole repair now happens inside the replay, so what comes back on the
 *  `ok` branch is whatever the caller chose to carry out. */
const carried = <T>(value: T): WorktreeReplayResult<T> => ({
  kind: "ok",
  value,
});

describe("narrowing the replay before anything in it is believed", () => {
  it("hands back the value on the one branch that carries one", () => {
    const read = readReplayFailure(carried("the repaired check"));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.value).toBe("the repaired check");
  });

  it("does NOT read a thrown replay as a proof", () => {
    // THE INVERSION TRAP. Everything inside the replay exits non-zero when it
    // goes wrong, exactly as a red check does. Reading this as red would
    // certify a rewrite nobody measured.
    const read = readReplayFailure({
      kind: "fn-threw",
      error: "the check-writer container blew up",
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.failure.because).toContain("errored instead");
    expect(read.failure.worktreeUnsafe).toBe(false);
  });

  it("does NOT read a failed revert as a proof", () => {
    // Nothing ran, so there is no proof in either direction.
    const read = readReplayFailure({
      kind: "revert-failed",
      error: "could not stand the worktree up on that commit",
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.failure.worktreeUnsafe).toBe(false);
  });

  it("refuses when the builder left tracked edits in no commit", () => {
    const read = readReplayFailure({
      kind: "dirty-at-entry",
      dirtyPaths: ["apps/nextjs/src/app/page.tsx"],
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.failure.because).toContain("apps/nextjs/src/app/page.tsx");
    // THE WORKTREE IS DIRTY — that is the whole reason this branch was taken —
    // and it used to be reported as safe. Uncommitted tracked files block the
    // run's final promotion, so the alarm is raised and the reason names the
    // cost in plain words.
    expect(read.failure.worktreeUnsafe).toBe(true);
    expect(read.failure.because).toContain("final promotion");
  });

  it("raises the worktree alarm when the restore could not be proved", () => {
    // THE DANGEROUS ONE. The tree may still be sitting on pre-builder code, so
    // nothing measured after this means anything and nothing may ship.
    const read = readReplayFailure({
      kind: "restore-failed",
      error: "the worktree does not match what it was before the replay",
      dirtyPaths: ["packages/api/src/router/deal.ts"],
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.failure.worktreeUnsafe).toBe(true);
    expect(read.failure.because).toContain("packages/api/src/router/deal.ts");
  });
});

describe("ruling 4's FIRST half — red against the code the builder was handed", () => {
  it("counts a run the HOST graded red as the proof", () => {
    // The run was executed by `proveFirstTestRewrite` itself, inside the
    // replay, graded against an expectation of RED. `"pass"` therefore means
    // "it went red, as demanded" — which is exactly what ruling 4 wants here.
    // NOTHING an agent said about its own grade is involved.
    expect(
      readPostBuilderRedProof({ status: "pass", reason: "observed red" }).proved,
    ).toBe(true);
  });

  it("REJECTS a check that passed against the pre-builder state", () => {
    // THE WHOLE POINT. A check that is green on the broken state too is green
    // on everything, which is the failure the design lock named and the one
    // the judge exists to stop. It must never be certified as a correction.
    const proof = readPostBuilderRedProof({
      status: "fail",
      reason: "observed green, expected red",
    });
    expect(proof.proved).toBe(false);
    if (proof.proved) throw new Error("unreachable");
    expect(proof.because).toContain("PASSED against the code as it stood");
    expect(proof.because).toContain("weakened check");
  });

  it("refuses an inconclusive run — a check that ERRORS also exits non-zero", () => {
    const proof = readPostBuilderRedProof({
      status: "inconclusive",
      reason: "no tally line",
    });
    expect(proof.proved).toBe(false);
    if (proof.proved) throw new Error("unreachable");
    expect(proof.because).toContain("could not be graded");
  });
});

describe("ruling 4's SECOND half — green against the finished code", () => {
  it("counts a passing run as the proof", () => {
    expect(
      readPostBuilderGreenProof({ status: "pass", reason: "1 passed" }).proved,
    ).toBe(true);
  });

  it("stops when the repaired check STILL fails the finished code", () => {
    const proof = readPostBuilderGreenProof({
      status: "fail",
      reason: "1 failed",
    });
    expect(proof.proved).toBe(false);
    if (proof.proved) throw new Error("unreachable");
    expect(proof.because).toContain("STILL fails against the finished code");
  });

  it("refuses an ungraded run rather than reading it as a pass", () => {
    // Same refusal as the red half, for the same reason: a run nobody could
    // grade has proved nothing, and this run is the ticket's whole claim to
    // ship.
    const proof = readPostBuilderGreenProof({
      status: "inconclusive",
      reason: "the bound fired",
    });
    expect(proof.proved).toBe(false);
    if (proof.proved) throw new Error("unreachable");
    expect(proof.because).toContain("could not be graded");
  });
});
