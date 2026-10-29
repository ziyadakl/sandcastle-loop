/**
 * The `landCheck` setting: with none configured the loop opens its run PR but
 * NEVER lands it itself (and says so); with one configured it runs that command
 * on the run branch tip before landing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import { makeArgs } from "./__fixtures__/scripted-run.mts";
import {
  NO_LAND_CHECK_WHY,
  classifyChange,
  plannedMergeLine,
  runHeldReasons,
} from "./lib/state/merge-rule.js";
import { defaultProjectConfig, resetProjectConfig, setProjectConfig } from "./lib/project-config.js";
import { buildDefaultDeps, buildRunPrBody, verifyLandAt } from "./main.mts";

const smallChange = classifyChange({
  files: [{ path: "src/a.ts", status: "M", additions: 3, deletions: 1 }],
  issueCount: 1,
  promotionFailed: false,
  breakerTripped: false,
  previouslyShippedCount: 0,
  migrationSql: new Map(),
});

describe("no landCheck configured (the default): the loop does not land its own run PR", () => {
  beforeEach(() => resetProjectConfig());

  it("the planned merge line says it waits for the owner and why", () => {
    expect(smallChange.door).toBe("two-way");
    expect(smallChange.blastRadius).toBe("small");
    // A small two-way change WOULD be merged by the loop if a check existed.
    expect(plannedMergeLine(smallChange)).toBe(
      `waits for the owner (${NO_LAND_CHECK_WHY}).`,
    );
  });

  it("the run PR body carries that line and tells the reader no pre-merge check is configured", () => {
    const body = buildRunPrBody({
      branch: "sandcastle/run-1",
      shippedIssueNums: [11],
      files: [{ path: "src/a.ts", status: "M", additions: 3, deletions: 1 }],
      change: smallChange,
    });
    expect(body).toContain("**Merge rule:** waits for the owner (no pre-merge check is configured");
    expect(body).toContain("No pre-merge check is configured");
    expect(body).not.toContain("the loop merges this itself");
  });

  it("the production settleRunPr returns not-merged WITHOUT touching GitHub", async () => {
    const deps = buildDefaultDeps(makeArgs({ repoRoot: tmpdir(), dryRun: false }));
    const settled = await deps.settleRunPr!("sandcastle/run-1", smallChange, "a".repeat(40));
    expect(settled).toEqual({ merged: false, why: NO_LAND_CHECK_WHY });
    // The held reason reaches the run report.
    expect(runHeldReasons(smallChange, settled)).toEqual([NO_LAND_CHECK_WHY]);
  });
});

describe("a landCheck is configured", () => {
  let repo: string;
  let sha: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-landcheck-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    sha = commitInto(repo, { "a.txt": "a\n" }, "seed");
    setProjectConfig({ ...defaultProjectConfig(), landCheck: ["node", "-e", "process.exit(0)"] });
  });
  afterEach(() => {
    resetProjectConfig();
    rmSync(repo, { recursive: true, force: true });
  });

  it("the planned line follows the normal merge rule again", () => {
    expect(plannedMergeLine(smallChange)).toBe("the loop merges this itself once every check is green.");
  });

  it("runs the configured command on the tip and passes on exit 0", async () => {
    const res = await verifyLandAt(repo, sha);
    expect(res.ok).toBe(true);
    expect(res.why).toContain("node -e process.exit(0) passed");
  });

  it("fails with the command's own words on a non-zero exit", async () => {
    setProjectConfig({
      ...defaultProjectConfig(),
      landCheck: ["node", "-e", "console.error('lint broke'); process.exit(4)"],
    });
    const res = await verifyLandAt(repo, sha);
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/exited 4/);
    expect(res.why).toContain("lint broke");
  });

  it("refuses (never guesses) when the checkout is not at the commit being landed", async () => {
    const res = await verifyLandAt(repo, "b".repeat(40));
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/not the commit being landed/);
  });

  it("a command that cannot start is a failed check, not a crash", async () => {
    setProjectConfig({ ...defaultProjectConfig(), landCheck: ["definitely-not-a-binary-xyz"] });
    const res = await verifyLandAt(repo, sha);
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/could not start/);
  });
});

