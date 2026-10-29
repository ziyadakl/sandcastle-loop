/**
 * Pins the run-evidence contract in `tally-signals.ts` against REAL BYTES —
 * including one test that executes the REAL epilogue through a REAL `sh` and
 * a REAL `node` against a REAL runner report, so the two halves of the format
 * (a JS string inside a shell string, and a `RegExp`) cannot drift apart.
 *
 * The scenarios that carry the most weight here are the ones that separate
 * "the runner said so" from "the check said so": a check that PRINTS a perfect
 * tally must move no verdict at all, and a check that prints a forged evidence
 * line before the host's real one must lose to the host's.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHECK_REPORT_INVOCATION,
  checkReportPathFor,
  formatRunEvidence,
  isSafeCheckNonce,
  newCheckNonce,
  parseRunEvidence,
  readRunEvidence,
  runEvidenceEpilogue,
} from "./tally-signals.js";

const NONCE = "0123456789abcdef0123456789abcdef";

/** One honest run's stream: the runner's own noise, then the host's evidence line. */
function stream(
  ev: Partial<Parameters<typeof formatRunEvidence>[1]> & { exitCode: number },
): string {
  return (
    " Test Files  1 failed (1)\n      Tests  1 failed (1)\n" +
    formatRunEvidence(NONCE, {
      reportPresent: true,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
      ...ev,
    }) +
    "\n"
  );
}

describe("newCheckNonce / isSafeCheckNonce", () => {
  it("is 128 bits of CSPRNG hex, and never the same twice", () => {
    const a = newCheckNonce();
    const b = newCheckNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(isSafeCheckNonce(a)).toBe(true);
  });

  it("REFUSES anything that could carry a shell, path or regex payload", () => {
    // The value is interpolated into a shell string, a filesystem path AND a
    // `RegExp`. A whitelist, never a blacklist.
    for (const bad of [
      "",
      "abc",
      "0123456789abcdef0123456789abcdeF", // uppercase
      "0123456789abcdef0123456789abcde", // 31 chars
      "0123456789abcdef0123456789abcdef0", // 33 chars
      "../../etc/passwd",
      "0123456789abcdef0123456789abcde;",
      42,
      undefined,
      null,
    ]) {
      expect(isSafeCheckNonce(bad)).toBe(false);
    }
  });
});

describe("runEvidenceEpilogue — the shell-injection gate", () => {
  it("THROWS rather than building a shell fragment from an unvalidated nonce", () => {
    // Unreachable through either command builder (both gate first and return
    // `undefined`), and deliberately loud: this string goes to a shell.
    expect(() => runEvidenceEpilogue("; rm -rf /")).toThrow(TypeError);
    expect(() => runEvidenceEpilogue("")).toThrow();
  });
});

describe("checkReportPathFor", () => {
  it("puts the report OUTSIDE any worktree — an untracked file there strands the whole run", () => {
    const p = checkReportPathFor(NONCE);
    expect(p.startsWith("/tmp/")).toBe(true);
    expect(p).toContain(NONCE);
  });
});

describe("parseRunEvidence", () => {
  it("reads back exactly what formatRunEvidence wrote", () => {
    const ev = {
      reportPresent: true,
      exitCode: 1,
      passed: 2,
      failed: 3,
      skipped: 4,
      flaky: 0,
    };
    expect(parseRunEvidence(`noise\n${formatRunEvidence(NONCE, ev)}\n`, NONCE)).toEqual(
      ev,
    );
  });

  it("finds nothing under a DIFFERENT nonce — this is the whole security property", () => {
    const other = "ffffffffffffffffffffffffffffffff";
    expect(parseRunEvidence(stream({ exitCode: 0, passed: 1 }), other)).toBeUndefined();
  });

  it("refuses an unsafe nonce rather than building a RegExp from it", () => {
    expect(parseRunEvidence("anything", "(.*)")).toBeUndefined();
  });

  it("takes the LAST line, so a forged one printed DURING the run loses to the host's", () => {
    // The host's epilogue runs after the runner has exited, so its line is
    // always last. A line printed from inside the run is always earlier.
    const forged = formatRunEvidence(NONCE, {
      reportPresent: true,
      exitCode: 0,
      passed: 99,
      failed: 0,
      skipped: 0,
      flaky: 0,
    });
    const real = formatRunEvidence(NONCE, {
      reportPresent: true,
      exitCode: 0,
      passed: 0,
      failed: 0,
      skipped: 1,
      flaky: 0,
    });
    const ev = parseRunEvidence(`${forged}\n runner noise\n${real}\n`, NONCE);
    expect(ev?.passed).toBe(0);
    expect(ev?.skipped).toBe(1);
  });

  it("is stateless across calls — a /g regex reused would match every OTHER call", () => {
    const s = stream({ exitCode: 0, passed: 1 });
    expect(parseRunEvidence(s, NONCE)).toBeDefined();
    expect(parseRunEvidence(s, NONCE)).toBeDefined();
    expect(parseRunEvidence(s, NONCE)).toBeDefined();
  });
});

describe("readRunEvidence — what one run PROVED", () => {
  it("PROVES THE INSTRUMENT: a real failure is red and a real pass is green", () => {
    expect(readRunEvidence(stream({ exitCode: 1, failed: 1 }), NONCE)).toMatchObject({
      kind: "proved",
      colour: "red",
    });
    expect(readRunEvidence(stream({ exitCode: 0, passed: 1 }), NONCE)).toMatchObject({
      kind: "proved",
      colour: "green",
    });
  });

  it("THE FORGERY: a check that prints a perfect tally, with no host evidence line, proves NOTHING", () => {
    const forged =
      "Tests  1 failed (1)\nTests  1 passed (1)\n  1 passed (1.2s)\n" +
      "      Tests  1 skipped (1)\n";
    expect(readRunEvidence(forged, NONCE).kind).toBe("no-evidence");
  });

  it("a report the runner never wrote is no-evidence, never a colour", () => {
    const s = stream({ exitCode: 1, failed: 1 });
    const missing = s.replace("report=ok", "report=missing");
    expect(readRunEvidence(missing, NONCE).kind).toBe("no-evidence");
  });

  it("a counter the host could not read (-1) is no-evidence — `0 failed` and `no idea` are different facts", () => {
    expect(readRunEvidence(stream({ exitCode: 1, failed: -1 }), NONCE).kind).toBe(
      "no-evidence",
    );
  });

  it("an all-skipped run is graded-nothing, never green — exit 0 with zero assertions run", () => {
    expect(readRunEvidence(stream({ exitCode: 0, skipped: 1 }), NONCE).kind).toBe(
      "graded-nothing",
    );
  });

  it("a collection failure is graded-nothing, never red — a broken file must not mint a receipt", () => {
    // Verified against the real runner: a top-level throw, a bad import and a
    // filter matching no file ALL report passed=0 failed=0 beside exit 1.
    expect(readRunEvidence(stream({ exitCode: 1 }), NONCE).kind).toBe(
      "graded-nothing",
    );
  });

  it("counters that contradict the exit code are refused in BOTH directions", () => {
    expect(readRunEvidence(stream({ exitCode: 0, failed: 1 }), NONCE).kind).toBe(
      "graded-nothing",
    );
    expect(readRunEvidence(stream({ exitCode: 1, passed: 1 }), NONCE).kind).toBe(
      "graded-nothing",
    );
  });

  it("Playwright's `flaky` bucket is graded-nothing — the same thing graded twice with two answers", () => {
    // playwright.config.ts pins `retries: 0` so this is unreachable today. It
    // used to be INVISIBLE: a flaky summary carries neither "N passed" nor
    // "N failed", so the old regexes read a check that had actually run as
    // having produced no tally at all.
    expect(
      readRunEvidence(stream({ exitCode: 0, passed: 1, flaky: 1 }), NONCE).kind,
    ).toBe("graded-nothing");
  });

  it("a mixed run (some failed, some passed) is RED — a passing sibling does not hide a failure", () => {
    expect(
      readRunEvidence(stream({ exitCode: 1, failed: 1, passed: 1 }), NONCE),
    ).toMatchObject({ kind: "proved", colour: "red" });
  });
});

describe("CHECK_REPORT_INVOCATION", () => {
  it("asks vitest for a JSON report AND keeps the human summary AND silences the check's console", () => {
    const inv = CHECK_REPORT_INVOCATION.unit("/tmp/r.json");
    expect(inv.envAssignments).toBe("");
    expect(inv.flags).toContain("--reporter=json");
    expect(inv.flags).toContain("--outputFile=/tmp/r.json");
    // The human summary must survive, or the run log loses its diagnostics.
    expect(inv.flags).toContain("--reporter=default");
    // `--silent=true`, never a bare `--silent`: the bare form swallows the
    // next argument and throws `Unexpected value "--silent=<path>"`.
    expect(inv.flags).toContain("--silent=true");
    expect(inv.flags).not.toContain("--silent ");
  });

  it("asks Playwright via the env var it actually reads, and keeps the line reporter", () => {
    const inv = CHECK_REPORT_INVOCATION.browser("/tmp/r.json");
    expect(inv.envAssignments).toBe("PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/r.json");
    expect(inv.flags).toBe(" --reporter=line,json");
  });
});

// ---------------------------------------------------------------------------
// The one test that closes the loop between the format's two halves.
// ---------------------------------------------------------------------------

describe("runEvidenceEpilogue — executed for real", () => {
  /**
   * Run the real epilogue in a real `sh`, after a command exiting `rc`, and
   * return its stdout. The `catch` is not incidental: the epilogue ends in
   * `exit $__sc_rc`, so a non-zero runner exit really does propagate — which is
   * the property the `timedOut` test below pins — and `execFileSync` throws on
   * it while still carrying the output.
   */
  function runEpilogue(nonce: string, rc: number): string {
    try {
      return execFileSync("sh", ["-c", `(exit ${rc}) ${runEvidenceEpilogue(nonce)}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return String((err as { stdout?: unknown }).stdout ?? "");
    }
  }

  it("reads a REAL vitest report and prints a line parseRunEvidence understands", () => {
    const nonce = newCheckNonce();
    // The exact shape vitest 3.2.4 wrote for a genuinely failing check
    // (verified by hand; vitest 4.1.5 keeps the same keys).
    writeFileSync(
      checkReportPathFor(nonce),
      JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [],
      }),
    );
    const out = runEpilogue(nonce, 1);
    expect(parseRunEvidence(out, nonce)).toEqual({
      reportPresent: true,
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      flaky: 0,
    });
    expect(readRunEvidence(out, nonce)).toMatchObject({ colour: "red" });
  });

  it("reads a REAL Playwright report — a different shape, the same normalised answer", () => {
    const nonce = newCheckNonce();
    writeFileSync(
      checkReportPathFor(nonce),
      JSON.stringify({
        suites: [],
        errors: [],
        stats: {
          startTime: "2026-08-06T00:00:00.000Z",
          duration: 728,
          expected: 1,
          skipped: 0,
          unexpected: 0,
          flaky: 0,
        },
      }),
    );
    const out = runEpilogue(nonce, 0);
    expect(readRunEvidence(out, nonce)).toMatchObject({
      kind: "proved",
      colour: "green",
    });
  });

  it("a report that is not there at all reads `missing`, never a clean run", () => {
    const nonce = newCheckNonce();
    const out = runEpilogue(nonce, 1);
    expect(parseRunEvidence(out, nonce)?.reportPresent).toBe(false);
    expect(readRunEvidence(out, nonce).kind).toBe("no-evidence");
  });

  it("a report that is not JSON reads `missing` too — a truncated write cannot become a verdict", () => {
    const nonce = newCheckNonce();
    writeFileSync(checkReportPathFor(nonce), '{"numFailedTests": 1');
    const out = runEpilogue(nonce, 1);
    expect(readRunEvidence(out, nonce).kind).toBe("no-evidence");
  });

  it("a report missing the counters reads them as -1, never as 0", () => {
    const nonce = newCheckNonce();
    writeFileSync(checkReportPathFor(nonce), JSON.stringify({ hello: "world" }));
    const out = runEpilogue(nonce, 1);
    expect(parseRunEvidence(out, nonce)?.failed).toBe(-1);
    expect(readRunEvidence(out, nonce).kind).toBe("no-evidence");
  });

  it("PRESERVES THE RUNNER'S EXIT CODE — `timedOut` inference (124/137) depends on it", () => {
    const nonce = newCheckNonce();
    let code = 0;
    try {
      execFileSync("sh", ["-c", `(exit 124) ${runEvidenceEpilogue(nonce)}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(124);
  });

  it("DELETES the report when it is done — /tmp must not fill up over a long night", () => {
    const nonce = newCheckNonce();
    const p = checkReportPathFor(nonce);
    writeFileSync(p, JSON.stringify({ numPassedTests: 1, numFailedTests: 0 }));
    expect(existsSync(p)).toBe(true);
    runEpilogue(nonce, 0);
    expect(existsSync(p)).toBe(false);
  });
});
