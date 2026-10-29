/**
 * Spec #1334, slice SF2: the judge is gone, and with it every road where it
 * refereed a reviewer's refusal. What replaces it, pinned here end to end
 * through the REAL `runMain` with scripted agents:
 *
 *   - a reviewer that says this ticket's first test is wrong
 *     (`GROUNDS: WRONG-CHECK (…)`) buys the test-writing AI ONE rewrite, briefed
 *     with the reviewer's own reason;
 *   - a rewrite the host can PROVE (red on the code the builder was handed,
 *     green on the code it produced) becomes the first test, and the ticket
 *     ships with it;
 *   - a rewrite that still disagrees with the code is thrown away, the
 *     accepted test is put back, and the ticket ships on the reviewer's pass
 *     labelled `shipped-without-first-test` — a wrong first test never stops a
 *     ticket;
 *   - a builder that edits the locked first test has it restored and the
 *     restored test re-run, and the first such edit never stops the ticket.
 *
 * Assertions are on run OUTPUT only: shipped or not, labels, which agents ran,
 * and the bytes of the check on the shipped commit.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GREEN_RUN,
  RED_RUN,
  checkRunExecSequence,
} from "./__fixtures__/check-evidence.js";
import { git } from "./__fixtures__/git-repo.js";
import {
  initRepoWithOrigin,
  makeArgs,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import { unitCheckDirFor } from "./lib/checkwriter/unit-check-path.js";
import type { Deps } from "./main.mts";
import { runMain } from "./main.mts";

const CHECK_FILE = "total-is-right.test.ts";
const ORIGINAL_CHECK =
  `import { expect, it } from "vitest";\n` +
  `import { dealTotal } from "../../services/deal-total.js";\n` +
  `it("counts each Agent once", () => { expect(dealTotal()).toBe(2000); });\n`;
const REWRITTEN_CHECK =
  `import { expect, it } from "vitest";\n` +
  `import { dealTotal } from "../../services/deal-total.js";\n` +
  `it("counts each Agent once", () => { expect(dealTotal()).toBe(1000); });\n`;

const PLAYWRIGHT_CONFIG = "export default { retries: 0 };\n";

const UNIT_ENVELOPE = [
  "reasoning about the ticket",
  "```json",
  JSON.stringify(
    {
      marker: "UNIT_CHECK_WRITTEN",
      inherited: false,
      checkPackage: "packages/api",
      checkPath: CHECK_FILE,
    },
    null,
    2,
  ),
  "```",
  "",
  "UNIT_CHECK_WRITTEN",
].join("\n");

const WRONG_CHECK_REASON =
  "total-is-right.test.ts: the ticket says each Agent's $1,000 counts once; the test expects $2,000";

const REFUSED_WRONG_CHECK = [
  "The code is right; the first test is not.",
  "",
  "CATEGORY SWEEP:",
  "- Spec fit: ok",
  "- Test fidelity: FINDING: the first test asserts a doubled total",
  "SWEEP COMPLETE.",
  `GROUNDS: WRONG-CHECK (${WRONG_CHECK_REASON})`,
  "",
  "HAS_BLOCKERS",
].join("\n");

const BUILDER_ENVELOPE = [
  "work done",
  "```json",
  JSON.stringify({
    marker: "STORY_COMPLETE",
    storyType: "backend-only",
    e2eRequired: false,
    e2eActuallyRan: false,
    testCommandUsed: null,
    e2eAssertionLine: null,
    outputNotFiltered: true,
    testReachedFeature: false,
  }),
  "```",
  "STORY_COMPLETE",
].join("\n");

describe("spec #1334 SF2 — the first test's one rewrite, and the restore", () => {
  let repo: string;
  /** The ticket's OWN worktree, apart from the run checkout — as in
   *  production. The run writes its status file into the run checkout, and a
   *  shared one would read as uncommitted builder work to the rewrite's
   *  replay. */
  let wt: string;
  let wtParent: string;
  let cleanup: () => void;
  const BRANCH = "sandcastle/sf2-run";

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-sf2-"));
    mkdirSync(path.join(repo, "packages/api/src/services"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages/api/package.json"),
      JSON.stringify({ name: "@acme/api", scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(repo, "packages/api/vitest.config.ts"), "export default {};\n");
    writeFileSync(
      path.join(repo, "packages/api/src/services/deal-total.ts"),
      "export const dealTotal = (): number => 2000;\n",
    );
    mkdirSync(path.join(repo, "tooling/vitest"), { recursive: true });
    writeFileSync(path.join(repo, "tooling/vitest/base.ts"), "export default {};\n");
    // A file the loop freezes against every agent (the browser runner's
    // config), so a test can edit it.
    mkdirSync(path.join(repo, "apps/nextjs"), { recursive: true });
    writeFileSync(path.join(repo, "apps/nextjs/playwright.config.ts"), PLAYWRIGHT_CONFIG);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "package");
    git(repo, "checkout", "-q", "-b", BRANCH);
    wtParent = mkdtempSync(path.join(tmpdir(), "sc-sf2-wt-"));
    wt = path.join(wtParent, "agent");
    git(repo, "worktree", "add", "-q", "-b", "agent/sf2", wt, BRANCH);
  });

  afterEach(() => {
    cleanup();
    rmSync(wtParent, { recursive: true, force: true });
  });

  const checkRel = (issue: number): string =>
    path.join(unitCheckDirFor("packages/api", issue), CHECK_FILE);

  /** The check-writer writes `body` as the check, then answers. */
  function writesCheck(issue: number, body: string) {
    return () => {
      const abs = path.join(wt, checkRel(issue));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      return UNIT_ENVELOPE;
    };
  }

  /** The builder fixes the product code and commits it. */
  function builderFixes(extra?: () => void) {
    return () => {
      writeFileSync(
        path.join(wt, "packages/api/src/services/deal-total.ts"),
        "export const dealTotal = (): number => 1000;\n",
      );
      extra?.();
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "feat: count each Agent once");
      return BUILDER_ENVELOPE;
    };
  }

  /** Records every ship-time harness run, with the check's bytes on disk at
   *  that moment. */
  function harnessSpy(issue: number) {
    const runs: string[] = [];
    const dep: Partial<Deps> = {
      runScreenCheckHarness: (async () => {
        runs.push(readFileSync(path.join(wt, checkRel(issue)), "utf8"));
        return { verdict: "match", reason: "matched", rerun: false };
      }) as unknown as Deps["runScreenCheckHarness"],
    };
    return { runs, dep };
  }

  const shippedCheck = (issue: number): string =>
    git(wt, "show", `HEAD:${checkRel(issue)}`);

  it("a wrong first test ships labelled no first test: the rewrite still disagrees, the accepted test is put back, and the reviewer's pass ships it", async () => {
    const issue = 721;
    const harness = harnessSpy(issue);
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: "agent/sf2",
      worktreePath: wt,
      // 1. the first test's own proof: RED on untouched code (accepted);
      // 2. the rewrite's proof against the code the builder was handed:
      //    GREEN — it cannot fail there, so it does not count.
      exec: checkRunExecSequence([RED_RUN, GREEN_RUN]),
      answers: {
        "check-writer": [
          writesCheck(issue, ORIGINAL_CHECK),
          writesCheck(issue, REWRITTEN_CHECK),
        ],
        implementer: builderFixes(),
        reviewer: [REFUSED_WRONG_CHECK, "looks good\nALL_CLEAR"],
      },
      deps: harness.dep,
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.shippedWithoutFirstTest).toEqual([issue]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
    // Exactly ONE rewrite, and no judge.
    expect(captured.specs.filter((n) => n.startsWith("check-writer"))).toHaveLength(2);
    expect(captured.specs.some((n) => n.startsWith("judge"))).toBe(false);
    // No builder round was spent on code the reviewer called right.
    expect(captured.specs.filter((n) => n.startsWith("implementer"))).toHaveLength(1);
    // The accepted test is what ships — the unproven rewrite was put back —
    // and no ship-time run graded a ticket that ships on the reviewer's word.
    expect(shippedCheck(issue)).toBe(ORIGINAL_CHECK.trimEnd());
    expect(harness.runs).toEqual([]);
  });

  it("a rewrite the host PROVES becomes the first test: red on the old code, green on the new, and the ticket ships WITH it, unlabelled", async () => {
    const issue = 722;
    const harness = harnessSpy(issue);
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: "agent/sf2",
      worktreePath: wt,
      // proof of the original (RED), the rewrite's red replay (RED), the
      // rewrite's green run on the finished code (GREEN).
      exec: checkRunExecSequence([RED_RUN, RED_RUN, GREEN_RUN]),
      answers: {
        "check-writer": [
          writesCheck(issue, ORIGINAL_CHECK),
          writesCheck(issue, REWRITTEN_CHECK),
        ],
        implementer: builderFixes(),
        reviewer: [REFUSED_WRONG_CHECK, "looks good\nALL_CLEAR"],
      },
      deps: harness.dep,
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.shippedWithoutFirstTest).toEqual([]);
    expect(captured.stops).toEqual([]);
    expect(captured.specs.filter((n) => n.startsWith("check-writer"))).toHaveLength(2);
    expect(captured.specs).toContain("reviewer-check-repaired");
    expect(shippedCheck(issue)).toBe(REWRITTEN_CHECK.trimEnd());
    // The ship-time run graded the REWRITTEN test.
    expect(harness.runs).toEqual([REWRITTEN_CHECK]);
  });

  it("after a PROVED rewrite the reviewer refuses again: the later review round and the ship-time run both use the REWRITTEN test, never the original", async () => {
    const issue = 724;
    const harnessCommands: (string | undefined)[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: "agent/sf2",
      worktreePath: wt,
      // proof of the original (RED), the rewrite's red replay (RED), the
      // rewrite's green run on the finished code (GREEN).
      exec: checkRunExecSequence([RED_RUN, RED_RUN, GREEN_RUN]),
      answers: {
        "check-writer": [
          writesCheck(issue, ORIGINAL_CHECK),
          writesCheck(issue, REWRITTEN_CHECK),
        ],
        implementer: [
          builderFixes(),
          () => {
            writeFileSync(path.join(wt, "packages/api/src/services/note.ts"), "export {};\n");
            git(wt, "add", "-A");
            git(wt, "commit", "-q", "-m", "fix: the reviewer's second finding");
            return BUILDER_ENVELOPE;
          },
        ],
        reviewer: [
          REFUSED_WRONG_CHECK,
          // The fresh look at the rewritten test refuses on an ordinary
          // finding, so a fix round is spent.
          [
            "Not yet.",
            "",
            "CATEGORY SWEEP:",
            "- Spec fit: FINDING: the empty-deal case is not handled",
            "SWEEP COMPLETE.",
            "GROUNDS: NO-CHECK",
            "",
            "HAS_BLOCKERS",
          ].join("\n"),
          "looks good\nALL_CLEAR",
        ],
      },
      deps: {
        runScreenCheckHarness: (async (o: { checkCommand?: string }) => {
          harnessCommands.push(o.checkCommand);
          return { verdict: "match", reason: "matched", rerun: false };
        }) as unknown as Deps["runScreenCheckHarness"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, retryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.shippedWithoutFirstTest).toEqual([]);
    const commandFor = (name: string): string | undefined =>
      captured.prompts.find((p) => p.name === name)?.promptArgs.CHECK_WRITER_CHECK_COMMAND;
    const original = commandFor("reviewer");
    const rewritten = commandFor("reviewer-check-repaired");
    expect(rewritten).toBeTruthy();
    expect(rewritten).not.toBe(original);
    // The later review round is told about the rewritten test...
    expect(commandFor("reviewer-retry")).toBe(rewritten);
    // ...and the ship-time run grades it.
    expect(harnessCommands).toEqual([rewritten]);
    expect(shippedCheck(issue)).toBe(REWRITTEN_CHECK.trimEnd());
  });

  it("a test-writer that edits a frozen file has it restored, its test re-run, and the ticket ships — never a stop", async () => {
    const issue = 725;
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: "agent/sf2",
      worktreePath: wt,
      // The first proof (RED), then the re-run on the restored files (RED).
      exec: checkRunExecSequence([RED_RUN, RED_RUN]),
      answers: {
        "check-writer": () => {
          const answer = writesCheck(issue, ORIGINAL_CHECK)();
          writeFileSync(
            path.join(wt, "apps/nextjs/playwright.config.ts"),
            "export default { retries: 99 };\n",
          );
          git(wt, "add", "-A");
          git(wt, "commit", "-q", "-m", "check plus a config tweak");
          return answer;
        },
        implementer: builderFixes(),
        reviewer: "looks good\nALL_CLEAR",
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.stops).toEqual([]);
    expect(captured.quarantines).toEqual([]);
    // The re-run proved the test red again, so it ships WITH its first test.
    expect(captured.shippedWithoutFirstTest).toEqual([]);
    // The frozen file ships exactly as it was before the test-writer touched it.
    expect(git(wt, "show", "HEAD:apps/nextjs/playwright.config.ts")).toBe(
      PLAYWRIGHT_CONFIG.trimEnd(),
    );
  });

  it("a first test edited a second time — by the fixer, after the builder — is restored again and the ticket ships: never a stop", async () => {
    const issue = 726;
    const editTest = () =>
      writeFileSync(
        path.join(wt, checkRel(issue)),
        `import { it } from "vitest";\nit("passes", () => {});\n`,
      );
    const verifyTestRun = vi
      .fn()
      .mockResolvedValueOnce({ status: "fail", reason: "1 test failed" })
      .mockResolvedValue({ status: "pass", reason: "suite passed" });
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: "agent/sf2",
      worktreePath: wt,
      exec: checkRunExecSequence([RED_RUN]),
      answers: {
        "check-writer": writesCheck(issue, ORIGINAL_CHECK),
        implementer: builderFixes(editTest),
        fixer: () => {
          editTest();
          writeFileSync(path.join(wt, "packages/api/src/services/note.ts"), "export {};\n");
          git(wt, "add", "-A");
          git(wt, "commit", "-q", "-m", "fix: the failing suite");
          return BUILDER_ENVELOPE;
        },
      },
      deps: {
        checkTestCert: async () => ({ status: "pass" }),
        verifyTestRun: verifyTestRun as unknown as Deps["verifyTestRun"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(captured.specs.filter((n) => n === "fixer")).toHaveLength(1);
    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.stops).toEqual([]);
    expect(captured.quarantines).toEqual([]);
    expect(shippedCheck(issue)).toBe(ORIGINAL_CHECK.trimEnd());
  });

  it("an edited first test is restored and re-run: the builder's edit never ships, the ship-time run grades the accepted test, and the first edit does not stop the ticket", async () => {
    const issue = 723;
    const harness = harnessSpy(issue);
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch: "agent/sf2",
      worktreePath: wt,
      exec: checkRunExecSequence([RED_RUN]),
      answers: {
        "check-writer": writesCheck(issue, ORIGINAL_CHECK),
        // The builder "fixes" the test instead of trusting it.
        implementer: builderFixes(() =>
          writeFileSync(
            path.join(wt, checkRel(issue)),
            `import { it } from "vitest";\nit("passes", () => {});\n`,
          ),
        ),
        reviewer: "looks good\nALL_CLEAR",
      },
      deps: harness.dep,
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1 }),
      deps,
    );

    expect(result.shippedIssues).toEqual([issue]);
    expect(captured.stops).toEqual([]);
    expect(captured.quarantines).toEqual([]);
    // The shipped commit carries the ACCEPTED test, through a restore commit.
    expect(shippedCheck(issue)).toBe(ORIGINAL_CHECK.trimEnd());
    expect(git(wt, "log", "--format=%B", "-n", "20")).toMatch(/protected/i);
    // And the restored test is what the ship-time run graded.
    expect(harness.runs).toEqual([ORIGINAL_CHECK]);
  });
});
