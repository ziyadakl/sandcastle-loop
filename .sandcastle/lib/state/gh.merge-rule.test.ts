/**
 * tokenmaxxing#29: `settleRunPr`, the GitHub-facing half of the merge rule.
 * It waits for the run PR's checks, then merges a small two-way change itself
 * or leaves the PR for the owner, and records which in the PR body.
 *
 * `runGh`, `land`, `sleep` and `now` are injected, so these run with no real
 * `gh` or `git` process, no network and no real waiting.
 *
 * The merge itself is a local fast-forward of the base branch onto the
 * classified commit (`land`), never `gh pr merge`: GitHub mints a server-side
 * merge commit authored as the owner, and agent work must never land under his
 * name (project CLAUDE.md).
 */
import { describe, expect, it } from "vitest";

import { settleRunPr } from "./gh.js";
import { mergeRuleSectionEnd, mergeRuleSectionStart } from "./merge-rule.js";
import { classifyChange } from "./merge-rule.js";
import type { ChangeClass, RollupEntry } from "./merge-rule.js";

const SHA = "335b499f6f93ce8e3f6917ff5a8884ede1d8deab";

const smallChange: ChangeClass = classifyChange({
  files: [{ path: "apps/nextjs/src/app/page.tsx", status: "M", additions: 10, deletions: 2 }],
  issueCount: 1,
  promotionFailed: false,
  breakerTripped: false,
  previouslyShippedCount: 0,
  migrationSql: new Map(),
});
const migrationChange: ChangeClass = classifyChange({
  files: [{ path: "packages/db/migrations/0142_add_wall.sql", status: "A", additions: 5, deletions: 0 }],
  migrationSql: new Map([["packages/db/migrations/0142_add_wall.sql", "ALTER TABLE deals DROP COLUMN wall;"]]),
  issueCount: 1,
  promotionFailed: false,
  breakerTripped: false,
  previouslyShippedCount: 0,
});

const passed = (name: string): RollupEntry => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
});
const running = (name: string): RollupEntry => ({ __typename: "CheckRun", name, status: "IN_PROGRESS", conclusion: null });
const failed = (name: string): RollupEntry => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE" });

/** A fake `gh` that answers `pr view` from a script of rollups (one per poll,
 *  the last one repeating) and records every call. */
function fakeGh(rollups: RollupEntry[][], opts: { headSha?: string; failMerge?: boolean } = {}) {
  const calls: string[][] = [];
  const landed: { sha: string; base: string }[] = [];
  let body = "Run PR body.";
  let poll = 0;
  const runGh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      const rollup = rollups[Math.min(poll, rollups.length - 1)];
      poll += 1;
      return {
        stdout: JSON.stringify({
          number: 7,
          headRefOid: opts.headSha ?? SHA,
          baseRefName: "main",
          body,
          statusCheckRollup: rollup,
        }),
        stderr: "",
      };
    }
    if (args[0] === "pr" && args[1] === "edit") {
      body = args[args.indexOf("--body") + 1]!;
    }
    return { stdout: "", stderr: "" };
  };
  const land = async (sha: string, base: string) => {
    if (opts.failMerge) throw new Error("push to main rejected: not a fast-forward");
    landed.push({ sha, base });
  };
  let clock = 0;
  return {
    calls,
    landed,
    body: () => body,
    deps: {
      runGh,
      land,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

const settings = { branch: "sandcastle/run-1", headSha: SHA, timeoutMs: 10_000, pollMs: 1_000 };

const called = (calls: string[][], verb: string) => calls.filter((c) => c[0] === "pr" && c[1] === verb);

describe("settleRunPr", () => {
  it("lands a small two-way change locally once every check is green, pinned to the classified commit", async () => {
    const gh = fakeGh([[running("lint")], [passed("lint"), passed("typecheck")]]);

    const result = await settleRunPr({ ...settings, change: smallChange }, gh.deps);

    expect(result).toEqual({ merged: true, why: "two-way door, small blast radius, every check green" });
    expect(called(gh.calls, "ready")).toHaveLength(1);
    // The base is fast-forwarded onto the exact classified commit; GitHub never
    // mints the merge commit, so nothing lands under the owner's name.
    expect(gh.landed).toEqual([{ sha: SHA, base: "main" }]);
    expect(called(gh.calls, "merge")).toHaveLength(0);
    expect(gh.body()).toContain(mergeRuleSectionStart());
    expect(gh.body()).toContain("**Merge rule:** merged by the loop: two-way door, small blast radius, every check green.");
    expect(gh.body()).toContain(mergeRuleSectionEnd());
  });

  it("leaves a one-way door for the owner without waiting on checks", async () => {
    const gh = fakeGh([[passed("lint")]]);

    const result = await settleRunPr({ ...settings, change: migrationChange }, gh.deps);

    expect(result.merged).toBe(false);
    expect(result.why).toMatch(/^one-way door: deletes or rewrites existing data/);
    expect(gh.landed).toEqual([]);
    expect(called(gh.calls, "ready")).toHaveLength(0);
    expect(gh.body()).toContain("**Merge rule:** waits for Alex (one-way door: deletes or rewrites existing data");
  });

  it("leaves the PR for the owner when a check fails", async () => {
    const gh = fakeGh([[passed("lint"), failed("typecheck")]]);

    const result = await settleRunPr({ ...settings, change: smallChange }, gh.deps);

    expect(result).toEqual({ merged: false, why: "a check failed" });
    expect(gh.landed).toEqual([]);
    expect(gh.body()).toContain("**Merge rule:** waits for Alex (a check failed).");
  });

  it("stops waiting at the deadline and leaves a still-running PR for the owner", async () => {
    const gh = fakeGh([[running("lint")]]);

    const result = await settleRunPr({ ...settings, change: smallChange }, gh.deps);

    expect(result).toEqual({ merged: false, why: "a check is still running" });
    // 10 s budget, 1 s polls: the first look plus ten more, then it gives up.
    expect(called(gh.calls, "view")).toHaveLength(11);
    expect(gh.landed).toEqual([]);
  });

  it("refuses to merge when the PR head is not the commit the loop classified", async () => {
    const gh = fakeGh([[passed("lint")]], { headSha: "0000000000000000000000000000000000000000" });

    const result = await settleRunPr({ ...settings, change: smallChange }, gh.deps);

    expect(result).toEqual({
      merged: false,
      why: "the PR head moved past the commit the loop classified",
    });
    expect(gh.landed).toEqual([]);
  });

  it("puts the PR back to draft and reports why when the merge itself fails", async () => {
    const gh = fakeGh([[passed("lint")]], { failMerge: true });

    const result = await settleRunPr({ ...settings, change: smallChange }, gh.deps);

    expect(result.merged).toBe(false);
    expect(result.why).toMatch(/^the merge failed: push to main rejected/);
    expect(called(gh.calls, "ready").at(-1)).toEqual(["pr", "ready", "7", "--undo"]);
    expect(gh.body()).toContain("**Merge rule:** waits for Alex (the merge failed:");
  });

  it("runs the pre-merge check on the exact classified commit before landing it", async () => {
    const gh = fakeGh([[passed("lint")]]);
    const checked: string[] = [];

    const result = await settleRunPr(
      { ...settings, change: smallChange },
      { ...gh.deps, beforeLand: async (sha) => void checked.push(sha) },
    );

    expect(result.merged).toBe(true);
    expect(checked).toEqual([SHA]);
    expect(gh.landed).toEqual([{ sha: SHA, base: "main" }]);
  });

  it("never lands when the pre-merge check fails: the PR waits for the owner and says why", async () => {
    const gh = fakeGh([[passed("lint")]]);

    const result = await settleRunPr(
      { ...settings, change: smallChange },
      {
        ...gh.deps,
        beforeLand: async () => {
          throw new Error("pnpm verify:land exited 1 — typecheck failed");
        },
      },
    );

    expect(result.merged).toBe(false);
    expect(result.why).toBe(
      "the pre-merge check failed: pnpm verify:land exited 1 — typecheck failed",
    );
    expect(gh.landed).toEqual([]);
    expect(called(gh.calls, "ready")).toHaveLength(0);
    expect(gh.body()).toContain("**Merge rule:** waits for Alex (the pre-merge check failed:");
  });

  it("never throws when gh is down; the PR simply waits for the owner", async () => {
    const result = await settleRunPr(
      { ...settings, change: smallChange },
      {
        runGh: async () => {
          throw new Error("gh: network down");
        },
        land: async () => {
          throw new Error("land must not be reached");
        },
        sleep: async () => {},
        now: () => 0,
      },
    );
    expect(result.merged).toBe(false);
    expect(result.why).toContain("gh: network down");
  });
});
