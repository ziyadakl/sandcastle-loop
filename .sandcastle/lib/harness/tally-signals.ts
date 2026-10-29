/**
 * The one home for "what in this run PROVES something actually happened"
 * (issue #956; rewritten 2026-08-06 to close the forged-tally hole).
 *
 * ## Why any of this exists at all
 *
 * Every gate in this loop that reads a subprocess result shares one
 * asymmetry: an exit code can be MANUFACTURED, output cannot. The SDK's docker
 * provider resolves `exitCode: code ?? 0`, so a `docker exec` CLIENT killed
 * mid-run — daemon restart, container removed, host reboot — arrives at the
 * classifier as exit 0 with truncated or empty output. Read as a bare code
 * that is a PASS: the gate manufacturing confidence it never had, on the one
 * check that exists to catch a false claim. So every verdict here requires
 * POSITIVE EVIDENCE that the suite really ran, and treats a code with no such
 * evidence behind it as inconclusive.
 *
 * ## THE HOLE THIS MODULE USED TO HAVE, and why regexes over stdout are gone
 *
 * Until 2026-08-06 that positive evidence was a set of REGEXES matched against
 * the run's combined stdout+stderr — `/^\s*Tests\s+[^\n]*\b\d+\s+failed\b/m`
 * for vitest, `/\b\d+\s+passed\b/i` anywhere at all for Playwright. Both
 * classifiers (`./verdict.ts` at ship time, `../checkwriter/verify-checks.ts`
 * for the must-fail-first proof) read the same stream.
 *
 * THE CHECK FILE IS WRITTEN BY AN AGENT AND ITS OWN OUTPUT IS IN THAT STREAM.
 * So the check could simply print the sentence that constituted its own proof.
 * Demonstrated against the real classifiers with a real committed check:
 *
 * ```ts
 * import { CreateDealSchema } from "../../deals.js";   // satisfies the import scan
 * console.log("Tests  1 failed (1)");                  // launders any non-zero exit into RED
 * console.log("Tests  1 passed (1)");                  // launders any exit-0 into MATCH
 * it.skip("never runs", () => { expect(1).toBe(2); }); // …and nothing is ever graded
 * ```
 *
 * Real vitest 3.2.4 output for that file is an honest `Tests  1 skipped (1)`;
 * with the two forged lines in the stream `classifyCheckRun("unit", exit 1,
 * expect "red")` returned `pass` (minting a byte-locked must-fail-first
 * receipt) and `classifyHarnessRun("unit", exit 0)` returned `match` (shipping
 * the ticket). Zero assertions ever executed. Playwright's route was worse:
 * `\b\d+\s+passed\b` matched ANYWHERE, so `1 passed` in any sentence did it.
 *
 * `--silent=true` (vitest) suppresses `console.*` and is kept below as a first
 * layer, but it is NOT the fix: `process.stdout.write("\nTests  1 passed
 * (1)\n")` survives it byte-for-byte, verified by hand. And Playwright has no
 * equivalent flag at all. **No amount of pattern-tightening can fix this**: the
 * runner's summary and the check's own printing arrive on the SAME merged
 * stream with nothing to tell them apart, so any rule expressible as "this text
 * appeared" is a rule the check can satisfy by printing that text.
 *
 * ## THE FIX: evidence the check cannot author, on a channel it does not own
 *
 * The check file's exact bytes are sha256-locked by the must-fail-first receipt
 * BEFORE the run, and the builder cannot edit it (the protected-path lock
 * covers the whole check directory). So a value the HOST generates at run time,
 * per run, cannot appear inside the check. That is the asymmetry, and this
 * module spends it twice:
 *
 *   1. **A machine-readable report at a nonce-named path.** The command asks
 *      the runner for its own structured report — `--reporter=json` for vitest,
 *      `--reporter=line,json` + `PLAYWRIGHT_JSON_OUTPUT_FILE` for Playwright —
 *      written to {@link checkReportPathFor}. The verdict is then read from
 *      COUNTERS (`numFailedTests` / `stats.unexpected` …), not from prose. A
 *      check that prints is printing into a stream nothing reads any more.
 *   2. **A host-printed evidence line carrying the nonce.** After the runner
 *      exits, {@link runEvidenceEpilogue} — appended by the HOST, not by the
 *      check — reads that report and prints ONE line containing the nonce, the
 *      runner's true exit code, and the counters. {@link parseRunEvidence}
 *      accepts nothing else. The check cannot forge the line because it cannot
 *      know the nonce, and it cannot suppress it because it runs in a process
 *      that is already dead by the time the line is printed.
 *
 * Both are required. (1) alone would leave the report readable but
 * unauthenticated — a killed `docker exec` client still returns exit 0 with
 * truncated output, and a truncated stream that happens to end mid-report must
 * not be read as a result. (2) alone would authenticate an exit code the
 * runner's own prose still has to interpret.
 *
 * ### How this meets each requirement it was set
 *
 *   - *Attributable to the RUNNER, not the check.* The counters come from a
 *     file the RUNNER writes, and they reach the classifier only inside a line
 *     the HOST prints, keyed by a nonce neither the check nor the builder has
 *     ever seen.
 *   - *Printing anything — `console.log`, `process.stdout.write`,
 *     `process.stderr.write`, a spawned subprocess — manufactures nothing.*
 *     Nothing in the verdict path reads free-text output any more. The one
 *     structured thing that IS read must carry a 128-bit nonce.
 *   - *Fails CLOSED.* No line, an unparseable line, a missing report, a
 *     negative/absent counter, or counters that contradict the exit code all
 *     read as "proved nothing" — never a pass, never a confident red. An
 *     inconclusive must-fail-first mints no receipt (`verify-checks.ts`).
 *   - *Survives the existing constraints.* The epilogue is one POSIX-`sh`
 *     fragment appended to the same single command string, so
 *     `SandboxCommandRunner` and the provider's `timeout` wrapper are unchanged;
 *     it ends in `exit $__sc_rc`, so the process exit code the caller observes
 *     is still the RUNNER's and the provider's `timedOut` inference (exit
 *     124/137 from `timeout`) is untouched. A killed `docker exec` client that
 *     manufactures exit 0 with truncated output now carries no evidence line at
 *     all, so it reads inconclusive — which is strictly stronger than the
 *     regexes were.
 *   - *Weakens no existing defence.* Every case the old regexes caught is
 *     caught here by construction, and read off counters instead of prose:
 *     `No test files found` (no report / zero counters), a collection failure
 *     or `Tests  no tests` (graded nothing), an all-`it.skip`'d file (`passed`
 *     0 with `skipped` > 0), a `Test Files` line with no `Tests` line beside it
 *     (never consulted), and Playwright's `N flaky` summary — which used to be
 *     invisible to both regexes and is now an explicit counter.
 *
 * ### What a nonce must be, and must not be
 *
 * {@link newCheckNonce} is 128 bits from `node:crypto`'s `randomUUID`. Never a
 * counter, a timestamp, or anything derived from the issue/branch: the check
 * file is authored by an agent that knows all of those, and a predictable nonce
 * is no nonce at all. It is the ONE impure export in this module.
 *
 * ### What is still open, said out loud
 *
 * The nonce travels in the command line, so a check that reads
 * `/proc/<ppid>/cmdline` (or, for the report path specifically, its own
 * `process.argv`) can LEARN it. Knowing it buys the check a way to print a
 * forged evidence line — which is why {@link parseRunEvidence} takes the LAST
 * match in the stream: the host's epilogue runs after the runner has exited, so
 * the host's line is always the last one, and a line printed from inside the
 * run is always earlier. Beating that requires a detached background process
 * that outlives the runner and wins a race against the epilogue's own `node`
 * invocation microseconds later. Named here rather than discovered later.
 *
 * Pure by construction apart from {@link newCheckNonce} — no IO, no clock, no
 * state. None of the regexes below carries `/g` on a `.test()` path, which
 * would make matching stateful; `./tally-signals.test.ts` asserts that.
 */

import { randomUUID } from "node:crypto";

import type { CheckKind } from "../checkwriter/check-kind.js";

/**
 * A fresh per-run nonce. THE ONE IMPURE EXPORT HERE, and the only place
 * entropy enters this design.
 *
 * MUST be called once PER RUN, never cached and never persisted alongside a
 * built command. The must-fail-first proof and the ship-time re-check are two
 * different runs with the BUILDER'S WHOLE DIFF in between, and the check is
 * required to import real product code — so builder-authored code executes
 * inside the check's own process. A nonce reused across the two would hand
 * that code the report path, and with it the ability to write the report the
 * ship-time verdict is read from. Rebuild the command with a new nonce at
 * every run site; see `buildUnitCheckCommand` / `buildCheckCommand`.
 *
 * `randomUUID` (128 bits, CSPRNG) with the dashes stripped, so the value is
 * pure lowercase hex — regex-safe, shell-safe, and safe to interpolate into a
 * filesystem path without further quoting.
 */
export function newCheckNonce(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Exactly what {@link newCheckNonce} produces: 32 lowercase hex characters.
 *
 * A WHITELIST, not a blacklist — the same discipline `SAFE_PACKAGE_NAME` and
 * `isSafeCheckRelativePath` apply, and for the same reason: the value is
 * interpolated into a shell string and into a filesystem path, and it is used
 * to BUILD a `RegExp`. A caller that hands over an unvalidated string would
 * otherwise get shell injection and regex injection in one move.
 */
const SAFE_CHECK_NONCE = /^[0-9a-f]{32}$/;

export function isSafeCheckNonce(value: unknown): value is string {
  return typeof value === "string" && SAFE_CHECK_NONCE.test(value);
}

/**
 * Where the runner is told to write its machine-readable report.
 *
 * OUTSIDE THE WORKTREE, deliberately. Every uncommitted or untracked file in a
 * run's worktree blocks that run's final promotion, so a report dropped beside
 * the code would strand the whole night's work over a temp file. `/tmp` exists
 * in the docker sandbox (`node:22-bookworm-slim`) and on the mac-host provider
 * alike, and the epilogue removes the file when it is done with it.
 *
 * Nonce-named, so no run can read a stale report left by another: a fresh
 * 128-bit name has never existed before, which is a stronger guarantee than
 * deleting the file first (though the epilogue does that too).
 */
export function checkReportPathFor(nonce: string): string {
  return `/tmp/sandcastle-check-${nonce}.json`;
}

/**
 * {@link checkReportPathFor}, read backwards: the nonce a command string was
 * keyed with, or `undefined` when it carries none.
 *
 * DERIVED from `checkReportPathFor` itself rather than re-typing the path
 * shape, so a change to that path cannot leave this reading the old one — the
 * two-hand-kept-copies liability this whole module was opened about.
 */
const REPORT_PATH_NONCE = new RegExp(
  checkReportPathFor("([0-9a-f]{32})").replace(/\./g, "\\."),
);

/**
 * The nonce a BUILT check command was keyed with, recovered from the report
 * path inside it.
 *
 * ONLY for a command that is REPLAYED rather than rebuilt. Anything that
 * builds a command already holds the nonce and must pass it along; fishing it
 * back out of a string is strictly worse and buys nothing. The one legitimate
 * caller is the ship-time re-run in `main.mts`, which is handed a
 * `checkCommand` that was persisted by the check-writer stage with no nonce
 * beside it — see the "KNOWN GAP" comment there and at that call site.
 *
 * Fails closed: no match, or a value {@link isSafeCheckNonce} refuses, comes
 * back `undefined`, and every reading keyed off it is inconclusive.
 */
export function checkNonceFromCommand(command: string): string | undefined {
  const nonce = REPORT_PATH_NONCE.exec(command)?.[1];
  return isSafeCheckNonce(nonce) ? nonce : undefined;
}

/** The fixed word that makes the evidence line greppable in a run log. */
const RUN_EVIDENCE_MARKER = "sandcastle-run-evidence";

/** One run's attributable, machine-read result. Counters are `-1` when the report did not supply them. */
export interface RunEvidence {
  /** The runner really wrote a report the epilogue could parse. */
  readonly reportPresent: boolean;
  /** The RUNNER's own exit status, captured by the host before anything else ran. */
  readonly exitCode: number;
  /** vitest `numPassedTests` / Playwright `stats.expected`. */
  readonly passed: number;
  /** vitest `numFailedTests` / Playwright `stats.unexpected`. */
  readonly failed: number;
  /** vitest `numPendingTests` / Playwright `stats.skipped`. */
  readonly skipped: number;
  /** Playwright `stats.flaky` — always 0 for vitest, which has no such bucket. */
  readonly flaky: number;
}

/**
 * The evidence line, exactly as {@link runEvidenceEpilogue}'s `node` program
 * prints it and exactly as {@link parseRunEvidence} reads it.
 *
 * Exported so the two halves cannot drift: `./tally-signals.test.ts` runs the
 * REAL epilogue through a REAL `sh` against a REAL report file and asserts the
 * parser reads what this formatter would have written. A format agreed by two
 * hand-kept copies — one in a JS string inside a shell string, one in a regex —
 * is precisely the liability issue #956 was opened about.
 */
export function formatRunEvidence(nonce: string, ev: RunEvidence): string {
  return (
    `${nonce} ${RUN_EVIDENCE_MARKER} ` +
    `report=${ev.reportPresent ? "ok" : "missing"} ` +
    `exit=${ev.exitCode} passed=${ev.passed} failed=${ev.failed} ` +
    `skipped=${ev.skipped} flaky=${ev.flaky}`
  );
}

/**
 * The POSIX-`sh` fragment the HOST appends to every check command.
 *
 * Reads as: remember the runner's real exit status; have `node` read the
 * runner's own report and print one nonce-keyed line of counters; delete the
 * report; exit with the status the RUNNER had.
 *
 * Four details are load-bearing.
 *
 *   1. `__sc_rc=$?` is captured IMMEDIATELY, before anything else can clobber
 *      `$?`, and `exit $__sc_rc` is the last statement — so the exit code the
 *      provider observes is still the runner's, `timedOut` inference (exit
 *      124/137 from the `timeout` wrapper) is untouched, and no existing reader
 *      of `exitCode` changes behaviour.
 *   2. The counters are normalised across the two runners INSIDE the `node`
 *      program, because a Playwright report and a vitest report answer the same
 *      question with different keys (`stats.expected` vs `numPassedTests`) and
 *      the classifier must not have to know which runner it graded. A report
 *      carrying `stats` is Playwright's; anything else is read as vitest's.
 *      VERIFIED against both real reports, not inferred from docs.
 *   3. Anything the program cannot read comes out `-1`, never 0. `0 failed`
 *      and "no idea how many failed" are different facts and only one of them
 *      is allowed to look like a clean run; {@link readRunEvidence} refuses
 *      every negative counter.
 *   4. `node` itself failing (missing, OOM) prints no line, which
 *      {@link parseRunEvidence} reports as no evidence at all — inconclusive.
 *      There is no branch here that can fail open.
 *
 * `extraFragment` is spliced in AFTER the evidence line and BEFORE the final
 * `exit $__sc_rc`, because anything appended past that `exit` never runs. It
 * exists so a second, independent host-side reading — today the success-path
 * grade mark of issue #925, see `./grade-mark.ts` — can ride the same
 * after-the-runner-exits moment without this module importing it. That
 * direction is deliberate: `grade-mark.ts` imports the nonce guard from HERE,
 * so a dependency the other way would close a module cycle. It must already
 * start with `; ` (re-checked below, never only asked for in prose) and must
 * not touch `$__sc_rc`.
 *
 * `nonce` is validated by the CALLER — both command builders gate on
 * {@link isSafeCheckNonce} and return `undefined` rather than build a command
 * — and re-validated HERE. The re-check is unreachable today and deliberately
 * THROWS rather than returning something harmless: this string goes to a
 * shell, so a caller that skipped the gate is a shell-injection bug, and a
 * crash is the only response that cannot be mistaken for working.
 */
export function runEvidenceEpilogue(
  nonce: string,
  extraFragment = "",
): string {
  if (!isSafeCheckNonce(nonce)) {
    throw new TypeError(
      "runEvidenceEpilogue: refusing to build a shell fragment from an " +
        "unvalidated nonce — call isSafeCheckNonce first",
    );
  }
  if (extraFragment !== "" && !extraFragment.startsWith("; ")) {
    throw new TypeError(
      "runEvidenceEpilogue: extraFragment must start with '; ' — a fragment " +
        "concatenated without its own separator would fuse onto the `rm -f` " +
        "before it and change what that command deletes",
    );
  }
  const report = checkReportPathFor(nonce);
  const program =
    `const f=require('fs');` +
    `let o=null;` +
    `try{o=JSON.parse(f.readFileSync('${report}','utf8'))}catch(e){}` +
    `const s=o&&o.stats;` +
    `const n=(x)=>Number.isInteger(x)?x:-1;` +
    `const p=s?n(s.expected):n(o&&o.numPassedTests);` +
    `const q=s?n(s.unexpected):n(o&&o.numFailedTests);` +
    `const k=s?n(s.skipped):n(o&&o.numPendingTests);` +
    `const y=s?n(s.flaky):0;` +
    `process.stdout.write('\\n${nonce} ${RUN_EVIDENCE_MARKER} report='+(o?'ok':'missing')+` +
    `' exit=$__sc_rc passed='+p+' failed='+q+' skipped='+k+' flaky='+y+'\\n')`;
  return (
    `; __sc_rc=$?` +
    `; node -e "${program}"` +
    `; rm -f ${report}` +
    extraFragment +
    `; exit $__sc_rc`
  );
}

/**
 * The LAST nonce-keyed evidence line in `output`, or `undefined` when there is
 * none this run's nonce can account for.
 *
 * THE LAST, not the first, and not "any": the host's epilogue runs after the
 * runner has exited, so an honest run's evidence line is always the final
 * thing in the stream. Should a check ever learn the nonce (see the module
 * doc's open item) and print a forged line from inside the run, that line is
 * necessarily earlier, and this reads past it.
 *
 * `output` must already have been through `stripAnsi` — the caller does that
 * for the whole stream before any matching, and a helper that silently
 * repaired its input would hide a caller that forgot.
 *
 * Returns `undefined` on an unsafe nonce rather than building a `RegExp` from
 * it. Fail-closed: an unusable nonce means no run can be graded, which is the
 * safe direction.
 */
export function parseRunEvidence(
  output: string,
  nonce: string,
): RunEvidence | undefined {
  if (!isSafeCheckNonce(nonce)) return undefined;
  const re = new RegExp(
    `^${nonce} ${RUN_EVIDENCE_MARKER} report=(ok|missing) exit=(-?\\d+) ` +
      `passed=(-?\\d+) failed=(-?\\d+) skipped=(-?\\d+) flaky=(-?\\d+)\\s*$`,
    "gm",
  );
  let last: RegExpExecArray | undefined;
  for (const m of output.matchAll(re)) last = m;
  if (last === undefined) return undefined;
  return {
    reportPresent: last[1] === "ok",
    exitCode: Number(last[2]),
    passed: Number(last[3]),
    failed: Number(last[4]),
    skipped: Number(last[5]),
    flaky: Number(last[6]),
  };
}

/**
 * What ONE run PROVED, or why it proved nothing. The single reading both
 * classifiers share, so the must-fail-first proof and the ship-time re-check
 * cannot end up disagreeing about what the same bytes mean — the drift issue
 * #956 was opened about.
 *
 * The three arms are not three flavours of the same thing:
 *
 *   - `proved`        — counters and exit code AGREE on a colour.
 *   - `graded-nothing`— the runner demonstrably ran and reported, and graded
 *                       no assertion. Proof of a run, no proof of a result;
 *                       maps to `environment-fault` (rank 1), never to a
 *                       builder-vs-check disagreement.
 *   - `no-evidence`   — nothing attributable to the runner reached us at all.
 *                       Rank 0, the genuine absence of proof.
 */
export type RunEvidenceReading =
  | {
      readonly kind: "proved";
      readonly colour: "red" | "green";
      readonly evidence: RunEvidence;
    }
  | { readonly kind: "graded-nothing"; readonly reason: string }
  | { readonly kind: "no-evidence"; readonly reason: string };

/**
 * Pure. Turn one run's stream into {@link RunEvidenceReading}.
 *
 * Decision order, and why each rung refuses rather than guesses:
 *
 *   1. No evidence line → the host's epilogue never ran (the process was
 *      killed, the `docker exec` client died and manufactured an exit 0, the
 *      output was truncated below it, `node` could not start). Nothing about
 *      this run is known.
 *   2. `report=missing`, or ANY counter below zero → the runner started but
 *      never produced a parseable report, or produced one missing the fields
 *      that answer the question. "We could not ask" is not "the answer is no".
 *   3. `flaky > 0` → Playwright retried a test internally and it passed on a
 *      later attempt. `playwright.config.ts` pins `retries: 0` precisely so
 *      this cannot happen; if it ever does, the run graded a thing twice and
 *      neither colour is honest.
 *   4. Counters that CONTRADICT the exit code → refused. A report saying a
 *      test failed beside a zero exit (or the reverse) means one of the two is
 *      lying, and this is the wrong place to decide which.
 *   5. `failed > 0` with a non-zero exit → RED. Positive evidence a test body
 *      executed and an assertion disagreed. This is the single most
 *      load-bearing rung in the module: it is what the must-fail-first proof
 *      requires, and it is what stops a check-writer minting a receipt from a
 *      file with a deliberate syntax error (which exits non-zero having graded
 *      nothing).
 *   6. `passed > 0`, `failed === 0`, exit 0 → GREEN.
 *   7. Everything left — `passed` and `failed` both zero — is a run that
 *      graded nothing: a collection failure, a bad import, a `describe` with
 *      no `it()`, a filter that matched no file, or a file whose every test is
 *      `it.skip`'d (which exits ZERO with a perfectly real report).
 */
export function readRunEvidence(
  output: string,
  nonce: string,
): RunEvidenceReading {
  const ev = parseRunEvidence(output, nonce);
  if (ev === undefined) {
    return {
      kind: "no-evidence",
      reason:
        "no host-generated evidence line in the output — nothing attributable " +
        "to the runner proves this check ran at all, so its exit code alone " +
        "is not trusted",
    };
  }
  if (!ev.reportPresent) {
    return {
      kind: "no-evidence",
      reason:
        "the runner wrote no machine-readable report — it never reached the " +
        "end of its own run, so nothing says what (if anything) was graded",
    };
  }
  if (ev.passed < 0 || ev.failed < 0 || ev.skipped < 0 || ev.flaky < 0) {
    return {
      kind: "no-evidence",
      reason:
        "the runner's report carried no usable test counters — the shape it " +
        "wrote is not one this host knows how to read",
    };
  }
  if (ev.flaky > 0) {
    return {
      kind: "graded-nothing",
      reason:
        `the runner recorded ${ev.flaky} flaky test(s) — it graded the same ` +
        "thing more than once and got different answers, so neither colour is " +
        "honest (playwright.config.ts pins retries: 0 to make this impossible)",
    };
  }
  if (ev.failed > 0 && ev.exitCode === 0) {
    return {
      kind: "graded-nothing",
      reason:
        `the report says ${ev.failed} test(s) failed but the runner exited 0 — ` +
        "the two disagree, and this is the wrong place to decide which is lying",
    };
  }
  if (ev.failed === 0 && ev.passed > 0 && ev.exitCode !== 0) {
    return {
      kind: "graded-nothing",
      reason:
        `the report records no failure but the runner exited ${ev.exitCode} — ` +
        "something outside the graded tests failed, so nothing here is proven",
    };
  }
  if (ev.failed > 0) {
    return { kind: "proved", colour: "red", evidence: ev };
  }
  if (ev.passed > 0) {
    return { kind: "proved", colour: "green", evidence: ev };
  }
  return {
    kind: "graded-nothing",
    reason:
      `the runner ran and graded nothing (${ev.skipped} skipped, 0 passed, ` +
      "0 failed) — a collection failure, a bad import, a describe holding no " +
      "test, a filter that matched no file, or a file whose every test is " +
      "skipped. No assertion was ever run",
  };
}

/**
 * The runner-specific flags that make a check produce the report
 * {@link runEvidenceEpilogue} reads.
 *
 * A lookup rather than a branch in each command builder: adding a third kind
 * to {@link CheckKind} then fails to compile HERE, in the one place that
 * decides how a runner is asked for its evidence, instead of silently leaving
 * some new runner's command with no report at all — which fails closed, but
 * fails closed on EVERY ticket that uses it.
 *
 * VERIFIED by hand against the real tools, not read off documentation:
 *
 *   - vitest 3.2.4 (this repo's catalog version, and shape-identical in 4.1.5):
 *     `--reporter=default --reporter=json --outputFile=<path>` keeps the human
 *     summary on stdout AND writes `{numPassedTests, numFailedTests,
 *     numPendingTests, …}` to the file. `--silent=true` is kept as a first
 *     layer of defence in depth — it deletes the cheapest forgery route
 *     (`console.log`) outright and keeps the check's own noise out of the
 *     bounded output tail the run log prints. Note the syntax: a bare
 *     `--silent <path>` throws `Unexpected value "--silent=<path>"`.
 *   - Playwright 1.56.1: `--reporter=line,json` (the CLI splits on the comma —
 *     `playwright/lib/program.js`) plus `PLAYWRIGHT_JSON_OUTPUT_FILE`, which
 *     `resolveOutputFile` reads BEFORE any config value and resolves against
 *     cwd, so an absolute path wins outright. The report carries
 *     `stats: {expected, unexpected, skipped, flaky}`. There is no `--silent`
 *     equivalent, which is exactly why the report — not the stream — is what
 *     the verdict reads.
 */
export interface CheckReportInvocation {
  /**
   * `NAME=value` assignments the command must carry inside its `env` prefix,
   * BEFORE the runner. Empty string when the runner needs none.
   */
  readonly envAssignments: string;
  /** Flags appended AFTER the runner's own path argument. Always starts with a space. */
  readonly flags: string;
}

export const CHECK_REPORT_INVOCATION: Readonly<
  Record<CheckKind, (reportPath: string) => CheckReportInvocation>
> = {
  browser: (reportPath) => ({
    envAssignments: `PLAYWRIGHT_JSON_OUTPUT_FILE=${reportPath}`,
    flags: " --reporter=line,json",
  }),
  unit: (reportPath) => ({
    envAssignments: "",
    flags: ` --silent=true --reporter=default --reporter=json --outputFile=${reportPath}`,
  }),
};
