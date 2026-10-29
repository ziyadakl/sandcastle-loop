/**
 * Spec #1334, slice SH: the builder or the fixer may edit an OLDER ticket's
 * test only when all four hold —
 *
 *   1. the loop ran the ORIGINAL older test against the new code and saw it
 *      fail;
 *   2. the edit stays inside that one test file;
 *   3. the file's test-case count is unchanged;
 *   4. no skip / only / todo / skipIf / runIf was added.
 *
 * The check runs at the ship gate (`verifyOlderTestEdits` in `main.mts`).
 * There is no repair road and no judge: whoever made the edit made it on the
 * ordinary path. A refused edit goes to the fixer like any failed ship-time
 * check; an allowed one ships and is recorded on the older ticket.
 *
 * Every case drives the REAL `runMain` with scripted agents against a real
 * temp git checkout and asserts only what the run produced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GREEN_RUN,
  RED_RUN,
  checkRunExecSequence,
} from "./__fixtures__/check-evidence.js";
import { git } from "./__fixtures__/git-repo.js";
import {
  IMPLEMENTER_STORY_COMPLETE,
  initRepoWithOrigin,
  makeArgs,
  scriptedRun,
} from "./__fixtures__/scripted-run.mts";
import type { SandboxCommandRunner } from "./lib/sandbox-exec.js";
import type { Deps } from "./main.mts";
import { runMain } from "./main.mts";

/** #1058's check — the real file from the 2026-09-10 #1235 refusal. */
const OLDER_TEST =
  "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts";
const OLDER_RECEIPT =
  "packages/api/src/__checks__/issue-1058/must-fail-first-proof.json";

const ORIGINAL =
  `import { expect, it } from "vitest";\n` +
  `import { relist } from "../../services/relist.js";\n` +
  `it("allows a relist at another address", () => { expect(relist("b")).toBe(true); });\n` +
  `it("allows a relist at the same address", () => { expect(relist("a")).toBe(true); });\n`;
const AMENDED =
  `import { expect, it } from "vitest";\n` +
  `import { relist } from "../../services/relist.js";\n` +
  `it("refuses a relist at another address", () => { expect(relist("b")).toBe(false); });\n` +
  `it("allows a relist at the same address", () => { expect(relist("a")).toBe(true); });\n`;
const SKIPPED =
  `import { expect, it } from "vitest";\n` +
  `import { relist } from "../../services/relist.js";\n` +
  `it.skip("allows a relist at another address", () => { expect(relist("b")).toBe(true); });\n` +
  `it("allows a relist at the same address", () => { expect(relist("a")).toBe(true); });\n`;
const SKIPPED_IF =
  `import { expect, it } from "vitest";\n` +
  `import { relist } from "../../services/relist.js";\n` +
  `it.skipIf(true)("allows a relist at another address", () => { expect(relist("b")).toBe(true); });\n` +
  `it("allows a relist at the same address", () => { expect(relist("a")).toBe(true); });\n`;

describe("spec #1334 SH — an older ticket's test may be edited only under the four rules", () => {
  let repo: string;
  let wt: string;
  let wtParent: string;
  let cleanup: () => void;
  const BRANCH = "sandcastle/sh-run";

  beforeEach(() => {
    ({ repo, cleanup } = initRepoWithOrigin("sc-sh-"));
    mkdirSync(path.join(repo, "packages/api/src/services"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages/api/package.json"),
      JSON.stringify({ name: "@acme/api", scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(repo, "packages/api/vitest.config.ts"), "export default {};\n");
    writeFileSync(
      path.join(repo, "packages/api/src/services/relist.ts"),
      "export const relist = (_a: string): boolean => true;\n",
    );
    mkdirSync(path.join(repo, path.dirname(OLDER_TEST)), { recursive: true });
    writeFileSync(path.join(repo, OLDER_TEST), ORIGINAL);
    writeFileSync(path.join(repo, OLDER_RECEIPT), "{}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "older ticket's test");
    git(repo, "checkout", "-q", "-b", BRANCH);
    wtParent = mkdtempSync(path.join(tmpdir(), "sc-sh-wt-"));
    wt = path.join(wtParent, "agent");
    git(repo, "worktree", "add", "-q", "-b", "agent/sh", wt, BRANCH);
  });

  afterEach(() => {
    cleanup();
    rmSync(wtParent, { recursive: true, force: true });
  });

  /** The builder changes the rule and writes `olderTest` over the older
   *  ticket's test (plus any extra files), then commits. */
  function builderEdits(olderTest: string, extra: Record<string, string> = {}) {
    return () => {
      writeFileSync(
        path.join(wt, "packages/api/src/services/relist.ts"),
        "export const relist = (a: string): boolean => a === \"a\";\n",
      );
      writeFileSync(path.join(wt, OLDER_TEST), olderTest);
      for (const [p, body] of Object.entries(extra)) {
        writeFileSync(path.join(wt, p), body);
      }
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "feat: refuse a relist at another address");
      return IMPLEMENTER_STORY_COMPLETE;
    };
  }

  /** An exec fake that counts its calls. */
  function countingExec(runs: Parameters<typeof checkRunExecSequence>[0]) {
    const inner = checkRunExecSequence(runs);
    const calls = { n: 0 };
    const exec: SandboxCommandRunner = async (command, opts) => {
      calls.n += 1;
      return inner(command, opts);
    };
    return { exec, calls };
  }

  function recorder() {
    const amended: { sibling: number; by: number; section: string }[] = [];
    const labelled: number[] = [];
    const dep: Partial<Deps> = {
      applyOlderTestEditRecord: (async (sibling: number, by: number, section: string) => {
        amended.push({ sibling, by, section });
        return "written";
      }) as unknown as Deps["applyOlderTestEditRecord"],
      markShippedWithOlderTestEdit: async (n: number) => {
        labelled.push(n);
      },
    };
    return { amended, labelled, dep };
  }

  async function run(opts: {
    readonly issue: number;
    readonly olderTest: string;
    readonly extra?: Record<string, string>;
    readonly exec: SandboxCommandRunner;
    readonly deps: Partial<Deps>;
  }) {
    const { deps, captured } = scriptedRun({
      issueNumber: opts.issue,
      branch: "agent/sh",
      worktreePath: wt,
      exec: opts.exec,
      answers: {
        implementer: builderEdits(opts.olderTest, opts.extra),
        // The fixer, when the edit is refused, changes nothing further.
        fixer: IMPLEMENTER_STORY_COMPLETE,
      },
      deps: opts.deps,
    });
    const result = await runMain(
      makeArgs({ repoRoot: repo, branch: BRANCH, iterations: 1, recoveryEnabled: true }),
      deps,
    );
    return { result, captured };
  }

  it("an allowed edit ships: the original older test FAILED on the new code, the amended one passes, and the edit is recorded on the older ticket", async () => {
    const rec = recorder();
    const { exec } = countingExec([RED_RUN, GREEN_RUN]);
    const { result, captured } = await run({
      issue: 1235,
      olderTest: AMENDED,
      exec,
      deps: rec.dep,
    });

    expect(result.shippedIssues).toEqual([1235]);
    expect(captured.stops).toEqual([]);
    expect(captured.specs.some((n) => n.startsWith("fixer"))).toBe(false);
    expect(rec.labelled).toEqual([1235]);
    expect(rec.amended).toHaveLength(1);
    expect(rec.amended[0]!.sibling).toBe(1058);
    expect(rec.amended[0]!.by).toBe(1235);
    expect(rec.amended[0]!.section).toContain(OLDER_TEST);
  });

  it.each([
    [
      2001,
      "names",
      `Refuse a relist at another address. Update ${OLDER_TEST} to match.\n\nTarget: subject exists`,
      "(named in the ticket)",
    ],
    [
      2002,
      "does not name",
      "Refuse a relist at another address.\n\nTarget: subject exists",
      "(NOT named in the ticket — check this one)",
    ],
  ] as const)(
    // Each case its own issue number: the claim-time body is pinned per issue
    // for the life of the process (#958), so reusing one would read the
    // previous case's body.
    "#%i: the run's pull request report lists the older-test edit and says the ticket %s that file — shown, never refused",
    async (issue, _name, body, expected) => {
      const rec = recorder();
      const reports: string[] = [];
      const { exec } = countingExec([RED_RUN, GREEN_RUN]);
      const { result } = await run({
        issue,
        olderTest: AMENDED,
        exec,
        deps: {
          ...rec.dep,
          getIssueBody: async () => body,
          openRunPr: async (_branch, _shipped, opts) => {
            if (opts?.report !== undefined) reports.push(opts.report);
            return { url: "https://example.invalid/pr/1" };
          },
        },
      });

      expect(result.shippedIssues).toEqual([issue]);
      expect(reports.at(-1)).toContain(
        `#${issue} scripted fixture ${issue} edited an older test: ${OLDER_TEST} ${expected}`,
      );
    },
  );

  it("an edit to a PASSING older test is refused and goes to the fixer — nothing shows the older test was failing", async () => {
    const rec = recorder();
    // The original older test passes on the new code.
    const { exec } = countingExec([GREEN_RUN]);
    const { result, captured } = await run({
      issue: 1236,
      olderTest: AMENDED,
      exec,
      deps: rec.dep,
    });

    expect(result.shippedIssues).toEqual([]);
    expect(captured.specs.some((n) => n.startsWith("fixer"))).toBe(true);
    expect(captured.logs.join("\n")).toMatch(
      /check-writer-locked-check-touched[\s\S]*issue-1058/,
    );
    expect(rec.labelled).toEqual([]);
    expect(rec.amended).toEqual([]);
  });

  it.each([
    ["it.skip(", SKIPPED],
    ["it.skipIf(", SKIPPED_IF],
  ])("an edit that adds %s is refused before any test is run", async (_name, body) => {
    const rec = recorder();
    const { exec, calls } = countingExec([RED_RUN, GREEN_RUN]);
    const { result, captured } = await run({
      issue: 1237,
      olderTest: body,
      exec,
      deps: rec.dep,
    });

    expect(result.shippedIssues).toEqual([]);
    expect(calls.n).toBe(0);
    expect(captured.specs.some((n) => n.startsWith("fixer"))).toBe(true);
    expect(rec.labelled).toEqual([]);
  });

  it("an edit that also touches the older ticket's proof receipt is refused, naming the receipt (#1328's shape)", async () => {
    const rec = recorder();
    const { exec, calls } = countingExec([RED_RUN, GREEN_RUN]);
    const { result, captured } = await run({
      issue: 1238,
      olderTest: AMENDED,
      extra: { [OLDER_RECEIPT]: '{"edited":true}\n' },
      exec,
      deps: rec.dep,
    });

    expect(result.shippedIssues).toEqual([]);
    expect(calls.n).toBe(0);
    expect(captured.logs.join("\n")).toContain(OLDER_RECEIPT);
  });

  it("an edit to a 17-scenario older test is ACCEPTED — a long test file is never refused for the time its worst case could take (#1310, #1366)", async () => {
    // 17 scenarios scale a unit check's window to 2_160_000 ms, so the
    // deleted worst-case pre-check (2 x that > one hour) used to refuse this
    // before running anything; the real runs take seconds.
    const filler = Array.from(
      { length: 15 },
      (_, i) =>
        `it("allows a relist at the same address (${i})", () => { expect(relist("a")).toBe(true); });\n`,
    ).join("");
    const head = `import { expect, it } from "vitest";\nimport { relist } from "../../services/relist.js";\n`;
    const many = (first: string) =>
      head +
      first +
      `it("allows a relist at the same address", () => { expect(relist("a")).toBe(true); });\n` +
      filler;
    const original = many(
      `it("allows a relist at another address", () => { expect(relist("b")).toBe(true); });\n`,
    );
    const amended = many(
      `it("refuses a relist at another address", () => { expect(relist("b")).toBe(false); });\n`,
    );
    writeFileSync(path.join(repo, OLDER_TEST), original);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "older ticket's 17-scenario test");
    git(wt, "merge", "-q", "--ff-only", BRANCH);

    const rec = recorder();
    const { exec, calls } = countingExec([RED_RUN, GREEN_RUN]);
    const { result, captured } = await run({
      issue: 1240,
      olderTest: amended,
      exec,
      deps: rec.dep,
    });

    expect(captured.logs.join("\n")).not.toContain("no room left");
    expect(calls.n).toBe(2);
    expect(result.shippedIssues).toEqual([1240]);
    expect(rec.labelled).toEqual([1240]);
  });

  it("an ordinary ticket that touches no older test pays nothing — no test run at all", async () => {
    const { exec, calls } = countingExec([GREEN_RUN]);
    const { result } = await run({
      issue: 1239,
      olderTest: ORIGINAL,
      exec,
      deps: {},
    });

    expect(result.shippedIssues).toEqual([1239]);
    expect(calls.n).toBe(0);
  });
});
