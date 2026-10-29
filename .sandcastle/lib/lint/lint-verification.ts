/**
 * In-sandbox LINT verification: run the project's own `lint` script inside the
 * sandbox and report what actually happened, so the loop never has to take an
 * agent's word for it.
 *
 * WHY THIS MODULE EXISTS. The lint gate used to be pure paperwork: it grepped
 * the shipped commit body for `SANDCASTLE-LINT: pass` and quarantined the
 * ticket when the token was absent. Issue #931 was correct, tested and
 * finished, and died anyway — the builder had stamped its own commit
 * `SANDCASTLE-LINT: n/a`. A recovery pass fixed the stamp and nothing else and
 * the work shipped, which is the proof that the code was never the problem.
 * An agent's honesty about paperwork must not be able to kill passing work when
 * the loop can simply RUN the linter and know the truth.
 *
 * WHY IN THE SANDBOX AND NOT ON THE HOST — the same reason its sibling
 * `../testing/test-verification.ts` gives at length: the per-issue worktree's
 * `node_modules` is installed by the Linux container, so a host-side `pnpm lint`
 * on a macOS host dies on a platform-specific binary before eslint sees a single
 * file. Running through the sandbox's own `exec` puts the command where its
 * dependencies already are, and makes the gate behave identically on both
 * halves of the fleet.
 *
 * THE CARDINAL RULE, INHERITED WHOLESALE FROM THE TEST GATE: a lint that could
 * not RUN is not a lint that FAILED. This runs unattended with no human to
 * override a wrong verdict, so every ambiguous signal resolves to
 * `inconclusive`. What the CALLER does with `inconclusive` is the caller's
 * decision, and it is the opposite of the test gate's: an unverifiable lint
 * leaves the missing certification exactly as it was, so the ticket still stops.
 * This module never decides that; it only reports.
 *
 * WHOLE PROJECT, NOT A SCOPED SUBSET — unlike the test gate, which resolves the
 * diff to owning workspace packages. `SANDCASTLE-LINT: pass` is a claim about
 * `pnpm lint`, the project's own script, so that is the claim this verifies.
 * The repo's script is turbo-driven and cached (`--cache-location
 * .cache/.eslintcache`), so the unchanged packages are replayed from cache
 * rather than re-linted, and there is no 79-minute-stall class of hazard to
 * scope around. The run is bounded anyway, twice: a timeout the sandbox itself
 * enforces and a host-side backstop for a transport that never answers.
 *
 * This module does NOT touch git, does not read the commit message (that is
 * `classifyLintCert`'s job in `main.mts`), does not decide ship/no-ship, and
 * never writes to the worktree.
 */

import type {
  SandboxCommandRunner,
  SandboxExecResult,
} from "../sandbox-exec.js";
import { stripAnsi } from "../testing/test-verification.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Wall-clock bound for the one `pnpm lint` command. Generous enough for a
 * COLD turbo/eslint cache across every package on a contended container, and
 * far short of the loop's per-issue ceiling. Overrunning it is `inconclusive`,
 * never `fail`.
 */
export const LINT_VERIFY_TIMEOUT_MS = 10 * 60_000;

/**
 * Max characters of captured output kept. eslint over a whole monorepo prints
 * hundreds of warning lines; nothing downstream needs more than the tail, which
 * is where the tally and the failure summary live.
 */
export const LINT_VERIFY_MAX_OUTPUT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LintRunStatus = "pass" | "fail" | "inconclusive";

/** Raw, transport-level facts about the lint command. */
export interface LintRunObservation {
  /**
   * True when the command never ran at all — no `exec` was available, or the
   * sandbox's `exec` rejected (a wedged docker daemon, a torn-down container).
   * Distinct from a command that ran and exited non-zero.
   */
  readonly spawnFailed: boolean;
  /** True when the sandbox timeout or the host-side backstop killed it. */
  readonly timedOut: boolean;
  /** Process exit code; null when killed by signal or never started. */
  readonly exitCode: number | null;
  /** stdout+stderr, ANSI-stripped and tail-truncated. */
  readonly output: string;
}

export interface LintRunVerdict {
  readonly status: LintRunStatus;
  /** One short human-readable clause naming the deciding signal, for the log line. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Substrings that prove the lint script could not RUN, as opposed to ran and
 * found problems. Exported so the tests assert against the real list rather
 * than a copy that can drift.
 *
 * Same caveat as its sibling in `../testing/test-verification.ts`: several of
 * these are ordinary strings an eslint message can contain (`not found` appears
 * in "Definition for rule … was not found"), so the list is only consulted when
 * {@link LINT_COMPLETED_SIGNALS} found no proof the run reached its end.
 */
export const LINT_INCONCLUSIVE_SIGNALS: readonly RegExp[] = [
  // Module/toolchain resolution — a half-installed or mismatched node_modules.
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /MODULE_NOT_FOUND/,
  /Cannot find package/,

  // pnpm/turbo could not select or start a `lint` script at all — a wiring
  // problem in the sandbox, not a lint result.
  /ERR_PNPM_NO_SCRIPT/,
  /ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT/,
  /Command "lint" not found/,
  /No projects matched the filters/,
  /could not find task/i,
  /Could not resolve workspaces/,

  // The invoked binary itself isn't on PATH. `/not found/` rather than
  // `/command not found/` for the reason the test gate documents: the
  // container's `/bin/sh` is dash, which phrases it `sh: 1: turbo: not found`.
  /not found/,
  /ENOENT/,
  /not recognized as an internal or external command/,
];

/**
 * Proof the lint run REACHED ITS END. Required before a zero exit may be read
 * as `pass`, and this is the asymmetry that matters most here.
 *
 * A zero exit code can be MANUFACTURED: the SDK's docker provider resolves
 * `exitCode: code ?? 0`, so a `docker exec` client killed mid-run — daemon
 * restart, container removed — arrives as exit 0 with empty output. Without
 * this guard that would read as "lint passed", and the ONE gate that exists to
 * replace an agent's unverified claim would be manufacturing a claim of its
 * own. A non-zero code needs no such proof: coercion can only ever fabricate a
 * zero.
 *
 * Both entries are real output from this repo's `pnpm lint`, captured from a
 * live run — turbo's task tally, and eslint's own summary line for a run that
 * completed with warnings.
 *
 * ACCEPTED COST: a project whose `lint` script prints neither reports
 * `inconclusive` rather than a fabricated `pass` — verification is lost for it,
 * never invented. Widen this list rather than dropping the requirement.
 */
export const LINT_COMPLETED_SIGNALS: readonly RegExp[] = [
  // turbo: ` Tasks:    15 successful, 15 total`
  /^\s*Tasks:\s+\d+\s+successful/m,
  // eslint: `✖ 277 problems (0 errors, 277 warnings)`
  /\d+\s+problems?\s*\(\d+\s+errors?/,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Pure. Turns the lint command's raw subprocess facts into a verdict. The
 * decision order mirrors `classifyTestRun` deliberately — the two gates share a
 * cardinal rule, and a reader who has understood one must not have to re-derive
 * the other:
 *   1. `spawnFailed` — nothing ran, so nothing can have failed.
 *   2. `timedOut` — the bound fired or something killed it; not a result.
 *   3. an {@link LINT_INCONCLUSIVE_SIGNALS} match, checked BEFORE the exit code
 *      and GUARDED by {@link LINT_COMPLETED_SIGNALS}: once the run printed its
 *      tally it demonstrably ran, so a runnability word further up came from
 *      eslint's own output and must not excuse a real failure.
 *   4. exit 0 WITH completion evidence — pass.
 *   5. exit 0 WITHOUT it — inconclusive (see the guard's own doc).
 *   6. exit null — killed by a signal outside our bound; unknown, not failed.
 *   7. anything else — the linter ran and reported problems.
 */
export function classifyLintRun(obs: LintRunObservation): LintRunVerdict {
  if (obs.spawnFailed) {
    return { status: "inconclusive", reason: "lint could not be spawned" };
  }
  if (obs.timedOut) {
    return {
      status: "inconclusive",
      reason:
        "lint did not complete — the bound fired or the process was killed",
    };
  }
  const completed = LINT_COMPLETED_SIGNALS.some((re) => re.test(obs.output));
  const matched = completed
    ? undefined
    : LINT_INCONCLUSIVE_SIGNALS.find((re) => re.test(obs.output));
  if (matched !== undefined) {
    return {
      status: "inconclusive",
      reason: `lint output matched inconclusive signal ${matched.source}`,
    };
  }
  if (obs.exitCode === 0) {
    return completed
      ? { status: "pass", reason: "`pnpm lint` exited 0 and reported a tally" }
      : {
          status: "inconclusive",
          reason:
            "`pnpm lint` exited 0 but printed no tally, so nothing proves it ran",
        };
  }
  if (obs.exitCode === null) {
    return {
      status: "inconclusive",
      reason: "lint was killed by a signal, exit code unknown",
    };
  }
  return { status: "fail", reason: `\`pnpm lint\` exited ${obs.exitCode}` };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * The exact shell string handed to the sandbox. No interpolation of any kind —
 * there is no package name, no path and no caller-supplied fragment in it, so
 * the injection surface its sibling has to guard against does not exist here.
 *
 * Every variable is load-bearing, for the reasons `buildPackageTestCommand`
 * argues at length: `CI=1` keeps watch-capable tools one-shot, and
 * `NO_COLOR=1`/`FORCE_COLOR=0` keep escape codes out of the middle of the tally
 * line, which is what {@link LINT_COMPLETED_SIGNALS} matches on. Output is
 * ANSI-stripped as well, because a guard that switches itself off when a tool
 * ignores an env var is not a guard.
 */
export function buildLintCommand(): string {
  return "env CI=1 NO_COLOR=1 FORCE_COLOR=0 pnpm lint";
}

/** Keep the TAIL: the tally and the failure summary are printed at the end. */
function truncateTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export interface VerifyProjectLintOptions {
  /** Override the sandbox-enforced bound. Tests use it; production does not. */
  readonly timeoutMs?: number;
}

/**
 * IO: run the project's `lint` script once, inside the sandbox, and report what
 * happened. NEVER THROWS — every failure becomes a verdict, so the ship gate
 * needs no try/catch and can never be crashed by a wedged sandbox.
 *
 * `exec` is optional because a sandbox handle may not offer one (a legacy or
 * mock handle). That is "could not verify", never "verified clean", and
 * deliberately NOT a fallback to a host-side run: on the docker path the host
 * cannot execute that worktree's `node_modules` at all, so a fallback would
 * produce a confident-looking result that is really the platform mismatch in
 * disguise.
 *
 * Bounded twice: `timeoutMs` is enforced by the provider INSIDE the sandbox
 * (the only bound that can actually kill the process), and a host-side race
 * covers the failure that bound cannot — the exec transport itself never
 * answering, which is what a wedged docker daemon looks like from here. Losing
 * that race leaves the underlying promise unobserved, not leaked; the sandbox is
 * torn down shortly after the gate returns.
 */
export async function verifyProjectLint(
  exec: SandboxCommandRunner | undefined,
  opts: VerifyProjectLintOptions = {},
): Promise<LintRunVerdict> {
  if (exec === undefined) {
    return {
      status: "inconclusive",
      reason: "sandbox does not expose command execution",
    };
  }
  const timeoutMs = opts.timeoutMs ?? LINT_VERIFY_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race<SandboxExecResult>([
      exec(buildLintCommand(), { timeoutMs }),
      new Promise<SandboxExecResult>((resolve) => {
        // The host-side backstop is deliberately slacker than the in-sandbox
        // bound: it must only fire when the transport itself has stopped
        // answering, never race the provider's own kill-and-report.
        timer = setTimeout(
          () =>
            resolve({
              stdout: "",
              stderr: "sandbox exec did not return before the host backstop",
              exitCode: null,
              timedOut: true,
            }),
          timeoutMs + 30_000,
        );
        // A pending backstop must never hold the loop's process open past its
        // own work.
        timer.unref?.();
      }),
    ]);
    return classifyLintRun({
      spawnFailed: false,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      // Strip BEFORE truncating: an escape sequence cut in half is no longer
      // recognisable to the stripper.
      output: truncateTail(
        stripAnsi(`${result.stdout}\n${result.stderr}`),
        LINT_VERIFY_MAX_OUTPUT_BYTES,
      ),
    });
  } catch (err) {
    // A REJECTION is the sandbox transport failing, never a lint result.
    return classifyLintRun({
      spawnFailed: true,
      timedOut: false,
      exitCode: null,
      output: `sandbox exec failed: ${(err as Error).message}`,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
