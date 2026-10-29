/**
 * Tests for the rework CLI itself: argv, wiring, and the exit-code contract.
 *
 * The pure halves this script used to hold are tested beside the code they now
 * live in — `lib/telemetry/rework-history.test.ts` for the git walk and
 * `lib/telemetry/rework-render.test.ts` for the tables and the JSON payload.
 * What is left here is what only the CLI can be wrong about: which flags it
 * accepts, that a missing store or an unusable repo DEGRADES rather than
 * crashing, and that the order it does things in — collapse duplicates, then
 * walk, then score, then pair positionally — still holds end to end.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ReworkRecord } from "../lib/telemetry/rework-store.js";
import type { ReworkReportJson } from "../lib/telemetry/rework-render.js";
import type { GitRunner } from "../lib/state/issue-lease.js";
import { parseArgs, run } from "./rework-report.mts";

const NOW = "2026-08-01T00:00:00.000Z";

function record(over: Partial<ReworkRecord> = {}): ReworkRecord {
  return {
    schemaVersion: 1,
    issueNumber: 1,
    runId: "run-a",
    hostId: "mac",
    shippedAtIso: "2026-07-01T00:00:00.000Z",
    shippedSha: "a".repeat(40),
    outcome: "shipped",
    ...over,
  };
}

describe("parseArgs", () => {
  it("reads the flags it supports", () => {
    const { args, error } = parseArgs([
      "--window-days",
      "30",
      "--json",
      "--store",
      "/x.jsonl",
    ]);
    expect(error).toBeUndefined();
    expect(args).toMatchObject({ windowDays: 30, json: true, storePath: "/x.jsonl" });
  });

  it("reports an unknown flag rather than ignoring it", () => {
    expect(parseArgs(["--nope"]).error).toContain("unknown flag");
  });

  it("reports a non-numeric window rather than silently defaulting", () => {
    expect(parseArgs(["--window-days", "soon"]).error).toContain("needs a number");
  });
});

describe("run — degrade paths", () => {
  const noGit: GitRunner = () =>
    Promise.resolve({ ok: false, stdout: "", stderr: "not a git repository" });

  /** A real one-line store on disk, so the non-empty path is exercised. */
  function storeWithOneRecord(): string {
    const dir = mkdtempSync(join(tmpdir(), "rework-cli-"));
    const path = join(dir, "issues.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(record({ issueNumber: 55, changedFilePaths: ["src/a.ts"] }))}\n`,
    );
    return path;
  }

  it("prints the no-data sentence and exits 0 when the store is missing", async () => {
    let out = "";
    const code = await run(
      ["--store", "/definitely/not/here.jsonl", "--repo-root", "/tmp"],
      { runner: noGit, cwd: "/tmp", nowIso: NOW, write: (t) => (out += t) },
    );
    expect(code).toBe(0);
    expect(out).toContain(
      "no data yet, the loop has not shipped an issue since telemetry landed",
    );
  });

  it("emits valid JSON with exists:false on that same path", async () => {
    let out = "";
    const code = await run(
      ["--store", "/definitely/not/here.jsonl", "--repo-root", "/tmp", "--json"],
      { runner: noGit, cwd: "/tmp", nowIso: NOW, write: (t) => (out += t) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      store: { exists: boolean };
      message: string;
    };
    expect(parsed.store.exists).toBe(false);
    expect(parsed.message).toContain("no data yet");
  });

  it("names the real fault when git is unusable, not a phantom fetch problem", async () => {
    // Without the preflight, every row would read "ship commit X is not in this
    // clone", sending the reader hunting for a fetch problem that isn't there.
    let out = "";
    const code = await run(
      ["--store", storeWithOneRecord(), "--repo-root", "/not/a/repo"],
      { runner: noGit, cwd: "/tmp", nowIso: NOW, write: (t) => (out += t) },
    );
    expect(code).toBe(0);
    expect(out).toContain("CANNOT SCORE ANYTHING: not a git repository");
    expect(out).not.toContain("never fetched");
    expect(out).toContain("TOOLING gap, not a verdict on the work");
  });

  it("exits 0 when git is unusable, falling back to cwd", async () => {
    let out = "";
    const code = await run(["--store", "/definitely/not/here.jsonl"], {
      runner: noGit,
      cwd: "/tmp",
      nowIso: NOW,
      write: (t) => (out += t),
    });
    expect(code).toBe(0);
    expect(out).toContain("no data yet");
  });
});

// ---------------------------------------------------------------------------
// UNION-MERGE DUPLICATES. `.gitattributes` gives the store `merge=union`, which
// resolves every collision by taking BOTH sides' lines — correct for an
// append-only log, and the reason the same record legitimately arrives twice.
// The writer's per-run Set cannot speak for what git does to the file
// afterwards, so the collapse has to happen in the reader.
//
// The collapse itself lives in `rework-store.ts` and is tested there. What is
// asserted below is the CLI's ORDERING: it must collapse before it builds
// histories, or the positional score↔record pairing is built on a list the
// scorer never saw.
// ---------------------------------------------------------------------------

describe("run — the duplicate collapse happens before anything else", () => {
  const noGit: GitRunner = () =>
    Promise.resolve({ ok: false, stdout: "", stderr: "not a git repository" });

  it("does not let a duplicated line double an issue's weight", async () => {
    // `aggregateRework` SUMS totalFileCount/reworkedFileCount across scores, so
    // an uncollapsed duplicate re-weights the file-weighted OVERALL rate as well
    // as inflating the issue counts — the headline number would depend on merge
    // history. Asserted through the CLI, because the collapse has to happen
    // before `histories` is built for the positional score↔record pairing to
    // survive.
    const dir = mkdtempSync(join(tmpdir(), "rework-dupe-"));
    const path = join(dir, "issues.jsonl");
    const line = `${JSON.stringify(
      record({ issueNumber: 55, changedFilePaths: ["src/a.ts", "src/b.ts"] }),
    )}\n`;
    writeFileSync(path, line + line);

    let out = "";
    const code = await run(
      ["--store", path, "--repo-root", "/not/a/repo", "--json"],
      { runner: noGit, cwd: "/tmp", nowIso: NOW, write: (t) => (out += t) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      store: { recordCount: number; duplicateLines: number };
    };
    expect(parsed.store.duplicateLines).toBe(1);
    // ONE issue, not two. (git is unusable here, so the record lands in
    // historyUnreadable — which is exactly where recordCount counts it.)
    expect(parsed.store.recordCount).toBe(1);
  });
});

describe("run — the outcome policy end to end", () => {
  /**
   * Resolves every sha, calls it an ancestor, and returns `stdout` for `log`.
   *
   * Matched with `includes`, not `gitArgs[0]`: the real walk leads with
   * `-c core.quotepath=false`, so a positional match would silently never fire
   * and the fixture would look like an empty history.
   */
  function fakeRepo(stdout: string): GitRunner {
    return (_cwd, ...gitArgs) => {
      if (gitArgs.includes("log")) {
        return Promise.resolve({ ok: true, stdout, stderr: "" });
      }
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") {
        return Promise.resolve({ ok: true, stdout: "a".repeat(40), stderr: "" });
      }
      return Promise.resolve({ ok: true, stdout: "", stderr: "" });
    };
  }

  function storeWith(records: readonly ReworkRecord[]): string {
    const dir = mkdtempSync(join(tmpdir(), "rework-outcome-"));
    const path = join(dir, "issues.jsonl");
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return path;
  }

  const rework = `\0${"b".repeat(40)}\x1f2026-07-03T00:00:00.000Z\x1f p \x1ffix: unrelated\x1f\n\nsrc/a.ts\nsrc/b.ts\n`;

  it("scores the shipped issue and refuses to score the quarantined one", async () => {
    // Both issues own the same two files and both had both files touched again.
    // Scored identically they would BOTH read 100%; but the quarantined lane
    // never merged, so that later commit is the redo of work that was never in
    // the tree. The whole point of passing `outcome` through.
    const path = storeWith([
      record({
        issueNumber: 70,
        runId: "run-a",
        changedFilePaths: ["src/a.ts", "src/b.ts"],
      }),
      record({
        issueNumber: 71,
        runId: "run-a",
        outcome: "quarantined",
        changedFilePaths: ["src/a.ts", "src/b.ts"],
      }),
    ]);
    let out = "";
    const code = await run(["--store", path, "--repo-root", "/repo", "--json"], {
      runner: fakeRepo(rework),
      cwd: "/repo",
      nowIso: NOW,
      write: (t) => (out += t),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as ReworkReportJson;
    expect(parsed.counts.scored).toBe(1);
    expect(parsed.counts.excludedByOutcome).toBe(1);
    expect(parsed.overall.reworkRate).toBe(1);
    // 2 files, not 4: the excluded issue is out of the DENOMINATOR too.
    expect(parsed.overall.totalFileCount).toBe(2);
    expect(
      parsed.issues.find((i) => i.issueNumber === 71)?.reworkRate,
    ).toBeNull();
  });

  it("gives each record only ITS window's commits out of the shared walk", async () => {
    // The one thing the union walk newly makes possible: two records whose
    // windows do not overlap now share a single `git log`, so #90's commit is
    // in the stdout #91 is placed against for the first time. Both issues own
    // the SAME file, so wrong attribution would show up as both scoring 100%.
    //
    // This is DEFENCE IN DEPTH, and worth knowing which layer actually holds
    // it: `commitsInWindow` is a narrowing, not the guarantee. Deleting that
    // filter entirely still passes this test, because Part 2 re-filters exactly
    // (`elapsed < 0 || elapsed > windowMs`) and drops a commit that belongs to
    // another record's window regardless of what was handed in. That is the
    // property that makes ONE walk safe at all — pinned here so a future change
    // to either filter cannot quietly leave neither of them doing the job.
    // (`commitsInWindow`'s own boundary rules are pinned in
    // `lib/telemetry/rework-history.test.ts`.)
    const path = storeWith([
      record({
        issueNumber: 90,
        shippedAtIso: "2026-01-01T00:00:00.000Z",
        changedFilePaths: ["src/shared.ts"],
      }),
      record({
        issueNumber: 91,
        shippedAtIso: "2026-06-01T00:00:00.000Z",
        changedFilePaths: ["src/shared.ts"],
      }),
    ]);
    // One commit inside #90's window only. Nothing at all in #91's.
    const inJanuaryOnly = `\0${"c".repeat(40)}\x1f2026-01-05T00:00:00.000Z\x1f p \x1ffix: unrelated\x1f\n\nsrc/shared.ts\n`;
    let out = "";
    await run(["--store", path, "--repo-root", "/repo", "--json"], {
      runner: fakeRepo(inJanuaryOnly),
      cwd: "/repo",
      nowIso: NOW,
      write: (t) => (out += t),
    });
    const parsed = JSON.parse(out) as ReworkReportJson;
    const by = (n: number) => parsed.issues.find((i) => i.issueNumber === n);
    expect(by(90)?.reworkRate).toBe(1);
    expect(by(91)?.reworkRate).toBe(0);
    // File-weighted across both: 1 of 2, not 2 of 2.
    expect(parsed.overall.reworkRate).toBe(0.5);
  });

  it("counts every deduped record, including one the pairing guard drops", async () => {
    // `recordCount` answers "how many records were in the store?", so it comes
    // from the deduped list — not from `rows + unreadable`, which is only what
    // survived scoring and so under-reports exactly when something went wrong.
    const path = storeWith([
      record({ issueNumber: 80, changedFilePaths: ["src/a.ts"] }),
      record({ issueNumber: 81, outcome: "needs-human" }),
    ]);
    let out = "";
    await run(["--store", path, "--repo-root", "/repo", "--json"], {
      runner: fakeRepo(""),
      cwd: "/repo",
      nowIso: NOW,
      write: (t) => (out += t),
    });
    const parsed = JSON.parse(out) as ReworkReportJson;
    expect(parsed.store.recordCount).toBe(2);
    expect(parsed.counts.historyUnreadable).toBe(0);
  });
});
