/**
 * REAL-GIT tests for the purge-coordination-refs tool (template hardening A3).
 *
 * Drives the PRODUCTION `purgeCoordinationRefs` in
 * `.sandcastle/lib/state/purge-coordination-refs.ts` against a REAL local bare
 * origin with real clones acting as hosts (offline, real git semantics). It
 * sweeps BOTH stale coordination ref roots — `refs/locks/*` (issue leases) and
 * `refs/sandcastle/*` (wip/lanes/status/strand/...) — off origin, and must NEVER
 * touch `refs/heads/*` or `refs/pull/*`.
 *
 * Assertions read refs off the bare ORIGIN via ls-remote (never mock calls), so a
 * green assertion is evidence the shipped path actually deletes (or, in preview,
 * spares) the refs. The dry-run pair makes the "it deleted" assertion provably
 * non-vacuous: the same drive in preview leaves every ref present.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { purgeCoordinationRefs } from "../.sandcastle/lib/state/purge-coordination-refs.js";
import { makeExecFileGitRunner } from "../.sandcastle/lib/state/index.js";

/** Run git synchronously for TEST SETUP/ASSERTIONS (not production code). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** ls-remote a single ref; returns the SHA it points at, or "" when absent. */
function lsRemote(cwd: string, ref: string, remote = "origin"): string {
  const out = git(cwd, "ls-remote", remote, ref);
  const first = out.split("\n").find((l) => l.trim().length > 0);
  return first ? first.split(/\s+/)[0] : "";
}

describe("purgeCoordinationRefs (real bare origin + real clones)", () => {
  let tmp: string;
  let remote: string;
  const gitRunner = makeExecFileGitRunner();

  const COORD_REFS = [
    "refs/locks/issue-11",
    "refs/locks/issue-22",
    "refs/sandcastle/wip/issue-11",
    "refs/sandcastle/lanes/hostA",
    "refs/sandcastle/strand/some-branch",
  ];

  function makeHost(name: string): string {
    const repo = path.join(tmp, name);
    git(tmp, "clone", remote, repo);
    git(repo, "config", "user.email", `${name}@t.test`);
    git(repo, "config", "user.name", name);
    return repo;
  }

  /** Seed origin with a `main` branch carrying a base file. */
  function seedOrigin(): void {
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", remote, seed);
    git(seed, "config", "user.email", "seed@t.test");
    git(seed, "config", "user.name", "seed");
    writeFileSync(path.join(seed, "base.txt"), "base content\n");
    git(seed, "add", "base.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "branch", "-M", "main");
    git(seed, "push", "-u", "origin", "main");
    rmSync(seed, { recursive: true, force: true });
  }

  /**
   * From `repo`, push every coordination ref (pointing at an arbitrary commit
   * SHA — the lock/wip objects need only EXIST) plus a normal branch we must
   * keep. Mirrors how strand-backup.test.ts pushes `refs/sandcastle/*`.
   */
  function seedCoordinationRefs(repo: string): string {
    const head = git(repo, "rev-parse", "HEAD");
    for (const ref of COORD_REFS) git(repo, "push", "origin", `${head}:${ref}`);
    // A NORMAL branch that must survive the purge.
    git(repo, "push", "origin", `${head}:refs/heads/keep-me`);
    return head;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-purge-"));
    remote = path.join(tmp, "remote.git");
    git(tmp, "init", "--bare", remote);
    seedOrigin();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("deletes EVERY coordination ref under refs/locks + refs/sandcastle, sparing refs/heads", async () => {
    const host = makeHost("hostA");
    const head = seedCoordinationRefs(host);
    // Sanity: they're all present before the purge.
    for (const ref of COORD_REFS) expect(lsRemote(host, ref)).toBe(head);
    expect(lsRemote(host, "refs/heads/keep-me")).toBe(head);

    const results = await purgeCoordinationRefs(gitRunner, { repoRoot: host });

    // Every coordination ref is GONE on origin.
    for (const ref of COORD_REFS) expect(lsRemote(host, ref)).toBe("");
    // The normal branch STILL exists.
    expect(lsRemote(host, "refs/heads/keep-me")).toBe(head);
    // main (the seed branch) untouched too.
    expect(lsRemote(host, "refs/heads/main")).toBe(head);

    // Every result is a real deletion of a coordination ref.
    expect(results.map((r) => r.ref).sort()).toEqual([...COORD_REFS].sort());
    expect(results.every((r) => r.outcome === "deleted")).toBe(true);
  });

  it("dry-run/preview deletes NOTHING — every ref still present", async () => {
    const host = makeHost("hostA");
    const head = seedCoordinationRefs(host);

    const results = await purgeCoordinationRefs(gitRunner, {
      repoRoot: host,
      dryRun: true,
    });

    // Nothing was deleted.
    for (const ref of COORD_REFS) expect(lsRemote(host, ref)).toBe(head);
    expect(lsRemote(host, "refs/heads/keep-me")).toBe(head);
    // The tool still reports what it WOULD delete.
    expect(results.map((r) => r.ref).sort()).toEqual([...COORD_REFS].sort());
    expect(results.every((r) => r.outcome === "would-delete")).toBe(true);
  });

  it("end-to-end via the thin runner (--yes) purges the refs on origin", () => {
    const host = makeHost("hostA");
    const head = seedCoordinationRefs(host);

    const script = fileURLToPath(
      new URL("../.sandcastle/scripts/purge-coordination-refs.mts", import.meta.url),
    );
    // Resolve the vendored tsx relative to this test file so it passes on any
    // checkout (this Mac, the VPS, CI).
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    execFileSync(tsx, [script, "--repo-root", host, "--yes"], { cwd: host });

    for (const ref of COORD_REFS) expect(lsRemote(host, ref)).toBe("");
    expect(lsRemote(host, "refs/heads/keep-me")).toBe(head);
  }, 30_000);
});
