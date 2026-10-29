/**
 * "Did this diff REMOVE test coverage?" — the pure half.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT MORE OF `escalation.ts`. That file
 * answers "how big and how sensitive is this diff", a sizing question whose
 * whole input is one numstat payload. This one answers a different question —
 * "is this file still a test suite afterwards" — and it needs a different
 * INSTRUMENT to answer it (the file's size on both sides), which is why it
 * could not just be another predicate over the same string. `parseGuttedFiles`
 * stays where it is: it is a numstat predicate, it is still exactly right for
 * the shape it names, and it is one of the three sets unioned here.
 *
 * ── WHY LINE COUNTS ARE THE WRONG INSTRUMENT, twice over ────────────────────
 *
 * The gate this feeds exists to stop a ticket deleting the browser regression
 * suite and shipping green (vitest's include is `src/**`, so a deleted
 * Playwright spec "passes" by being absent). Two demonstrated ways past a
 * numstat-only rule, both verified against real git in
 * `diff-measurement.test.ts`:
 *
 *  1. EMPTYING IS NOT DELETING. A 200-case suite replaced by
 *     `it("noop", () => {});` prints `1<TAB>200<TAB>path` — `added` is 1, so
 *     an `added === 0` predicate says "not gutted". The claim that deleting a
 *     file and emptying it out "read identically in numstat" is false.
 *  2. `-`/`-` MEANS UNKNOWN, NOT ZERO. A root `.gitattributes` carrying
 *     `*.spec.ts binary` — a root file, which raises no proof demand at all —
 *     makes every spec print `-<TAB>-<TAB>path`. Parsed as 0/0, `deleted > 0`
 *     is false, and a commit that `git rm`-ed the whole suite came back with
 *     an EMPTY removal set.
 *
 * So the removal question is answered from three sets, unioned:
 *
 *   A. EXISTENCE — `git diff --diff-filter=D --name-only`. Whether a file was
 *      removed is a question about existence, and existence is immune to line
 *      counts, `.gitattributes`, and text/binary detection alike. This alone
 *      closes hole 2's delete.
 *   B. NOTHING ADDED — `parseGuttedFiles` (`./escalation.ts`), unchanged: a
 *      row that removes lines and adds none. Kept in the union rather than
 *      replaced, because it is a genuinely different signal from C — a 23 KB
 *      spec that loses 103 lines and gains none still holds a suite, so C is
 *      silent, but "removed something, added nothing" is worth a human look
 *      and this gate has always said so.
 *   C. COLLAPSE — {@link collapsedPaths}: the file kept only a small FRACTION
 *      of its bytes. This is the direct form of the question, and the only one
 *      of the three that can answer it for a binary-marked row, where there
 *      are no line counts to reason about at all.
 *
 * ── THE THRESHOLD, AND THE DATA BEHIND IT ───────────────────────────────────
 *
 * A rule that fires on healthy work is the worse failure (see
 * `lib/testing/test-verification.ts`), so the ratio was measured, not chosen.
 * Population: every MODIFIED test-file row under `apps/**` and `packages/**`
 * across this repo's first-parent history — 918 rows. A modification is the
 * only population a false positive can come from; a deletion SHOULD fire.
 *
 *   instrument                                   fires on
 *   added === 0 && deleted > 0  (today's rule)   37/918 = 4.03%
 *   added < deleted * 0.5   (a hunk ratio)       90/918 = 9.80%
 *   added < deleted * 0.1   (a hunk ratio)       49/918 = 5.34%
 *   afterBytes < beforeBytes * R, any R ≤ 0.5     0/918 = 0.00%
 *
 * A HUNK RATIO WAS REJECTED ON THAT EVIDENCE. Its extra hits are real,
 * healthy commits: `f9f3f096` ("119 browser tests stopped skipping themselves
 * and now run") deletes 79 lines of per-file auth boilerplate from a 20 KB
 * spec and adds 5, a ratio of 0.06 — coverage strictly INCREASED, and every
 * hunk-ratio threshold down to 0.1 quarantines it. `f234253d` (dedupe an
 * icon-guard helper) is the same story at 0.21. Hunk counts describe how the
 * diff was SHAPED; they say nothing about what is left, which is the actual
 * question.
 *
 * The size ratio fired on ZERO of the 918 at every threshold from 0.1 to 0.5.
 * The tightest legitimate edit in the whole population kept 54.3% of its bytes
 * (2552B → 1385B, `f234253d`). {@link COVERAGE_COLLAPSE_RATIO} is 0.25 — under
 * half of the nearest real datapoint, so the margin is a factor of two on
 * measured history rather than on taste, while the attack it must catch keeps
 * under 1% (a 200-case suite → a one-line stub).
 *
 * NO MINIMUM-SIZE FLOOR, deliberately. The data needs none (zero hits at 0.25
 * with no floor), and any floor is an evasion window: gut whatever sits under
 * it and the gate is silent by construction.
 *
 * WHAT THIS STILL DOES NOT CLOSE, said plainly rather than left to be
 * discovered: a ratio is a ratio. A builder who deletes the suite and pads the
 * file back over 25% of its original bytes — 160 lines of `// TODO` against a
 * 20 KB suite, measured — clears the threshold. Raising the ratio narrows that
 * band and closes it at ~0.54, where the tightest healthy edit in the measured
 * population sits; that is not a margin, it is a collision, and a rule that
 * quarantines real refactors is the worse failure. 0.25 is where the two costs
 * balance on the evidence available. Sets A and B are unaffected by padding.
 *
 * BYTES, NOT LINES. One `git ls-tree -r -l` per side answers the whole
 * candidate set in ~50 ms without transferring a single blob; counting lines
 * would mean reading every candidate file's contents. For the shapes that
 * matter the two agree, and bytes additionally refuse to be fooled by a
 * one-line file that is 40 KB wide.
 *
 * ── WHAT THE 2026-08-06 NIGHT ADDED, AND WHY ────────────────────────────────
 *
 * Three finished tickets stopped `stopped:check-disagreement` in one run and
 * two of them had removed nothing at all. Both false alarms came from set B
 * being read as a VERDICT when it is only a SHAPE:
 *
 *  - #820 RENAMED a suite (`staging-rls.integration.test.ts` →
 *    `staging-rls-query-shape.test.ts`, 78% similar, same directory) and added
 *    a second suite beside it. `--no-renames` splits that into a delete plus an
 *    add, so the OLD path prints `0<TAB>N<TAB>path` and set B fired on a file
 *    whose every case is still in the tree under a better name. The answer is
 *    {@link renamedNotRemoved} — a fourth git question, asked WITH rename
 *    detection, whose only job is to say which of B's and A's hits are moves.
 *    `--no-renames` stays exactly where it is on the other three calls: it is
 *    load-bearing for the paths themselves (see {@link parseDeletedPaths}), so
 *    the fix adds a signal rather than flipping a flag three things depend on.
 *
 *  - #860 deleted TWO LINES from a 140-line suite — precisely the two lines the
 *    ticket asked to be removed. numstat prints `0<TAB>2<TAB>path`, and set B
 *    called 98% of a file surviving "gutted coverage". The answer is that B now
 *    has to agree with the size question too, at its OWN, looser threshold
 *    ({@link PURE_DELETION_COLLAPSE_RATIO}). "Removed lines, added none" stays
 *    a real signal and keeps the 0.25–0.5 band to itself; what it stops being
 *    is a verdict on a file that is plainly still there.
 *
 * Both changes only ever SHRINK the removal set, so both had to be bounded, and
 * the rename one was bounded WRONGLY when it shipped. Its first two conditions
 * are about the destination's PATH — still a test, still under the same
 * top-level directory — and an earlier version of this paragraph claimed they
 * "refuse a gutting done BY renaming". They do not and cannot: they refuse a
 * change of LOCATION and never look at a byte, so `git mv big.spec.ts
 * small.spec.ts` satisfied both. {@link renamedNotRemoved}'s third condition is
 * the one that answers the actual question — the destination is sized against
 * the source through the same collapse pass as sets B and C. Read its doc
 * before trusting it: at the pinned 50% rename threshold git's own scorer
 * already refuses any pair whose destination is at or below half the source, so
 * condition 3 is a floor guard rather than a live catch, and the band that
 * stays reachable is one bytes cannot judge at all.
 *
 * Pure by construction — every function here takes strings or maps the caller
 * got from git. `./diff-measurement.ts`'s `guttedFilesBetween` owns the IO and
 * the fail-closed contract.
 */

import { isTestFilePath } from "../paths/test-file.js";

/**
 * A file that keeps less than this fraction of its bytes has been collapsed,
 * not edited. Measured, not guessed — see the distribution in this module's
 * header. Strictly less-than: a file that lands exactly on the ratio is an
 * edit.
 */
export const COVERAGE_COLLAPSE_RATIO = 0.25;

/**
 * The same question asked of set B's rows only — a row that removed lines and
 * added NONE — where the bar sits higher because the shape is already
 * suspicious. A pure-deletion row that kept at least half its bytes is an edit;
 * below half it is a removal.
 *
 * WHY 0.5 AND NOT 1.0 (i.e. why B is not simply believed). The distribution in
 * this module's header was measured over the same 918 modified test-file rows:
 * `afterBytes < beforeBytes * R` fires on ZERO of them at every R up to and
 * including 0.5, and the tightest legitimate edit in the whole population kept
 * 54.3% of its bytes. So 0.5 is the LARGEST threshold with no measured false
 * positive, and #860 — a 140-line suite losing two lines, 98% surviving — is
 * nowhere near it.
 *
 * WHY 0.5 AND NOT 0.25 (i.e. why B still exists at all). Below 0.25
 * {@link COVERAGE_COLLAPSE_RATIO} already answers, for every row shape. The
 * band from 0.25 to 0.5 belongs to B alone: a file that lost two thirds of
 * itself and gained nothing back is not a refactor, and the collapse pass —
 * which has to tolerate the healthy 54.3% edit — cannot reach down there
 * without colliding with it. Narrowing B to this band is what keeps the guard
 * from getting weaker overall while it stops firing on #860.
 */
export const PURE_DELETION_COLLAPSE_RATIO = 0.5;

/**
 * Iterate `git diff --numstat -z` records, yielding the raw added/deleted
 * columns and the path. Shared by the candidate scan below and nothing else
 * yet; kept private because the two public parsers here disagree about what to
 * DO with a `-` column, and that disagreement is the point.
 *
 * Record format, one per changed file: `<added> TAB <deleted> TAB <path> NUL`.
 * Everything after the SECOND tab is the path, so a literal tab inside a
 * filename survives. Records with fewer than two tabs are skipped.
 */
function* numstatRecords(
  stdout: string,
): Generator<{ addedCol: string; deletedCol: string; path: string }> {
  for (const record of stdout.split("\0")) {
    // Only terminator-adjacent whitespace is noise; a path may legitimately
    // start or end with a space, so trim is used for the EMPTINESS test only.
    if (record.trim() === "") continue;
    const firstTab = record.indexOf("\t");
    if (firstTab === -1) continue;
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;
    yield {
      addedCol: record.slice(0, firstTab).trimStart(),
      deletedCol: record.slice(firstTab + 1, secondTab),
      path: record.slice(secondTab + 1),
    };
  }
}

/**
 * Parse `git diff --diff-filter=D --name-only -z --no-renames` stdout: one raw,
 * NUL-terminated path per DELETED file.
 *
 * `-z` is a contract, not tuning — plain `--name-only` C-quotes and
 * octal-escapes a non-ASCII path (`"src/caf\303\251.ts"`), which joins to no
 * file on either side. `--no-renames` is equally load-bearing: it turns a
 * rename into a delete plus an add, so moving a spec OUT of the watched
 * workspace is reported at its original path instead of vanishing into a
 * single `R` record.
 */
export function parseDeletedPaths(stdout: string): readonly string[] {
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record.trim() === "") continue;
    paths.push(record);
  }
  return paths;
}

/** One rename git detected: where the content was, and where it went. */
export interface DetectedRename {
  readonly from: string;
  readonly to: string;
}

/**
 * Parse `git diff --diff-filter=R --find-renames=50% --name-status -z` stdout
 * into the (from, to) pairs git considers renames.
 *
 * THE THRESHOLD IS SPELT OUT ON THE COMMAND LINE ON PURPOSE. `-M` alone honours
 * `diff.renames` / `diff.renameLimit` from whatever git config the host happens
 * to carry, and this decides whether a ticket ships — it may not vary by
 * machine. 50% is git's own default and is already twice
 * {@link COVERAGE_COLLAPSE_RATIO}: a file git will not call a rename has kept
 * so little of itself that the collapse pass is the right instrument for it
 * anyway.
 *
 * Record format under `-z`: the status field (`R` plus a similarity score,
 * e.g. `R078`), then the OLD path, then the NEW path — three NUL-terminated
 * fields per rename, unlike the two-field records everywhere else here.
 *
 * A triple whose status does not start with `R` ABANDONS the rest of the parse
 * rather than skipping just that triple, and the difference matters. Skipping
 * one bad triple assumes the stream is still three-field-aligned after it; it is
 * not — a two-field record from a widened `--diff-filter` shifts every
 * subsequent field by one, so "skip and continue" would mis-pair real renames
 * into plausible-looking garbage. Abandoning yields FEWER exonerations, which
 * means more paths read as removals, which stops tickets rather than shipping
 * them: the safe direction for a gate. Today only `R` records can arrive, so
 * this cannot fire; it exists for the caller that widens the filter later.
 */
export function parseRenames(stdout: string): readonly DetectedRename[] {
  const fields = stdout.split("\0");
  const renames: DetectedRename[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const status = fields[i] ?? "";
    const from = fields[i + 1] ?? "";
    const to = fields[i + 2] ?? "";
    if (!status.startsWith("R")) break;
    if (from === "" || to === "") continue;
    renames.push({ from, to });
  }
  return renames;
}

/**
 * Which rename SOURCES must not read as removals — the files that moved with
 * their coverage intact.
 *
 * Three conditions, and each one closes something the others do not. The first
 * two are about WHERE the file went; the third is about WHAT ARRIVED, and it is
 * the one a location-only rule cannot express.
 *
 *  1. THE DESTINATION IS STILL TEST MATERIAL. `git mv suite.test.ts
 *     suite.test.ts.bak` is 100% similar and lands in the same directory, and
 *     vitest never loads the result again. A rename that stops the file BEING a
 *     test has removed the coverage as surely as `git rm` would, so it is
 *     refused. (A source that was never test material to begin with is
 *     unaffected — there was no coverage to keep.)
 *
 *  2. THE DESTINATION SHARES THE SOURCE'S TOP-LEVEL DIRECTORY. This is the
 *     property `--no-renames` was chosen for and the one this function must not
 *     undo: moving a spec OUT of `apps/**` or `packages/**` removes it from the
 *     workspace the gate watches, and the consumer
 *     (`lib/checkwriter/proof-demand.ts`'s `removedTestFiles`) scopes to exactly
 *     those two roots. First-segment equality is the precise test for "still
 *     under the same watched root" without this module having to know which
 *     roots those are — a question that belongs to the gate, not to a git
 *     parser. `apps/**` → `packages/**` is refused too; that is a real move of
 *     coverage between workspaces, it is rare, and stopping for a person is the
 *     cheap direction to be wrong in.
 *
 *  3. THE DESTINATION DID NOT ARRIVE COLLAPSED. Conditions 1 and 2 refuse a
 *     change of LOCATION; neither of them looks at a single byte, so on their
 *     own they exonerate `git mv big.spec.ts small.spec.ts` no matter what
 *     `small.spec.ts` contains. The source's BEFORE size is compared against
 *     the destination's AFTER size through {@link collapsedPaths} — the same
 *     pass, and the same measured threshold, that sets B and C already use — so
 *     a rename is exempt only if what landed is still the size of a suite. A
 *     destination missing from the after tree counts as zero and is refused,
 *     matching that function's own rule.
 *
 * WHAT CONDITION 3 IS AND IS NOT, measured rather than assumed (git 2.39.5,
 * 200-case fixture, `--find-renames=50%` as pinned by {@link parseRenames}):
 *
 *   dst/src bytes   0.898  0.593  0.542  0.502 │ 0.497  0.442  0.294  0.047
 *   git reports     R089   R059   R054   R050  │  —      —      —      —
 *
 * `estimate_similarity` refuses the pair outright once the size DELTA exceeds
 * `(1 - minimum_score)` of the larger side, so at a pinned 50% no detected
 * rename can have a destination at or below half the source. Condition 3 is
 * therefore a FLOOR GUARD, not a live catch: with today's pinned threshold it
 * cannot fire, and the gutted-by-rename cases it would catch are already caught
 * by sets A/B/C because git calls them a delete plus an add. What it buys is
 * that the exemption stops depending on an undocumented internal of git's
 * rename scorer — the same reason the threshold is spelt out on the command
 * line instead of inherited from host config. Lower `--find-renames` later and
 * this function degrades safely instead of opening a hole.
 *
 * WHY THE RATIO MAY NOT BE RAISED ABOVE 0.5 TO MAKE IT FIRE. The band left
 * reachable — a detected rename that kept between half and all of its bytes —
 * cannot be judged by size, because the healthy shape and the attack are the
 * same size. Splitting a 20 KB suite into two 10 KB files is #820's exact shape
 * (a rename plus a new suite beside it) and lands at R052; gutting a 20 KB
 * suite to 10 KB lands there too. A ratio above 0.5 quarantines both, and a
 * rule that stops healthy work is the worse failure (see this module's header).
 * Separating them needs an instrument that can see CASES rather than bytes, and
 * this function does not have one.
 *
 * STILL NOT CLOSED, and deliberately: a rename to a directory the runners do
 * not load. `apps/nextjs/e2e/x.spec.ts` → `apps/nextjs/e2e-disabled/x.spec.ts`
 * is R100, keeps every byte, satisfies all three conditions, and Playwright
 * never collects it again because it sits outside the configured `testDir`.
 * That is a different question — "is the destination still LOADED", not "does
 * the destination still HOLD the coverage" — and answering it requires
 * Playwright's `testDir` and vitest's `include`, which this pure git parser
 * cannot see and must not guess at. Every lexical proxy either collides with
 * condition 2's `packages/api → packages/db` case (directory equality) or is
 * one rename away from useless (a deny-list of `-disabled` suffixes). It wants
 * the runner's own collection list (`playwright test --list`), which belongs to
 * the check-writer track, not here.
 *
 * A `..` in either path makes both segment claims meaningless, so it is
 * refused. Order follows `renames`, so the caller's output is deterministic.
 */
export function renamedNotRemoved(input: {
  readonly renames: readonly DetectedRename[];
  readonly sizesBefore: ReadonlyMap<string, number>;
  readonly sizesAfter: ReadonlyMap<string, number>;
  /** Defaults to {@link COVERAGE_COLLAPSE_RATIO}. */
  readonly ratio?: number;
}): readonly string[] {
  const kept: string[] = [];
  for (const { from, to } of input.renames) {
    const fromSegments = from.split("/");
    const toSegments = to.split("/");
    if (fromSegments.includes("..") || toSegments.includes("..")) continue;
    if (isTestFilePath(from) && !isTestFilePath(to)) continue;
    if (fromSegments[0] !== toSegments[0]) continue;
    // `collapsedPaths` keys both sides by ONE path, so the destination's after
    // size is re-keyed onto the source's path. Reusing it rather than
    // open-coding the comparison is what keeps one threshold, one strictness
    // rule and one treatment of a missing size across all three call sites.
    const arrived = collapsedPaths({
      candidates: [from],
      sizesBefore: input.sizesBefore,
      sizesAfter: new Map([[from, input.sizesAfter.get(to) ?? 0]]),
      ratio: input.ratio,
    });
    if (arrived.length > 0) continue;
    kept.push(from);
  }
  return kept;
}

/**
 * Which paths from a numstat payload are worth SIZING — i.e. could possibly
 * have shrunk?
 *
 * Two admissions, and the second is hole 2's other half. A row that removed
 * lines obviously qualifies. A BINARY row (`-`/`-`) qualifies too, because
 * those dashes mean the counts are UNKNOWN, not zero: a `.gitattributes`
 * `binary` mark strips the line counts off an ordinary text file, and reading
 * that as "nothing was removed" is exactly how a gutting hides. A pure
 * addition and an untouched row are excluded — neither can have shrunk, and
 * sizing them would only cost lookups.
 */
export function parseShrinkCandidates(stdout: string): readonly string[] {
  const candidates: string[] = [];
  for (const { addedCol, deletedCol, path } of numstatRecords(stdout)) {
    const unknownCounts = addedCol === "-" || deletedCol === "-";
    const deleted = Number(deletedCol) || 0;
    if (unknownCounts || deleted > 0) candidates.push(path);
  }
  return candidates;
}

/**
 * Parse `git ls-tree -r -l -z <ref>` stdout into path → byte size.
 *
 * Record format: `<mode> SP <type> SP <sha> SP<right-aligned size> TAB <path>
 * NUL`. Only `blob` entries carry a size; a submodule is a `commit` entry
 * whose size column git prints as `-`, and recording that as 0 would make
 * every submodule look permanently emptied. Non-blob and unparseable records
 * are therefore SKIPPED, which — because a missing BEFORE size means "nothing
 * to shrink from" in {@link collapsedPaths} — is the quiet direction.
 *
 * Why a whole-tree listing rather than asking about the candidates only: it is
 * one process per side with no stdin (the loop's `runGit` cannot write to a
 * child's stdin), no pathspec-glob escaping, and no argv limit when a ticket
 * deletes 117 files at once. Measured on this repo: 3,106 entries in ~46 ms.
 */
export function parseTreeSizes(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const record of stdout.split("\0")) {
    if (record.trim() === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/).filter(Boolean);
    // <mode> <type> <sha> <size>
    if (meta.length < 4) continue;
    if (meta[1] !== "blob") continue;
    const size = Number(meta[3]);
    if (!Number.isFinite(size) || size < 0) continue;
    sizes.set(record.slice(tab + 1), size);
  }
  return sizes;
}

/**
 * Which candidates kept only a small fraction of their bytes — the collapse
 * test, in its pure form so the threshold is exercisable without git.
 *
 * A candidate missing from the AFTER tree kept nothing and is reported (it is
 * normally already in the `--diff-filter=D` set; agreeing costs nothing and
 * means neither set alone has to be perfect). A candidate missing from the
 * BEFORE tree, or one that was already empty, is NOT reported — there is
 * nothing to have shrunk from, and answering otherwise would flag every newly
 * added file the moment a later hunk deleted a line from it.
 *
 * Order follows `candidates`, so the caller's output is deterministic.
 */
export function collapsedPaths(input: {
  readonly candidates: readonly string[];
  readonly sizesBefore: ReadonlyMap<string, number>;
  readonly sizesAfter: ReadonlyMap<string, number>;
  /** Defaults to {@link COVERAGE_COLLAPSE_RATIO}. */
  readonly ratio?: number;
}): readonly string[] {
  const ratio = input.ratio ?? COVERAGE_COLLAPSE_RATIO;
  const collapsed: string[] = [];
  for (const path of input.candidates) {
    const before = input.sizesBefore.get(path);
    if (before === undefined || before <= 0) continue;
    const after = input.sizesAfter.get(path) ?? 0;
    if (after < before * ratio) collapsed.push(path);
  }
  return collapsed;
}
