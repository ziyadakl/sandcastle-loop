/**
 * In-sandbox test-verification gate: the pure classifier that turns one
 * package's raw command outcome into pass/fail/inconclusive, plus the bounded
 * runner that executes `pnpm --filter <pkg> run test` INSIDE the sandbox.
 *
 * WHY THIS MODULE EXISTS: the loop ships a ticket the moment the implementer's
 * commit message says `SANDCASTLE-TEST: pass` — nothing ever re-runs the
 * suite, so a lying or wrong commit message ships broken code unchallenged.
 * This module is the piece that actually runs the affected packages' tests and
 * reports what happened, closing that gap.
 *
 * WHY IN THE SANDBOX AND NOT ON THE HOST: the per-issue worktree's
 * `node_modules` is installed by the container, so it holds Linux binaries. A
 * host-side run on macOS dies with `Cannot find module
 * @rollup/rollup-darwin-arm64` before a single test executes — the gate landed
 * INCONCLUSIVE every time and verified nothing on the whole Mac half of the
 * fleet. Executing through the sandbox's own `exec` puts the command where its
 * dependencies already are, and makes the gate behave identically on macOS and
 * Linux because in both cases the tests run in the container.
 *
 * THE SINGLE MOST IMPORTANT RULE: a test that could not RUN is not a test
 * that FAILED. This gate's only dangerous failure direction is blocking a
 * GOOD ticket on a broken environment (missing toolchain, unreachable
 * Postgres, no browser binary, a stalled process) — the loop has no human in
 * the loop to notice and override a false quarantine. So "inconclusive" is a
 * real third state, not a fallback spelling of "fail", and every ambiguous
 * signal resolves toward it. See {@link classifyTestRun} for the precedence
 * and {@link INCONCLUSIVE_SIGNALS} for the concrete evidence patterns.
 *
 * Second rule: never the whole-repo suite, and never unbounded. A bare
 * whole-repo `pnpm test` on a contended host once ran 79 minutes and
 * false-quarantined an issue that had nothing to do with the slow package.
 * {@link runScopedTests} only ever runs the packages it's given (scope
 * resolution is `./workspace-packages.js`'s job, not this module's), runs
 * them SEQUENTIALLY to avoid piling load onto an already-contended machine,
 * and every command is bounded by both a per-package timeout and an overall
 * ceiling this module enforces itself.
 *
 * This module does NOT decide which packages are in scope (that's
 * `./workspace-packages.js`, resolving changed paths to package names), does
 * NOT touch git, does not make the ship/no-ship decision (that's the gate that
 * calls this), and no longer owns a subprocess runner at all — it is handed a
 * {@link SandboxCommandRunner} and only builds command strings and interprets
 * results. It never writes to the worktree.
 *
 * Invocation discipline: the sandbox seam takes a SHELL STRING, so the package
 * name is validated against {@link SAFE_PACKAGE_NAME} before interpolation
 * rather than trusted. Package names come from the repo's own manifests, not
 * from an attacker — but they reach this module through a chain of file reads
 * that a malicious dependency could influence, and "it's our own data" is
 * exactly the assumption that makes shell-string builders dangerous. A name
 * that fails the check is inconclusive, never silently run.
 */

import type {
  SandboxCommandRunner,
  SandboxExecResult,
} from "../sandbox-exec.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Per-package subprocess timeout. 8 minutes is generous for a single
 * package's `vitest` run on a contended host while still being far short of
 * the overall ceiling, so one slow package can't alone eat the whole budget.
 */
export const TEST_VERIFY_PACKAGE_TIMEOUT_MS = 8 * 60_000;

/**
 * Overall ceiling across every package in scope for one ticket. Exists because
 * the 79-minute whole-repo stall that motivated "never unbounded" (see module
 * comment) can still happen one contended package at a time — this is the
 * backstop even when each individual package looks reasonable.
 *
 * {@link runScopedTests} ENFORCES this itself rather than documenting it as the
 * caller's job. An earlier draft exported the constant and left the wrapping to
 * `main.mts`; that made the module's own "never unbounded" invariant
 * unenforceable by the module, so a second call site that forgot the wrapper
 * would silently get `N × TEST_VERIFY_PACKAGE_TIMEOUT_MS` with nothing failing.
 */
export const TEST_VERIFY_TOTAL_CEILING_MS = 20 * 60_000;

/**
 * Max characters of captured output kept per package. `vitest` output on a
 * real failure can run to megabytes of stack traces and diff noise; nothing
 * downstream (the classifier, the ship-log line) needs more than the tail of
 * that.
 *
 * The providers already bound their capture to a 64KB tail per stream, so in
 * practice this ceiling is never the binding one. It stays as the module's own
 * guarantee rather than an assumption about a provider it does not own: a
 * future provider that captures everything must not be able to hand the
 * classifier a megabyte.
 */
export const TEST_VERIFY_MAX_OUTPUT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TestRunStatus = "pass" | "fail" | "inconclusive";

/** Raw, transport-level facts about ONE package's test command. */
export interface TestRunObservation {
  readonly packageName: string;
  /**
   * True when the command never ran at all — the sandbox's `exec` rejected (a
   * wedged docker daemon, a torn-down container), or the package name was
   * rejected by {@link SAFE_PACKAGE_NAME} before anything was executed.
   * Distinct from a command that ran and exited non-zero.
   */
  readonly spawnFailed: boolean;
  /** True when the per-package timeout or the overall ceiling killed it. */
  readonly timedOut: boolean;
  /** Process exit code; null when killed by signal or never started. */
  readonly exitCode: number | null;
  /** stdout+stderr, already tail-truncated by the provider and this module. */
  readonly output: string;
}

export interface TestRunVerdict {
  readonly status: TestRunStatus;
  /** One short human-readable clause naming the deciding signal, for the log line. */
  readonly reason: string;
}

/**
 * A verdict with the package it belongs to. Named rather than respelled as an
 * inline intersection at each use: the pair is one concept (this package got
 * this verdict), and the three inline copies it replaced had already drifted —
 * one of them had dropped `readonly`.
 */
export interface PackageTestVerdict extends TestRunVerdict {
  readonly packageName: string;
}

// ---------------------------------------------------------------------------
// Inconclusive-signal evidence
// ---------------------------------------------------------------------------

/**
 * Substrings/patterns that prove the suite could not RUN — as opposed to ran
 * and failed. Exported so the unit tests assert on the real list, not a copy
 * that could silently drift from what {@link classifyTestRun} actually
 * checks.
 *
 * IMPORTANT CAVEAT: these are matched against the whole captured output, and
 * several of them (`ECONNREFUSED`, `ENOENT`, `Cannot find module`) are ordinary
 * strings a test's OWN error-path assertions can print. Unguarded, a genuinely
 * failing suite could excuse itself. {@link SUITE_COMPLETED_SIGNALS} is that
 * guard: this list is only consulted when the suite never printed a tally, i.e.
 * when it plausibly never finished running.
 *
 * What remains after the guard is the narrow, accepted false-negative: a suite
 * that dies DURING collection because the implementer's changed code has a real
 * bad import reads as inconclusive. That is deliberate — the alternative is
 * false-quarantining every ticket on a host whose toolchain is merely broken,
 * and per the single most important rule, blocking a good ticket is the worse
 * failure mode of the two.
 */
export const INCONCLUSIVE_SIGNALS: readonly RegExp[] = [
  // Module/toolchain resolution: a half-installed or mismatched node_modules,
  // or any other unresolved dependency. The Linux→Mac
  // `@rollup/rollup-darwin-arm64` case that motivated this entry is now
  // structurally impossible (the command runs in the container that installed
  // the deps), but a `pnpm install` interrupted mid-flight still produces it.
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /MODULE_NOT_FOUND/,
  /Cannot find package/,

  // pnpm could not select or start a "test" script at all — a scope/wiring
  // problem on the host, not a test result.
  /ERR_PNPM_NO_MATCHING_VERSION/,
  /ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT/,
  /No projects matched the filters/,
  /Command "test" not found/,

  // The invoked binary itself isn't on PATH — a provisioning gap.
  //
  // `/not found/` deliberately, NOT `/command not found/`. The sandbox runs
  // commands through `sh -c`, and the container's `/bin/sh` is dash, which
  // phrases it `sh: 1: timeout: not found` — no "command" prefix. VERIFIED in
  // a live container. The narrower pattern missed it, so a missing `timeout`
  // binary exited 127 with no matching signal and classified as FAIL: a
  // toolchain gap false-quarantining a healthy ticket, which is the one
  // outcome this module's cardinal rule forbids. Bash's own phrasing
  // (`command not found`) is a superset of this, so nothing is lost.
  //
  // Broad on purpose, and safe to be: {@link SUITE_COMPLETED_SIGNALS} gates
  // this whole list, so a test asserting the words "not found" in its own
  // output cannot excuse a suite that demonstrably ran.
  /not found/,
  /ENOENT/,
  /not recognized as an internal or external command/,

  // Database unreachable — the suite needs Postgres and the host's instance
  // is down, unmigrated, or misconfigured; not something the ticket's code
  // caused.
  /ECONNREFUSED/,
  /could not connect to server/,
  /Connection terminated/,
  /password authentication failed/,
  /database .* does not exist/,

  // Browser binary missing — Playwright/browser-driven suites need an
  // installed browser the host never provisioned.
  /Executable doesn't exist/,
  /playwright install/,
  /Failed to launch the browser/,

  // Nothing to run — an empty/misfiltered suite is not evidence of a
  // failure, it's evidence the scope resolution or filter matched nothing.
  /No test files found/,
];

/**
 * Proof that the runner REACHED THE END of a real suite — vitest only prints
 * these tallies once collection succeeded and every file ran.
 *
 * This exists to close the hole {@link INCONCLUSIVE_SIGNALS} would otherwise
 * open. Those patterns are matched against the whole captured output, and this
 * repo's own suites assert on error paths — a genuinely FAILING test whose diff
 * output happens to print `ECONNREFUSED`, `ENOENT` or `Cannot find module`
 * would match a signal and be excused as "could not run", shipping the exact
 * broken work this gate exists to catch. A suite that printed its tally
 * demonstrably RAN, so any runnability word further up is a red herring from a
 * test's own output, not evidence about the host.
 *
 * Deliberately narrow: matching nothing only costs a false INCONCLUSIVE (safe),
 * while matching too eagerly would restore the false-quarantine risk.
 */
export const SUITE_COMPLETED_SIGNALS: readonly RegExp[] = [
  /^\s*Test Files\s+\d/m,
  /^\s*Tests\s+\d/m,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Pure. Turns one package's raw subprocess facts into a verdict.
 *
 * Decision order is deliberate and each branch is a distinct real-world
 * cause:
 *   1. `spawnFailed` — the process never ran at all, so there is nothing to
 *      have failed.
 *   2. `timedOut` — killed by the per-package or overall ceiling; we don't
 *      know whether the suite would have passed, only that it didn't finish.
 *   3. {@link INCONCLUSIVE_SIGNALS} match in the output — checked BEFORE the
 *      exit code on purpose. This precedence is the crux of the whole
 *      module: the gate's only dangerous direction is blocking a good
 *      ticket, never letting a bad one through undetected (a human/reviewer
 *      still sees the diff), so any signal that's ambiguous between "the
 *      host is broken" and "the code is broken" resolves to inconclusive
 *      rather than fail, even though the exit code is very likely non-zero
 *      in this branch too. GUARDED by {@link SUITE_COMPLETED_SIGNALS}: once
 *      the suite printed its tally it demonstrably RAN, so a runnability word
 *      in the output came from a test's own assertion output and must not
 *      excuse the failure.
 *   4. `exitCode === 0` AND the suite printed a tally — pass. The tally is
 *      REQUIRED, and this is the asymmetry that matters most in the module.
 *      A zero exit code can be MANUFACTURED: the SDK's docker provider
 *      resolves `exitCode: code ?? 0` (chunk-CP3TYXZA.js), so a `docker exec`
 *      client killed by a signal — daemon restart, container removed
 *      mid-run — arrives here as exit 0 with truncated or empty output. Under
 *      the old rule that read as PASS: the gate manufacturing confidence it
 *      never had, on the one check that exists to catch a false
 *      `SANDCASTLE-TEST: pass`. Requiring positive evidence closes it.
 *
 *      The reverse is NOT symmetrical and deliberately so: coercion can only
 *      ever fabricate a ZERO, so a non-zero code is evidence no accident
 *      produces, and {@link INCONCLUSIVE_SIGNALS} already covers the
 *      environment causes of one. Fail therefore needs no tally.
 *
 *      Accepted cost: a package whose `test` script is not vitest prints no
 *      tally, so it reports inconclusive instead of pass — verification is
 *      lost for that package rather than fabricated for it. Every package in
 *      this workspace runs vitest today; if that changes, widen
 *      {@link SUITE_COMPLETED_SIGNALS} rather than dropping the requirement.
 *   5. `exitCode === 0` with NO tally — inconclusive, per the above.
 *   6. `exitCode === null` — killed by a signal outside our own timeout
 *      handling (e.g. OOM-killed by the OS); we don't know what happened,
 *      so this is inconclusive, not fail.
 *   7. anything else — a clean non-zero exit with no inconclusive signal in
 *      the output: the suite ran and told us it failed.
 */
export function classifyTestRun(obs: TestRunObservation): TestRunVerdict {
  if (obs.spawnFailed) {
    return {
      status: "inconclusive",
      reason: `${obs.packageName}: process could not be spawned`,
    };
  }
  if (obs.timedOut) {
    // Worded for what is actually known. The docker provider infers this from
    // exit 124/137, and 137 is also what an OOM-killed vitest returns — so
    // "timed out" would be a false cause in the durable run log. Both really
    // are "the bound fired or something killed it", and neither is a result.
    return {
      status: "inconclusive",
      reason: `${obs.packageName}: did not complete — the bound fired or the process was killed`,
    };
  }
  const suiteCompleted = SUITE_COMPLETED_SIGNALS.some((re) =>
    re.test(obs.output),
  );
  const matchedSignal = suiteCompleted
    ? undefined
    : INCONCLUSIVE_SIGNALS.find((re) => re.test(obs.output));
  if (matchedSignal !== undefined) {
    return {
      status: "inconclusive",
      reason: `${obs.packageName}: output matched inconclusive signal ${matchedSignal.source}`,
    };
  }
  if (obs.exitCode === 0) {
    return suiteCompleted
      ? { status: "pass", reason: `${obs.packageName}: exit 0 with suite tally` }
      : {
          status: "inconclusive",
          reason: `${obs.packageName}: exit 0 but the suite never printed a result tally, so nothing proves it ran`,
        };
  }
  if (obs.exitCode === null) {
    return {
      status: "inconclusive",
      reason: `${obs.packageName}: killed by signal, exit code unknown`,
    };
  }
  return {
    status: "fail",
    reason: `${obs.packageName}: exit ${obs.exitCode}`,
  };
}

/**
 * Pure. Fold per-package verdicts into one aggregate for the gate.
 *
 * Any real `fail` wins outright — one genuine failure already decides the
 * gate regardless of how many other packages passed or were inconclusive.
 * Otherwise any `inconclusive` wins, per the module's central rule: an
 * unknown result must never be silently treated as a pass. An empty list
 * (nothing was in scope to run) is itself inconclusive rather than a vacuous
 * pass — "no evidence either way" is the honest read, not "nothing to worry
 * about".
 */
export function aggregateTestRuns(
  results: readonly PackageTestVerdict[],
): TestRunVerdict {
  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    return {
      status: "fail",
      reason: `failing packages: ${failed.map((r) => r.packageName).join(", ")}`,
    };
  }
  const inconclusive = results.filter((r) => r.status === "inconclusive");
  if (inconclusive.length > 0) {
    return {
      status: "inconclusive",
      reason: `inconclusive packages: ${inconclusive
        .map((r) => r.packageName)
        .join(", ")}`,
    };
  }
  if (results.length === 0) {
    return { status: "inconclusive", reason: "no packages in scope" };
  }
  return { status: "pass", reason: `all ${results.length} package(s) passed` };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
/**
 * A package name safe to interpolate into the shell string handed to the
 * sandbox. Deliberately a WHITELIST of what the registry actually permits —
 * lowercase letters, digits, `.`, `_`, `-`, and an optional `@scope/` prefix —
 * rather than a blacklist of metacharacters, because a blacklist is only ever
 * as complete as the last person who thought about it.
 *
 * A name outside this set is not escaped and run; it is refused. The gate then
 * reports inconclusive, which is the correct read: we could not verify that
 * package, and we will not guess at quoting to try.
 */
export const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

/**
 * The command run for one package, as a shell string for the sandbox seam.
 *
 * `env …` rather than a bare `CI=1 pnpm …` prefix: the string is additionally
 * wrapped by the provider's `timeout`, and `timeout CI=1 pnpm` is not a thing —
 * `env` is the portable way to set variables for a command that something else
 * is about to wrap.
 *
 * Every variable here is load-bearing:
 *   - `CI=1` — the `test` script in this repo's packages is a bare `vitest`,
 *     and without `CI` (or a TTY) vitest can enter WATCH mode and hang forever
 *     instead of running once and exiting, silently eating the whole timeout
 *     budget and reporting as a timeout instead of a real result.
 *   - `NO_COLOR=1` — vitest colorizes its summary even under `CI`, and the
 *     escape codes land in the middle of the tally line
 *     (`\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m11 passed`), which defeats
 *     {@link SUITE_COMPLETED_SIGNALS} and therefore re-opens the hole that
 *     guard exists to close. VERIFIED against a live container: `FORCE_COLOR=0`
 *     alone does NOT suppress them; `NO_COLOR=1` does.
 *   - `FORCE_COLOR=0` — kept as the belt to `NO_COLOR`'s braces; some tools
 *     honour only one of the two.
 *
 * Colour is additionally stripped from the captured output before
 * classification, because a guard that silently switches itself off when a
 * tool ignores an env var is not a guard.
 *
 * Exported so the tests assert on the exact string the sandbox will receive,
 * rather than on a paraphrase of it.
 */
export function buildPackageTestCommand(packageName: string): string {
  return `env CI=1 NO_COLOR=1 FORCE_COLOR=0 pnpm --filter ${packageName} run test`;
}

/**
 * ANSI CSI/OSC escape sequences. Stripped from captured output before it
 * reaches {@link classifyTestRun}, so both signal lists match against plain
 * text regardless of whether the tool honoured `NO_COLOR`.
 *
 * This is not cosmetic. `SUITE_COMPLETED_SIGNALS` matches `^\s*Test Files\s+\d`
 * and vitest's real tally line is `\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m11
 * passed` — the escapes sit both before `Test Files` and between it and the
 * digit, so the guard matched NOTHING against un-stripped output. With the
 * guard dead, `INCONCLUSIVE_SIGNALS` was consulted on every run and a genuinely
 * failing suite that printed `ECONNREFUSED` from its own assertions would have
 * excused itself as "could not run" and shipped.
 */
const ANSI_ESCAPE = new RegExp(
  [
    // CSI — colour, cursor, erase. This is what vitest actually emits.
    "\\u001B\\[[0-9;?]*[ -/]*[@-~]",
    // OSC — window titles / hyperlinks, terminated by BEL or ST.
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
  ].join("|"),
  "g",
);

/** Remove ANSI escape sequences so the signal lists match against plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** What a caller may set. */
export interface RunPackageTestsOptions {
  readonly perPackageTimeoutMs?: number;
  /** Overall ceiling for {@link runScopedTests}; ignored by {@link runPackageTests}. */
  readonly totalCeilingMs?: number;
}

/**
 * {@link RunPackageTestsOptions} plus the one field only {@link runScopedTests}
 * may set. Split into its own type rather than shipped as an underscore-prefixed
 * member of the public one: "internal, callers do not set it" written in a doc
 * comment is a convention, and a convention on an exported interface is an
 * invitation. Here the compiler enforces it.
 */
interface InternalRunPackageTestsOptions extends RunPackageTestsOptions {
  /**
   * Host-side backstop deadline, as an absolute epoch-ms instant, computed by
   * {@link runScopedTests} from `totalCeilingMs`.
   */
  readonly deadlineAt?: number;
}

/**
 * Truncate to the TAIL, not the head, of `text`. `vitest` prints its failure
 * summary at the end of the run, so keeping the head would throw away
 * exactly the part a human (or the classifier's signal matching) needs most.
 */
function truncateTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * Race `work` against a wall-clock deadline on the HOST.
 *
 * This is a BACKSTOP, not the primary bound — the primary bound is the
 * `timeoutMs` the provider enforces inside the sandbox, which can actually kill
 * the process. This one only stops the loop from waiting, and exists for the
 * failure the in-sandbox timeout cannot cover: the exec transport itself
 * hanging (a wedged docker daemon never returns, so a `timeout` inside a
 * container we can no longer talk to never gets its exit status back to us).
 *
 * Losing the race leaves the underlying promise pending; it is unobserved, not
 * leaked, and the sandbox is torn down shortly after the gate returns.
 */
async function withHostDeadline<T>(
  work: Promise<T>,
  deadlineAt: number | undefined,
  onExpiry: () => T,
): Promise<T> {
  if (deadlineAt === undefined) return work;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return onExpiry();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onExpiry()), remaining);
        // `unref` so a pending backstop can never hold the loop's process open
        // past its own work — the timer is a bound on this call, not a reason
        // to live.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * IO: run ONE package's tests through `exec`, inside the sandbox. Never throws
 * — every failure (a rejected exec, a timeout, a non-zero exit) becomes an
 * observation for {@link classifyTestRun} to interpret, so a caller can always
 * fold results without a try/catch of its own.
 *
 * Read-only with respect to the worktree: this only executes a command and
 * reads its output. It leaves no state behind for the gate to clean up.
 */
export async function runPackageTests(
  exec: SandboxCommandRunner,
  packageName: string,
  opts: InternalRunPackageTestsOptions = {},
): Promise<TestRunObservation> {
  if (!SAFE_PACKAGE_NAME.test(packageName)) {
    return {
      packageName,
      spawnFailed: true,
      timedOut: false,
      exitCode: null,
      output: `refusing to build a shell command for unsafe package name ${JSON.stringify(packageName)}`,
    };
  }
  const timeoutMs = opts.perPackageTimeoutMs ?? TEST_VERIFY_PACKAGE_TIMEOUT_MS;
  try {
    const result = await withHostDeadline<SandboxExecResult>(
      exec(buildPackageTestCommand(packageName), { timeoutMs }),
      opts.deadlineAt,
      () => ({
        stdout: "",
        stderr: "sandbox exec did not return before the overall ceiling",
        exitCode: null,
        timedOut: true,
      }),
    );
    return {
      packageName,
      spawnFailed: false,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      // Strip BEFORE truncating: an escape sequence split across the cut would
      // otherwise leave a half-sequence the strip can no longer recognise.
      output: truncateTail(
        stripAnsi(`${result.stdout}\n${result.stderr}`),
        TEST_VERIFY_MAX_OUTPUT_BYTES,
      ),
    };
  } catch (err) {
    // A REJECTION is the sandbox transport failing, never a test result. It
    // must read as "could not run" — classifying it as a failure would let a
    // wedged docker daemon quarantine healthy tickets one after another.
    return {
      packageName,
      spawnFailed: true,
      timedOut: false,
      exitCode: null,
      output: `sandbox exec failed: ${(err as Error).message}`,
    };
  }
}

/**
 * IO: run each package in `packageNames` in sequence and fold into one
 * aggregate verdict. Never throws.
 *
 * SEQUENTIAL, not parallel — deliberately. A contended machine is exactly the
 * scenario that produced the 79-minute whole-repo stall this gate exists to
 * avoid (see module comment); running N package suites in parallel on that
 * same contended machine multiplies the contention instead of avoiding it.
 *
 * Stops EARLY the moment a `fail` is observed: one real failure already
 * decides the gate (see {@link aggregateTestRuns}), so there is no value in
 * spending the rest of the time budget running further packages whose
 * result can no longer change the outcome — every remaining package is left
 * out of `perPackage` entirely, not recorded as skipped/inconclusive, since
 * they were never run and never claimed to be.
 *
 * OWNS its {@link TEST_VERIFY_TOTAL_CEILING_MS} ceiling: the deadline is
 * computed here and applied twice — as a shrinking per-package `timeoutMs` the
 * sandbox enforces, and as the host-side backstop in {@link runPackageTests} —
 * so no caller can forget to bound the loop and no single package can overrun
 * the whole budget. An expired budget surfaces as inconclusive, never as a
 * failure.
 */
export async function runScopedTests(
  exec: SandboxCommandRunner,
  packageNames: readonly string[],
  opts: RunPackageTestsOptions = {},
): Promise<{
  readonly verdict: TestRunVerdict;
  readonly perPackage: readonly PackageTestVerdict[];
}> {
  const deadlineAt =
    Date.now() + (opts.totalCeilingMs ?? TEST_VERIFY_TOTAL_CEILING_MS);
  const perPackage: PackageTestVerdict[] = [];
  for (const packageName of packageNames) {
    // Shrink each package's own bound to whatever is left of the overall
    // budget. Without this the LAST package could still be handed the full
    // per-package timeout after the budget was already nearly spent, and only
    // the host-side backstop would stop it — leaving a real test run going
    // inside the container with nobody waiting on it.
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      perPackage.push({
        packageName,
        status: "inconclusive",
        reason: `${packageName}: overall ceiling reached before it ran`,
      });
      break;
    }
    const obs = await runPackageTests(exec, packageName, {
      ...opts,
      perPackageTimeoutMs: Math.min(
        opts.perPackageTimeoutMs ?? TEST_VERIFY_PACKAGE_TIMEOUT_MS,
        remaining,
      ),
      deadlineAt,
    });
    const verdict = classifyTestRun(obs);
    perPackage.push({ ...verdict, packageName });
    if (verdict.status === "fail") break;
  }
  return { verdict: aggregateTestRuns(perPackage), perPackage };
}
