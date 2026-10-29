/**
 * Tests for the mac-host provider's command-execution seam
 * (`_execInWorktree` in `./mac-host-sandbox.ts`).
 *
 * WHY THIS FILE EXISTS: this is the half of the test-verification gate that
 * runs on the reviewer's own machine, and it was shipped with no coverage at
 * all while its docker twin got eight tests. The triage it performs — spawn
 * error vs. our own bound vs. an ordinary exit — is the error-prone part, and
 * a wrong answer here feeds the classifier a wrong observation about whether a
 * ticket's tests passed.
 *
 * These drive REAL processes (`sh -c` one-liners), not a mocked `spawn`: the
 * behaviours under test are process behaviours — exit codes, signal delivery
 * to a process group, stream close ordering — and a mock would only assert
 * that this file agrees with itself.
 */
import { describe, expect, it } from "vitest";

import { _execInWorktree } from "./mac-host-sandbox.js";

describe("_execInWorktree", () => {
  it("captures stdout and reports exit 0", async () => {
    const r = await _execInWorktree(process.cwd(), "echo hello", { env: {} });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.timedOut).toBe(false);
  });

  it("captures stderr separately from stdout", async () => {
    const r = await _execInWorktree(process.cwd(), "echo oops 1>&2", { env: {} });
    expect(r.stderr).toContain("oops");
    expect(r.stdout).not.toContain("oops");
  });

  // A non-zero exit is NORMAL FLOW for this seam — the gate has to be able to
  // tell "the suite ran and failed" from "we could not run it", and an
  // exception at this layer would erase that distinction.
  it("reports a non-zero exit as an exit code, not an exception", async () => {
    const r = await _execInWorktree(process.cwd(), "exit 3", { env: {} });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("runs in the cwd it is given", async () => {
    const r = await _execInWorktree("/tmp", "pwd", { env: {} });
    expect(r.stdout.trim()).toMatch(/tmp$/);
  });

  // The gap this closed: without threading env, a suite needing DATABASE_URL
  // from `.sandcastle/.env` would run unconfigured and land on ECONNREFUSED →
  // inconclusive, a silent asymmetry against the docker path where those
  // variables are baked into the container.
  it("injects the sandbox env on top of process.env", async () => {
    const r = await _execInWorktree(process.cwd(), "echo $SANDCASTLE_TEST_VAR", {
      env: { SANDCASTLE_TEST_VAR: "injected" },
    });
    expect(r.stdout.trim()).toBe("injected");
  });

  it("still inherits process.env for variables it does not override", async () => {
    const r = await _execInWorktree(process.cwd(), "echo $PATH", { env: {} });
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it("reports timedOut when the bound fires, and does not hang", async () => {
    const started = Date.now();
    const r = await _execInWorktree(process.cwd(), "sleep 30", {
      timeoutMs: 150,
      env: {},
    });
    expect(r.timedOut).toBe(true);
    // Well under the 30s the command asked for — proof the kill landed rather
    // than the process simply being awaited.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // `timedOut` is tracked from OUR timer, never inferred from the exit signal.
  // Inferring would report any signal death — an OOM kill, an operator's
  // Ctrl-C — as a timeout, putting a false cause in the run log.
  it("a self-inflicted signal death is NOT reported as a timeout", async () => {
    const r = await _execInWorktree(process.cwd(), "kill -TERM $$", {
      timeoutMs: 60_000,
      env: {},
    });
    expect(r.timedOut).toBe(false);
  });

  // The reason for `detached: true` + `process.kill(-pid)`: with `shell: true`
  // the direct child is the command, and a grandchild holding the inherited
  // stdout pipe can outlive a kill aimed at the parent alone — keeping a test
  // run burning CPU and delaying `close`.
  it("the bound reaches a grandchild, not just the direct child", async () => {
    const started = Date.now();
    const r = await _execInWorktree(
      process.cwd(),
      "sh -c 'sleep 30' & wait",
      { timeoutMs: 150, env: {} },
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("an unspawnable command resolves with exitCode null, never throws", async () => {
    const r = await _execInWorktree(
      "/definitely/not/a/real/directory",
      "echo hi",
      { env: {} },
    );
    expect(r.exitCode).toBe(null);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("bounds captured output rather than accumulating it", async () => {
    // 512KB of output against a 64KB tail budget.
    const r = await _execInWorktree(
      process.cwd(),
      "awk 'BEGIN{for(i=0;i<8192;i++) printf \"%064d\\n\", i}'",
      { env: {} },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024);
    // The TAIL is what is kept — a vitest failure summary prints last.
    expect(r.stdout.trimEnd().endsWith("8191")).toBe(true);
  });
});
