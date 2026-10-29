/**
 * Design rules are graded by the REVIEWER, not by a separate critique stage
 * (spec #1334). Until #1334 a ticket whose type listed design principles in
 * SANDCASTLE.md went through a second, post-review "design critique" with its
 * own two retries and a fix pass, ending in `stopped:critique-blocked` — or,
 * when no rubric file was on disk, a hand-off to the owner. Both are gone: the
 * reviewer reads PRODUCT.md and the type's principles itself, and a design
 * defect comes back as an ordinary blocking reviewer finding.
 *
 * Three readers here:
 *  - a scripted run (the whole loop, stand-in agents) proving a design-typed
 *    ticket ships on the reviewer's pass with no critique dispatched;
 *  - a source guard that the critique stage and its prompts stay deleted;
 *  - prompt pins that the reviewer prompt carries the design category.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "./__fixtures__/git-repo.js";
import {
  IMPLEMENTER_STORY_COMPLETE,
  initRepoWithOrigin,
  makeArgs,
  roleOf,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { PROMPT_FILES } from "./lib/telemetry/run-identity.js";
import { runMain } from "./main.mts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (name: string): string =>
  readFileSync(path.join(HERE, name), "utf8");

describe("scripted run: a ticket with design principles ships on the reviewer's pass alone", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-design-review-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("dispatches no design critique and stops nothing", async () => {
    const BRANCH = "sandcastle/design-review";
    // A SANDCASTLE.md naming one required principle for the ticket's type, and
    // that principle's rubric on disk — exactly the shape that used to wake
    // the critique stage up.
    writeFileSync(
      path.join(repo, "SANDCASTLE.md"),
      [
        "# SANDCASTLE.md",
        "",
        "### type:visual-enhance",
        "",
        "Required critique dimensions:",
        "",
        "- impeccable",
        "",
      ].join("\n"),
    );
    git(repo, "add", "SANDCASTLE.md");
    git(repo, "commit", "-q", "-m", "sandcastle rubric");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", BRANCH);

    // The builder must really invoke the required skill, or the separate
    // skill-discipline gate (untouched by #1334) stops it first.
    const session = path.join(repo, "builder-session.jsonl");
    writeFileSync(
      session,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "impeccable" } },
          ],
        },
      })}\n`,
    );

    const { deps, captured } = scriptedRun({
      issueNumber: 601,
      branch: "agent/issue-601",
      labels: ["ready-for-agent", "type:visual-enhance"],
      answers: {
        implementer: {
          stdout: IMPLEMENTER_STORY_COMPLETE,
          commits: [{ sha: "abc123", subject: "work" }],
          iterations: [{ sessionFilePath: session }],
        },
        // If a critique were dispatched it would get a verdict that blocks.
        critique: "Findings: everything.\n\nCRITIQUE_CRITICAL",
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(captured.specs.filter((n) => roleOf(n) === "critique")).toEqual([]);
    expect(captured.stops).toEqual([]);
    expect(captured.quarantines).toEqual([]);
    expect(result.shippedIssues).toEqual([601]);
  });
});

describe("the design critique stage stays deleted", () => {
  const main = read("main.mts");
  const count = (needle: string): number => main.split(needle).length - 1;

  it("main.mts names neither critique prompt nor the critique runner", () => {
    expect(count("critique-prompt.md")).toBe(0);
    expect(count("critique-fix-prompt.md")).toBe(0);
    expect(count("runCritique")).toBe(0);
    expect(count("critiqueFixPass")).toBe(0);
    expect(count("CritiqueCriticalError")).toBe(0);
    // No dispatch is timed or billed to the retired `critique` cost role.
    expect(count('timeIssueRole(ctx, "critique"')).toBe(0);
    expect(count('captureIssueRoleCost(ctx, "critique"')).toBe(0);
  });

  it("the two critique prompt files are gone", () => {
    expect(existsSync(path.join(HERE, "critique-prompt.md"))).toBe(false);
    expect(existsSync(path.join(HERE, "critique-fix-prompt.md"))).toBe(false);
  });

  it("no run-identity prompt hash is taken of a critique prompt", () => {
    expect(PROMPT_FILES.filter((f) => f.includes("critique"))).toEqual([]);
  });
});

describe("the reviewer prompt carries the design rules", () => {
  const review = read("review-prompt.md");

  it("has a Design rules row in the CATEGORY SWEEP block", () => {
    const sweep = review.slice(review.lastIndexOf("CATEGORY SWEEP:"));
    expect(sweep).toContain(
      "- Design rules: <OK | N/A (<reason>) | FINDING: <one-line finding>>",
    );
  });

  it("grades against PRODUCT.md and blocks only on objective defects", () => {
    expect(review).toContain("- **Design rules**");
    expect(review).toContain("PRODUCT.md");
    expect(review).toContain("Objective vs subjective");
  });

  it("the builder prompt no longer takes critique findings", () => {
    expect(read("implement-prompt.md")).not.toContain("{{CRITIQUE_FEEDBACK}}");
  });
});
