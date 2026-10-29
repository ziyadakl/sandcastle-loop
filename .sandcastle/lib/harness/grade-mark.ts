/**
 * Proof that grading actually RAN — the success-path mark issue #925 is
 * about, and the one thing this design never had.
 *
 * ## The hole this closes
 *
 * `missingGradedHelperCalls` (`../checkwriter/check-path.ts`) decides whether
 * a check-writer's spec really grades the screen by a SUBSTRING TEST on its
 * source: `codeOnly.includes(`${h}(`)`. It has no notion of reachability, so
 * all three of these satisfy it —
 *
 *   - `if (false) { await gradeScreenText(x, y) }`
 *   - a call inside a function nobody invokes
 *   - a call placed after an early `return`
 *
 * — and all three produce a Playwright run that exits 0 with a real report
 * and no sentinel. `classifyHarnessRun` reads that as `match`. A ticket ships
 * with the wrong number on screen behind a green screen check, which is the
 * exact failure the screen check exists to prevent.
 *
 * The three sentinels in `./verdict.ts` cannot close it, because all three
 * are FAILURE marks. There has never been a mark for "grading ran and the
 * figure matched", so "graded correctly" and "never graded at all" are the
 * same bytes.
 *
 * ## Owner decision, 2026-08-15 — observe, do not infer
 *
 * Two other options were on the table and both were refused: a TypeScript
 * reachability parser, and a narrower structural rule about where the call
 * may sit. Both try to infer from the source text whether the call can be
 * reached. The ruling was that the run should stop inferring and start
 * observing: the grading helper emits a mark when it executes, and the run
 * refuses to trust a check that produced no mark. Evidence, not inference.
 *
 * ## Why the mark rides a FILE and not the output stream
 *
 * The check file is written by the check-writer — the run's own step that
 * authors the check — and its `console.log` lands in the same
 * stream the host reads — that is the forgery route `./tally-signals.ts`
 * already had to close for the test counters. So the browser-side helper
 * appends one JSON line per successful grade to {@link gradeMarkPathFor}'s
 * path, named after this run's nonce, and the HOST's epilogue reads that file
 * after the runner has exited and prints one nonce-keyed line for it.
 *
 * The threat model the owner set for #925 is a CARELESS check-writer, not a
 * deceptive one — a grading call that lands somewhere it never runs,
 * unnoticed. A run-local file the run reads back closes that case.
 *
 * TWO RESIDUALS, named here rather than discovered later.
 *
 *   1. A deliberately deceptive check that learns the nonce can write the
 *      mark file itself. The epilogue therefore counts only lines that parse
 *      as a real mark — an object carrying BOTH a screen and a figure — so
 *      the forgery is at least as much work as fabricating the runner's own
 *      report. It is not impossible, and `parseRunEvidence` documents the
 *      same residual for the same reason.
 *   2. The gate's precondition is `kind === "browser"`, and that kind comes
 *      from the check-writer's OWN envelope. A check-writer that declares a
 *      screen-bearing ticket a unit check skips the mark requirement. It
 *      also skips all three sentinels in `./verdict.ts`, so this is
 *      pre-existing rather than opened here — but "closes it completely"
 *      would be untrue, so it is not claimed.
 *
 * ## Why the detail is base64
 *
 * Build step 2 requires the mark to carry WHAT was graded — the screen and
 * the figure — because "a bare 'I ran' proves less than the mechanism can
 * cheaply prove". A screen address or a dollar figure can contain a space, a
 * quote or a newline, and the count is read off a line-anchored regex. So the
 * detail travels base64-encoded: the line format stays fixed no matter what a
 * screen is called, and the load-bearing count can never be broken by content.
 *
 * Pure by construction — no IO, no clock, no state. The IO half is the shell
 * epilogue in `./tally-signals.ts` and the browser-side helper in
 * `apps/nextjs/e2e/lib/graded-screen-check.ts`.
 */

import { isSafeCheckNonce } from "./tally-signals.js";

/**
 * The environment variable naming the file the browser-side grading helper
 * appends its marks to.
 *
 * Read by `apps/nextjs/e2e/lib/graded-screen-check.ts`, which `.sandcastle`
 * may never import — the same module boundary that forces the three sentinels
 * in `./verdict.ts` to exist as duplicated literals. `./sentinel-contract.test.ts`
 * pins this literal on both sides so a rename cannot silently switch the mark
 * off, which would read as "grading never ran" on every check at once.
 *
 * UNSET means "not under the run": a developer running the spec by hand gets
 * no mark file and no mark, and the helper must do nothing rather than throw.
 */
export const GRADE_MARK_ENV = "SANDCASTLE_GRADE_MARK_FILE";

/**
 * The marker on the host-printed line, distinct from `RUN_EVIDENCE_MARKER` so
 * neither parser can ever read the other's line.
 */
export const GRADE_MARK_MARKER = "SC-GRADED";

/**
 * The marker on the host-printed SETTLED line (2026-09-01), distinct from
 * both of the above for the same one-parser-per-line reason.
 *
 * What it relays: `waitForGradableScreen`'s success record — appended to the
 * SAME nonce-named mark file as the grade marks by
 * `apps/nextjs/e2e/lib/graded-screen-check.ts`'s `writeSettledMark`, told
 * apart by shape (`settled: true` and no `figure`). This is the evidence a
 * "settled, then went red on a plain expect() before `gradeScreenText`" run
 * rests on. It used to rest on the check printing the literal
 * `SCREEN_SETTLED_SENTINEL` line into its own output stream — the exact
 * forgery channel this module's header names, reopened for one verdict; the
 * nonce-keyed file closes it the same way it is closed for the grade mark.
 */
export const SETTLED_MARK_MARKER = "SC-SETTLED";

/**
 * How many bytes of the mark file may be relayed, before base64.
 *
 * SMALL ON PURPOSE, and the number is not free. When a check stops, the run
 * keeps only the LAST `CHECK_OUTPUT_TAIL_CHARS` (4000) characters of its
 * output, precisely so a human reading the stop can see the runner's failure
 * block — a rule added after a night when two tickets stopped with nothing on
 * disk saying why. The grade-mark line is the very LAST thing in the stream,
 * so an over-generous bound here would evict exactly the diagnostic text that
 * rule exists to preserve.
 *
 * 600 bytes carries several marks and leaves over 3000 characters of that tail
 * intact. A multiple of 3, so the encoded form lands on a base64 boundary and
 * is always decodable.
 */
export const GRADE_MARK_RAW_MAX_BYTES = 600;

/**
 * The bound on the ENCODED detail, DERIVED from the raw bound rather than
 * typed beside it.
 *
 * Two hand-kept numbers agreeing only by arithmetic nothing asserts is the
 * drift liability this subsystem keeps being bitten by. Base64 is 4 characters
 * per 3 bytes, so this is the raw bound and nothing to keep in step with.
 *
 * The COUNT is never bounded — it is the load-bearing half and costs a few
 * digits.
 */
export const GRADE_MARK_DETAIL_MAX_CHARS = (GRADE_MARK_RAW_MAX_BYTES / 3) * 4;

/**
 * Where the browser-side helper is told to append its marks.
 *
 * OUTSIDE THE WORKTREE and nonce-named, for the two reasons
 * `checkReportPathFor` already gives: an untracked file inside a run's
 * worktree blocks that run's final promotion and would strand the night's
 * work over a temp file, and a fresh 128-bit name cannot collide with a stale
 * file another run left behind. The epilogue removes it when it is done.
 *
 * `.jsonl`, not `.json`: the helper APPENDS one line per grade, from however
 * many test files a check spans, and appending to a JSON array needs a read
 * and a rewrite that two parallel workers would race on.
 */
export function gradeMarkPathFor(nonce: string): string {
  if (!isSafeCheckNonce(nonce)) {
    throw new TypeError(
      "gradeMarkPathFor: refusing to build a path from an unvalidated " +
        "nonce — call isSafeCheckNonce first",
    );
  }
  return `/tmp/sandcastle-graded-${nonce}.jsonl`;
}

/** What one run's grade marks say. */
export interface GradeMarkReading {
  /** How many times the grading helper executed and its figure matched. */
  readonly count: number;
  /**
   * The decoded mark file — one JSON line per grade, naming the screen and
   * the figure. Empty string when nothing was graded. Truncated, never
   * dropped, when the file is longer than {@link GRADE_MARK_RAW_MAX_BYTES}.
   *
   * DIAGNOSTIC ONLY. No verdict reads it; the count is the load-bearing half.
   */
  readonly detail: string;
}

/** Only what {@link gradeMarkPathFor}'s file can legitimately contain. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The host line, exactly as the epilogue prints it and exactly as
 * {@link parseGradeMark} reads it.
 *
 * NOT the producer the epilogue uses. {@link gradeMarkEpilogue} hand-builds
 * the same format inside its shell program, because that program runs in a
 * separate `node` that cannot import this module. So the two copies are
 * pinned by EXECUTION, not by a shared function: `./grade-mark.test.ts` runs
 * the real fragment in a real `sh` and parses its real output. Naming the
 * export as the guard would be a claim with nothing behind it.
 *
 * This function is the fixtures' producer, so a test can build the line
 * without a shell.
 *
 * THROWS on over-long detail rather than truncating silently. A truncated
 * base64 payload decodes to mojibake, and a reader cannot tell mojibake from
 * a screen that really is called that. The caller bounds the file instead.
 */
export function formatGradeMarkLine(
  nonce: string,
  count: number,
  detailBase64: string,
): string {
  if (detailBase64.length > GRADE_MARK_DETAIL_MAX_CHARS) {
    throw new RangeError(
      `formatGradeMarkLine: detail is ${detailBase64.length} characters, ` +
        `over the ${GRADE_MARK_DETAIL_MAX_CHARS} bound — bound the mark file ` +
        "before encoding it, never truncate the encoded form",
    );
  }
  return `${nonce} ${GRADE_MARK_MARKER} graded=${count} detail=${detailBase64}`;
}

/** What one run's settled records say (2026-09-01). */
export interface SettledMarkReading {
  /** How many times `waitForGradableScreen` settled a page and its claim matched. */
  readonly count: number;
  /**
   * The screens those records name — each record's `screen` (the caller's
   * label) and `url` (`page.url()`, what was really open), flattened into one
   * list. Parsed from the relayed detail, so a record past the
   * {@link GRADE_MARK_RAW_MAX_BYTES} truncation point can be missing from
   * here while still counted; the classifier treats "count > 0 but no
   * readable screen" as unconfirmed when it has a declared screen to hold it
   * against — fail-closed, never a free pass.
   */
  readonly screens: readonly string[];
}

/**
 * The settled line, exactly as the epilogue prints it — the settled sibling
 * of {@link formatGradeMarkLine}, with the identical throw-on-overlong-detail
 * contract and the identical fixtures-only role (the epilogue hand-builds the
 * same format inside its shell program; `./grade-mark.test.ts` pins the two
 * by execution).
 */
export function formatSettledMarkLine(
  nonce: string,
  count: number,
  detailBase64: string,
): string {
  if (detailBase64.length > GRADE_MARK_DETAIL_MAX_CHARS) {
    throw new RangeError(
      `formatSettledMarkLine: detail is ${detailBase64.length} characters, ` +
        `over the ${GRADE_MARK_DETAIL_MAX_CHARS} bound — bound the mark file ` +
        "before encoding it, never truncate the encoded form",
    );
  }
  return `${nonce} ${SETTLED_MARK_MARKER} settled=${count} detail=${detailBase64}`;
}

/**
 * Pure. The LAST nonce-keyed settled-mark line in `output`, or `undefined`
 * when there is none this run's nonce can account for — same take-the-LAST
 * rule, same stripped-input contract, and same "absence ≠ settled=0"
 * distinction as {@link parseGradeMark}.
 */
export function parseSettledMark(
  output: string,
  nonce: string,
): SettledMarkReading | undefined {
  if (!isSafeCheckNonce(nonce)) return undefined;
  const re = new RegExp(
    `^${nonce} ${SETTLED_MARK_MARKER} settled=(\\d+) detail=(\\S*)[ \\t]*$`,
    "gm",
  );
  let last: RegExpExecArray | undefined;
  for (const m of output.matchAll(re)) last = m;
  if (last === undefined) return undefined;

  const encoded = last[2] ?? "";
  if (!BASE64.test(encoded)) return undefined;

  const detail = Buffer.from(encoded, "base64").toString("utf8");
  const screens: string[] = [];
  for (const line of detail.split("\n")) {
    // Complete JSON lines only — a line cut mid-character by the byte-bound
    // truncation simply fails to parse and contributes no screen, which the
    // classifier reads as "unconfirmed", never as a match.
    try {
      const o: unknown = JSON.parse(line);
      if (
        typeof o === "object" &&
        o !== null &&
        (o as { settled?: unknown }).settled === true
      ) {
        const rec = o as { screen?: unknown; url?: unknown };
        if (typeof rec.screen === "string") screens.push(rec.screen);
        if (typeof rec.url === "string") screens.push(rec.url);
      }
    } catch {
      // not a complete record — skip
    }
  }
  return { count: Number(last[1]), screens };
}

/**
 * Pure. The LAST nonce-keyed grade-mark line in `output`, or `undefined` when
 * there is none this run's nonce can account for.
 *
 * THE LAST, for the identical reason `parseRunEvidence` takes the last
 * evidence line: the host's epilogue runs after the runner has exited, so an
 * honest mark line is always the final thing in the stream, and a line printed
 * from inside the run is necessarily earlier.
 *
 * `output` must already have been through `stripAnsi` — every caller strips
 * the whole stream before any matching, and a helper that silently repaired
 * its input would hide a caller that forgot.
 *
 * `undefined` is the ABSENCE of a line, which is a different fact from a line
 * saying `graded=0`. The first means nothing is known about whether grading
 * ran; the second means the run demonstrably graded nothing. The classifiers
 * treat them differently and this must not flatten them together.
 */
export function parseGradeMark(
  output: string,
  nonce: string,
): GradeMarkReading | undefined {
  if (!isSafeCheckNonce(nonce)) return undefined;
  // `[ \t]*$`, never `\s*$`: under `gm` the `\s` class matches a newline, so
  // the tail could span past the line the `^${nonce}` anchor started on.
  const re = new RegExp(
    `^${nonce} ${GRADE_MARK_MARKER} graded=(\\d+) detail=(\\S*)[ \\t]*$`,
    "gm",
  );
  let last: RegExpExecArray | undefined;
  for (const m of output.matchAll(re)) last = m;
  if (last === undefined) return undefined;

  const encoded = last[2] ?? "";
  if (!BASE64.test(encoded)) return undefined;

  return {
    count: Number(last[1]),
    detail: Buffer.from(encoded, "base64").toString("utf8"),
  };
}

/**
 * The POSIX-`sh` fragment that reads the mark file back, prints one
 * nonce-keyed line for it, and deletes it.
 *
 * Splices into `runEvidenceEpilogue`'s `extraFragment` slot, so it runs at the
 * same after-the-runner-has-exited moment the evidence line does — which is
 * what makes {@link parseGradeMark}'s take-the-LAST-line rule meaningful.
 *
 * Four details are load-bearing.
 *
 *   1. It touches `$__sc_rc` not at all, so the runner's real exit code still
 *      reaches the provider and `timedOut` inference (124/137) is untouched.
 *   2. A missing or unreadable file prints `graded=0`, never no line. "The
 *      helper never ran" is a fact worth stating; silence would be read as
 *      "nothing is known", which is a different and weaker answer.
 *   3. Slicing the raw text at a BYTE boundary keeps the base64 valid. It
 *      does not keep the text whole: a cut can land mid-character, and that
 *      last character then decodes to a replacement mark. Stated rather than
 *      glossed — the detail is diagnostic and the count is untouched.
 *   4. `node` itself failing prints nothing at all, which
 *      {@link parseGradeMark} reports as absence — inconclusive, never a
 *      pass. There is no branch here that can fail open.
 */
export function gradeMarkEpilogue(nonce: string): string {
  const file = gradeMarkPathFor(nonce);
  // Counts only lines that ARE a mark. Two kinds share the file, told apart
  // by shape so neither can be counted as the other: a GRADE mark carries
  // both a screen and a figure; a SETTLED record (2026-09-01,
  // `writeSettledMark`) carries a screen, `settled: true`, and never a
  // figure. Counting every non-empty line would set the forgery bar at one
  // stray byte, far below the runner's own report, which a forger must
  // fabricate as a coherent `stats` object. It also makes the screen and the
  // figure load-bearing rather than decorative.
  //
  // No `$`, no backtick, no double quote and no backslash other than `\n` in
  // this program: it is spliced into a double-quoted `sh` word, where those
  // four are the only characters that keep their meaning.
  const program =
    `const f=require('fs');let t='';` +
    `try{t=f.readFileSync('${file}','utf8')}catch(e){}` +
    `const c=(s)=>{try{const o=JSON.parse(s);` +
    `if(!o||typeof o.screen!=='string')return 0;` +
    `if(typeof o.figure==='string')return 1;` +
    `if(o.settled===true)return 2;return 0}` +
    `catch(e){return 0}};` +
    `const a=t.split('\\n');` +
    `const l=a.filter(s=>c(s)===1);` +
    `const m=a.filter(s=>c(s)===2);` +
    `const e=(x)=>Buffer.from(x.join('\\n'),'utf8')` +
    `.subarray(0,${GRADE_MARK_RAW_MAX_BYTES}).toString('base64');` +
    `process.stdout.write('\\n${nonce} ${GRADE_MARK_MARKER} graded='+l.length+` +
    `' detail='+e(l)+'\\n${nonce} ${SETTLED_MARK_MARKER} settled='+m.length+` +
    `' detail='+e(m)+'\\n')`;
  return `; node -e "${program}"; rm -f ${file}`;
}
