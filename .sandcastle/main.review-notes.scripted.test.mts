/**
 * The approving reviewer's report-only rows (spec #1334 follow-on): a
 * Structure FINDING or a WEAK first test on the review whose `ALL_CLEAR`
 * shipped the ticket puts a label on it — and does nothing else. No stop, no
 * extra review round.
 *
 * Drives the REAL `runMain` with scripted agents (`__fixtures__/
 * scripted-run.mts`) and asserts only what the run produced.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import {
  initRepoWithOrigin,
  makeArgs,
  reviewerRefused,
  roleOf,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { runMain } from "./main.mts";

function approving(rows: readonly string[]): string {
  return [
    "I read the finished diff.",
    "",
    "CATEGORY SWEEP:",
    "- Spec fit: OK",
    ...rows,
    "SWEEP COMPLETE.",
    "",
    "ALL_CLEAR",
  ].join("\n");
}

const BRANCH = "sandcastle/review-notes";

function run(issue: number, reviewer: string | readonly string[]) {
  const labels: { issue: number; label: string }[] = [];
  const reports: string[] = [];
  const { deps, captured } = scriptedRun({
    issueNumber: issue,
    title: "Show the team total",
    branch: `agent/issue-${issue}`,
    answers: { reviewer },
    deps: {
      markShippedWithReviewNote: async (n, label) => {
        labels.push({ issue: n, label });
      },
      openRunPr: async (_branch, _shipped, opts) => {
        if (opts?.report !== undefined) reports.push(opts.report);
        return { url: "https://example.invalid/pr/7" };
      },
    },
  });
  return { deps, captured, labels, reports };
}

describe("the approving review's Structure and First-test strength rows", () => {
  let repo: string;
  let cleanup: () => void;
  const args = () => makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 });

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-review-notes-"));
    git(repo, "checkout", "-q", "-b", BRANCH);
  });

  afterEach(() => {
    cleanup();
  });

  it("a FINDING and a WEAK on the approving review ship the ticket with both labels, in one review round", async () => {
    const issue = 701;
    const { deps, captured, labels, reports } = run(
      issue,
      approving([
        "- Structure (quality rubric): FINDING: totals.ts grows a one-Team special case",
        "- First-test strength: WEAK: asserts the page renders, not the total",
      ]),
    );

    const result = await runMain(args(), deps);

    expect(result.shippedIssues).toEqual([issue]);
    expect(labels).toEqual([
      { issue, label: "shipped-with-structure-finding" },
      { issue, label: "shipped-with-weak-first-test" },
    ]);
    expect(captured.specs.filter((n) => roleOf(n) === "reviewer")).toHaveLength(1);
    expect(captured.specs.filter((n) => roleOf(n) === "implementer")).toHaveLength(1);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
    // The owner's end-of-run review reads the note on the Shipped line.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(
      "#701 Show the team total " +
        "(structure finding: totals.ts grows a one-Team special case) " +
        "(weak first test: asserts the page renders, not the total)",
    );
  });

  it("OK and STRONG ship with no label", async () => {
    const issue = 702;
    const { deps, labels } = run(
      issue,
      approving([
        "- Structure (quality rubric): OK",
        "- First-test strength: STRONG",
      ]),
    );

    const result = await runMain(args(), deps);

    expect(result.shippedIssues).toEqual([issue]);
    expect(labels).toEqual([]);
  });

  it("reads only the APPROVING review: a finding on an earlier refusal labels nothing", async () => {
    const issue = 703;
    const { deps, labels } = run(issue, [
      reviewerRefused([
        "- Spec fit: FINDING: the total is wrong",
        "- Structure (quality rubric): FINDING: a 1,200-line file",
      ]),
      approving([
        "- Structure (quality rubric): OK",
        "- First-test strength: N/A (no first test on this ticket)",
      ]),
    ]);

    const result = await runMain(args(), deps);

    expect(result.shippedIssues).toEqual([issue]);
    expect(labels).toEqual([]);
  });
});
