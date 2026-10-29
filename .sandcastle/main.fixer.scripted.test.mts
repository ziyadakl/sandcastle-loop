/**
 * Spec #1334, slice SG: ONE fixer, three review rounds, one ship gate; resumed
 * or already-built work goes to review; a skipped tool run never stops a
 * ticket.
 *
 * Every case drives the REAL `runMain` → `runIssuePipeline` with scripted
 * agents (`__fixtures__/scripted-run.mts`) against a real temp git checkout,
 * and asserts only what the run produced: shipped or stopped, which label,
 * which agents were dispatched, which ship-time checks ran.
 *
 * The rules pinned here:
 *   - any failure — a review refusal after the builder's rounds, a failed
 *     pre-merge check, a time-out — goes to ONE fixer;
 *   - the fixer gets the builder's same three review-and-fix rounds, under
 *     the same third-round rule;
 *   - the fixer ships through the ordinary ship gate, so its work gets the
 *     test re-run the old rescue road skipped;
 *   - a fixer failure ends the attempt: one stop, recorded on the retry
 *     budget, never a second fixer;
 *   - finished saved work, and work the test-writer says is already built,
 *     goes straight to review — never to the owner;
 *   - a missing record of a required tool run never stops a ticket.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  IMPLEMENTER_HARD_CEILING_MESSAGE,
  IMPLEMENTER_STORY_COMPLETE,
  initRepoWithOrigin,
  makeArgs,
  reviewerRefused,
  scriptedRun,
  type ScriptedCapture,
} from "./__fixtures__/scripted-run.mts";
import { unitCheckDirFor } from "./lib/checkwriter/unit-check-path.js";
import type { Deps } from "./main.mts";
import { runMain } from "./main.mts";

const HERE = import.meta.dirname;

const count = (c: ScriptedCapture, pred: (n: string) => boolean): number =>
  c.specs.filter(pred).length;
const isBuilder = (n: string): boolean => n.startsWith("implementer");
const isFixer = (n: string): boolean =>
  n.startsWith("fixer") && !n.startsWith("fixer-reviewer");
const isFixerReview = (n: string): boolean => n.startsWith("fixer-reviewer");
const isReviewer = (n: string): boolean => n.startsWith("reviewer");

/** Round 1 names one finding; round 2 clears it and names a fresh one —
 *  the shape that earns a third round. */
const ROUND_1 = reviewerRefused([
  "- Spec fit: FINDING: the deal total counts one Agent twice",
  "- Test fidelity: ok",
]);
const ROUND_2_FRESH = reviewerRefused([
  "- Spec fit: ok",
  "- Test fidelity: FINDING: the new branch has no test",
]);
const ROUND_2_RECURRING = reviewerRefused([
  "- Spec fit: FINDING: the deal total STILL counts one Agent twice",
  "- Test fidelity: ok",
]);
const ROUND_3 = reviewerRefused([
  "- Spec fit: FINDING: a third, unrelated problem",
  "- Test fidelity: ok",
]);

function alreadyBuiltEnvelope(): string {
  return [
    "reasoning about the ticket",
    "```json",
    JSON.stringify({
      marker: "ALREADY_BUILT",
      inherited: false,
      alreadyBuiltEvidence: "packages/api/src/deal-total.ts:40 already does this",
    }),
    "```",
    "",
    "ALREADY_BUILT",
  ].join("\n");
}

describe("the fixer (spec #1334, SG)", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-fixer-"));
  });

  afterEach(() => {
    cleanup();
  });

  function start(issueNumber: number): string {
    const branch = `agent/issue-${issueNumber}`;
    git(repo, "checkout", "-q", "-b", branch);
    return branch;
  }

  it("a builder killed at the time limit goes to the fixer, which gets three review rounds and ships through the ordinary ship gate", async () => {
    const ISSUE = 93401;
    const branch = start(ISSUE);
    const verifyTestRun = vi.fn(async () => ({
      status: "pass" as const,
      reason: "stub suite passed",
    }));
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: {
        implementer: new Error(IMPLEMENTER_HARD_CEILING_MESSAGE),
        "fixer-reviewer": [ROUND_1, ROUND_2_FRESH, "all good now\nALL_CLEAR"],
      },
      deps: {
        checkTestCert: async () => ({ status: "pass" }),
        verifyTestRun: verifyTestRun as unknown as Deps["verifyTestRun"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(count(captured, isFixer)).toBe(3);
    expect(count(captured, isFixerReview)).toBe(3);
    // The fixer's ship re-ran the tests — the old rescue road never did.
    expect(verifyTestRun).toHaveBeenCalledTimes(1);
    expect(captured.stops).toEqual([]);
    expect(captured.quarantines).toEqual([]);
  });

  it("a builder whose three review rounds all refuse is handed to the fixer", async () => {
    const ISSUE = 93402;
    const branch = start(ISSUE);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: { reviewer: [ROUND_1, ROUND_2_FRESH, ROUND_3] },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(count(captured, isBuilder)).toBe(3);
    expect(count(captured, isReviewer)).toBe(3);
    expect(count(captured, isFixer)).toBe(1);
    expect(count(captured, isFixerReview)).toBe(1);
    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(captured.stops).toEqual([]);
  });

  it("a builder whose work fails the test re-run at the ship gate is handed to the fixer, and the fixer's own ship re-runs the tests", async () => {
    const ISSUE = 93403;
    const branch = start(ISSUE);
    const verifyTestRun = vi
      .fn()
      .mockResolvedValueOnce({ status: "fail", reason: "1 test failed" })
      .mockResolvedValue({ status: "pass", reason: "suite passed" });
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      deps: {
        checkTestCert: async () => ({ status: "pass" }),
        verifyTestRun: verifyTestRun as unknown as Deps["verifyTestRun"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(count(captured, isFixer)).toBe(1);
    expect(verifyTestRun).toHaveBeenCalledTimes(2);
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  it("a builder whose diff deletes a test is handed to the fixer, not stopped — the fixer puts the test back and the ticket ships", async () => {
    const ISSUE = 93406;
    const testRel = "packages/api/src/deal-total.test.ts";
    mkdirSync(path.join(repo, "packages/api/src"), { recursive: true });
    writeFileSync(path.join(repo, testRel), "it('x', () => {});\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "an existing test");
    const branch = start(ISSUE);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: {
        implementer: () => {
          rmSync(path.join(repo, testRel));
          writeFileSync(path.join(repo, "packages/api/src/deal-total.ts"), "export {};\n");
          git(repo, "add", "-A");
          git(repo, "commit", "-q", "-m", "feat: work, and a deleted test");
          return IMPLEMENTER_STORY_COMPLETE;
        },
        fixer: () => {
          git(repo, "checkout", "HEAD~1", "--", testRel);
          git(repo, "commit", "-q", "-m", "fix: put the test back");
          return IMPLEMENTER_STORY_COMPLETE;
        },
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(count(captured, isFixer)).toBe(1);
    expect(captured.stops).toEqual([]);
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  it("a fixer refused through its third round ends the attempt: one stop, recorded on the retry budget, never a second fixer", async () => {
    const ISSUE = 93404;
    const branch = start(ISSUE);
    const recordRetryAttempt = vi.fn(async (_issue: number, _attempt: unknown) => ({
      decision: { action: "retry" },
    }));
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: {
        implementer: new Error(IMPLEMENTER_HARD_CEILING_MESSAGE),
        "fixer-reviewer": [ROUND_1, ROUND_2_FRESH, ROUND_3],
      },
      deps: {
        recordRetryAttempt: recordRetryAttempt as unknown as Deps["recordRetryAttempt"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([]);
    expect(count(captured, isFixer)).toBe(3);
    expect(count(captured, isFixerReview)).toBe(3);
    expect(captured.quarantines).toHaveLength(1);
    expect(captured.stops.map((s) => s.label)).toEqual(["stopped:reviewer-refused"]);
    expect(recordRetryAttempt).toHaveBeenCalledTimes(1);
    expect(recordRetryAttempt.mock.calls[0]?.[1]).toMatchObject({
      note: "stopped:reviewer-refused",
    });
  });

  it("a fixer that fails saves its work to the ticket's saved-work ref — whether it crashed or its reviewer refused it to the end", async () => {
    for (const [ISSUE, fixerAnswers] of [
      [93408, { fixer: new Error('hard ceiling: sandbox run "fixer" exceeded 3600s wall-clock') }],
      [93409, { "fixer-reviewer": [ROUND_1, ROUND_2_FRESH, ROUND_3] }],
    ] as const) {
      const branch = start(ISSUE);
      const saved: { wt: string; issue: number }[] = [];
      const { deps } = scriptedRun({
        issueNumber: ISSUE,
        branch,
        worktreePath: repo,
        answers: { implementer: new Error(IMPLEMENTER_HARD_CEILING_MESSAGE), ...fixerAnswers },
        deps: {
          saveFailedWork: async (wt: string, issue: number) => {
            saved.push({ wt, issue });
            return { saved: true, detail: "pinned" };
          },
        },
      });

      const result = await runMain(
        makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
        deps,
      );

      expect(result.shippedIssues).toEqual([]);
      expect(saved).toEqual([{ wt: repo, issue: ISSUE }]);
      git(repo, "checkout", "-q", "main");
    }
  });

  it("a blocker that recurs across the fixer's first two rounds is denied a third, exactly as the builder's would be", async () => {
    const ISSUE = 93405;
    const branch = start(ISSUE);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: {
        implementer: new Error(IMPLEMENTER_HARD_CEILING_MESSAGE),
        "fixer-reviewer": [ROUND_1, ROUND_2_RECURRING, "ALL_CLEAR"],
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1, recoveryEnabled: true }),
      deps,
    );

    expect(result.shippedIssues).toEqual([]);
    expect(count(captured, isFixer)).toBe(2);
    expect(count(captured, isFixerReview)).toBe(2);
    expect(captured.stops.map((s) => s.label)).toEqual(["stopped:reviewer-refused"]);
  });
});

describe("work that is already built goes to review (spec #1334, SG)", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-already-built-"));
  });

  afterEach(() => {
    cleanup();
  });

  function start(issueNumber: number): string {
    const branch = `agent/issue-${issueNumber}`;
    git(repo, "checkout", "-q", "-b", branch);
    return branch;
  }

  it("finished saved work resumed from a checkpoint goes straight to review and ships, labelled no first test — no builder, no owner", async () => {
    const ISSUE = 93410;
    const branch = start(ISSUE);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      resumedFromCheckpoint: true,
      answers: { "check-writer": alreadyBuiltEnvelope() },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1 }),
      deps,
    );

    expect(count(captured, isBuilder)).toBe(0);
    expect(count(captured, isReviewer)).toBe(1);
    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(captured.shippedWithoutFirstTest).toEqual([ISSUE]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
  });

  it("a ticket whose change is already on main is confirmed by the reviewer and closed as done — never handed to the owner", async () => {
    const ISSUE = 93411;
    const branch = start(ISSUE);
    const markDone = vi.fn(async (_issue: number, _summary: string) => undefined);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: { "check-writer": alreadyBuiltEnvelope() },
      deps: {
        markDone,
        locateAlreadyBuiltWork: async () => ({ onMain: true, onStaging: false }),
      },
    });

    await runMain(makeArgs({ repoRoot: repo, branch, iterations: 1 }), deps);

    expect(count(captured, isBuilder)).toBe(0);
    expect(count(captured, isReviewer)).toBe(1);
    expect(markDone).toHaveBeenCalledTimes(1);
    expect(markDone.mock.calls[0]?.[0]).toBe(ISSUE);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
  });

  it("an 'already built' claim the reviewer refutes is built by the builder's next round, and ships", async () => {
    const ISSUE = 93412;
    const branch = start(ISSUE);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      answers: {
        "check-writer": alreadyBuiltEnvelope(),
        reviewer: [ROUND_1, "built now\nALL_CLEAR"],
      },
      deps: {
        locateAlreadyBuiltWork: async () => ({ onMain: true, onStaging: false }),
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1 }),
      deps,
    );

    expect(count(captured, isBuilder)).toBe(1);
    expect(count(captured, isReviewer)).toBe(2);
    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
  });
});

describe("a resumed ticket owns the check folders its saved work created (#1361)", () => {
  // The 2026-10-13 shape: #1311 resumed from its checkpoint, the test-writer
  // answered ALREADY_BUILT, and the ship gate read #1311's OWN committed
  // `must-fail-first-proof.json` as another ticket's locked test.
  const RUN_BRANCH = "sandcastle/resume-run";
  /** #1058's receipt — another ticket's, already on the run branch. */
  const OLDER_RECEIPT =
    "packages/api/src/__checks__/issue-1058/must-fail-first-proof.json";
  let repo: string;
  let wt: string;
  let wtParent: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-resume-own-"));
    mkdirSync(path.join(repo, path.dirname(OLDER_RECEIPT)), { recursive: true });
    writeFileSync(path.join(repo, OLDER_RECEIPT), "{}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "an older ticket's check");
    git(repo, "checkout", "-q", "-b", RUN_BRANCH);
    wtParent = mkdtempSync(path.join(tmpdir(), "sc-resume-own-wt-"));
    wt = path.join(wtParent, "agent");
  });

  afterEach(() => {
    cleanup();
    rmSync(wtParent, { recursive: true, force: true });
  });

  /** The ticket's saved work: committed on its own branch BEFORE this run,
   *  the way a `/sandcastle-stop --now` checkpoint leaves it. */
  function savedWork(issue: number, files: Record<string, string>): string {
    const branch = `agent/issue-${issue}`;
    git(repo, "worktree", "add", "-q", "-b", branch, wt, RUN_BRANCH);
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(path.join(wt, path.dirname(p)), { recursive: true });
      writeFileSync(path.join(wt, p), body);
    }
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "saved work");
    return branch;
  }

  async function resume(issue: number, branch: string) {
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch,
      worktreePath: wt,
      resumedFromCheckpoint: true,
      answers: { "check-writer": alreadyBuiltEnvelope() },
    });
    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: RUN_BRANCH, iterations: 1 }),
      deps,
    );
    return { result, captured };
  }

  it("a resumed ticket with its own committed check folder, answered ALREADY_BUILT, ships", async () => {
    const ISSUE = 1311;
    const branch = savedWork(ISSUE, {
      [`packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`]:
        '{"red":true}\n',
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });

    const { result, captured } = await resume(ISSUE, branch);

    expect(captured.logs.join("\n")).not.toContain(
      "check-writer-locked-check-touched",
    );
    expect(count(captured, isFixer)).toBe(0);
    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(captured.stops).toEqual([]);
  });

  it("a resumed ticket whose builder rewrites its SAVED first test does not ship that rewrite — the saved bytes are restored", async () => {
    // Owning the saved folder must not unlock it: the saved first test is the
    // instrument the ticket is judged by, so this run's edit to it is undone
    // by the protected-path restore and the saved bytes are what ship.
    const ISSUE = 1314;
    const SAVED_RECEIPT = `packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`;
    const SAVED_BYTES = '{"red":true}\n';
    const branch = savedWork(ISSUE, {
      [SAVED_RECEIPT]: SAVED_BYTES,
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });
    // The reviewer refutes "already built", so a builder runs — and that
    // builder rewrites the saved first test and commits it.
    const builderRewritesSavedTest = (): string => {
      writeFileSync(path.join(wt, SAVED_RECEIPT), '{"red":false}\n');
      writeFileSync(
        path.join(wt, "packages/api/src/services/access-log.ts"),
        "export const logAccessChange = (): number => 1;\n",
      );
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "builder work");
      return IMPLEMENTER_STORY_COMPLETE;
    };
    const errors: string[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: wt,
      resumedFromCheckpoint: true,
      answers: {
        "check-writer": alreadyBuiltEnvelope(),
        reviewer: [ROUND_1, "built now\nALL_CLEAR"],
        implementer: builderRewritesSavedTest,
      },
      deps: { logError: (line: string) => void errors.push(line) },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: RUN_BRANCH, iterations: 1 }),
      deps,
    );

    // POSITIVE CONTROL FIRST: the builder really did run and touch the file.
    expect(count(captured, isBuilder)).toBe(1);
    const tamper = errors.filter((l) => l.includes("protected-paths-tampered"));
    expect(tamper.length).toBeGreaterThan(0);
    expect(tamper.some((l) => l.includes(SAVED_RECEIPT))).toBe(true);
    // The rewrite never ships: whatever this ticket's branch ends on carries
    // the SAVED bytes, not the builder's.
    expect(git(wt, "show", `HEAD:${SAVED_RECEIPT}`) + "\n").toBe(SAVED_BYTES);
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  it("a resumed ticket that edits ANOTHER ticket's check folder is still refused, naming that folder only", async () => {
    const ISSUE = 1312;
    const branch = savedWork(ISSUE, {
      [`packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`]:
        '{"red":true}\n',
      [OLDER_RECEIPT]: '{"edited":true}\n',
    });

    const { result, captured } = await resume(ISSUE, branch);

    expect(result.shippedIssues).toEqual([]);
    const refusals = captured.logs.filter((l) =>
      l.includes("check-writer-locked-check-touched"),
    );
    // POSITIVE CONTROL FIRST: the refusal fired at all.
    expect(refusals.length).toBeGreaterThan(0);
    for (const line of refusals) {
      expect(line).toContain(OLDER_RECEIPT);
      expect(line).not.toContain(`issue-${ISSUE}/`);
    }
  });

  it("a ticket's own-number check folder from an EARLIER shipped run stays locked (#972 gap 5)", async () => {
    // An earlier run already shipped #1313's first test onto the run branch.
    // Owning a folder because it carries this ticket's number would let a
    // re-dispatched #1313 rewrite that locked test unchecked.
    const ISSUE = 1313;
    const SHIPPED_RECEIPT = `packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`;
    mkdirSync(path.join(repo, path.dirname(SHIPPED_RECEIPT)), {
      recursive: true,
    });
    writeFileSync(path.join(repo, SHIPPED_RECEIPT), '{"red":true}\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "an earlier run shipped this ticket's check");
    const branch = savedWork(ISSUE, {
      [SHIPPED_RECEIPT]: '{"red":false}\n',
    });

    const { result, captured } = await resume(ISSUE, branch);

    const refusals = captured.logs.filter((l) =>
      l.includes("check-writer-locked-check-touched"),
    );
    // POSITIVE CONTROL FIRST: the refusal fired at all.
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.some((l) => l.includes(SHIPPED_RECEIPT))).toBe(true);
    expect(result.shippedIssues).toEqual([]);
  });

  it("a resumed ticket whose builder COMMITS a deletion of its saved first test gets the saved test back, and ships", async () => {
    // The deleted file stands neither at the run branch's fork point nor at
    // the shipped tip, so a lock that reads only that diff never sees it.
    const ISSUE = 1315;
    const SAVED_RECEIPT = `packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`;
    const SAVED_BYTES = '{"red":true}\n';
    const branch = savedWork(ISSUE, {
      [SAVED_RECEIPT]: SAVED_BYTES,
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });
    const builderDeletesSavedTest = (): string => {
      git(wt, "rm", "-q", SAVED_RECEIPT);
      writeFileSync(
        path.join(wt, "packages/api/src/services/access-log.ts"),
        "export const logAccessChange = (): number => 1;\n",
      );
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "builder work");
      return IMPLEMENTER_STORY_COMPLETE;
    };
    const errors: string[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: wt,
      resumedFromCheckpoint: true,
      answers: {
        "check-writer": alreadyBuiltEnvelope(),
        reviewer: [ROUND_1, "built now\nALL_CLEAR"],
        implementer: builderDeletesSavedTest,
      },
      deps: { logError: (line: string) => void errors.push(line) },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: RUN_BRANCH, iterations: 1 }),
      deps,
    );

    // POSITIVE CONTROL FIRST: the builder really did run and delete the file.
    expect(count(captured, isBuilder)).toBe(1);
    const tamper = errors.filter((l) => l.includes("protected-paths-tampered"));
    expect(tamper.some((l) => l.includes(SAVED_RECEIPT))).toBe(true);
    expect(git(wt, "show", `HEAD:${SAVED_RECEIPT}`) + "\n").toBe(SAVED_BYTES);
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  /** A resumed ticket whose reviewer refutes "already built", so `builder`
   *  runs once on top of the saved work. */
  async function resumeWithBuilder(
    issue: number,
    branch: string,
    builder: () => string,
    extraDeps: Partial<Deps> = {},
  ) {
    const errors: string[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: issue,
      branch,
      worktreePath: wt,
      resumedFromCheckpoint: true,
      answers: {
        "check-writer": alreadyBuiltEnvelope(),
        reviewer: [ROUND_1, "built now\nALL_CLEAR"],
        implementer: builder,
      },
      deps: { logError: (line: string) => void errors.push(line), ...extraDeps },
    });
    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: RUN_BRANCH, iterations: 1 }),
      deps,
    );
    return { result, captured, errors };
  }

  it("a resumed ticket whose builder COMMITS a rename of its saved first test OUT of the locked folder gets the saved test back", async () => {
    // With git's rename detection on, a moved file lists only its NEW path,
    // which sits outside the lock — so the old path escaped it.
    const ISSUE = 1318;
    const SAVED_RECEIPT = `packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`;
    const MOVED_TO = "packages/api/src/moved-proof.json";
    const SAVED_BYTES = '{"red":true}\n';
    const branch = savedWork(ISSUE, {
      [SAVED_RECEIPT]: SAVED_BYTES,
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });
    const { result, captured, errors } = await resumeWithBuilder(ISSUE, branch, () => {
      git(wt, "mv", SAVED_RECEIPT, MOVED_TO);
      git(wt, "commit", "-q", "-m", "builder work");
      return IMPLEMENTER_STORY_COMPLETE;
    });

    // POSITIVE CONTROL FIRST: the builder really did run and move the file.
    expect(count(captured, isBuilder)).toBe(1);
    const tamper = errors.filter((l) => l.includes("protected-paths-tampered"));
    expect(tamper.some((l) => l.includes(SAVED_RECEIPT))).toBe(true);
    expect(git(wt, "show", `HEAD:${SAVED_RECEIPT}`) + "\n").toBe(SAVED_BYTES);
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  it("a resumed ticket whose builder COMMITS a rename of its saved first test WITHIN the locked folder gets the original back and the new name removed", async () => {
    const ISSUE = 1319;
    const DIR = `packages/api/src/__checks__/issue-${ISSUE}`;
    const SAVED_RECEIPT = `${DIR}/must-fail-first-proof.json`;
    const RENAMED = `${DIR}/renamed-proof.json`;
    const SAVED_BYTES = '{"red":true}\n';
    const branch = savedWork(ISSUE, {
      [SAVED_RECEIPT]: SAVED_BYTES,
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });
    const { result, captured, errors } = await resumeWithBuilder(ISSUE, branch, () => {
      git(wt, "mv", SAVED_RECEIPT, RENAMED);
      git(wt, "commit", "-q", "-m", "builder work");
      return IMPLEMENTER_STORY_COMPLETE;
    });

    // POSITIVE CONTROL FIRST: the builder really did run and rename the file.
    expect(count(captured, isBuilder)).toBe(1);
    const tamper = errors.filter((l) => l.includes("protected-paths-tampered"));
    expect(tamper.some((l) => l.includes(SAVED_RECEIPT))).toBe(true);
    expect(git(wt, "show", `HEAD:${SAVED_RECEIPT}`) + "\n").toBe(SAVED_BYTES);
    expect(git(wt, "ls-tree", "--name-only", "HEAD", "--", RENAMED)).toBe("");
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  it("a resumed ticket whose builder deletes its saved first test has the RESTORED test re-run at ship", async () => {
    // A deleted saved test that was failing would otherwise ship back red
    // unrun, and the run-end gate would then block the whole run.
    const ISSUE = 1320;
    const SAVED_TEST = `packages/billing/src/__checks__/issue-${ISSUE}/fee.test.ts`;
    const branch = savedWork(ISSUE, {
      [SAVED_TEST]: `it("charges the fee", () => {});\n`,
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });
    const verifyTestRun = vi.fn(async () => ({
      status: "pass" as const,
      reason: "stub suite passed",
    }));
    const { captured } = await resumeWithBuilder(
      ISSUE,
      branch,
      () => {
        git(wt, "rm", "-q", SAVED_TEST);
        git(wt, "commit", "-q", "-m", "builder work");
        return IMPLEMENTER_STORY_COMPLETE;
      },
      {
        checkTestCert: async () => ({ status: "pass" }),
        verifyTestRun: verifyTestRun as unknown as Deps["verifyTestRun"],
      },
    );

    // POSITIVE CONTROL FIRST: the builder ran and the ship gate ran tests.
    expect(count(captured, isBuilder)).toBe(1);
    expect(verifyTestRun).toHaveBeenCalled();
    const scopes = verifyTestRun.mock.calls.map(
      (call) => (call as unknown as [unknown, readonly string[]])[1],
    );
    expect(scopes.some((files) => files.includes(SAVED_TEST))).toBe(true);
  });

  it("a resumed ticket whose saved work holds TWO own check folders (a browser AND a unit one, as #1310 had) ships", async () => {
    const ISSUE = 1310;
    const branch = savedWork(ISSUE, {
      [`packages/api/src/__checks__/issue-${ISSUE}/must-fail-first-proof.json`]:
        '{"red":true}\n',
      [`apps/nextjs/e2e/checks/issue-${ISSUE}/must-fail-first-proof.json`]:
        '{"red":true}\n',
      "packages/api/src/services/access-log.ts":
        "export const logAccessChange = (): void => undefined;\n",
    });

    const { result, captured } = await resume(ISSUE, branch);

    expect(captured.logs.join("\n")).not.toContain(
      "check-writer-locked-check-touched",
    );
    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(captured.stops).toEqual([]);
  });

  it("a FRESH ticket whose builder COMMITS a deletion of its locked first test gets the test back", async () => {
    // Forked from the run branch, the check-writer's commit sits after the
    // fork point, so the deleted test is absent at both ends of the ship
    // diff — the same hole a resumed ticket had.
    const ISSUE = 1317;
    const CHECK_FILE = "total-is-right.test.ts";
    const CHECK = `${unitCheckDirFor("packages/api", ISSUE)}/${CHECK_FILE}`;
    const CHECK_BYTES =
      `import { expect, it } from "vitest";\n` +
      `import { dealTotal } from "../../services/deal-total.js";\n` +
      `it("counts each Agent once", () => { expect(dealTotal()).toBe(1000); });\n`;
    mkdirSync(path.join(repo, "packages/api"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages/api/package.json"),
      JSON.stringify({ name: "@acme/api", scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(repo, "packages/api/vitest.config.ts"), "export default {};\n");
    mkdirSync(path.join(repo, "tooling/vitest"), { recursive: true });
    writeFileSync(path.join(repo, "tooling/vitest/base.ts"), "export default {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "package");
    const branch = `agent/issue-${ISSUE}`;
    git(repo, "worktree", "add", "-q", "-b", branch, wt, RUN_BRANCH);
    const writesUnitCheck = (): string => {
      mkdirSync(path.join(wt, path.dirname(CHECK)), { recursive: true });
      writeFileSync(path.join(wt, CHECK), CHECK_BYTES);
      return [
        "reasoning about the ticket",
        "```json",
        JSON.stringify({
          marker: "UNIT_CHECK_WRITTEN",
          inherited: false,
          checkPackage: "packages/api",
          checkPath: CHECK_FILE,
        }),
        "```",
        "",
        "UNIT_CHECK_WRITTEN",
      ].join("\n");
    };
    const builderDeletesTest = (): string => {
      git(wt, "rm", "-q", CHECK);
      writeFileSync(path.join(wt, "packages/api/deal-total.ts"), "export const x = 1;\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "builder work");
      return IMPLEMENTER_STORY_COMPLETE;
    };
    const errors: string[] = [];
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: wt,
      exec: checkRunExecSequence([RED_RUN, GREEN_RUN]),
      answers: {
        "check-writer": writesUnitCheck,
        implementer: builderDeletesTest,
      },
      deps: { logError: (line: string) => void errors.push(line) },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: RUN_BRANCH, iterations: 1 }),
      deps,
    );

    // POSITIVE CONTROL FIRST: the builder really did run and delete the test.
    expect(count(captured, isBuilder)).toBe(1);
    const tamper = errors.filter((l) => l.includes("protected-paths-tampered"));
    expect(tamper.some((l) => l.includes(CHECK))).toBe(true);
    expect(git(wt, "show", `HEAD:${CHECK}`) + "\n").toBe(CHECK_BYTES);
    expect(result.shippedIssues).toEqual([ISSUE]);
  });

  it("a FRESH ticket whose builder creates a second issue-<N> check folder is refused, as before #1361", async () => {
    // A fresh ticket owns only the folder its check-writer created and
    // locked. A second folder carrying its number is the builder's own
    // writing in a locked place, and is refused.
    const ISSUE = 1316;
    const CHECK_FILE = "total-is-right.test.ts";
    const SECOND = `apps/nextjs/e2e/checks/issue-${ISSUE}/extra.spec.ts`;
    mkdirSync(path.join(repo, "packages/api"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages/api/package.json"),
      JSON.stringify({ name: "@acme/api", scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(repo, "packages/api/vitest.config.ts"), "export default {};\n");
    mkdirSync(path.join(repo, "tooling/vitest"), { recursive: true });
    writeFileSync(path.join(repo, "tooling/vitest/base.ts"), "export default {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "package");
    const writesUnitCheck = (): string => {
      const dir = path.join(repo, unitCheckDirFor("packages/api", ISSUE));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, CHECK_FILE),
        `import { expect, it } from "vitest";\n` +
          `import { dealTotal } from "../../services/deal-total.js";\n` +
          `it("counts each Agent once", () => { expect(dealTotal()).toBe(1000); });\n`,
      );
      return [
        "reasoning about the ticket",
        "```json",
        JSON.stringify({
          marker: "UNIT_CHECK_WRITTEN",
          inherited: false,
          checkPackage: "packages/api",
          checkPath: CHECK_FILE,
        }),
        "```",
        "",
        "UNIT_CHECK_WRITTEN",
      ].join("\n");
    };
    const builderWritesSecondFolder = (): string => {
      mkdirSync(path.join(repo, path.dirname(SECOND)), { recursive: true });
      writeFileSync(path.join(repo, SECOND), "// the builder's own test\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "builder work");
      return IMPLEMENTER_STORY_COMPLETE;
    };
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch: RUN_BRANCH,
      worktreePath: repo,
      exec: checkRunExecSequence([RED_RUN, GREEN_RUN]),
      answers: {
        "check-writer": writesUnitCheck,
        implementer: builderWritesSecondFolder,
      },
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: RUN_BRANCH, iterations: 1 }),
      deps,
    );

    const refusals = captured.logs.filter((l) =>
      l.includes("check-writer-locked-check-touched"),
    );
    // POSITIVE CONTROL FIRST: the refusal fired at all.
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.some((l) => l.includes(SECOND))).toBe(true);
    expect(result.shippedIssues).toEqual([]);
  });
});

describe("a skipped tool run never stops a ticket (spec #1334, SG)", () => {
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-skills-"));
    writeFileSync(
      path.join(repo, "SANDCASTLE.md"),
      ["### type:feature", "", "Required:", "", "- impeccable", "", "Opt in via `tool:` labels."].join(
        "\n",
      ),
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("a builder that recorded no required Skill() run still reaches review and ships", async () => {
    const ISSUE = 93420;
    const branch = `agent/issue-${ISSUE}`;
    git(repo, "checkout", "-q", "-b", branch);
    const { deps, captured } = scriptedRun({
      issueNumber: ISSUE,
      branch,
      worktreePath: repo,
      labels: ["ready-for-agent", "type:feature"],
    });

    const result = await runMain(
      makeArgs({ repoRoot: repo, branch, iterations: 1 }),
      deps,
    );

    expect(count(captured, isReviewer)).toBe(1);
    expect(result.shippedIssues).toEqual([ISSUE]);
    expect(captured.quarantines).toEqual([]);
    expect(captured.stops).toEqual([]);
  });

  it("no prompt tells an agent that a missing tool-run record stops or refuses a ticket", () => {
    const read = (f: string): string => readFileSync(path.join(HERE, f), "utf8");
    expect(read("review-prompt.md")).not.toContain("A missing Required tool is a HARD finding");
    const implement = read("implement-prompt.md");
    expect(implement).not.toContain("MissingRequiredSkillsError");
    expect(implement).not.toContain("skill-discipline-fail");
    expect(implement).not.toContain("re-quarantine");
    expect(read("post-merge-review-prompt.md")).not.toMatch(
      /missing Required tool[\s\S]{0,200}HAS_BLOCKERS/,
    );
    expect(read("post-merge-fix-prompt.md")).not.toContain("re-quarantine");
  });
});
