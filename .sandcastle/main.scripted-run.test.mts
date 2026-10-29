/**
 * Proves the shared scripted-run fixture (`__fixtures__/scripted-run.mts`)
 * drives the REAL `runMain` end to end in both of its modes, so every later
 * "scripted run" test (spec #1334) can trust it rather than re-proving it.
 *
 * - Mocked mode (no `worktreePath`): the normal road — check-writer, builder,
 *   reviewer — ships the one ticket.
 * - Real-git mode (`worktreePath` = a real checkout): the fixer road. This
 *   case pins that the fixture's real-git mode reaches the fixer and the
 *   fixer's own reviewer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import {
  IMPLEMENTER_HARD_CEILING_MESSAGE,
  initRepoWithOrigin,
  makeArgs,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { runMain } from "./main.mts";

describe("scripted-run fixture", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-scripted-run-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("mocked mode: with every role's default answer, the one ticket ships after one review", async () => {
    const BRANCH = "sandcastle/scripted-run";
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = scriptedRun({
      issueNumber: 501,
      branch: "agent/issue-501",
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([501]);
    expect(captured.stops).toEqual([]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.specs.filter((n) => n.startsWith("implementer"))).toHaveLength(1);
    expect(captured.specs.filter((n) => n.startsWith("reviewer"))).toHaveLength(1);
  });

  it("real-git mode: a builder killed at the hard ceiling goes to the fixer, and the fixer's reviewer actually runs", async () => {
    const BRANCH = "agent/issue-502";
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = scriptedRun({
      issueNumber: 502,
      branch: BRANCH,
      worktreePath: repo,
      answers: { implementer: new Error(IMPLEMENTER_HARD_CEILING_MESSAGE) },
    });

    const result = await runMain(
      makeArgs({
        repoRoot: repo,
        branch: BRANCH,
        iterations: 1,
        recoveryEnabled: true,
      }),
      deps,
    );

    expect(captured.specs.filter((n) => n === "fixer")).toHaveLength(1);
    expect(captured.specs.filter((n) => n === "fixer-reviewer")).toHaveLength(1);
    expect(result.shippedIssues).toEqual([502]);
  });

  it("per-round answers: a reviewer refusal then a pass gives the builder a second round", async () => {
    const BRANCH = "sandcastle/scripted-run";
    git(repo, "checkout", "-q", "-b", BRANCH);
    const { deps, captured } = scriptedRun({
      issueNumber: 503,
      branch: "agent/issue-503",
      answers: {
        reviewer: [
          [
            "not passing it",
            "",
            "CATEGORY SWEEP:",
            "- Spec fit: FINDING: the total is wrong",
            "SWEEP COMPLETE.",
            "",
            "HAS_BLOCKERS",
          ].join("\n"),
          "looks good\nALL_CLEAR",
        ],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(captured.specs.filter((n) => n.startsWith("implementer"))).toHaveLength(2);
    expect(captured.specs.filter((n) => n.startsWith("reviewer"))).toHaveLength(2);
    expect(result.shippedIssues).toEqual([503]);
  });
});
