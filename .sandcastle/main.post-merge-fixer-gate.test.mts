/**
 * #972 gap 6 — the post-merge fixer's own output must clear the SAME
 * never-waived removed-coverage gate the per-issue ship path enforces.
 *
 * The post-merge fixer (`post-merge-fix-prompt.md`) writes and commits code
 * DIRECTLY on `integration-candidate` AFTER every per-issue proof gate has
 * already run. Before this ticket nothing measured its diff, so a fixer that
 * deleted a Playwright spec shipped green by being absent (vitest's include is
 * `src/**`) — exactly the failure the per-issue gate exists to stop. The threat
 * model is CARELESSNESS: a fixer whose edit lands unmeasured, not one hunting a
 * loophole.
 *
 * These prove, against a REAL git repo and REAL commits (never a stubbed git
 * layer), that {@link postMergeFixerProofRefusal}:
 *   (a) REFUSES a fixer diff that deletes or guts a test file, and
 *   (b) PASSES a clean fixer diff, and a fixer that changed nothing, and
 *   (c) FAILS CLOSED — refuses — when the tip moved but git could not be asked
 *       what changed, and never throws on a bad ref.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import { postMergeFixerProofRefusal } from "./main.mts";

const TEST_FILE = "packages/db/src/practice-world.test.ts";
const SRC_FILE = "packages/db/src/practice-world.ts";

/** A real 100-line vitest suite — enough that gutting it to one line trips the
 *  collapse detector, and a plausible thing a careless fixer might blow away. */
function bigSuite(): string {
  const cases = Array.from(
    { length: 100 },
    (_i, n) => `  it("keeps invariant ${n}", () => { expect(${n}).toBe(${n}); });`,
  ).join("\n");
  return `import { describe, it, expect } from "vitest";\n\ndescribe("practice world", () => {\n${cases}\n});\n`;
}

describe("postMergeFixerProofRefusal — real git repo, real fixer commits", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-fixer-gate-"));
    git(repo, "init", "-q", "-b", "integration-candidate");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("REFUSES a fixer diff that DELETES a test file (git rm)", () => {
    const fromSha = commitInto(
      repo,
      {
        [SRC_FILE]: "export const practiceWorld = { keeps: 10967.5 };\n",
        [TEST_FILE]: bigSuite(),
      },
      "chore: certified staging tip (per-issue gates already passed)",
    );
    // The fixer, running directly on integration-candidate, deletes the suite.
    git(repo, "rm", "-q", TEST_FILE);
    git(repo, "commit", "-q", "-m", "post-merge fixer: drop the failing suite");
    const toSha = git(repo, "rev-parse", "HEAD");

    const errors: string[] = [];
    const refusal = postMergeFixerProofRefusal({
      repoRoot: repo,
      fromSha,
      toSha,
      logError: (m) => errors.push(m),
    });

    expect(refusal).toBeDefined();
    // Removed coverage is NEVER waived, in either enforcement mode.
    expect(refusal?.neverWaived).toBe(true);
    expect(refusal?.touchedPaths).toContain(TEST_FILE);
    expect(refusal?.message).toContain(TEST_FILE);
    expect(refusal?.message.toLowerCase()).toContain("post-merge fixer");
  });

  it("REFUSES a fixer diff that GUTS a test file (200-case suite → one noop)", () => {
    const fromSha = commitInto(
      repo,
      { [TEST_FILE]: bigSuite() },
      "chore: certified staging tip",
    );
    // The fixer overwrites the suite with a hollow stub — file still present,
    // coverage gone. This is the numstat-`1 200 path` shape the collapse
    // detector exists for.
    const toSha = commitInto(
      repo,
      { [TEST_FILE]: 'import { it } from "vitest";\nit("noop", () => {});\n' },
      "post-merge fixer: hollow out the suite",
    );

    const refusal = postMergeFixerProofRefusal({
      repoRoot: repo,
      fromSha,
      toSha,
      logError: () => {},
    });

    expect(refusal).toBeDefined();
    expect(refusal?.neverWaived).toBe(true);
    expect(refusal?.touchedPaths).toContain(TEST_FILE);
  });

  it("PASSES a clean fixer diff that only edits non-test product code", () => {
    const fromSha = commitInto(
      repo,
      {
        [SRC_FILE]: "export const practiceWorld = { keeps: 10967.5 };\n",
        [TEST_FILE]: bigSuite(),
      },
      "chore: certified staging tip",
    );
    // A legitimate fixer edit: fix the product code, leave the suite intact.
    const toSha = commitInto(
      repo,
      { [SRC_FILE]: "export const practiceWorld = { keeps: 10967.55 };\n" },
      "post-merge fixer: correct the rounding",
    );

    const refusal = postMergeFixerProofRefusal({
      repoRoot: repo,
      fromSha,
      toSha,
      logError: () => {},
    });

    expect(refusal).toBeUndefined();
  });

  it("PASSES when the fixer changed nothing (tip did not move)", () => {
    const sha = commitInto(
      repo,
      { [TEST_FILE]: bigSuite() },
      "chore: certified staging tip",
    );
    const refusal = postMergeFixerProofRefusal({
      repoRoot: repo,
      fromSha: sha,
      toSha: sha,
      logError: () => {},
    });
    expect(refusal).toBeUndefined();
  });

  it("FAILS CLOSED — refuses, without throwing — when the tip moved but git cannot measure the diff", () => {
    const toSha = commitInto(
      repo,
      { [TEST_FILE]: bigSuite() },
      "chore: staging tip",
    );
    const errors: string[] = [];
    // A bogus `fromSha` no `git diff` can resolve: the tip demonstrably moved
    // (from ≠ to), but the change is unknowable. Silence is not an all-clear.
    let refusal: ReturnType<typeof postMergeFixerProofRefusal>;
    expect(() => {
      refusal = postMergeFixerProofRefusal({
        repoRoot: repo,
        fromSha: "0000000000000000000000000000000000000000",
        toSha,
        logError: (m) => errors.push(m),
      });
    }).not.toThrow();

    expect(refusal).toBeDefined();
    expect(refusal?.neverWaived).toBe(true);
  });

  it("PASSES a clean fixer diff that adds a NEW test alongside product code", () => {
    const fromSha = commitInto(
      repo,
      { [SRC_FILE]: "export const practiceWorld = {};\n" },
      "chore: certified staging tip",
    );
    const toSha = commitInto(
      repo,
      {
        [SRC_FILE]: "export const practiceWorld = { keeps: 1 };\n",
        [TEST_FILE]: bigSuite(),
      },
      "post-merge fixer: fix + add coverage",
    );
    const refusal = postMergeFixerProofRefusal({
      repoRoot: repo,
      fromSha,
      toSha,
      logError: () => {},
    });
    expect(refusal).toBeUndefined();
  });
});
