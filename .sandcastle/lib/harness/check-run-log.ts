/**
 * Persist WHAT THE CHECK RUNNER ACTUALLY DID to a file, next to the agent logs.
 *
 * ## The hole this closes
 *
 * Every thinking agent the loop dispatches leaves a session log at
 * `<repoRoot>/.sandcastle/logs/<sanitized-branch>-<role>.log` — for issue #803
 * there are seven of them (check-writer, its retry, implementer, reviewer, two
 * critiques, recovery, recovery-reviewer). The one step that OPENS A BROWSER
 * AND DECIDES THE TICKET'S FATE left nothing at all. #803 stopped
 * `stopped:no-failing-check` and the stop report had to offer the owner THREE
 * possible causes ("it timed out, could not be spawned, or produced no
 * Playwright tally line") because the machine could not tell them apart either.
 * The output existed — `runOnce` built `${stdout}\n${stderr}`, graded it, and
 * dropped it on the floor.
 *
 * ## The failure cases are the point
 *
 * A check that times out, cannot be spawned, or dies before printing anything
 * produces little or no output — and those are EXACTLY the runs somebody needs
 * to read afterwards. So {@link formatCheckRunLog} is built the other way up
 * from a normal transcript dump: the header is written from FACTS THE CALLER
 * ALWAYS HAS (the command, the budget it was given, how long it really ran, the
 * exit code or the absence of one, whether the bound fired, which attempt this
 * was, and the verdict that came out), and the runner's own output is merely
 * appended. A run with zero bytes of output still yields a file that names what
 * happened. A zero-byte file, or no file, is the bug being fixed here.
 *
 * ## Diagnostics may never decide a ticket
 *
 * {@link writeCheckRunLog} cannot throw and cannot alter a verdict: every
 * filesystem call is wrapped, and a failure routes to the caller's `onError`
 * rather than out of the function. It does not swallow the fault silently
 * either — a write that fails says so on the run log, which is the one place
 * still guaranteed to exist.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { CheckKind } from "../checkwriter/check-kind.js";
import {
  CHECK_RUN_LOG_MARKER,
  sanitizeBranchForLogFilename,
} from "../testing/log-prefilter.js";

/**
 * Which of the loop's two check executions produced this file.
 *
 * `must-fail-first` is the RED run (`runCheckCommand`, Piece D): the check is
 * run against untouched code and must fail. That is the run #803 died on.
 * `ship` is the ship-time / rescue re-run (`runHarnessScreenCheck`, Piece F/I)
 * against the finished code. Both go in the filename, so a directory listing
 * alone says which half of the gate was being executed.
 */
export type CheckRunPhase = "must-fail-first" | "ship";

/**
 * Replace the `user:password@` userinfo of any URL-shaped token with `***@`.
 *
 * The sandbox is handed `POSTGRES_URL=postgres://postgres:postgres@…` and a
 * connection failure prints the whole URL — which is precisely the line that
 * would have explained #803 — so anything persisting that output is a
 * credential-carrying surface. `SANDCASTLE_TEST_DB_URL` is an operator escape
 * hatch that MAY carry a real password, which is why this scrubs the userinfo
 * rather than trusting the default's throwaway one. The host:port stays
 * visible: that address is the entire diagnostic value of the line, and it is
 * not a secret.
 *
 * LIVES HERE, not in `../checkwriter/verify-checks.ts` where it was written,
 * for one mechanical reason: `verify-checks.ts` imports
 * `../harness/run-harness-check.js`, and `run-harness-check.ts` now imports
 * THIS module, so leaving it there and importing it back would close a module
 * cycle. `verify-checks.ts` re-exports it under its original name, so every
 * existing import site and its own tests are untouched.
 *
 * Total and non-throwing: a plain-text tail with no URL in it comes back
 * byte-for-byte.
 */
export function redactUrlCredentials(text: string): string {
  // `[^\s/@]+@` — userinfo cannot contain whitespace, a slash or a second `@`,
  // so this cannot run past the authority into a path or a following word.
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

/**
 * Characters of the runner's own output kept in the file.
 *
 * Far larger than `CHECK_OUTPUT_TAIL_CHARS` (4 KiB — what rides back on a
 * verdict and lands in the pushed run log) because this file is written under
 * `.sandcastle/logs/`, which `.sandcastle/.gitignore` excludes: it never leaves
 * the machine that ran it, so the trade is disk against diagnosis rather than
 * repo weight against diagnosis. Sized to the provider's OWN retention —
 * `EXEC_OUTPUT_TAIL_CHARS` is 64 KiB PER STREAM (`../sandbox-exec.ts`), so
 * 128 KiB is exactly "everything the provider was willing to give us", and
 * anything bigger could not occur.
 *
 * NOT `bound-output.mjs`: that filter is deliberately plain `.mjs` so it can be
 * piped to by `node` inside the sandbox, it is outside this project's typecheck
 * set by design (see its own module doc), and its head+tail+diagnostics shape is
 * tuned for what an AGENT re-reads every turn. Nothing re-reads this file on a
 * token budget, and dropping the middle of the one transcript a human opens
 * after a silent night is the opposite of the goal here.
 */
export const CHECK_RUN_LOG_OUTPUT_CHARS = 128 * 1024;

/** Where the file goes and what run it belongs to. Everything the NAME needs. */
export interface CheckRunLogTarget {
  /** Launch worktree root — the same `repoRoot` the SDK writes agent logs under. */
  readonly repoRoot: string;
  /** The PER-ISSUE branch (`agent/issue-803`), so the file sorts beside that issue's agent logs. */
  readonly branch: string;
  readonly issueNumber: number;
  readonly phase: CheckRunPhase;
  /**
   * Host path of the worktree the sandbox was cut from, when this host has one.
   * Reported, never used: the command itself runs in the sandbox's OWN repo
   * directory (`../sandbox-exec.ts` omits `cwd` on purpose — the docker
   * provider's `/home/agent/workspace` and this path are different strings for
   * the same bind mount), and a reader chasing a failure needs both names.
   */
  readonly worktreePath?: string;
  /**
   * Where a failure to WRITE gets reported. Never `throw` — see the module doc.
   * Omitted only by tests that assert the silent path.
   */
  readonly onError?: (message: string) => void;
}

/** Everything observed about ONE execution. Assembled by the caller, which always has it all. */
export interface CheckRunLogRecord {
  readonly kind: CheckKind;
  /** 1-based, within the one-re-run rule (`runHarnessScreenCheck` allows at most 2). */
  readonly attempt: number;
  /** How many attempts this phase may make in total (1 for the red run, 2 for the ship re-run rule). */
  readonly maxAttempts: number;
  /** The exact string handed to the sandbox. Reproducible by hand. */
  readonly command: string;
  /** The bound the run was GIVEN, in ms — the number a timeout must be read against. */
  readonly timeoutMs: number;
  /** Wall-clock the run actually consumed, in ms. Present even when nothing ran. */
  readonly durationMs: number;
  readonly startedAtIso: string;
  /** `null` when the process was killed with no status reported, or nothing ran. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /**
   * The transport/spawn fault, when `exec` itself rejected or was absent — as
   * distinct from a command that ran and exited non-zero. Undefined otherwise.
   */
  readonly failure?: string;
  /** Combined stdout+stderr, raw. Redacted and bounded HERE so no caller can forget either. */
  readonly output: string;
  /** What the classifier concluded, and why. Recorded, never decided here. */
  readonly verdict: string;
  readonly reason: string;
  /** Only the red run has one; `undefined` on the ship path. */
  readonly expectation?: string;
}

/** `420000` → `"420000 ms (7m 0s)"`. Both, because one is checkable and the other is readable. */
function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${String(ms)} ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${ms} ms (${m}m ${s}s)`;
}

/**
 * Render the whole file. PURE — no clock, no filesystem — so every branch below
 * is assertable against string literals, including the ones that only happen on
 * a night nobody is watching.
 *
 * The header comes first and is unconditional. That ordering is the whole
 * design: a reader opening this file after a silent stop learns what was run,
 * under what budget, for how long, and what came out, WITHOUT the output having
 * to exist.
 */
export function formatCheckRunLog(
  target: CheckRunLogTarget,
  rec: CheckRunLogRecord,
): string {
  const redacted = redactUrlCredentials(rec.output);
  const bounded =
    redacted.length <= CHECK_RUN_LOG_OUTPUT_CHARS
      ? redacted
      : `… ${redacted.length - CHECK_RUN_LOG_OUTPUT_CHARS} earlier characters omitted …\n` +
        redacted.slice(-CHECK_RUN_LOG_OUTPUT_CHARS);
  // Said in words, not left to an empty section. "The check printed nothing"
  // and "somebody truncated this file" look identical otherwise, and only one
  // of them is a finding.
  //
  // `trim()`, not `=== ""`: both runners build their output as
  // `${stdout}\n${stderr}`, so a run that printed absolutely nothing still
  // arrives here as a lone newline. Testing for the empty string would put the
  // most important sentence in this file out of reach of the exact case it was
  // written for — a check that timed out before emitting a byte.
  const outputBody =
    rec.output.trim() === ""
      ? "(the run produced NO output on either stream — not a truncated file)"
      : bounded;
  const exitLine =
    rec.exitCode === null
      ? "(none — the process reported no exit status)"
      : String(rec.exitCode);
  const lines = [
    "",
    // Matches the header the SDK writes atop every agent log in this directory,
    // so anything already reading these files recognises the format.
    `--- Run started: ${rec.startedAtIso} ---`,
    `sandcastle check run — phase=${target.phase}, attempt ${rec.attempt} of ${rec.maxAttempts}`,
    `issue: #${target.issueNumber}`,
    `branch: ${target.branch}`,
    `runner: ${rec.kind}`,
    ...(rec.expectation === undefined
      ? []
      : [`expected to observe: ${rec.expectation}`]),
    `command: ${rec.command === "" ? "(none — no command was built)" : rec.command}`,
    `working directory: the sandbox's own repo directory (the provider default; ` +
      `this host's path for it: ${target.worktreePath ?? "(none — no worktree on this host)"})`,
    `timeout budget: ${humanMs(rec.timeoutMs)}`,
    `ran for: ${humanMs(rec.durationMs)}`,
    `exit code: ${exitLine}`,
    `timed out: ${rec.timedOut ? "YES — the budget above fired" : "no"}`,
    `spawn/transport fault: ${rec.failure === undefined ? "(none)" : rec.failure}`,
    `verdict: ${rec.verdict} — ${rec.reason}`,
    `output bytes: ${rec.output.length}`,
    "--- combined stdout+stderr (credential-redacted) ---",
    outputBody,
    "--- end of check output ---",
    "",
  ];
  return lines.join("\n");
}

/**
 * `agent-issue-803-checkrun-must-fail-first-1.log`.
 *
 * Same directory, same `<sanitized-branch>-<role>.log` shape and the same
 * `sanitizeBranchForLogFilename` the SDK's own naming is mirrored from, so
 * whatever rotates or reaps `.sandcastle/logs/*.log` (today: `/sandcastle-clean`
 * deleting anything older than 7 days) treats these identically with no new
 * rule.
 *
 * `seq` — not the attempt number — is what makes the name unique, and that is
 * deliberate. The rescue ladder can call the ship-time harness up to three
 * times for ONE ticket, each of those making up to two attempts, so
 * `-attempt-1` would be overwritten five times over and the one file that
 * survived would be the least interesting. The attempt ordinal lives in the
 * header instead, where it can say "1 of 2" without competing for a filename.
 */
export function checkRunLogFilename(
  branch: string,
  phase: CheckRunPhase,
  seq: number,
): string {
  return `${sanitizeBranchForLogFilename(branch)}${CHECK_RUN_LOG_MARKER}${phase}-${seq}.log`;
}

/** `<repoRoot>/.sandcastle/logs` — where the SDK puts the agent logs. */
export function checkRunLogDir(repoRoot: string): string {
  return path.join(repoRoot, ".sandcastle", "logs");
}

/**
 * How many candidate names to try before giving up.
 *
 * The real ceiling is 2 attempts per phase per issue (one run plus its one
 * re-run), so 64 is far above the worst case that can actually occur —
 * high enough that a legitimate run never loses its file, low enough that a
 * pathological loop cannot spin here.
 */
const MAX_SEQ = 64;

/**
 * Write one file and return its path, or `undefined` if it could not be
 * written.
 *
 * NEVER THROWS, NEVER OVERWRITES. `wx` makes the create exclusive, so a second
 * attempt (or a second rescue round, or a peer process on the same branch)
 * takes the next free sequence number instead of erasing what is already
 * there — a first-attempt failure that the second attempt then passes is
 * precisely the signal worth keeping, and it is the one an overwrite destroys.
 *
 * Faults route to `target.onError` and stop there. Diagnostics must not be able
 * to fail, stall or alter a run — but a write that vanishes without a word
 * would re-create the blindness this module exists to remove, so silence is not
 * an option either.
 */
export function writeCheckRunLog(
  target: CheckRunLogTarget,
  rec: CheckRunLogRecord,
): string | undefined {
  try {
    const dir = checkRunLogDir(target.repoRoot);
    mkdirSync(dir, { recursive: true });
    const body = formatCheckRunLog(target, rec);
    for (let seq = 1; seq <= MAX_SEQ; seq += 1) {
      const full = path.join(
        dir,
        checkRunLogFilename(target.branch, target.phase, seq),
      );
      try {
        writeFileSync(full, body, { encoding: "utf8", flag: "wx" });
        return full;
      } catch (err) {
        // EEXIST is the expected, healthy case: take the next number. Any
        // other error is real and is reported by the throw below.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`all ${MAX_SEQ} candidate filenames were already taken`);
  } catch (err) {
    target.onError?.(
      `[issue=${target.issueNumber}] could not persist the ${target.phase} ` +
        `check-run log — ${err instanceof Error ? err.message : String(err)}. ` +
        `The check itself is unaffected; only its transcript was lost.`,
    );
    return undefined;
  }
}
