/**
 * The merge rule (tokenmaxxing#29): the loop merges its own run PR only when
 * the change is a two-way door, its blast radius is small, and every check is
 * green. Anything else waits for the owner.
 */
import { describe, expect, it } from "vitest";

import {
  classifyChange,
  decideMerge,
  parseDiff,
  readChecks,
  renderMergeDanger,
  renderSummary,
} from "./merge-rule.js";
import type { ChangedFile, RunFacts } from "./merge-rule.js";

const file = (path: string, additions = 10, deletions = 2, status: ChangedFile["status"] = "M"): ChangedFile => ({
  path,
  status,
  additions,
  deletions,
});

const MIGRATION = "packages/db/migrations/0142_add_wall.sql";

const cleanRun = (files: ChangedFile[], extra: Partial<RunFacts> = {}): RunFacts => ({
  files,
  issueCount: 1,
  promotionFailed: false,
  breakerTripped: false,
  previouslyShippedCount: 0,
  migrationSql: new Map(),
  ...extra,
});

describe("classifyChange", () => {
  it("calls a two-file app change a two-way door with a small blast radius", () => {
    const c = classifyChange(
      cleanRun([file("apps/nextjs/src/app/page.tsx"), file("packages/ui/src/button.tsx")]),
    );
    expect(c.door).toBe("two-way");
    expect(c.blastRadius).toBe("small");
    expect(c.doorReasons).toEqual([]);
    expect(c.blastReasons).toEqual([]);
  });
});

describe("classifyChange: the door", () => {
  it("calls a migration that deletes or rewrites existing data a one-way door, and names it", () => {
    const c = classifyChange(
      cleanRun([file(MIGRATION, 5, 0, "A"), file("apps/nextjs/src/app/page.tsx")], {
        migrationSql: new Map([[MIGRATION, "ALTER TABLE deals DROP COLUMN wall;"]]),
      }),
    );
    expect(c.door).toBe("one-way");
    expect(c.doorReasons).toEqual([
      `deletes or rewrites existing data (${MIGRATION}: drops the column deals.wall)`,
    ]);
    expect(c.destructiveMigrations).toEqual([MIGRATION]);
  });

  it("does not hold an additive migration: adding tables, columns, indexes or policies is a two-way door", () => {
    const c = classifyChange(
      cleanRun([file(MIGRATION, 5, 0, "A"), file("packages/db/migrations/meta/_journal.json", 7, 0)], {
        migrationSql: new Map([[MIGRATION, "CREATE TABLE notes (id uuid PRIMARY KEY); CREATE INDEX i ON notes (id);"]]),
      }),
    );
    expect(c.door).toBe("two-way");
    expect(c.doorReasons).toEqual([]);
    expect(c.destructiveMigrations).toEqual([]);
  });

  it("holds a new migration the loop could not read: an unread migration is never assumed safe", () => {
    const c = classifyChange(cleanRun([file(MIGRATION, 5, 0, "A")]));
    expect(c.door).toBe("one-way");
    expect(c.doorReasons).toEqual([`a migration the loop could not read (${MIGRATION})`]);
    expect(c.destructiveMigrations).toEqual([MIGRATION]);
  });

  it("holds an edit to a migration already on the default branch: production never re-runs it", () => {
    const old = "packages/db/migrations/0101_teams_timezone_default_toronto.sql";
    const c = classifyChange(cleanRun([file(old, 1, 1, "M")]));
    expect(c.door).toBe("one-way");
    expect(c.doorReasons).toEqual([`edits a migration already on the default branch (${old})`]);
    expect(c.destructiveMigrations).toEqual([old]);
  });

  it("does not hold a change to the migration journal alone", () => {
    const c = classifyChange(cleanRun([file("packages/db/migrations/meta/_journal.json", 7, 0)]));
    expect(c.door).toBe("two-way");
  });

  it("calls a change to the production migration release workflow a one-way door", () => {
    const c = classifyChange(cleanRun([file(".github/workflows/release-migrations.yml")]));
    expect(c.door).toBe("one-way");
  });
});

describe("classifyChange: the blast radius", () => {
  const appFiles = (n: number, linesEach = 10) =>
    Array.from({ length: n }, (_, i) => file(`apps/nextjs/src/f${i}.tsx`, linesEach, 0));

  it("keeps ten changed files small and calls eleven large", () => {
    expect(classifyChange(cleanRun(appFiles(10))).blastRadius).toBe("small");
    const c = classifyChange(cleanRun(appFiles(11)));
    expect(c.blastRadius).toBe("large");
    expect(c.blastReasons).toContain("changes 11 files (small is at most 10)");
  });

  it("keeps 300 changed lines small and calls 301 large", () => {
    expect(classifyChange(cleanRun([file("apps/nextjs/src/a.tsx", 200, 100)])).blastRadius).toBe("small");
    const c = classifyChange(cleanRun([file("apps/nextjs/src/a.tsx", 200, 101)]));
    expect(c.blastRadius).toBe("large");
    expect(c.blastReasons).toContain("changes 301 lines (small is at most 300)");
  });

  it("does not count the loop's own rework telemetry file", () => {
    const c = classifyChange(
      cleanRun([...appFiles(10), file(".sandcastle/telemetry/issues.jsonl", 5000, 0)]),
    );
    expect(c.blastRadius).toBe("small");
  });

  it("calls a run that shipped more than three issues large", () => {
    expect(classifyChange(cleanRun(appFiles(1), { issueCount: 3 })).blastRadius).toBe("small");
    const c = classifyChange(cleanRun(appFiles(1), { issueCount: 4 }));
    expect(c.blastReasons).toContain("ships 4 issues (small is at most 3)");
  });

  it.each([
    ["package.json", "changes dependencies or workspace setup"],
    ["pnpm-lock.yaml", "changes dependencies or workspace setup"],
    ["turbo.json", "changes dependencies or workspace setup"],
    [".github/workflows/ci.yml", "changes CI"],
    ["packages/auth/src/index.ts", "changes sign-in"],
    ["packages/db/src/schema.ts", "changes the database schema code"],
    [".sandcastle/main.mts", "changes the loop itself"],
    ["tooling/eslint/base.js", "changes shared tooling"],
  ])("calls a change to %s large", (path, what) => {
    const c = classifyChange(cleanRun([file(path, 1, 1)]));
    expect(c.blastRadius).toBe("large");
    expect(c.blastReasons).toContain(`${what} (${path})`);
  });

  it("calls a deleted file large", () => {
    const c = classifyChange(cleanRun([file("apps/nextjs/src/old.tsx", 0, 20, "D")]));
    expect(c.blastReasons).toContain("deletes a file (apps/nextjs/src/old.tsx)");
  });

  it("calls a run with a failed promotion, a breaker trip, or unverified earlier work large", () => {
    expect(classifyChange(cleanRun(appFiles(1), { promotionFailed: true })).blastReasons).toContain(
      "a final promotion failed, so the branch may be incomplete",
    );
    expect(classifyChange(cleanRun(appFiles(1), { breakerTripped: true })).blastReasons).toContain(
      "the circuit breaker cut the run short",
    );
    expect(classifyChange(cleanRun(appFiles(1), { previouslyShippedCount: 2 })).blastReasons).toContain(
      "carries 2 issue(s) from an interrupted run that nobody re-checked",
    );
  });
});

describe("decideMerge", () => {
  it("waits for the owner on a large blast radius even when every check is green", () => {
    const c = classifyChange(cleanRun([file(".sandcastle/main.mts")]));
    expect(decideMerge(c, "green")).toEqual({
      merge: false,
      why: "large blast radius: changes the loop itself (.sandcastle/main.mts)",
    });
  });

  it("waits for the owner on a one-way door even when every check is green", () => {
    const c = classifyChange(
      cleanRun([file(MIGRATION, 5, 0, "A")], {
        migrationSql: new Map([[MIGRATION, "TRUNCATE deals;"]]),
      }),
    );
    expect(decideMerge(c, "green")).toEqual({
      merge: false,
      why: `one-way door: deletes or rewrites existing data (${MIGRATION}: empties the table deals)`,
    });
  });

  it("merges a small two-way change once every check is green", () => {
    const c = classifyChange(cleanRun([file("apps/nextjs/src/app/page.tsx")]));
    expect(decideMerge(c, "green")).toEqual({ merge: true, why: "two-way door, small blast radius, every check green" });
  });

  it.each([
    ["pending", "a check is still running"],
    ["failing", "a check failed"],
    ["none", "no check ran on this PR"],
  ] as const)("waits for the owner when checks are %s", (state, why) => {
    const c = classifyChange(cleanRun([file("apps/nextjs/src/app/page.tsx")]));
    expect(decideMerge(c, state)).toEqual({ merge: false, why });
  });
});

describe("readChecks", () => {
  // Shapes copied from `gh pr view 1324 --json statusCheckRollup` (2026-10-06).
  const run = (name: string, status: string, conclusion: string | null) => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
  });
  const ctx = (context: string, state: string) => ({ __typename: "StatusContext", context, state });

  it("is green when every check run succeeded and every status is success", () => {
    expect(
      readChecks([run("lint", "COMPLETED", "SUCCESS"), run("format", "COMPLETED", "SUCCESS"), ctx("Vercel", "SUCCESS")]),
    ).toBe("green");
  });

  it("counts a skipped or neutral check as passing", () => {
    expect(readChecks([run("lint", "COMPLETED", "SKIPPED"), run("x", "COMPLETED", "NEUTRAL")])).toBe("green");
  });

  it("is none when no check reported", () => {
    expect(readChecks([])).toBe("none");
  });

  it("is pending while a check run is queued or a status is pending", () => {
    expect(readChecks([run("lint", "IN_PROGRESS", null), run("format", "COMPLETED", "SUCCESS")])).toBe("pending");
    expect(readChecks([run("lint", "COMPLETED", "SUCCESS"), ctx("Vercel", "PENDING")])).toBe("pending");
  });

  it("is failing as soon as any check failed, even while others still run", () => {
    expect(readChecks([run("lint", "COMPLETED", "FAILURE"), run("format", "QUEUED", null)])).toBe("failing");
    expect(readChecks([run("lint", "COMPLETED", "CANCELLED")])).toBe("failing");
    expect(readChecks([ctx("Vercel", "ERROR")])).toBe("failing");
  });
});

describe("renderMergeDanger (the `pr` skill's Merge Danger section)", () => {
  it("names the door and the blast radius, and says the loop will merge a small two-way change itself", () => {
    const c = classifyChange(cleanRun([file("apps/nextjs/src/app/page.tsx")]));
    expect(renderMergeDanger(c, "the loop merges this itself once every check is green.")).toBe(
      [
        "## Merge Danger",
        "",
        "**Door:** two-way",
        "",
        "**Blast Radius:** small",
        "",
        "**Merge rule:** the loop merges this itself once every check is green.",
      ].join("\n"),
    );
  });

  it("lists every reason under the door and the blast radius when they block the self-merge", () => {
    const c = classifyChange(
      cleanRun([file(MIGRATION, 5, 0, "A"), file(".sandcastle/main.mts")], {
        migrationSql: new Map([[MIGRATION, "ALTER TABLE deals DROP COLUMN wall;"]]),
      }),
    );
    const text = renderMergeDanger(c, "waits for Alex.");
    expect(text).toContain(
      `**Door:** one-way\n\n- deletes or rewrites existing data (${MIGRATION}: drops the column deals.wall)`,
    );
    expect(text).toContain("**Blast Radius:** large\n\n- changes the loop itself (.sandcastle/main.mts)");
    expect(text).toContain("**Merge rule:** waits for Alex.");
  });
});

describe("renderSummary (the `pr` skill's Summary section)", () => {
  it("draws the changed files as a diff-sketch file list with line counts, telemetry left out", () => {
    const text = renderSummary("Autonomous run `sandcastle/run-1`: 1 issue(s) certified by the loop.", [
      file("apps/nextjs/src/new.tsx", 40, 0, "A"),
      file("apps/nextjs/src/page.tsx", 12, 3, "M"),
      file("apps/nextjs/src/old.tsx", 0, 9, "D"),
      file(".sandcastle/telemetry/issues.jsonl", 1, 0, "M"),
    ]);
    expect(text).toBe(
      [
        "## Summary",
        "",
        "Autonomous run `sandcastle/run-1`: 1 issue(s) certified by the loop.",
        "",
        "```diff",
        "+ apps/nextjs/src/new.tsx  (+40 -0)",
        "  apps/nextjs/src/page.tsx  (+12 -3)",
        "- apps/nextjs/src/old.tsx  (+0 -9)",
        "```",
      ].join("\n"),
    );
  });

  it("names at most 40 files and counts the rest, so a big run cannot overflow the PR body", () => {
    const many = Array.from({ length: 45 }, (_, i) => file(`apps/f${String(i).padStart(2, "0")}.ts`, 1, 0));
    const text = renderSummary("Run.", many);
    expect(text).toContain("  apps/f39.ts  (+1 -0)");
    expect(text).not.toContain("apps/f40.ts");
    expect(text).toContain("... and 5 more files");
  });
});

describe("parseDiff (git diff --no-renames --numstat and --name-status, base...branch)", () => {
  it("joins the two outputs into one entry per file", () => {
    const numstat = "12\t3\tapps/nextjs/src/page.tsx\n40\t0\tapps/nextjs/src/new.tsx\n-\t-\tapps/nextjs/public/logo.png\n";
    const nameStatus = "M\tapps/nextjs/src/page.tsx\nA\tapps/nextjs/src/new.tsx\nA\tapps/nextjs/public/logo.png\n";
    expect(parseDiff(numstat, nameStatus)).toEqual([
      { path: "apps/nextjs/src/page.tsx", status: "M", additions: 12, deletions: 3 },
      { path: "apps/nextjs/src/new.tsx", status: "A", additions: 40, deletions: 0 },
      // A binary file has no line counts; it still counts as a changed file.
      { path: "apps/nextjs/public/logo.png", status: "A", additions: 0, deletions: 0 },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("", "")).toEqual([]);
  });
});
