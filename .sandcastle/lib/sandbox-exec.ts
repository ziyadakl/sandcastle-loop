/**
 * The one-shot command-execution seam every sandbox provider exposes.
 *
 * WHY IT EXISTS: the test-verification gate must run the shipped code's test
 * suites, and the ONLY place those suites can run is where their dependencies
 * were installed — inside the sandbox. The per-issue worktrees are populated by
 * the Linux container, so a host-side `pnpm --filter … test` on a Mac dies on
 * `Cannot find module @rollup/rollup-darwin-arm64` before a single test
 * executes. Running host-side therefore verified nothing on half the fleet.
 *
 * The SDK already has this capability — `Sandbox.exec(command, opts)` on
 * `@ai-hero/sandcastle` (dist/index.d.ts:861) and `exec` on every provider
 * handle. This module is the loop's own narrow re-statement of it, kept
 * deliberately smaller than the SDK's: no `onLine`, no `stdin`, no `sudo`, no
 * `cwd`. The gate needs none of them, and every option added here is one the
 * mac-host provider would also have to honour.
 *
 * `cwd` is omitted ON PURPOSE. The SDK defaults it to the sandbox's repo
 * directory — which is exactly the worktree holding the shipped code — and that
 * default is the only value that is correct across providers. The docker
 * provider's in-container path (`/home/agent/workspace`) and the host path the
 * orchestrator knows (`.sandcastle/worktrees/agent-issue-N`) are DIFFERENT
 * strings for the same bind-mounted directory, so a caller passing the host
 * path would silently land outside the container's workspace.
 *
 * This file holds the exec types, the constants both providers must agree on,
 * and one pure command-string builder — no imports and no I/O — so `main.mts`,
 * `lib/sandbox-provider.ts`, `lib/mac-host-sandbox.ts` and `lib/testing/` can
 * all depend on it without a cycle through the 400KB orchestrator entry point.
 */

/** Outcome of one command executed inside a sandbox. */
export interface SandboxExecResult {
  /** Captured stdout. Providers bound this to a tail; it is not the full stream. */
  readonly stdout: string;
  /** Captured stderr. Bounded the same way. */
  readonly stderr: string;
  /**
   * Exit status, or `null` when the command was killed and no status was
   * reported. A non-zero code is NORMAL FLOW here, never an exception — the
   * gate's whole job is to interpret it.
   */
  readonly exitCode: number | null;
  /** True when {@link SandboxExecOptions.timeoutMs} ended the command. */
  readonly timedOut: boolean;
}

export interface SandboxExecOptions {
  /**
   * Wall-clock bound the PROVIDER enforces in its own execution environment —
   * not a host-side race. This matters: the SDK's `exec` has no timeout and no
   * `AbortSignal`, so a host-side `Promise.race` would leave the real process
   * running inside the container, burning a CPU until the sandbox is torn down.
   * Each provider translates this into a kill it can actually deliver.
   */
  readonly timeoutMs?: number;
}

/**
 * A bound `exec` for one live sandbox. Handed to the gate rather than the whole
 * sandbox handle so the gate cannot reach `run`/`close` — it may only observe.
 *
 * MAY REJECT: a provider-level transport fault (the docker daemon is wedged,
 * the container is gone) surfaces as a rejection, distinct from a command that
 * ran and exited non-zero. Callers must treat a rejection as "could not run",
 * never as "the tests failed".
 */
export type SandboxCommandRunner = (
  command: string,
  opts?: SandboxExecOptions,
) => Promise<SandboxExecResult>;

/**
 * GNU coreutils `timeout` exit status when the command outlived its bound.
 * The docker sandbox is `node:22-bookworm-slim`, so this is the real coreutils
 * behavior, not a guess.
 */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * `timeout -k` had to escalate to SIGKILL. Shells report a signal death as
 * `128 + signum`, and SIGKILL is 9.
 */
export const TIMEOUT_KILL_EXIT_CODE = 137;

/**
 * Grace between the polite signal and the hard one when a bound fires. Both
 * providers must promise the same thing about how hard they try to stop a
 * command, so the number lives here rather than being restated in each with a
 * comment claiming they match — comment-enforced equality across files is how
 * two providers quietly drift apart.
 */
export const EXEC_KILL_GRACE_MS = 10_000;

/**
 * Characters of each stream a provider retains. Fixed at the SDK docker
 * provider's `MAX_TAIL_CHARS` (chunk-NGBM7T3E.js), which the loop does not
 * override — the mac-host provider matches it so a classifier that decides on
 * output patterns gets the same amount of evidence whichever provider ran.
 */
export const EXEC_OUTPUT_TAIL_CHARS = 64 * 1024;

/**
 * Wrap `command` so a POSIX `timeout` inside the sandbox kills it.
 *
 * Single-quoted with the standard `'\''` escape rather than interpolated bare,
 * so a command containing spaces, quotes or shell metacharacters survives the
 * extra `sh -c` hop intact. Without the wrapper the caller's command would have
 * to be a single simple command forever — an invisible constraint that the
 * first pipeline someone writes would break silently.
 *
 * `-k 10s` is the escalation: SIGTERM first (vitest gets to flush), SIGKILL ten
 * seconds later if it ignored it.
 */
export function wrapWithPosixTimeout(
  command: string,
  timeoutMs: number,
): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const graceSeconds = Math.max(1, Math.ceil(EXEC_KILL_GRACE_MS / 1000));
  const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
  return `timeout -k ${graceSeconds}s ${seconds}s sh -c ${quoted}`;
}
