/**
 * Rework rate — did the work the loop shipped have to be corrected afterwards?
 *
 * WHY THIS EXISTS: the loop's own review pass is not an external quality
 * signal — it approved work that two later, independent reviews found real
 * defects in. The only honest signal is what HAPPENED to the code after it
 * shipped: if a file the loop touched for issue #N is edited again days later
 * by somebody else's commit, that edit is the correction the review missed.
 * This module turns the durable per-issue records into that number.
 *
 * Everything here is pure (no IO, no git, no clock): the caller walks history
 * with git and passes the later commits in, and passes the current time in as
 * `nowIso`. That is what makes the policy fully unit-testable without a repo —
 * do not add a `Date.now()` or a `readFile` here.
 *
 * THE ONE RULE THAT MATTERS MOST — `insufficientData`. A ticket shipped
 * yesterday scoring 0% rework has NOT scored well; nothing has had time to go
 * wrong yet. Such an issue is flagged, its `reworkRate` is `null`, and it is
 * excluded from every aggregate's numerator and denominator and counted
 * separately instead. A no-op ticket (zero changed files) is likewise `null`,
 * never 0% — dividing by zero and reporting "perfect" is the same lie.
 *
 * WINDOW BOUNDARIES (both comparisons use the same arithmetic, deliberately):
 *   - a commit counts when `0 <= commitTime - shipTime <= windowDays`, i.e.
 *     inclusive at exactly `shippedAt + windowDays`
 *   - the window has fully elapsed when `nowIso >= shippedAt + windowDays`, so
 *     the instant a boundary commit still counts is also the instant the score
 *     becomes final
 * A commit dated BEFORE the ship is dropped rather than counted: the caller
 * guarantees ancestry, so a negative delta means committer-date skew from a
 * rebase, and a skewed date cannot be trusted to place the commit in a window.
 *
 * WHAT IS SCORED AT ALL — `outcome`. A quarantined issue's lane branch never
 * merged, so a later commit to "its" files is the REDO of work that never
 * landed, not a correction of shipped work. Scoring it produces a rework rate
 * for code that was never in the tree. So {@link scoreIssueRework} scores only
 * records whose `outcome` is `"shipped"` unless the caller opts in via
 * {@link ReworkOptions.includeAllOutcomes}; everything else — including an
 * ABSENT outcome, which states "we do not know how this issue left" — is
 * marked {@link IssueReworkScore.excludedByOutcome} and kept out of every
 * aggregate's numerator, denominator and issue buckets.
 *
 * THE ORDERING CONTRACT `scoreRework` OWES ITS CALLER: exactly one score per
 * input, in input order, ALWAYS — excluded issues included. Callers pair
 * `report.issues[i]` back to their own `inputs[i]` positionally; silently
 * dropping an excluded issue here would shift every later row onto the wrong
 * record. Exclusion is applied when AGGREGATING, never by shortening the list.
 */
import { pathMatchesGlob } from "../paths/glob.js";

/** Days after ship during which a later edit counts as rework. */
export const DEFAULT_REWORK_WINDOW_DAYS = 14;

/** Churn that is never a quality signal on either side of the comparison. */
export const DEFAULT_REWORK_EXCLUDED_PATH_GLOBS: readonly string[] = [
  "*.lock",
  "pnpm-lock.yaml",
  "*.min.*",
];

/**
 * Milliseconds in a day. EXPORTED because the caller that walks git must bound
 * its walk with the same arithmetic this module scores with — a private copy in
 * the caller is a comment asserting agreement where an import would guarantee
 * it (this was a real finding: the report script had duplicated both this and
 * {@link resolveWindowDays}).
 */
export const DAY_MS = 86_400_000;

/**
 * How the issue left the loop, mirroring `rework-store.ts`'s `ReworkOutcome`.
 *
 * Declared as a UNION and not a bare `string` on purpose: it is what makes the
 * type-level bridge in `rework-projection.ts` non-vacuous, so a store-side
 * widening of the enum fails typecheck here instead of silently arriving as an
 * outcome this scorer's default policy would then exclude without anyone
 * noticing.
 */
export type ReworkScoreOutcome = "shipped" | "quarantined" | "needs-human";

/** The one outcome that means the work is actually in the tree. */
export const SHIPPED_OUTCOME = "shipped" as const satisfies ReworkScoreOutcome;

/**
 * The subset of a durable issue record this scorer reads. Structural on
 * purpose: it is satisfied by the JSONL record written by the store without
 * this module importing it.
 */
export interface ReworkIssueRecord {
  issueNumber: number;
  /** ISO 8601. Unparsable ⇒ the issue is scored `insufficientData`. */
  shippedAtIso: string;
  /** The ship commit, excluded from its own rework set when known. */
  shippedSha?: string;
  /** Absent is not empty — an unrecorded list scores `null`, like a no-op. */
  changedFilePaths?: readonly string[];
  runId?: string;
  hostId?: string;
  /** Role → model id, as the run resolved it. */
  models?: Readonly<Record<string, string>>;
  /**
   * How the issue left the loop. ABSENT IS NOT `"shipped"` — an unrecorded
   * outcome is an unknown, and an unknown is excluded by default exactly like a
   * quarantine, because scoring it would put work that may never have merged
   * into the headline rate. Callers reading the store always have this field;
   * it is optional here only so the interface stays structural.
   */
  outcome?: ReworkScoreOutcome;
}

/** A commit that lands after some issue shipped, as the caller read it from git. */
export interface LaterCommit {
  sha: string;
  /** ISO 8601. Unparsable ⇒ the commit is skipped. */
  dateIso: string;
  message: string;
  /** Repo-relative, `/`-separated paths this commit touched. */
  files: readonly string[];
  /** True when the commit has more than one parent. */
  isMerge?: boolean;
}

/** One issue plus the commits the caller found after its ship point. */
export interface ReworkInput {
  record: ReworkIssueRecord;
  laterCommits: readonly LaterCommit[];
}

export interface ReworkOptions {
  /** REQUIRED — the clock is an input, never read here. */
  nowIso: string;
  /** Defaults to {@link DEFAULT_REWORK_WINDOW_DAYS}; non-finite/<=0 falls back. */
  windowDays?: number;
  /** Default true. */
  excludeMergeCommits?: boolean;
  /** Default true — a commit naming the issue is the issue's own work. */
  excludeSameIssueCommits?: boolean;
  /** Defaults to {@link DEFAULT_REWORK_EXCLUDED_PATH_GLOBS}. */
  excludedPathGlobs?: readonly string[];
  /**
   * Default FALSE — score only `outcome === "shipped"` records.
   *
   * Opt in to score quarantined / needs-human / outcome-less records too. That
   * is a legitimate question ("how much did we redo work that never landed?"),
   * but it is a DIFFERENT question from the rework rate, so the caller has to
   * ask for it, and a report that sets this must say so in its output —
   * otherwise the headline number silently changes meaning.
   */
  includeAllOutcomes?: boolean;
}

export interface IssueReworkScore {
  issueNumber: number;
  runId?: string;
  models?: Readonly<Record<string, string>>;
  /** Echoed from the record so a renderer can show an `outcome` column without
   *  going back to the store. Absent when the record carried none. */
  outcome?: ReworkScoreOutcome;
  /**
   * True when this issue is outside the scored population because of its
   * outcome (see the header). Such a score always has `reworkRate: null` and is
   * counted in {@link ReworkAggregate.excludedByOutcomeCount} INSTEAD of any
   * other bucket — it is not "insufficient data", which means "shipped, but too
   * recently to judge".
   */
  excludedByOutcome: boolean;
  /** Distinct, non-excluded files the issue changed. */
  totalFileCount: number;
  reworkedFileCount: number;
  /** `null` when the window has not elapsed OR the issue changed no files. */
  reworkRate: number | null;
  /** Fractional days from ship to the earliest rework commit; `null` if none. */
  daysToFirstRework: number | null;
  insufficientData: boolean;
  reworkedFilePaths: readonly string[];
  /** `null` when the ship date is unparsable. */
  windowEndsAtIso: string | null;
}

export interface ReworkAggregate {
  issueCount: number;
  /** Issues contributing to the rate: neither insufficient nor zero-file. */
  scoredIssueCount: number;
  insufficientDataCount: number;
  /** No-op tickets — a 0/0 that must not read as a clean 0%. */
  zeroFileIssueCount: number;
  /** Issues left out because of their outcome (quarantined / needs-human /
   *  unrecorded). Counted before every other bucket, so an issue is never in
   *  two of them: `issueCount` is exactly the sum of the four. */
  excludedByOutcomeCount: number;
  totalFileCount: number;
  reworkedFileCount: number;
  /** `null` when no scoreable file is in the denominator. */
  reworkRate: number | null;
  /** Earliest across the group; `null` if nothing was reworked. */
  daysToFirstRework: number | null;
}

export interface ReworkGroup {
  key: string;
  aggregate: ReworkAggregate;
}

export interface ReworkReport {
  /** Per issue, in input order — worst-first sorting is the caller's job. */
  issues: readonly IssueReworkScore[];
  byRun: readonly ReworkGroup[];
  /** Keyed by each DISTINCT model id. An issue whose run used two models is
   * counted in BOTH groups, so these do not sum to `overall`. */
  byModel: readonly ReworkGroup[];
  overall: ReworkAggregate;
  windowDays: number;
}

/** Milliseconds since epoch, or `null` when the string is not a usable date. */
function parseIso(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The window in days, with a non-number / non-finite / non-positive value
 * falling back to {@link DEFAULT_REWORK_WINDOW_DAYS}.
 *
 * EXPORTED for the same reason as {@link DAY_MS}: whoever bounds a git walk
 * before calling in must resolve the window the identical way. Walking 14 days
 * while scoring 30 hides every correction in the gap and prints the result as
 * good news.
 */
export function resolveWindowDays(windowDays: number | undefined): number {
  if (typeof windowDays !== "number") return DEFAULT_REWORK_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_REWORK_WINDOW_DAYS;
  }
  return windowDays;
}

function isExcludedPath(path: string, globs: readonly string[]): boolean {
  for (const glob of globs) {
    if (pathMatchesGlob(path, glob)) return true;
  }
  return false;
}

/**
 * Does this commit undo something? A revert of the issue names the issue's own
 * number, so it would otherwise be filtered out as the issue's own work — and a
 * revert is the STRONGEST possible rework signal. This check therefore wins
 * over the attribution filter.
 */
export function looksLikeRevert(message: string): boolean {
  return /^\s*revert\b/i.test(message) || /this reverts commit/i.test(message);
}

/**
 * Is this commit part of issue `issueNumber`'s own work?
 *
 * TWO shapes, and the second is the one that matters. Humans write `#783`, but
 * the LOOP writes `SANDCASTLE(it=9 issue=783): ...` with no `#` at all — 1,061
 * commits in this repo's history use that form and none of them carry a hash.
 * Matching only `#N` therefore fails to recognise the loop's own commits as its
 * own, so every follow-up commit an issue made would score as REWORK OF ITSELF
 * and drive the rate toward 100%. The number is the signal; the sigil is not.
 *
 * Both forms are guarded against a longer number, so `#1000` and `issue=1000`
 * never satisfy `100`.
 */
export function referencesIssue(message: string, issueNumber: number): boolean {
  return new RegExp(`(?:#|\\bissue=)${issueNumber}(?![0-9])`).test(message);
}

/** Score one issue against the commits that followed it. */
export function scoreIssueRework(
  input: ReworkInput,
  options: ReworkOptions,
): IssueReworkScore {
  const { record, laterCommits } = input;
  const windowDays = resolveWindowDays(options.windowDays);
  const excludeMerges = options.excludeMergeCommits ?? true;
  const excludeSameIssue = options.excludeSameIssueCommits ?? true;
  const excludedGlobs =
    options.excludedPathGlobs ?? DEFAULT_REWORK_EXCLUDED_PATH_GLOBS;
  // Outcome is checked FIRST and independently of everything else: a
  // quarantined issue is out of the population regardless of how much of it
  // was later touched, so the file walk below still runs (a renderer may want
  // to show what happened) but the rate it feeds is forced to `null`.
  const excludedByOutcome =
    options.includeAllOutcomes === true
      ? false
      : record.outcome !== SHIPPED_OUTCOME;

  const shipMs = parseIso(record.shippedAtIso);
  const nowMs = parseIso(options.nowIso);
  const windowMs = windowDays * DAY_MS;
  const windowEndMs = shipMs === null ? null : shipMs + windowMs;
  // An unparsable ship date or clock cannot prove the window elapsed, and an
  // unproven window must read as UNKNOWN, never as a clean score.
  const insufficientData =
    shipMs === null || nowMs === null || nowMs < shipMs + windowMs;

  const owned = new Set<string>();
  for (const path of record.changedFilePaths ?? []) {
    if (isExcludedPath(path, excludedGlobs)) continue;
    owned.add(path);
  }

  /** file → earliest ms of a commit that reworked it. */
  const reworkedAt = new Map<string, number>();
  if (shipMs !== null) {
    for (const commit of laterCommits) {
      if (excludeMerges && commit.isMerge === true) continue;
      if (record.shippedSha !== undefined && commit.sha === record.shippedSha) {
        continue;
      }
      if (
        excludeSameIssue &&
        referencesIssue(commit.message, record.issueNumber) &&
        !looksLikeRevert(commit.message)
      ) {
        continue;
      }
      const commitMs = parseIso(commit.dateIso);
      if (commitMs === null) continue;
      const elapsed = commitMs - shipMs;
      if (elapsed < 0 || elapsed > windowMs) continue;
      for (const path of commit.files) {
        if (!owned.has(path)) continue;
        const seen = reworkedAt.get(path);
        if (seen === undefined || commitMs < seen)
          reworkedAt.set(path, commitMs);
      }
    }
  }

  const totalFileCount = owned.size;
  const reworkedFilePaths = [...reworkedAt.keys()];
  const reworkedFileCount = reworkedFilePaths.length;
  const firstMs =
    reworkedFileCount === 0 ? null : Math.min(...reworkedAt.values());

  return {
    issueNumber: record.issueNumber,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.models === undefined ? {} : { models: record.models }),
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    excludedByOutcome,
    totalFileCount,
    reworkedFileCount,
    reworkRate:
      excludedByOutcome || insufficientData || totalFileCount === 0
        ? null
        : reworkedFileCount / totalFileCount,
    daysToFirstRework:
      firstMs === null || shipMs === null ? null : (firstMs - shipMs) / DAY_MS,
    insufficientData,
    reworkedFilePaths,
    windowEndsAtIso:
      windowEndMs === null ? null : new Date(windowEndMs).toISOString(),
  };
}

/**
 * Fold per-issue scores into one aggregate. Insufficient-data issues are
 * counted but contribute NOTHING to the rate — that separation is the whole
 * point, so never let one back into the denominator.
 */
export function aggregateRework(
  scores: readonly IssueReworkScore[],
): ReworkAggregate {
  let scoredIssueCount = 0;
  let insufficientDataCount = 0;
  let zeroFileIssueCount = 0;
  let excludedByOutcomeCount = 0;
  let totalFileCount = 0;
  let reworkedFileCount = 0;
  let daysToFirstRework: number | null = null;

  for (const score of scores) {
    // BEFORE `insufficientData`, deliberately: a quarantined issue shipped
    // (well, didn't) an hour ago is BOTH, and filing it under
    // "insufficient data" would inflate the count that says "give these
    // tickets more time" with tickets that will never be scoreable at all.
    if (score.excludedByOutcome) {
      excludedByOutcomeCount++;
      continue;
    }
    if (score.insufficientData) {
      insufficientDataCount++;
      continue;
    }
    if (score.totalFileCount === 0) {
      zeroFileIssueCount++;
      continue;
    }
    scoredIssueCount++;
    totalFileCount += score.totalFileCount;
    reworkedFileCount += score.reworkedFileCount;
    if (
      score.daysToFirstRework !== null &&
      (daysToFirstRework === null ||
        score.daysToFirstRework < daysToFirstRework)
    ) {
      daysToFirstRework = score.daysToFirstRework;
    }
  }

  return {
    issueCount: scores.length,
    scoredIssueCount,
    insufficientDataCount,
    zeroFileIssueCount,
    excludedByOutcomeCount,
    totalFileCount,
    reworkedFileCount,
    reworkRate:
      totalFileCount === 0 ? null : reworkedFileCount / totalFileCount,
    daysToFirstRework,
  };
}

/** Group scores by a key extractor that may yield zero or several keys. */
function groupBy(
  scores: readonly IssueReworkScore[],
  keysOf: (score: IssueReworkScore) => readonly string[],
): readonly ReworkGroup[] {
  const buckets = new Map<string, IssueReworkScore[]>();
  for (const score of scores) {
    for (const key of keysOf(score)) {
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [score]);
      else bucket.push(score);
    }
  }
  return [...buckets.entries()].map(([key, group]) => ({
    key,
    aggregate: aggregateRework(group),
  }));
}

/**
 * Score every issue and build the run / model / overall aggregates.
 *
 * CONTRACT: `issues` has exactly one entry per input, in input order — always,
 * outcome-excluded issues included. Callers pair `issues[i]` back to their own
 * `inputs[i]`, so filtering here would shift every later row onto the wrong
 * record. Exclusion happens in {@link aggregateRework}, never by shortening
 * this list.
 *
 * A consequence worth expecting: a run or model whose every issue is excluded
 * still appears in `byRun`/`byModel`, with `scoredIssueCount: 0` and a `null`
 * rate. That is the honest rendering — the group existed and produced nothing
 * scoreable — not an empty row to filter out silently.
 */
export function scoreRework(
  inputs: readonly ReworkInput[],
  options: ReworkOptions,
): ReworkReport {
  const issues = inputs.map((input) => scoreIssueRework(input, options));
  return {
    issues,
    byRun: groupBy(issues, (s) => (s.runId === undefined ? [] : [s.runId])),
    byModel: groupBy(issues, (s) =>
      s.models === undefined ? [] : [...new Set(Object.values(s.models))],
    ),
    overall: aggregateRework(issues),
    windowDays: resolveWindowDays(options.windowDays),
  };
}
