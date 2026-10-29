/**
 * The run-log appender keeps a per-run archive as well as the latest-run
 * pointer (issue #1096): a refused ticket is closed on a later night, and the
 * run that refused it must not have been overwritten by then.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunLogAppender } from "./main.mts";

describe("createRunLogAppender — latest pointer plus a per-run archive", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "sc-runlog-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const archiveDir = (): string =>
    path.join(repoRoot, ".sandcastle", "logs", "runs");

  it("writes every line to run.log AND to a per-run archive file", () => {
    const append = createRunLogAppender({
      repoRoot,
      runId: "night-42",
      now: () => new Date("2026-08-25T02:00:00.000Z"),
    });
    append("first line\n");
    append("second line\n");

    const runLog = readFileSync(
      path.join(repoRoot, ".sandcastle", "run.log"),
      "utf8",
    );
    expect(runLog).toBe("first line\nsecond line\n");

    const archives = readdirSync(archiveDir());
    expect(archives).toHaveLength(1);
    expect(archives[0]).toContain("night-42");
    expect(readFileSync(path.join(archiveDir(), archives[0]!), "utf8")).toBe(
      "first line\nsecond line\n",
    );
  });

  it("a second run truncates run.log but leaves the first run's archive intact", () => {
    createRunLogAppender({
      repoRoot,
      runId: "night-1",
      now: () => new Date("2026-08-24T02:00:00.000Z"),
    })("run one only\n");

    createRunLogAppender({
      repoRoot,
      runId: "night-2",
      now: () => new Date("2026-08-25T02:00:00.000Z"),
    })("run two only\n");

    // run.log is the latest run and only the latest run.
    expect(
      readFileSync(path.join(repoRoot, ".sandcastle", "run.log"), "utf8"),
    ).toBe("run two only\n");

    // Both runs survive as separate archives — the whole point of #1096.
    const archives = readdirSync(archiveDir()).sort();
    expect(archives).toHaveLength(2);
    const contents = archives.map((f) =>
      readFileSync(path.join(archiveDir(), f), "utf8"),
    );
    expect(contents).toContain("run one only\n");
    expect(contents).toContain("run two only\n");
  });

  it("honours an explicit --log-file override for the latest pointer, still archiving per run", () => {
    const logFile = path.join(repoRoot, "custom.log");
    createRunLogAppender({
      repoRoot,
      logFile,
      runId: "night-9",
      now: () => new Date("2026-08-25T03:00:00.000Z"),
    })("hello\n");
    expect(readFileSync(logFile, "utf8")).toBe("hello\n");
    expect(existsSync(archiveDir())).toBe(true);
    expect(readdirSync(archiveDir())).toHaveLength(1);
  });
});
