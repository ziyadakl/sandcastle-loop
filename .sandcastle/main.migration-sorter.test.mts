/**
 * Spec #1334, scripted run: "a data-destroying migration holds the run and an
 * additive one does not". No AI and no real `gh`: a real temporary git origin
 * and clone, the run branch's diff and migration SQL read the way the loop
 * reads them when it opens the run PR (`readRunChange`), then the merge rule
 * (`settleRunPr`) with a fake `gh` and the REAL local land (`landRunLocally`).
 *
 * The run branch carries one small file so the blast radius stays small: these
 * pin the migration door, not the size limits.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { settleRunPr } from "./lib/state/gh.js";
import type { RollupEntry } from "./lib/state/merge-rule.js";
import { landRunLocally, readRunChange } from "./main.mts";

const AGENT = "Claude (on behalf of Alex) <noreply@anthropic.com>";
const MIGRATION = "packages/db/migrations/0143_t.sql";
const RUN = "sandcastle/run-1";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let origin: string;
let work: string;

function commitFile(path: string, content: string, message: string): void {
  mkdirSync(join(work, path, ".."), { recursive: true });
  writeFileSync(join(work, path), content);
  git(work, "add", path);
  git(work, "commit", "-q", "-m", message);
}

/** A run branch off `main` holding one migration, pushed like `openRunPr` does. */
function runBranchWith(sql: string): void {
  git(work, "checkout", "-q", "-b", RUN, "main");
  commitFile(MIGRATION, sql, "feat(db): migration");
  git(work, "push", "-q", "origin", `${RUN}:refs/heads/${RUN}`);
}

const FACTS = { issueCount: 1, promotionFailed: false, breakerTripped: false, previouslyShippedCount: 0 };
const green: RollupEntry = { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" };

/** A `gh` that reports the run PR (number 7, base `main`) at `headSha` with
 *  green checks, and records every call. */
function fakeGh(headSha: string) {
  const calls: string[][] = [];
  const runGh = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "view") {
      return {
        stdout: JSON.stringify({
          number: 7,
          headRefOid: headSha,
          baseRefName: "main",
          body: "",
          statusCheckRollup: [green],
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, runGh };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sd-migration-sorter-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "config", "user.name", "Claude (on behalf of Alex)");
  git(work, "config", "user.email", "noreply@anthropic.com");
  commitFile("apps/x.ts", "export const x = 1;\n", "chore: seed");
  git(work, "push", "-q", "origin", "main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a data-destroying migration holds the run and an additive one does not", () => {
  it("holds a run whose migration drops a column, and lands nothing", async () => {
    runBranchWith("ALTER TABLE public.deals DROP COLUMN legacy_note;\n");

    const read = readRunChange(work, "main", RUN, FACTS);
    expect(read.change?.door).toBe("one-way");
    expect(read.change?.destructiveMigrations).toEqual([MIGRATION]);

    const mainBefore = git(origin, "rev-parse", "main");
    const gh = fakeGh(read.headSha);
    const settled = await settleRunPr(
      { branch: RUN, headSha: read.headSha, change: read.change!, timeoutMs: 0, pollMs: 0 },
      { runGh: gh.runGh, land: async (sha, base) => landRunLocally(work, sha, base) },
    );

    expect(settled.merged).toBe(false);
    expect(settled.why).toBe(
      `one-way door: deletes or rewrites existing data (${MIGRATION}: drops the column public.deals.legacy_note)`,
    );
    expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
    expect(gh.calls.filter((c) => c[1] === "merge")).toEqual([]);
  });

  it("lands a run whose migration only adds a table and a policy, as the agent, with no new commit", async () => {
    runBranchWith(
      "CREATE TABLE public.notes (id uuid PRIMARY KEY);\nCREATE POLICY team_isolation ON public.notes USING (true);\n",
    );

    const read = readRunChange(work, "main", RUN, FACTS);
    expect(read.change).toMatchObject({ door: "two-way", blastRadius: "small", destructiveMigrations: [] });

    const gh = fakeGh(read.headSha);
    const settled = await settleRunPr(
      { branch: RUN, headSha: read.headSha, change: read.change!, timeoutMs: 0, pollMs: 0 },
      { runGh: gh.runGh, land: async (sha, base) => landRunLocally(work, sha, base) },
    );

    expect(settled.merged).toBe(true);
    // `main` on the origin is now exactly the classified commit: a fast-forward,
    // so no merge commit was minted, and the tip is authored by the agent.
    expect(git(origin, "rev-parse", "main")).toBe(read.headSha);
    expect(git(origin, "log", "-1", "--format=%an <%ae>", "main")).toBe(AGENT);
    expect(gh.calls.filter((c) => c[1] === "merge")).toEqual([]);
  });

  it("judges the migration as it is at the classified commit", () => {
    runBranchWith("CREATE TABLE public.notes (id uuid PRIMARY KEY);\n");
    const additive = readRunChange(work, "main", RUN, FACTS);

    commitFile(MIGRATION, "TRUNCATE public.notes;\n", "fix(db): change migration");
    const destructive = readRunChange(work, "main", RUN, FACTS);

    expect(additive.change?.door).toBe("two-way");
    expect(destructive.change?.door).toBe("one-way");
    expect(destructive.headSha).not.toBe(additive.headSha);
  });
});

describe("landRunLocally", () => {
  it("refuses when the base moved on and the land is no longer a fast-forward", () => {
    runBranchWith("CREATE TABLE public.notes (id uuid PRIMARY KEY);\n");
    const head = git(work, "rev-parse", "HEAD");

    git(work, "checkout", "-q", "main");
    commitFile("apps/y.ts", "export const y = 2;\n", "chore: someone else landed first");
    git(work, "push", "-q", "origin", "main");
    const mainBefore = git(origin, "rev-parse", "main");

    expect(() => landRunLocally(work, head, "main")).toThrow(/could not land/);
    expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
  });
});
