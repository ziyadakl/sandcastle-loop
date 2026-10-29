/**
 * How the loop MEASURES an issue's diff — the base-ref rules, the numstat
 * sizer, and the single guarded route from a measurement to the telemetry bag.
 *
 * Extracted verbatim from `main.mts` (which was 9,208 lines) as the IO half of
 * the review track: it sits beside `./escalation.ts`, which already holds the
 * pure policy half (`parseNumstat` / `shouldEscalateReviewer`) this module
 * feeds. What stayed behind in `main.mts` is `decideFirstPassReviewerModel`,
 * the thin orchestrator that joins the two — it depends on `roleModelsFor` and
 * the args bag, neither of which can leave that file.
 *
 * Nothing here reads env or config; git is reached only through
 * {@link runGit}, so every rule below is exercisable against a real temp repo.
 */
import { runGit, type GitRunResult } from "../state/git-exec.js";
import {
  collapsedPaths,
  parseDeletedPaths,
  parseRenames,
  parseShrinkCandidates,
  parseTreeSizes,
  PURE_DELETION_COLLAPSE_RATIO,
  renamedNotRemoved,
} from "./coverage-removal.js";
import { parseGuttedFiles, parseNumstat } from "./numstat.js";

/**
 * A resolved reviewer base, and WHICH of the two rules produced it. The `kind`
 * is not decoration: `tip-parent` is a REVIEWER-ONLY rescue (give the reviewer
 * something to look at) and is wrong as a measurement base, so callers that
 * measure must be able to tell the two apart instead of guessing from the
 * string. Making the fallback visible in the type is what stops a caller from
 * silently inheriting it (see {@link shipDiffBase}).
 */
export interface ReviewBaseResolution {
  readonly ref: string;
  /** `fork-point` = the real merge-base; `tip-parent` = the `<sha>~1` rescue. */
  readonly kind: "fork-point" | "tip-parent";
}

/**
 * Decide the base ref the reviewer diffs against — pure (no IO) so the
 * empty-diff guard is unit-testable. The highest-stakes branch is `baseIsTip`:
 * when the merge-base equals the tip, the commit is already an ancestor of the
 * base, `git diff base..tip` is EMPTY, and the reviewer would see nothing and
 * rubber-stamp (issue #340's inverse failure). Falls back to the tip's parent
 * (`<sha>~1`, the prior single-commit behavior) for that case AND when the base
 * can't be resolved — reporting `kind: "tip-parent"` so the caller knows the
 * ref is a rescue rather than a real fork point.
 */
export function resolveReviewBase(
  mergeBase: GitRunResult,
  tipSha: GitRunResult,
  commitSha: string,
): ReviewBaseResolution {
  const baseOk = mergeBase.ok && mergeBase.stdout.length > 0;
  const baseIsTip = baseOk && tipSha.ok && tipSha.stdout === mergeBase.stdout;
  return baseOk && !baseIsTip
    ? { ref: mergeBase.stdout, kind: "fork-point" }
    : { ref: `${commitSha}~1`, kind: "tip-parent" };
}

/**
 * Resolve the concrete base ref the reviewer diffs `commitSha` against on
 * `branch`: the fork-point merge-base (whole-branch delta, issue #340), falling
 * back to the tip's parent when the base is the tip or unresolvable. Extracted
 * so `runReviewer`'s in-prompt `REVIEW_BASE` and the first-pass escalation sizer
 * ({@link reviewDiffStats}) can never diff against different bases.
 */
export function reviewBaseForCommit(
  repoRoot: string,
  branch: string,
  commitSha: string,
): ReviewBaseResolution {
  const mergeBase = runGit(repoRoot, "merge-base", branch, commitSha);
  const tipSha = runGit(repoRoot, "rev-parse", commitSha);
  return resolveReviewBase(mergeBase, tipSha, commitSha);
}

/**
 * One diff measurement, as {@link reviewDiffStats} produces it: a line total
 * plus the changed PATHS. The count of changed files is deliberately NOT a
 * member — in-process it is always exactly `changedFiles.length`, and carrying
 * it separately is what let the three fields drift apart. It becomes its own
 * field only at the telemetry boundary, where the paths array is capped and the
 * count therefore stops being derivable from it.
 */
export interface DiffStats {
  readonly changedLines: number;
  readonly changedFiles: readonly string[];
}

/**
 * "Nothing was measured" — the one literal, so the fail-quiet wrapper below and
 * every caller that has to reconstruct it cannot disagree about its shape.
 */
export const UNMEASURED_DIFF: DiffStats = { changedLines: 0, changedFiles: [] };

/**
 * Numstat sizer that FAILS CLOSED: the total added+deleted line count and the
 * changed file paths between two refs, or `null` when git could not be asked.
 *
 * The exact sibling of {@link guttedFilesBetween}, and for the exact same
 * reason. Equal or empty refs are an ANSWER — they genuinely describe an empty
 * diff — so they return `{0, []}`. A `git diff` that FAILED is not an answer,
 * and this is the function that refuses to pretend otherwise.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link reviewDiffStats} (2026-08-06 review).
 * The changed-file list has two consumers with opposite safe directions, and
 * for a while they shared the fail-quiet one:
 *
 *   - the first-pass reviewer escalation sizer, where a git hiccup answering
 *     "do not escalate" is the cheap status quo and is correct;
 *   - the SHIP-TIME PROOF GATE, where an empty changed-file list makes
 *     `requiredProofForDiff` answer `none` — a demand EVERY marker satisfies.
 *     One git hiccup there waived the entire gate and shipped an unproven diff.
 *
 * That is the same "silence reads as an all-clear" shape `guttedFilesBetween`
 * refuses to produce, and it was strictly worse: the removal half is allowed to
 * carry on past a `null` only BECAUSE the demand half is independently
 * conservative, and that stops being true the moment the changed-file list is
 * the thing that failed. So the gate reads THIS function, and the sizer keeps
 * the wrapper.
 *
 * Binary files (numstat "-") count as changed files but contribute 0 lines.
 */
export function diffStatsBetween(
  repoRoot: string,
  fromRef: string,
  toRef: string,
): DiffStats | null {
  if (fromRef === "" || toRef === "" || fromRef === toRef) {
    return UNMEASURED_DIFF;
  }
  // `-z --no-renames` is required, not tuning: plain `--numstat` C-quotes
  // non-ASCII paths and collapses a rename into `src/{old => new}`, neither of
  // which is a path anything can join on. See {@link parseNumstat}.
  const res = runGit(
    repoRoot,
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    fromRef,
    toRef,
  );
  if (!res.ok) return null;
  return parseNumstat(res.stdout);
}

/**
 * Numstat sizer for the first-pass reviewer escalation decision. Returns the
 * total added+deleted line count and the changed file paths between two refs.
 * Fail-quiet: equal/empty refs or any `git diff` error return `{0, []}` so a git
 * hiccup can NEVER escalate — the safe default is the cheap current behavior.
 *
 * A THIN WRAPPER over {@link diffStatsBetween}, never a second `git diff`: one
 * measurement, two failure directions, so a caller that needs both cannot end
 * up reasoning about two different diffs. Read that function's doc for which
 * caller belongs on which side.
 */
export function reviewDiffStats(
  repoRoot: string,
  fromRef: string,
  toRef: string,
): DiffStats {
  return diffStatsBetween(repoRoot, fromRef, toRef) ?? UNMEASURED_DIFF;
}

/**
 * Which paths between two refs did this diff REMOVE — deleted outright,
 * emptied, or collapsed to a stub? Feeds the ship-time proof router's
 * removed-test hard stop (`lib/checkwriter/proof-demand.ts`'s
 * `removedTestFiles`), which no check-writer outcome waives.
 *
 * THREE QUESTIONS, UNIONED, then one SUBTRACTED, because no single question can
 * answer it alone. The reasoning and the measured thresholds live in
 * `./coverage-removal.ts`; the short version:
 *
 *   1. `--diff-filter=D` — pure EXISTENCE. Immune to line counts, so a root
 *      `.gitattributes` carrying `*.spec.ts binary` can no longer make a
 *      `git rm` of the whole browser suite report nothing.
 *   2. {@link parseGuttedFiles} — a row that removes lines and adds none, NOW
 *      confirmed against the file's surviving bytes at
 *      {@link PURE_DELETION_COLLAPSE_RATIO} (0.5). On its own it fired on 4% of
 *      this repo's healthy test edits, including a 140-line suite that lost two
 *      lines (#860). It keeps the 0.25–0.5 band, which nothing else covers.
 *   3. {@link collapsedPaths} — the file kept under a quarter of its bytes.
 *      This is what catches a 200-case suite replaced by
 *      `it("noop", () => {});`, whose numstat row is `1 200 <path>` and whose
 *      `added` is therefore NOT zero.
 *
 *   MINUS {@link renamedNotRemoved} — the moves. Everything above is measured
 *   with `--no-renames`, which is a CONTRACT (see {@link parseNumstat} and
 *   `parseDeletedPaths`) and is not flipped here: a rename arrives as a delete
 *   plus an add, so a renamed suite's old path lands in sets 1 and 2 having
 *   lost nothing (#820). The fourth git call asks the rename question directly,
 *   at a pinned 50% similarity, and its answers are subtracted — but only when
 *   the destination is still test material, still under the same top-level
 *   directory, AND still the size of what left. So `suite.test.ts →
 *   suite.test.ts.bak`, a move out of the watched workspace, and a move that
 *   arrives collapsed all stay removals. The size half is why the `ls-tree`
 *   pair is now taken BEFORE the subtraction rather than after it; read
 *   `renamedNotRemoved` for how far that third condition does and does not
 *   reach.
 *
 * Output order is deterministic: numstat order first (git's own), then any
 * deleted path numstat somehow never mentioned.
 *
 * FAILS CLOSED, and that is the whole difference from {@link reviewDiffStats}
 * directly above. Its fail-quiet `{0, []}` is correct because a git hiccup
 * there only means "do not escalate the reviewer", i.e. the cheap status quo.
 * Here an empty list on error would read as "nothing was removed", which is
 * the single most dangerous thing this function could say — a git hiccup would
 * silently re-open the hole. So an unaskable git returns `null`, which the
 * guard treats as "cannot prove anything is safe to exempt". The cost of being
 * wrong in this direction is one ticket quarantined for a human to look at.
 *
 * THAT APPLIES TO EVERY ONE OF THE FIVE GIT CALLS, not just the first. A
 * PARTIAL answer is the dangerous shape here — "here are the removals I could
 * find" reads exactly like "here are the removals", and the caller has no way
 * to tell. So any failing call collapses the whole answer to `null`. The rename
 * call is no exception, even though it can only ever SHRINK the answer: a
 * rename pass that silently returned nothing would put #820 back.
 *
 * COST: up to five git calls where there was one. The two `ls-tree` calls are
 * skipped only when nothing in the diff lost a line AND nothing was renamed,
 * which is the minority — assume they run. A rename adds nothing to that bill:
 * under `--no-renames` its source prints `0<TAB>N<TAB>path`, so it was already
 * a shrink candidate and the pair was already being fetched. Measured on this repo they are ~46 ms each for a 3,106-file
 * tree, against a ship funnel that has already spent minutes, and they
 * transfer no blob contents. Not worth optimising into a narrower query that
 * would have to escape pathspec globs and cope with a 117-file argv.
 */
export function guttedFilesBetween(
  repoRoot: string,
  fromRef: string,
  toRef: string,
): readonly string[] | null {
  // Not a failure: identical or absent refs genuinely describe an empty diff,
  // in which nothing was removed. Provable, so it answers rather than nulls.
  if (fromRef === "" || toRef === "" || fromRef === toRef) return [];
  // `-z --no-renames` is required, not tuning. See {@link parseNumstat} for
  // `-z`, and `parseDeletedPaths` for why a rename must read as delete + add.
  const numstat = runGit(
    repoRoot,
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    fromRef,
    toRef,
  );
  if (!numstat.ok) return null;
  const deletedRes = runGit(
    repoRoot,
    "diff",
    "--diff-filter=D",
    "--name-only",
    "-z",
    "--no-renames",
    fromRef,
    toRef,
  );
  if (!deletedRes.ok) return null;
  // The ONE call that asks git to detect renames, and the only one that may.
  // Its answers are subtracted from the three sets above, never added to them.
  const renameRes = runGit(
    repoRoot,
    "diff",
    "--diff-filter=R",
    "--find-renames=50%",
    "--name-status",
    "-z",
    fromRef,
    toRef,
  );
  if (!renameRes.ok) return null;
  const renames = parseRenames(renameRes.stdout);

  // THE SIZE PASS RUNS FIRST, because the exemption below is now one of its
  // consumers rather than something decided ahead of it. One `ls-tree` per side
  // answers every size question this function asks — the two collapse bands AND
  // whether each rename's destination arrived intact — so a rename costs no
  // extra git call. Skipped only when nothing shrank and nothing moved, which
  // is why the pair is reached through a possibly-empty map rather than a flag.
  const shrinkCandidates = parseShrinkCandidates(numstat.stdout);
  let sizesBefore: ReadonlyMap<string, number> = new Map();
  let sizesAfter: ReadonlyMap<string, number> = new Map();
  if (shrinkCandidates.length > 0 || renames.length > 0) {
    const before = runGit(repoRoot, "ls-tree", "-r", "-l", "-z", fromRef);
    if (!before.ok) return null;
    const after = runGit(repoRoot, "ls-tree", "-r", "-l", "-z", toRef);
    if (!after.ok) return null;
    sizesBefore = parseTreeSizes(before.stdout);
    sizesAfter = parseTreeSizes(after.stdout);
  }
  const moved = new Set(
    renamedNotRemoved({ renames, sizesBefore, sizesAfter }),
  );

  // EXISTENCE (set A), less the moves.
  const removed = new Set(
    parseDeletedPaths(deletedRes.stdout).filter((p) => !moved.has(p)),
  );
  // NOTHING ADDED (set B) is now a CANDIDATE list, not a verdict — a pure
  // deletion earns its place in the answer only by also failing the size
  // question at its own looser ratio. See PURE_DELETION_COLLAPSE_RATIO.
  const pureDeletions = parseGuttedFiles(numstat.stdout).filter(
    (p) => !moved.has(p) && !removed.has(p),
  );
  const candidates = shrinkCandidates.filter(
    (p) => !moved.has(p) && !removed.has(p),
  );
  // COLLAPSE (set C) over every candidate, at 0.25.
  for (const path of collapsedPaths({ candidates, sizesBefore, sizesAfter })) {
    removed.add(path);
  }
  // Set B's own band, 0.25–0.5, over the pure-deletion rows only.
  for (const path of collapsedPaths({
    candidates: pureDeletions,
    sizesBefore,
    sizesAfter,
    ratio: PURE_DELETION_COLLAPSE_RATIO,
  })) {
    removed.add(path);
  }

  // Deterministic order: git's own numstat order, then anything only the
  // delete listing knew about.
  const numstatOrder = parseNumstat(numstat.stdout).changedFiles;
  const ordered = numstatOrder.filter((p) => removed.has(p));
  const seen = new Set(ordered);
  return [...ordered, ...[...removed].filter((p) => !seen.has(p))];
}

/**
 * Pick the ship-time diff base from the merge-base of the two candidate bases —
 * pure (no IO) so the fallback is unit-testable. Fail-quiet: an unresolvable
 * merge-base falls back to `preSha`, the pre-existing behavior (same philosophy
 * as {@link reviewDiffStats} — a git hiccup must never make things worse).
 */
export function resolveShipDiffBase(
  mergeBase: GitRunResult,
  preSha: string,
): string {
  return mergeBase.ok && mergeBase.stdout.length > 0
    ? mergeBase.stdout
    : preSha;
}

/**
 * THE ship-time diff base, and the reason the telemetry bag's diff setter can
 * be LAST WRITE WINS. ← canonical statement of that invariant; other sites
 * point here instead of restating it.
 *
 * The loop measures an issue's diff twice: once at first-pass review (against
 * {@link reviewBaseForCommit} on the run branch, so only implementer attempt 1
 * is in view) and once at the ship funnel, which must span the WHOLE issue.
 * Overwriting the first record is correct only if the ship base is never LATER
 * than the first-pass base, i.e. the measurement can never narrow.
 *
 * `preSha` alone does NOT satisfy that. On a checkpoint RESUME, `createSandbox`
 * force-moves the issue branch onto the saved WIP ref before the worktree
 * exists (`git branch -f <issueBranch> <wipRef>`), so `preSha` is the WIP tip —
 * already carrying the previous session's commits — while the run branch's fork
 * point sits behind it. Diffing from `preSha` there yields a strict SUBSET that
 * silently replaces the broader record on exactly the tickets most likely to
 * need rework analysis.
 *
 * So the base is the COMMON ANCESTOR of both candidates. On a normal issue both
 * collapse to the same commit and behavior is unchanged; on a resume it
 * resolves back to the fork point.
 *
 * WHAT THE CODE ACTUALLY GUARANTEES (two regimes, both "never narrower"):
 *
 *  1. FORK-POINT regime — the ship base EQUALS the first-pass base, not merely
 *     includes it. Two facts compose. (a) `merge-base(branch, postSha)` is
 *     RETRY-INVARIANT: every retry commit lands on the issue branch, which does
 *     not move the fork point, so the merge-base computed from attempt 1's sha
 *     and from the final sha are the same commit. (b) `preSha` always DESCENDS
 *     from that fork point (fresh issue: `preSha` IS it; resume: `preSha` is the
 *     WIP tip ahead of it), so `merge-base(preSha, fork) == fork`. Precondition:
 *     nothing rebases or force-moves the issue branch BETWEEN the two
 *     measurements — that would move the fork point and break (a).
 *  2. TIP-PARENT regime — `reviewBaseForCommit` fell back to `<sha>~1`, which is
 *     a reviewer-only rescue and is REFUSED here (see below). The ship base is
 *     then `preSha`, an ancestor-or-equal of the first-pass base `postSha1~1`
 *     (attempt 1's commits descend from `preSha`), so the ship diff is a
 *     SUPERSET — wider, never narrower.
 *
 * Note this is NOT the property an earlier version of this comment claimed
 * ("ancestor-or-equal of `preSha`"). That is a different, weaker statement and
 * it cannot imply "never narrower": on a resume `preSha` is strictly AHEAD of
 * the first-pass base, which is the entire case this function exists for.
 *
 * WHY THE `~1` FALLBACK IS REFUSED. When an issue produces NO commits,
 * `postSha` is already an ancestor of the run branch, `resolveReviewBase`'s
 * `baseIsTip` branch fires, and the base becomes `postSha~1` — the PRECEDING
 * commit on the run branch, i.e. ANOTHER issue's work. Deriving the ship base
 * from that credits this issue with files it never touched, in the exact
 * dataset built to answer "which files did this ticket touch". So a
 * `tip-parent` resolution is discarded in favour of `preSha`, which for a
 * zero-commit issue makes `reviewDiffStats` short-circuit to "nothing
 * measured" — the honest answer under this project's ABSENT ≠ ZERO rule.
 *
 * A retry that legitimately REVERTS files still yields a smaller diff, which
 * last-write-wins is then right to record.
 */
export function shipDiffBase(
  repoRoot: string,
  branch: string,
  preSha: string,
  postSha: string,
): string {
  const reviewBase = reviewBaseForCommit(repoRoot, branch, postSha);
  if (reviewBase.kind !== "fork-point") return preSha;
  return resolveShipDiffBase(
    runGit(repoRoot, "merge-base", preSha, reviewBase.ref),
    preSha,
  );
}

/**
 * Guards a diff measurement before it's recorded. Pure — no IO.
 *
 * {@link reviewDiffStats} is deliberately fail-quiet: a git error and a
 * genuinely empty diff both come back as `{changedLines: 0, changedFiles:
 * []}`, indistinguishable from each other. The telemetry bag's diff-size
 * setter is LAST WRITE WINS (why that is safe: {@link shipDiffBase}), so an
 * unguarded second measurement would blank a perfectly good earlier record on
 * any git hiccup. A shipping issue with a truly empty diff carries no
 * information worth overwriting real data for — so this rejects the `{0, []}`
 * shape outright, whichever cause produced it.
 *
 * {@link recordDiffMeasurement} applies it to every measurement on its way to
 * the bag, so the guard holds by construction at both measurement sites. ONE
 * caller also applies it directly: `decideFirstPassReviewerModel` in
 * `main.mts`, to decide whether its returned decision carries a `.diff` at all.
 * That is not a bypass — the decision object has its own ABSENT contract (see
 * `FirstPassReviewerDecision`, also in `main.mts`), and it is the same
 * predicate that decides recording, so the two can't disagree about what
 * `{0, []}` means.
 */
export function shouldRecordDiffMeasurement(stats: DiffStats): boolean {
  return stats.changedLines !== 0 || stats.changedFiles.length !== 0;
}

/**
 * The slice of `PipelineCtx` {@link recordDiffMeasurement} reads — a structural
 * subset, so `main.mts` can pass its real ctx while tests build a one-field
 * literal and neither module has to import the other. Same seam as
 * `lib/telemetry/wrappers.ts`'s `TelemetryCtx`.
 */
export interface DiffRecordCtx {
  readonly telemetry?: {
    noteDiff(
      changedLines: number,
      changedFiles: number,
      paths?: readonly string[],
    ): void;
  };
}

/**
 * The single route from a {@link DiffStats} measurement to the telemetry bag:
 * guard, then derive the file COUNT from the paths. Both measurement sites go
 * through here so neither can record a fail-quiet `{0, []}` as "measured, and
 * genuinely empty" — under this project's ABSENT ≠ ZERO rule that would be a
 * lie about a git failure — and so the count can never disagree with the paths
 * it was derived from.
 */
export function recordDiffMeasurement(
  ctx: DiffRecordCtx,
  stats?: DiffStats,
): void {
  if (stats === undefined || !shouldRecordDiffMeasurement(stats)) return;
  ctx.telemetry?.noteDiff(
    stats.changedLines,
    stats.changedFiles.length,
    stats.changedFiles,
  );
}
