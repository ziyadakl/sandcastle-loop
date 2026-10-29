/**
 * Spec #1334, slice SF1: the first test is advisory. It is written before the
 * builder, must fail on untouched code, and is locked — but a problem with it
 * never stops a ticket and never reaches the owner. Every first-test problem
 * collapses into ONE outcome: the ticket is built anyway, reviewed, and ships
 * labelled `shipped-without-first-test`.
 *
 * These drive the REAL `runMain` with scripted agents (`__fixtures__/
 * scripted-run.mts`) and assert only what the run produced: shipped or not,
 * which label, which agents were dispatched.
 *
 * What SF1 deleted, and what these pin as gone:
 *   - the judge's early pass, which read every written check before the
 *     builder ran (no `judge` dispatch may happen on a healthy ticket);
 *   - the weak-check ladder's budgeted third rewrite (a check observed green
 *     twice gets exactly ONE briefed retry, then the ticket builds anyway);
 *   - the owner hand-off for a check-writer whose last line contradicts its
 *     own envelope (`stopped:check-disagreement` + `needs-human`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GREEN_RUN,
  RED_RUN,
  checkRunExecSequence,
} from "./__fixtures__/check-evidence.js";
import { git } from "./__fixtures__/git-repo.js";
import {
  initRepoWithOrigin,
  IMPLEMENTER_STORY_COMPLETE,
  makeArgs,
  roleOf,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { unitCheckDirFor } from "./lib/checkwriter/unit-check-path.js";
import type { Deps } from "./main.mts";
import { runMain } from "./main.mts";

const CHECK_FILE = "total-is-right.test.ts";

function envelope(body: Record<string, unknown>, lastLine: string): string {
  return [
    "reasoning about the ticket",
    "```json",
    JSON.stringify(body, null, 2),
    "```",
    "",
    lastLine,
  ].join("\n");
}

/** A self-consistent unit-check envelope for `packages/api`. */
const UNIT_ENVELOPE = envelope(
  {
    marker: "UNIT_CHECK_WRITTEN",
    inherited: false,
    checkPackage: "packages/api",
    checkPath: CHECK_FILE,
  },
  "UNIT_CHECK_WRITTEN",
);

/** The check-writer's answer: write the check file into the worktree, then
 *  answer with `stdout`. */
function writesCheck(repo: string, issue: number, stdout: string) {
  return () => {
    const dir = path.join(repo, unitCheckDirFor("packages/api", issue));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, CHECK_FILE),
      `import { expect, it } from "vitest";\n` +
        `import { dealTotal } from "../../services/deal-total.js";\n` +
        `it("counts each Agent once", () => { expect(dealTotal()).toBe(1000); });\n`,
    );
    return stdout;
  };
}

describe("spec #1334 SF1 — the first test is advisory", () => {
  let repo: string;
  let cleanup: () => void;
  const BRANCH = "sandcastle/sf1-run";

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-sf1-"));
    // A package that can host a unit check: a name, a `test` script and a
    // vitest config (`resolveUnitCheckPackage` refuses anything less).
    mkdirSync(path.join(repo, "packages/api"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages/api/package.json"),
      JSON.stringify({ name: "@acme/api", scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(repo, "packages/api/vitest.config.ts"), "export default {};\n");
    // The shared vitest tooling the check freeze locks alongside a unit check.
    mkdirSync(path.join(repo, "tooling/vitest"), { recursive: true });
    writeFileSync(path.join(repo, "tooling/vitest/base.ts"), "export default {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "package");
    git(repo, "checkout", "-q", "-b", BRANCH);
  });

  afterEach(() => {
    cleanup();
  });

  it("a written check that fails on untouched code goes straight to the builder — no judge — and ships WITH its first test", async () => {
    const issue = 611;
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: BRANCH,
      worktreePath: repo,
      exec: checkRunExecSequence([RED_RUN, GREEN_RUN]),
      answers: { "check-writer": writesCheck(repo, issue, UNIT_ENVELOPE) },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.specs.some((n) => n.startsWith("judge"))).toBe(false);
    expect(captured.specs.filter((n) => n.startsWith("check-writer"))).toHaveLength(1);
    expect(captured.shippedWithoutFirstTest).toEqual([]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
  });

  it("a first test that is still red at ship time never stops the ticket: it ships labelled no first test", async () => {
    const issue = 614;
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: BRANCH,
      worktreePath: repo,
      exec: checkRunExecSequence([RED_RUN]),
      answers: { "check-writer": writesCheck(repo, issue, UNIT_ENVELOPE) },
      deps: {
        runScreenCheckHarness: (async () => ({
          verdict: "graded-mismatch",
          reason: "1 failed",
          rerun: false,
          record: {
            verdict: "graded-mismatch",
            whenIso: new Date(0).toISOString(),
            rerun: false,
            pictureStored: false,
          },
        })) as unknown as Deps["runScreenCheckHarness"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.shippedWithoutFirstTest).toEqual([issue]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
    // No tamper, so no fixer: a plain red first test keeps today's behaviour.
    expect(captured.specs.some((n) => roleOf(n) === "fixer")).toBe(false);
  });

  it("a builder that edited the first test, whose restored test then fails at ship, goes to the fixer — never ships labelled no first test", async () => {
    const issue = 615;
    const checkFile = path.join(repo, unitCheckDirFor("packages/api", issue), CHECK_FILE);
    // The builder weakens its own first test and commits it with the work.
    const tamperingBuilder = () => {
      writeFileSync(
        checkFile,
        `import { expect, it } from "vitest";\n` +
          `import { dealTotal } from "../../services/deal-total.js";\n` +
          `it("counts each Agent once", () => { expect(dealTotal()).toBeDefined(); });\n`,
      );
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "work");
      return IMPLEMENTER_STORY_COMPLETE;
    };
    const verdicts = ["graded-mismatch", "match"];
    let harnessRuns = 0;
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: BRANCH,
      worktreePath: repo,
      exec: checkRunExecSequence([RED_RUN]),
      answers: {
        "check-writer": writesCheck(repo, issue, UNIT_ENVELOPE),
        implementer: tamperingBuilder,
      },
      deps: {
        runScreenCheckHarness: (async () => {
          const verdict = verdicts[Math.min(harnessRuns, verdicts.length - 1)]!;
          harnessRuns += 1;
          return {
            verdict,
            reason: verdict === "match" ? "1 passed" : "1 failed",
            rerun: false,
            record: {
              verdict,
              whenIso: new Date(0).toISOString(),
              rerun: false,
              pictureStored: false,
            },
          };
        }) as unknown as Deps["runScreenCheckHarness"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    // The restored test failing is a red result on the code the builder
    // wrote, so the ticket takes the ordinary fixer road ...
    expect(captured.specs.some((n) => roleOf(n) === "fixer")).toBe(true);
    // ... and is never waved through on a test the reviewer saw tampered.
    expect(captured.shippedWithoutFirstTest).toEqual([]);
    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.stops).toEqual([]);
  });

  it("a check that passes on untouched code twice gets ONE briefed retry, then the ticket ships labelled no first test", async () => {
    const issue = 612;
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: BRANCH,
      worktreePath: repo,
      // Every run green: the check cannot fail.
      exec: checkRunExecSequence([GREEN_RUN]),
      answers: { "check-writer": writesCheck(repo, issue, UNIT_ENVELOPE) },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    // Attempt 1 and its one briefed retry — never a third, budgeted rewrite.
    expect(captured.specs.filter((n) => n.startsWith("check-writer"))).toHaveLength(2);
    expect(captured.specs.some((n) => n.startsWith("judge"))).toBe(false);
    expect(captured.shippedWithoutFirstTest).toEqual([issue]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
  });

  it("a check-writer whose last line contradicts its own envelope never reaches the owner: the ticket ships labelled no first test", async () => {
    const issue = 613;
    const contradicted = envelope(
      {
        marker: "NO_SCREEN_APPLIES",
        inherited: false,
        noScreenReason: "only a loop config change",
      },
      "CHECKS_WRITTEN",
    );
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: BRANCH,
      worktreePath: repo,
      answers: { "check-writer": contradicted },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
    expect(captured.shippedWithoutFirstTest).toEqual([issue]);
  });
});
