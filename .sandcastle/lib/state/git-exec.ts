/**
 * The loop's general-purpose synchronous git shell-out, hoisted out of
 * `main.mts` (where it was module-private) so modules extracted from that file
 * can keep using it without either importing `main.mts` — which would be an
 * import cycle — or growing a `git` parameter that 24 existing call sites would
 * have to thread through.
 *
 * Bounded by a COARSE default wall-clock timeout (`RUN_GIT_DEFAULT_TIMEOUT_MS`,
 * 2026-08-31 freeze): this is the everyday runner for local plumbing commands,
 * and because it is SYNCHRONOUS a hung local `git` (a pinentry prompt, a stuck
 * lock, an unresponsive filesystem) would otherwise block the whole event loop
 * with nothing to save it. The bound is `execFileSync`'s NATIVE `timeout` — a
 * synchronous SIGTERM/kill, not a Promise.race that would abandon a live child.
 * The cross-host LEASE ref ops that talk to a remote still use `runGitLease` in
 * `main.mts` instead: they need a TIGHTER bound plus a transient-only retry —
 * see `LEASE_GIT_TIMEOUT_MS` there — which this coarse local default does not
 * give them.
 *
 * Not re-exported from `./index.js`: that barrel fronts the user-land state
 * MACHINE surface (`gh.ts`, `issue-lease.ts`, …), and routing a one-function
 * exec primitive through it would put those large modules on the dependency
 * edge of every consumer that only wants to run git.
 *
 * ⚠️ WARNING — DO NOT IMPORT THIS FROM THE REST OF `lib/state/`. This carries
 * only the coarse LOCAL default bound and NO transient-only retry, and it lives
 * in this directory only because it had nowhere better to go. Its siblings
 * `issue-lease.ts`, `branch-checkpoint.ts` and `ref-peers.ts` deliberately take
 * an INJECTED `GitRunner` so their remote ops get the tighter bound AND the
 * retry; `issue-lease.ts` even declares its own `GitRunResult`, and because the
 * two types are structurally identical they are MUTUALLY ASSIGNABLE — so
 * autocompleting `runGit` from here in place of the injected runner typechecks
 * cleanly AND passes tests whose fake runner is simply never consulted, leaving
 * that path on the wrong policy against a hung remote (a 120s local bound and no
 * retry, not the lease's 30s + transient retry). Thread the injected
 * `GitRunner` instead.
 *
 * The only legitimate importers are `main.mts` and
 * `lib/review/diff-measurement.ts` (a module extracted from it). If you are
 * adding a third, that is the moment to check you are not in `lib/state/`.
 */
import { execFileSync } from "node:child_process";

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Coarse default wall-clock bound for a LOCAL git shell-out (2026-08-31 freeze).
 * Because `runGit` is synchronous, a hung `git` blocks the whole event loop; a
 * finite bound turns that indefinite freeze into a catchable failure. 120s is
 * generous for any local plumbing command yet finite. Remote/lease ops use the
 * tighter `LEASE_GIT_TIMEOUT_MS` (30s) + transient retry via `runGitLease`
 * instead — see the ⚠️ warning above.
 *
 * NOTE: `timeoutMs` cannot be a trailing optional parameter on `runGit` — a
 * `...gitArgs` rest parameter forbids one after it — so the bound is applied
 * UNCONDITIONALLY here rather than being per-call overridable. Every one of the
 * 24+ existing call sites is now bounded with no signature change. A future
 * caller that needs a different bound should add a dedicated variant then.
 */
export const RUN_GIT_DEFAULT_TIMEOUT_MS = 120_000;

export function runGit(repoRoot: string, ...gitArgs: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", gitArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Native execFileSync timeout — a SYNCHRONOUS SIGTERM/kill of the child,
      // never a Promise.race that would leave a hung git running (2026-08-31
      // freeze). Mirrors runGitLeaseOnce in main.mts.
      timeout: RUN_GIT_DEFAULT_TIMEOUT_MS,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as Error & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      killed?: boolean;
      signal?: string;
    };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const stdout =
      typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    // A timeout kill surfaces as `killed` + a signal, often with EMPTY stderr;
    // fold the signal into stderr so a caller can tell a timeout kill from an
    // ordinary git failure (mirrors runGitLeaseOnce in main.mts).
    const signalNote = e.killed
      ? ` ${e.signal ?? "SIGTERM"} (killed by timeout)`
      : "";
    return {
      ok: false,
      stdout: stdout.trim(),
      stderr: (stderr.trim() || e.message) + signalNote,
    };
  }
}
