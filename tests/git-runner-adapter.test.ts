/**
 * Canonical GitRunner adapters (Quality #2 dedup) — behavior-preservation tests.
 *
 * These lock the OBSERVABLE behavior of the two shapes the three former inline
 * adapters had:
 *   - async execFileAsync runner (was checkpoint-stop.mts / launch.mts): raw,
 *     UNtrimmed stdout/stderr on success; `stderr: e.stderr ?? ""` on error.
 *   - sync execFileSync runner (was mac-host-sandbox.ts): TRIMMED stdout on
 *     success; Buffer-or-string unwrap + trim + `e.message` fallback on error.
 *
 * Exercised against REAL git in a throwaway local repo (offline).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  makeExecFileGitRunner,
  makeSyncGitRunner,
} from "../.sandcastle/lib/state/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "git-runner-adapter-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("makeExecFileGitRunner (async)", () => {
  it("returns ok:true with RAW (untrimmed) stdout on success", async () => {
    const run = makeExecFileGitRunner();
    const res = await run(dir, "rev-parse", "HEAD");
    expect(res.ok).toBe(true);
    // rev-parse emits a trailing newline; the async adapter must NOT trim it.
    expect(res.stdout).toMatch(/^[0-9a-f]{40}\n$/);
    expect(res.stderr).toBe("");
  });

  it("returns ok:false with e.stderr on failure (no message fallback)", async () => {
    const run = makeExecFileGitRunner();
    const res = await run(dir, "rev-parse", "--verify", "definitely-not-a-ref");
    expect(res.ok).toBe(false);
    expect(res.stdout).toBe("");
    // Real git writes a diagnostic to stderr; must be surfaced (and NOT trimmed
    // — the async adapter keeps stderr raw, so the trailing newline survives).
    expect(res.stderr).toContain("Needed a single revision");
    expect(res.stderr.endsWith("\n")).toBe(true);
  });
});

describe("makeSyncGitRunner (sync)", () => {
  it("returns ok:true with TRIMMED stdout on success", async () => {
    const run = makeSyncGitRunner();
    const res = await run(dir, "rev-parse", "HEAD");
    expect(res.ok).toBe(true);
    // The sync adapter trims: a bare 40-char sha, no trailing newline.
    expect(res.stdout).toMatch(/^[0-9a-f]{40}$/);
    expect(res.stderr).toBe("");
  });

  it("returns ok:false with trimmed stderr on failure", async () => {
    const run = makeSyncGitRunner();
    const res = await run(dir, "rev-parse", "--verify", "definitely-not-a-ref");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("Needed a single revision");
    // sync adapter trims → no leading/trailing whitespace (newline gone)
    expect(res.stderr).toBe(res.stderr.trim());
    expect(res.stderr.endsWith("\n")).toBe(false);
  });
});
