/**
 * The success-path grade mark (issue #925, build steps 1 and 2).
 *
 * Everything the three existing sentinels in `./verdict.ts` prove is a
 * FAILURE. There has never been a mark meaning "grading ran, and the figure
 * matched" — so a check whose `gradeScreenText` call sits behind
 * `if (false)`, after an early `return`, or inside a function nobody calls
 * exits 0 with a perfectly real Playwright report and is read as `match`.
 * That is #925's failure scenario, word for word.
 *
 * These tests pin the pure half: the path the browser side writes to, the
 * host line that relays it, and the reading both classifiers will gate on.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { newCheckNonce, runEvidenceEpilogue } from "./tally-signals.js";

import {
  GRADE_MARK_DETAIL_MAX_CHARS,
  GRADE_MARK_ENV,
  GRADE_MARK_MARKER,
  formatGradeMarkLine,
  formatSettledMarkLine,
  gradeMarkEpilogue,
  gradeMarkPathFor,
  parseGradeMark,
  parseSettledMark,
} from "./grade-mark.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";

describe("gradeMarkPathFor", () => {
  it("is nonce-named and outside the worktree, like the report path", () => {
    // Same two reasons as `checkReportPathFor`: an untracked file inside the
    // worktree strands the whole night's final promotion, and a fresh
    // 128-bit name cannot collide with a stale file from another run.
    expect(gradeMarkPathFor(NONCE)).toBe(
      `/tmp/sandcastle-graded-${NONCE}.jsonl`,
    );
    expect(gradeMarkPathFor(NONCE)).not.toBe(gradeMarkPathFor(OTHER_NONCE));
  });

  it("refuses an unvalidated nonce rather than building a path from it", () => {
    // The value is interpolated into a shell string and a filesystem path.
    // Fail-closed, exactly as `runEvidenceEpilogue` does.
    expect(() => gradeMarkPathFor("../../etc/passwd")).toThrow(TypeError);
  });
});

describe("GRADE_MARK_ENV", () => {
  it("names the variable the browser-side helper reads", () => {
    // Pinned as a literal because the other side of this contract lives in
    // `apps/nextjs/e2e/lib/graded-screen-check.ts`, which `.sandcastle` may
    // never import. `./sentinel-contract.test.ts` pins the pair together.
    expect(GRADE_MARK_ENV).toBe("SANDCASTLE_GRADE_MARK_FILE");
  });
});

describe("formatGradeMarkLine and parseGradeMark", () => {
  it("round-trips a count and its detail", () => {
    const line = formatGradeMarkLine(NONCE, 2, "aGVsbG8=");
    const reading = parseGradeMark(line, NONCE);
    expect(reading).toEqual({ count: 2, detail: "hello" });
  });

  it("carries WHAT was graded, not only that grading happened", () => {
    // Build step 2: "a bare 'I ran' proves less than the mechanism can
    // cheaply prove". The detail rides base64 so a screen name or a dollar
    // figure containing a space or a newline cannot break the line format
    // the count is read off.
    const detail = [
      '{"screen":"/finance/reports?view=team","figure":"$1,000.00"}',
      '{"screen":"/deals","figure":"12 deals"}',
    ].join("\n");
    const encoded = Buffer.from(detail, "utf8").toString("base64");
    const reading = parseGradeMark(
      formatGradeMarkLine(NONCE, 2, encoded),
      NONCE,
    );
    expect(reading?.detail).toBe(detail);
    expect(reading?.detail).toContain("$1,000.00");
  });

  it("reads the LAST line, so a mark printed from inside the run loses", () => {
    // Identical reasoning to `parseRunEvidence`: the host's epilogue runs
    // after the runner has exited, so an honest mark is always last. A
    // forged one printed from inside the run is necessarily earlier.
    const forged = formatGradeMarkLine(NONCE, 99, "Zm9yZ2Vk");
    const honest = formatGradeMarkLine(NONCE, 1, "aG9uZXN0");
    const reading = parseGradeMark(`${forged}\nnoise\n${honest}\n`, NONCE);
    expect(reading).toEqual({ count: 1, detail: "honest" });
  });

  it("ignores a line keyed with a different nonce", () => {
    const line = formatGradeMarkLine(OTHER_NONCE, 5, "aGVsbG8=");
    expect(parseGradeMark(line, NONCE)).toBeUndefined();
  });

  it("returns undefined when no mark line is present at all", () => {
    expect(parseGradeMark("ordinary playwright output\n", NONCE)).toBeUndefined();
  });

  it("returns undefined on an unsafe nonce rather than building a RegExp", () => {
    expect(parseGradeMark("anything", "not-a-nonce")).toBeUndefined();
  });

  it("reads a zero count as a real zero, not as absence", () => {
    // "Grading never ran" and "no line reached us" are different facts and
    // the classifiers answer them differently: the first is a check that
    // proves nothing, the second is a run nothing is known about.
    expect(parseGradeMark(formatGradeMarkLine(NONCE, 0, ""), NONCE)).toEqual({
      count: 0,
      detail: "",
    });
  });

  it("refuses a detail that is not base64, rather than guessing", () => {
    const line = `${NONCE} ${GRADE_MARK_MARKER} graded=1 detail=not base64!`;
    expect(parseGradeMark(line, NONCE)).toBeUndefined();
  });

  it("bounds the detail so one run cannot flood the output", () => {
    const huge = "x".repeat(GRADE_MARK_DETAIL_MAX_CHARS * 2);
    const encoded = Buffer.from(huge, "utf8").toString("base64");
    expect(() => formatGradeMarkLine(NONCE, 1, encoded)).toThrow(RangeError);
  });
});

describe("formatSettledMarkLine and parseSettledMark (2026-09-01)", () => {
  const record = (screen: string, url: string): string =>
    JSON.stringify({ screen, url, settled: true });
  const enc = (lines: readonly string[]): string =>
    Buffer.from(lines.join("\n"), "utf8").toString("base64");

  it("round-trips a count and the screens the records name", () => {
    const line = formatSettledMarkLine(
      NONCE,
      1,
      enc([record("/finance/reports?view=team", "http://x/finance/reports?view=team")]),
    );
    expect(parseSettledMark(line, NONCE)).toEqual({
      count: 1,
      screens: [
        "/finance/reports?view=team",
        "http://x/finance/reports?view=team",
      ],
    });
  });

  it("reads a zero count as a real zero, not as absence", () => {
    expect(parseSettledMark(formatSettledMarkLine(NONCE, 0, ""), NONCE)).toEqual(
      { count: 0, screens: [] },
    );
  });

  it("THE SPOOF CHANNEL STAYS CLOSED: the printed sentinel is not a settled mark", () => {
    // A check-authored console.log of the settled sentinel used to be the
    // whole evidence. It must parse as NOTHING here.
    expect(
      parseSettledMark(
        "SCREEN_CHECK_VERDICT:SCREEN_SETTLED screen=/finance/reports\n",
        NONCE,
      ),
    ).toBeUndefined();
  });

  it("ignores a line keyed with a different nonce, and takes the LAST honest line", () => {
    expect(
      parseSettledMark(formatSettledMarkLine(OTHER_NONCE, 3, ""), NONCE),
    ).toBeUndefined();
    const forged = formatSettledMarkLine(NONCE, 9, enc([record("/x", "u")]));
    const honest = formatSettledMarkLine(NONCE, 1, enc([record("/y", "u2")]));
    expect(parseSettledMark(`${forged}\nnoise\n${honest}\n`, NONCE)?.screens).toEqual([
      "/y",
      "u2",
    ]);
  });

  it("skips a record cut mid-line by truncation rather than guessing a screen", () => {
    const whole = record("/a", "http://x/a");
    const cut = whole.slice(0, 10);
    const line = formatSettledMarkLine(
      NONCE,
      2,
      Buffer.from(`${whole}\n${cut}`, "utf8").toString("base64"),
    );
    expect(parseSettledMark(line, NONCE)).toEqual({
      count: 2,
      screens: ["/a", "http://x/a"],
    });
  });

  it("a grade mark is never read as a settled record (and vice versa)", () => {
    // Two markers, two parsers — a line of one kind must be invisible to the
    // other parser entirely.
    const graded = formatGradeMarkLine(NONCE, 1, "");
    expect(parseSettledMark(graded, NONCE)).toBeUndefined();
    const settled = formatSettledMarkLine(NONCE, 1, "");
    expect(parseGradeMark(settled, NONCE)).toBeUndefined();
  });
});

describe("gradeMarkEpilogue — executed for real", () => {
  /**
   * Run the REAL grade-mark fragment inside the REAL evidence epilogue, in a
   * real `sh`, after a command exiting `rc`. Not a hand-written imitation of
   * the shell string: the format lives in one JS string inside a shell string
   * and one regex, and only executing it proves the two agree.
   */
  function runEpilogue(nonce: string, rc: number): string {
    try {
      return execFileSync(
        "sh",
        ["-c", `(exit ${rc}) ${runEvidenceEpilogue(nonce, gradeMarkEpilogue(nonce))}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      return String((err as { stdout?: unknown }).stdout ?? "");
    }
  }

  it("reads a REAL mark file and prints a line parseGradeMark understands", () => {
    const nonce = newCheckNonce();
    writeFileSync(
      gradeMarkPathFor(nonce),
      '{"screen":"/finance/reports","figure":"$1,000.00"}\n' +
        '{"screen":"/deals","figure":"12 deals"}\n',
    );
    const reading = parseGradeMark(runEpilogue(nonce, 0), nonce);
    expect(reading?.count).toBe(2);
    expect(reading?.detail).toContain("$1,000.00");
  });

  it("THE WHOLE POINT: a run that graded nothing reports graded=0, not silence", () => {
    // #925's failure scenario end to end. The grading call sat somewhere it
    // never ran, so the helper never wrote a mark file. Playwright still
    // exits 0 with a real report. Before this line existed, that was
    // indistinguishable from a check that graded correctly.
    const nonce = newCheckNonce();
    expect(existsSync(gradeMarkPathFor(nonce))).toBe(false);
    expect(parseGradeMark(runEpilogue(nonce, 0), nonce)).toEqual({
      count: 0,
      detail: "",
    });
  });

  it("PRESERVES THE RUNNER'S EXIT CODE — timedOut inference (124/137) depends on it", () => {
    const nonce = newCheckNonce();
    let status = 0;
    try {
      execFileSync(
        "sh",
        ["-c", `(exit 137) ${runEvidenceEpilogue(nonce, gradeMarkEpilogue(nonce))}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      status = Number((err as { status?: unknown }).status ?? 0);
    }
    expect(status).toBe(137);
  });

  it("relays a mixed mark file as TWO lines — grade marks and settled records never cross-count", () => {
    // One file, two record kinds (2026-09-01). The grade line must count only
    // the figure-bearing marks; the settled line only the settled records —
    // a settled record counted as a grade would wave a green through the
    // #925 gate, and a grade counted as settled would launder an unrelated
    // red.
    const nonce = newCheckNonce();
    writeFileSync(
      gradeMarkPathFor(nonce),
      '{"screen":"/finance/reports","figure":"$1,000.00"}\n' +
        '{"screen":"/finance/reports","url":"http://localhost:3000/finance/reports","settled":true}\n',
    );
    const out = runEpilogue(nonce, 0);
    expect(parseGradeMark(out, nonce)?.count).toBe(1);
    const settled = parseSettledMark(out, nonce);
    expect(settled?.count).toBe(1);
    expect(settled?.screens).toContain("/finance/reports");
    expect(settled?.screens).toContain("http://localhost:3000/finance/reports");
  });

  it("a run that settled nothing reports settled=0, not silence", () => {
    const nonce = newCheckNonce();
    expect(parseSettledMark(runEpilogue(nonce, 0), nonce)).toEqual({
      count: 0,
      screens: [],
    });
  });

  it("DELETES the mark file — /tmp must not fill up over a long night", () => {
    const nonce = newCheckNonce();
    writeFileSync(gradeMarkPathFor(nonce), '{"screen":"/x","figure":"1"}\n');
    runEpilogue(nonce, 0);
    expect(existsSync(gradeMarkPathFor(nonce))).toBe(false);
  });

  it("bounds a flooding mark file and still decodes cleanly", () => {
    // Base64 is cut on a 3-byte boundary, never mid-quantum, so the decoded
    // detail is real text rather than mojibake a reader would misdiagnose.
    const nonce = newCheckNonce();
    const line = `{"screen":"/x","figure":"${"9".repeat(200)}"}\n`;
    writeFileSync(gradeMarkPathFor(nonce), line.repeat(60));
    const reading = parseGradeMark(runEpilogue(nonce, 0), nonce);
    expect(reading?.count).toBe(60);
    expect(reading?.detail.startsWith('{"screen":"/x"')).toBe(true);
    expect(reading?.detail.length).toBeLessThanOrEqual(3000);
  });
});
