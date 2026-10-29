// The `git diff --numstat -z --no-renames` record parsers.
//
// WHY THIS MODULE EXISTS (issue #959). Both parsers used to live in
// `./escalation.ts`, and `parseGuttedFiles`'s record loop was a VERBATIM copy of
// `parseNumstat`'s, identical except for the final predicate. Nothing kept the
// two in sync. That is not a style complaint: if the record-splitting contract
// drifts in one and not the other, the gutted set starts describing a different
// file set from `changedFiles`, and those two sets are INTERSECTED by the
// ship-time proof gate (`lib/checkwriter/proof-demand.ts`). A drift there is
// exactly the failure the removal gate exists to prevent.
//
// So the record split is written ONCE, in {@link numstatRecords}, and both
// parsers read it. A change to the contract is now a change to one loop.
//
// The second half of the move is placement. `./escalation.ts` declares itself
// the first-pass reviewer escalation POLICY, and `parseGuttedFiles` has nothing
// to do with reviewer escalation — its own doc conceded it lived there only for
// proximity to `parseNumstat`. Both parsers are numstat questions, so they live
// in a numstat module and `./escalation.ts`'s header is true again.
//
// Everything here is pure (no IO): the caller runs git and passes the raw
// stdout in, so every rule below is unit-testable without a repo.

/**
 * One parsed `--numstat -z` record.
 *
 * `added` / `deleted` are LINE COUNTS AS NUMSTAT REPORTS THEM, which is not the
 * same as the truth: a binary file prints `-`/`-` and lands here as 0/0. That
 * means "git declined to count this file's lines", NEVER "nothing changed".
 * Every consumer of a 0 has to decide which of the two it is looking at; see
 * {@link parseGuttedFiles} for the one that gets this wrong if read carelessly.
 */
export interface NumstatRecord {
  readonly added: number;
  readonly deleted: number;
  readonly path: string;
}

/**
 * Split `git diff --numstat -z --no-renames` stdout into records. THE ONE
 * record loop — both parsers below read it, so they can never disagree about
 * what a record is.
 *
 * THE `-z --no-renames` FLAGS ARE PART OF THIS CONTRACT, not an optimization —
 * plain `--numstat` does not emit usable paths. Verified against real git:
 *   - a rename prints `src/{old.ts => new.ts}`, which is NEITHER path, so it
 *     joins to no file on either side
 *   - a non-ASCII path prints C-quoted and octal-escaped (`"src/caf\303\251.ts"`)
 * Both were harmless while these strings only fed glob matching, and both are
 * corrupt now that the paths are recorded to answer "which files did this ticket
 * touch". `-z` emits RAW, NUL-terminated paths; `--no-renames` turns a rename
 * into a delete + an add, i.e. two genuine paths (and real line counts for both,
 * where the rename row scored 0/0).
 *
 * Record format, one per changed file: `<added> TAB <deleted> TAB <path> NUL`.
 *   - binary files show `-`/`-` → 0 lines, but still count as a changed file
 *   - records with fewer than two tabs are skipped
 *   - non-numeric added/deleted columns coerce to 0 (`Number(x) || 0`)
 *   - everything after the SECOND tab is the path, so a literal tab inside a
 *     filename survives intact
 *   - the trailing newline git appends after the final NUL, and any empty
 *     record, are skipped
 */
export function* numstatRecords(stdout: string): Generator<NumstatRecord> {
  for (const record of stdout.split("\0")) {
    // Only the terminator-adjacent whitespace is noise; a path may legitimately
    // start or end with a space, so trim is used for the EMPTINESS test only.
    if (record.trim() === "") continue;
    const firstTab = record.indexOf("\t");
    if (firstTab === -1) continue;
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;
    const addedCol = record.slice(0, firstTab).trimStart();
    const deletedCol = record.slice(firstTab + 1, secondTab);
    yield {
      added: addedCol === "-" ? 0 : Number(addedCol) || 0,
      deleted: deletedCol === "-" ? 0 : Number(deletedCol) || 0,
      path: record.slice(secondTab + 1),
    };
  }
}

/**
 * Parse numstat stdout into the total added+deleted line count and the changed
 * file paths. Feeds the first-pass reviewer escalation decision
 * (`./escalation.ts`'s `shouldEscalateReviewer`) and, through
 * `./diff-measurement.ts`'s `diffStatsBetween`, the ship-time proof gate's
 * changed-file set.
 *
 * The record contract it reads is {@link numstatRecords}'s, not its own.
 */
export function parseNumstat(stdout: string): {
  changedLines: number;
  changedFiles: readonly string[];
} {
  let changedLines = 0;
  const changedFiles: string[] = [];
  for (const { added, deleted, path } of numstatRecords(stdout)) {
    changedLines += added + deleted;
    changedFiles.push(path);
  }
  return { changedLines, changedFiles };
}

/**
 * Which paths in the same numstat output ADD nothing and REMOVE something?
 *
 * Deleting a file and emptying it out both look identical to numstat —
 * `0<TAB>N<TAB>path` — which is exactly the property wanted here. The ship-time
 * proof router (`lib/checkwriter/proof-demand.ts`'s `removedTestFiles`) stops
 * any ticket whose finished diff REMOVES test coverage under `apps/**` or
 * `packages/**`, under every check-writer outcome and with no proof that buys
 * it off: passing the one check a ticket wrote proves nothing about the
 * coverage the same diff deleted. Both removal shapes land here.
 *
 * (Under the guard this replaced, the removal question was narrower: it existed
 * only to keep a blanket "test files need no screen" exemption honest. That
 * exemption is gone — a test-only diff now owes a unit proof — and the removal
 * stop outlived it, because it was always the stronger of the two rules.)
 *
 * A binary file (`-<TAB>-<TAB>path`) parses as 0/0 and is therefore NOT
 * gutted — this function is a NUMSTAT predicate, and numstat declines to count
 * that file's lines.
 *
 * READ THAT NARROWLY. It is a statement about this predicate, not about the
 * gate. `-`/`-` means the counts are UNKNOWN, not that nothing was removed,
 * and a root `.gitattributes` carrying `*.spec.ts binary` was enough to make a
 * `git rm` of an entire browser suite report nothing here. Likewise a suite
 * replaced by `it("noop", () => {});` prints `1<TAB>200<TAB>path`, so `added`
 * is not 0 and this says "not gutted" about a destroyed test file. BOTH are
 * real, both were demonstrated against real git, and neither is fixable in a
 * numstat predicate — answering them needs a different instrument (file
 * existence, and the file's size on both sides). That is what
 * `./coverage-removal.ts` adds; `guttedFilesBetween` unions all three, and
 * THAT union — not this function alone — is what the removal gate consumes.
 *
 * ⚠️ WHAT THIS FUNCTION'S ANSWER MEANS TO ITS CALLER CHANGED ON 2026-08-06, and
 * the name did not. It is a SHAPE, not a verdict. `guttedFilesBetween` no
 * longer adds these paths to the removal set directly: each one has to fail the
 * size question too, at `PURE_DELETION_COLLAPSE_RATIO` (0.5). On its own this
 * predicate fired on 37 of 918 healthy modified test rows in this repo's
 * history — 4% — and on the night of 2026-08-06 it stopped a finished ticket
 * (#860) whose diff deleted TWO LINES from a 140-line suite, which numstat
 * prints as `0<TAB>2<TAB>path`. "Removed lines, added none" is still a real
 * signal and still owns the 0.25–0.5 survival band that nothing else covers; it
 * was never a statement about whether the file is still a test suite. The
 * function is unchanged; only the claim made from it is.
 *
 * Deliberately a separate pass rather than another field on
 * {@link parseNumstat}: that function's return shape is consumed by the
 * reviewer-escalation decision, which has no business growing a field it never
 * reads. Since issue #959 the two passes at least SPLIT records identically,
 * because they share {@link numstatRecords} — before that they were two copies
 * of one loop with nothing keeping them in step.
 */
export function parseGuttedFiles(stdout: string): readonly string[] {
  const gutted: string[] = [];
  for (const { added, deleted, path } of numstatRecords(stdout)) {
    if (added === 0 && deleted > 0) gutted.push(path);
  }
  return gutted;
}
