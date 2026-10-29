import type { HistoryMode, IssueHistory } from "./rework-history.js";
import type {
  IssueReworkScore,
  ReworkAggregate,
  ReworkGroup,
  ReworkReport,
} from "./rework-rate.js";
import type { ReworkRecord } from "./rework-store.js";
import { flattenModels } from "./rework-projection.js";
import { aggregateRework } from "./rework-rate.js";

/**
 * Rework telemetry, the presentation half: buckets, tables, and the JSON
 * contract.
 *
 * Pure — no clock, no filesystem, no git. It takes a scored {@link ReworkReport}
 * plus the histories `rework-history.ts` read, and turns them into the two
 * things a caller can consume: a human report and a typed `--json` payload.
 *
 * ## The three things this report must never misprint
 *
 * 1. A `null` rework rate is an UNKNOWN, never 0%. A ticket shipped yesterday
 *    that nothing has touched has not scored well — nothing has had TIME to go
 *    wrong. Such rows print in their own section, and the string "0%" never
 *    appears on them.
 * 2. An aggregate's `daysToFirstRework` is a MIN across the group. It is
 *    labelled "earliest", never "average".
 * 3. The by-run and by-model tables DO NOT sum to the overall row. An issue
 *    with no `runId` joins no run group; an issue whose ladder names two models
 *    is counted in BOTH model groups. Both facts are printed under the tables.
 *
 * And one more the outcome policy added: a rate read on a `date only` basis
 * cannot tell a correction from a merely CONCURRENT commit, so it can only
 * overstate. The aggregates say how many rows rest on that basis and restate
 * the rate over ancestry-verified rows alone, rather than printing one hard
 * number over a mixed population.
 *
 * That last rule holds at EVERY level and in BOTH outputs. OVERALL, each BY RUN
 * row and each BY MODEL row carry their own basis, and so does every group in
 * the `--json` payload — one number with no basis beside it is the same lie
 * whichever format it is told in, and the machine contract is the one that will
 * outlive the table. {@link basisByKey} is the single fold all of them read.
 */

/** The CLI's name, printed in the report and echoed in the JSON payload. */
export const TOOL = "sandcastle:rework";

/** The role whose model actually WROTE the code — the one a per-issue row means. */
const IMPLEMENTER_ROLE = "implementer";

// ---------------------------------------------------------------------------
// Shaping (pure)
// ---------------------------------------------------------------------------

/** One printable line: a Part 2 score joined back to the record it came from. */
export interface Row {
  score: IssueReworkScore;
  record: ReworkRecord;
  mode: HistoryMode;
  note?: string;
}

/**
 * Worst first: highest rate, then most reworked files, then the fastest
 * regression, then issue number so the order is stable across runs.
 * Only ever called with rows whose `reworkRate` is non-null.
 */
export function sortWorstFirst(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const rateDelta = (b.score.reworkRate ?? 0) - (a.score.reworkRate ?? 0);
    if (rateDelta !== 0) return rateDelta;
    const countDelta = b.score.reworkedFileCount - a.score.reworkedFileCount;
    if (countDelta !== 0) return countDelta;
    const aDays = a.score.daysToFirstRework ?? Number.POSITIVE_INFINITY;
    const bDays = b.score.daysToFirstRework ?? Number.POSITIVE_INFINITY;
    if (aDays !== bDays) return aDays - bDays;
    return a.score.issueNumber - b.score.issueNumber;
  });
}

export interface Buckets {
  /** Real scores — a non-null `reworkRate`. */
  scored: Row[];
  /**
   * Work that never landed: quarantined, needs-human, or an outcome the store
   * never recorded. A later commit to "its" files is the REDO of work that was
   * never in the tree, not a correction of shipped work.
   */
  excluded: Row[];
  /** The window has not fully elapsed. UNKNOWN, not a good score. */
  insufficient: Row[];
  /** No changed files recorded — a 0/0 that must not read as a clean 0%. */
  zeroFile: Row[];
}

/**
 * Split rows the same way `aggregateRework` does, in the SAME precedence:
 * `excludedByOutcome` wins over `insufficientData`, which wins over
 * `totalFileCount === 0`. If these two orderings disagreed, the printed section
 * counts would contradict the printed aggregate counts — and specifically, a
 * quarantined issue shipped an hour ago would appear in the table's
 * "not enough time elapsed" section while the summary counted it as excluded,
 * which is the same class of lie the outcome policy exists to kill.
 */
export function bucketRows(rows: readonly Row[]): Buckets {
  const buckets: Buckets = {
    scored: [],
    excluded: [],
    insufficient: [],
    zeroFile: [],
  };
  for (const row of rows) {
    if (row.score.excludedByOutcome) buckets.excluded.push(row);
    else if (row.score.insufficientData) buckets.insufficient.push(row);
    else if (row.score.totalFileCount === 0) buckets.zeroFile.push(row);
    else buckets.scored.push(row);
  }
  return buckets;
}

/**
 * How much of a set of scored rows could only be read by DATE, and what the
 * rate says over the ancestry-verified rows alone.
 *
 * WHY BOTH NUMBERS: a `date-only` row tests every commit in the window against
 * the issue's files, so a change another issue made on the same day counts as
 * rework of this one. That is an over-estimate of unknown size, and printing it
 * at the same weight as an ancestry-verified row reports an unknown as a hard
 * number. `aggregateRework` is reused rather than re-folded by hand so this
 * second figure cannot drift from the library's scoring policy.
 */
export interface GroupBasis {
  ancestryScoredCount: number;
  dateOnlyScoredCount: number;
  ancestryOnly: ReworkAggregate;
}

/** The basis of one already-selected set of scored rows. */
function basisOf(scored: readonly Row[]): GroupBasis {
  const ancestry = scored.filter((row) => row.mode === "ancestry");
  return {
    ancestryScoredCount: ancestry.length,
    dateOnlyScoredCount: scored.length - ancestry.length,
    ancestryOnly: aggregateRework(ancestry.map((row) => row.score)),
  };
}

/**
 * No scored rows in the group, so no basis to state.
 *
 * A FUNCTION, not a shared const: this used to be one module-level object
 * handed out by reference to every basis-less group in the JSON payload (and in
 * the text render). It serialised correctly, but a single consumer mutating one
 * group's basis — or its nested `ancestryOnly` — would have silently rewritten
 * every other empty group at the same time. Each caller gets its own.
 */
function emptyGroupBasis(): GroupBasis {
  return basisOf([]);
}

/**
 * The basis for the WHOLE scored population — what OVERALL rests on.
 *
 * Takes the ALREADY-BUCKETED rows, not the raw list: `renderReport` and
 * `buildJson` each hold a `Buckets` before they get here, and re-bucketing
 * inside every helper would fan the same fold out three more times per render.
 */
export function basisSplit(buckets: Buckets): GroupBasis {
  return basisOf(buckets.scored);
}

/**
 * The basis split for EACH group, keyed exactly the way Part 2 keys `byRun` /
 * `byModel`.
 *
 * The keys must match `groupBy`'s: `runId` for a run, and each DISTINCT model
 * VALUE (not role) for a model. A figure joined onto the wrong row is worse than
 * no figure at all, so this mirrors the library's key extraction rather than
 * inventing its own — and it folds through the SAME {@link basisOf} that
 * OVERALL uses, so a group's basis cannot come to mean something else.
 *
 * ONE fold serves both outputs. The table reads `dateOnlyScoredCount` and
 * `ancestryOnly.reworkRate` off it, and `buildJson` puts the whole thing on
 * each group — because a machine consumer reading `byRun[0].aggregate.reworkRate`
 * with no basis beside it reads an unknown as a hard number, which is the same
 * defect the human OVERALL block already refuses to commit.
 */
export function basisByKey(
  buckets: Buckets,
  keysOf: (row: Row) => readonly string[],
): Map<string, GroupBasis> {
  const rowsByKey = new Map<string, Row[]>();
  for (const row of buckets.scored) {
    for (const key of keysOf(row)) {
      const bucket = rowsByKey.get(key);
      if (bucket === undefined) rowsByKey.set(key, [row]);
      else bucket.push(row);
    }
  }
  const out = new Map<string, GroupBasis>();
  for (const [key, rows] of rowsByKey) out.set(key, basisOf(rows));
  return out;
}

/** `byRun`'s key: the run the issue was worked in, or none at all. */
export const runKeysOf = (row: Row): readonly string[] =>
  row.score.runId === undefined ? [] : [row.score.runId];

/** `byModel`'s keys: each DISTINCT model the run's ladder named, in any role. */
export const modelKeysOf = (row: Row): readonly string[] =>
  row.score.models === undefined
    ? []
    : [...new Set(Object.values(row.score.models))];

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

/**
 * A rate as a percentage. Never rounds a real, nonzero rate down to "0%" —
 * printing 0% for 1-in-300 files would claim perfection this data cannot
 * support. `null` never reaches here; it is handled section by section.
 */
export function formatPercent(rate: number): string {
  const pct = rate * 100;
  if (pct > 0 && pct < 0.5) return "<1%";
  if (pct < 100 && pct > 99.5) return ">99%";
  return `${Math.round(pct)}%`;
}

export function formatDays(days: number | null): string {
  return days === null ? "none" : `${days.toFixed(1)}d`;
}

/** Absent / `null` / a figure are THREE different states — see the store. */
export function formatCost(costUsd: number | null | undefined): string {
  if (costUsd === undefined) return "not measured";
  if (costUsd === null) return "unpriced";
  return `$${costUsd.toFixed(2)}`;
}

/** The model that actually wrote the code, falling back to any recorded role. */
export function implementerModel(record: ReworkRecord): string {
  const flat = flattenModels(record.models);
  if (flat === undefined) return "not recorded";
  return flat[IMPLEMENTER_ROLE] ?? Object.values(flat)[0] ?? "not recorded";
}

/** Left-aligned fixed-width table. Empty rows render as nothing. */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (rows.length === 0) return "";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

function aggregateLine(label: string, agg: ReworkAggregate): string {
  if (agg.scoredIssueCount === 0) {
    return `${label}: nothing scoreable yet — ${agg.issueCount} issue(s) recorded, 0 with an elapsed window and recorded files.`;
  }
  const rate =
    agg.reworkRate === null ? "unknown" : formatPercent(agg.reworkRate);
  return (
    `${label}: ${agg.reworkedFileCount} of ${agg.totalFileCount} files reworked = ${rate} ` +
    `across ${agg.scoredIssueCount} scored issue(s); earliest rework ${formatDays(agg.daysToFirstRework)} after ship.`
  );
}

/**
 * One table row per group. The basis is joined on by KEY, never recomputed —
 * re-folding a group's rate script-side would duplicate the library's scoring
 * policy, which is the drift class findings 12/13 exist to kill.
 *
 * The `ancestry` column is what makes these tables say what OVERALL says: the
 * `rate` column is over a mixed population that date-only rows can only
 * overstate, and a group with no verified rows honestly reads "unknown" there
 * rather than borrowing the mixed number's authority.
 */
function groupRows(
  groups: readonly ReworkGroup[],
  basis: Map<string, GroupBasis>,
): string[][] {
  return [...groups]
    .sort((a, b) => {
      const ar = a.aggregate.reworkRate;
      const br = b.aggregate.reworkRate;
      if (ar === null && br === null) return a.key.localeCompare(b.key);
      if (ar === null) return 1;
      if (br === null) return -1;
      if (br !== ar) return br - ar;
      return a.key.localeCompare(b.key);
    })
    .map((g) => {
      const groupBasis = basis.get(g.key) ?? emptyGroupBasis();
      return [
        g.key,
        String(g.aggregate.scoredIssueCount),
        String(g.aggregate.totalFileCount),
        g.aggregate.reworkRate === null
          ? "unknown"
          : formatPercent(g.aggregate.reworkRate),
        groupBasis.ancestryOnly.reworkRate === null
          ? "unknown"
          : formatPercent(groupBasis.ancestryOnly.reworkRate),
        formatDays(g.aggregate.daysToFirstRework),
        String(g.aggregate.insufficientDataCount),
        String(g.aggregate.excludedByOutcomeCount),
        String(groupBasis.dateOnlyScoredCount),
      ];
    });
}

/** The column headers `groupRows` fills, shared by BY RUN and BY MODEL. */
const GROUP_HEADERS = [
  "scored",
  "files",
  "rate",
  "ancestry",
  "earliest",
  "in-window",
  "excluded",
  "date-only",
] as const;

export interface RenderInput {
  storePath: string;
  repoRoot: string;
  windowDays: number;
  skippedLines: number;
  futureVersionLines: number;
  /** Lines collapsed by `rework-store.ts`'s `dedupeRecords` — a `merge=union`
   *  artefact, not damage, but the store's line count is not the issue count
   *  without it. */
  duplicateLines: number;
  /** Distinct issue-run records read, AFTER the duplicate collapse. Carried
   *  rather than derived from `rows`: a row the positional-pairing guard drops
   *  is still a record that was in the store. */
  recordCount: number;
  report: ReworkReport;
  rows: readonly Row[];
  /** Records git could not place in history — excluded from every aggregate. */
  unreadable: readonly IssueHistory[];
  /** Set when git itself is unusable, so the banner explains it ONCE. */
  gitUnavailableReason?: string;
}

/**
 * The whole human report.
 *
 * Pure so the test can assert the one thing that matters most: that an
 * insufficient-data row renders "not enough time elapsed" and that the string
 * "0%" appears nowhere on it.
 */
export function renderReport(input: RenderInput): string {
  const { report, windowDays } = input;
  const buckets = bucketRows(input.rows);
  const out: string[] = [];

  out.push(`${TOOL} — rework within ${windowDays} days of ship`);
  out.push(`repo:  ${input.repoRoot}`);
  out.push(`store: ${input.storePath}`);
  out.push("");
  out.push(
    "Rework = a file this issue changed was changed AGAIN, by somebody else's commit,",
    `within ${windowDays} days. It is the only quality signal the loop cannot grade itself on.`,
    "",
  );

  if (input.gitUnavailableReason !== undefined) {
    out.push(
      `CANNOT SCORE ANYTHING: ${input.gitUnavailableReason}`,
      "  Rework is measured by walking git history forward from each ship commit. With no",
      "  repository there is no history to walk, so every record below is unscored — that is",
      "  a TOOLING gap, not a verdict on the work.",
      "",
    );
  }

  if (input.skippedLines > 0) {
    out.push(
      `WARNING: ${input.skippedLines} damaged line(s) in the store were skipped — coverage below is incomplete.`,
    );
  }
  if (input.futureVersionLines > 0) {
    out.push(
      `WARNING: ${input.futureVersionLines} line(s) were written by a NEWER schema than this tool understands and were not scored.`,
    );
  }
  if (input.duplicateLines > 0) {
    out.push(
      `NOTE: ${input.duplicateLines} duplicate line(s) (same issue, same run) were collapsed to one.`,
      "  Expected, not damage: the store is merged with git's `union` driver, which takes BOTH",
      "  sides of every collision. Counting them would double an issue's files in the rate.",
    );
  }
  if (
    input.skippedLines > 0 ||
    input.futureVersionLines > 0 ||
    input.duplicateLines > 0
  ) {
    out.push("");
  }

  // --- scored -------------------------------------------------------------
  out.push(`SCORED — window elapsed, files recorded (worst first)`);
  if (buckets.scored.length === 0) {
    out.push(
      "  (none yet — every recorded issue is still inside its window, has no recorded files,",
      "   or its ship commit could not be found. Nothing here is a good score; it is an absence.)",
    );
  } else {
    out.push(
      renderTable(
        [
          "issue",
          "run",
          "outcome",
          "files",
          "reworked",
          "rate",
          "earliest",
          "cost",
          "model",
          "basis",
        ],
        sortWorstFirst(buckets.scored).map((row) => [
          `#${row.score.issueNumber}`,
          row.record.runId,
          row.record.outcome,
          String(row.score.totalFileCount),
          String(row.score.reworkedFileCount),
          formatPercent(row.score.reworkRate ?? 0),
          formatDays(row.score.daysToFirstRework),
          formatCost(row.record.costUsd),
          implementerModel(row.record),
          row.mode === "ancestry" ? "ancestry" : "date only",
        ]),
      ),
    );
  }
  // Beside the `outcome` column, and UNCONDITIONAL — the two properties this
  // caveat needs and did not have. It used to sit above the by-run/by-model
  // tables, which carry no outcome at all, so it pointed at nothing. And a
  // clean-looking report is precisely the moment it needs saying: every count
  // here reads as a census unless something says it is not one.
  //
  // The gap is structural. The store REQUIRES `shippedSha` — it is the point a
  // reader walks history forward from — and the loop's bare-`HALT` quarantine
  // paths never hand one back. Those quarantines are therefore never written at
  // all, and no reader can recover their number from this file; the run log is
  // the only place they exist.
  out.push(
    "  QUARANTINES IN THE outcome COLUMN ARE A FLOOR, NOT A CENSUS. A quarantine that reached",
    "  no ship commit has no sha to score from and is never recorded at all, so the true count",
    '  is at least this one. The loop logs each unrecorded one ("no ship sha for a',
    "  'quarantined' outcome\"); grep the run log for the real total.",
  );
  out.push("");

  // --- excluded by outcome ------------------------------------------------
  if (buckets.excluded.length > 0) {
    out.push(
      "NOT SCORED — the work never landed (quarantined, needs-human, or outcome unrecorded)",
    );
    out.push(
      renderTable(
        ["issue", "run", "outcome", "files", "later touches", "cost", "model"],
        [...buckets.excluded]
          .sort((a, b) => a.score.issueNumber - b.score.issueNumber)
          .map((row) => [
            `#${row.score.issueNumber}`,
            row.record.runId,
            row.record.outcome,
            String(row.score.totalFileCount),
            String(row.score.reworkedFileCount),
            formatCost(row.record.costUsd),
            implementerModel(row.record),
          ]),
      ),
      `  These ${buckets.excluded.length} issue(s) have no rework rate. Their lane never merged, so a later`,
      '  commit to "their" files is the REDO of work that was never in the tree — not a correction',
      "  of shipped work. The `later touches` count is shown because it is a real number about a",
      "  real cost, but it is NOT rework and never enters the rate. An UNRECORDED outcome is",
      "  excluded on the same terms: an unknown is not a pass.",
      "",
    );
  }

  // --- not enough time ----------------------------------------------------
  out.push("NOT ENOUGH TIME ELAPSED — no score yet, and NOT a good score");
  if (buckets.insufficient.length === 0) {
    out.push("  (none)");
  } else {
    out.push(
      renderTable(
        ["issue", "run", "files", "rate", "scoreable after", "cost", "model"],
        [...buckets.insufficient]
          .sort((a, b) => a.score.issueNumber - b.score.issueNumber)
          .map((row) => [
            `#${row.score.issueNumber}`,
            row.record.runId,
            String(row.score.totalFileCount),
            "not enough time elapsed",
            row.score.windowEndsAtIso ?? "unknown (bad ship date)",
            formatCost(row.record.costUsd),
            implementerModel(row.record),
          ]),
      ),
      `  These ${buckets.insufficient.length} issue(s) have no rework rate at all. Nothing has yet had TIME`,
      "  to go wrong, so they are excluded from every number below — numerator AND denominator.",
    );
    for (const row of buckets.insufficient) {
      if (row.note !== undefined)
        out.push(`  #${row.score.issueNumber}: ${row.note}`);
    }
  }
  out.push("");

  // --- no files -----------------------------------------------------------
  if (buckets.zeroFile.length > 0) {
    out.push("NO FILES RECORDED — cannot be scored (a 0/0 is not a clean 0%)");
    out.push(
      renderTable(
        ["issue", "run", "outcome", "cost", "model"],
        buckets.zeroFile.map((row) => [
          `#${row.score.issueNumber}`,
          row.record.runId,
          row.record.outcome,
          formatCost(row.record.costUsd),
          implementerModel(row.record),
        ]),
      ),
      "",
    );
  }

  // --- unreadable ---------------------------------------------------------
  if (input.unreadable.length > 0) {
    out.push("HISTORY UNREADABLE — excluded from every number below");
    out.push(
      renderTable(
        ["issue", "run", "ship commit", "why"],
        input.unreadable.map((h) => [
          `#${h.record.issueNumber}`,
          h.record.runId,
          h.record.shippedSha,
          h.note ?? "unknown",
        ]),
      ),
      "  Scoring these as 0% would invent good news out of a missing commit, so they are dropped.",
      "",
    );
  }

  // --- aggregates ---------------------------------------------------------
  const basis = basisSplit(buckets);
  out.push(aggregateLine("OVERALL", report.overall));
  out.push(
    `  ${report.overall.insufficientDataCount} issue(s) still inside the window · ` +
      `${report.overall.excludedByOutcomeCount} whose work never landed · ` +
      `${report.overall.zeroFileIssueCount} with no recorded files · ` +
      `${input.unreadable.length} with unreadable history.`,
  );
  out.push(
    '  "earliest" is the MINIMUM days-to-first-rework across the group, not an average.',
  );
  // The number above is only as strong as its weakest row, and it does not say
  // so on its own. A `date only` row tests EVERY commit in the window against
  // the issue's files, so another issue's concurrent change counts as rework of
  // this one — an over-estimate of unknown size, printed at the same weight as
  // an ancestry-verified row. Restating the rate over the verified rows alone is
  // what turns "here is a number" into "here is what the number rests on".
  if (basis.dateOnlyScoredCount > 0) {
    out.push(
      `  BASIS: ${basis.dateOnlyScoredCount} of ${basis.dateOnlyScoredCount + basis.ancestryScoredCount} scored issue(s) were read by DATE ONLY — their ship commit is not`,
      "  on this branch, so every commit in the window was tested against their files and work",
      "  another issue did concurrently can count as rework of theirs. Those rows can only",
      "  OVERSTATE the rate.",
      `  ${aggregateLine("ANCESTRY-VERIFIED ONLY", basis.ancestryOnly)}`,
      "  Treat the two as the range the true rate lies in, not as two competing answers.",
    );
  } else if (basis.ancestryScoredCount > 0) {
    out.push(
      "  BASIS: every scored issue's ship commit is an ancestor of HEAD, so each rate is over",
      "  commits that provably came after that issue shipped.",
    );
  }
  out.push("");

  const runRows = groupRows(report.byRun, basisByKey(buckets, runKeysOf));
  if (runRows.length > 0) {
    out.push("BY RUN");
    out.push(renderTable(["run", ...GROUP_HEADERS], runRows));
    out.push(
      "  Issues with no runId join no group here, so these rows need not sum to OVERALL.",
      '  "excluded" is work that never landed; "date-only" is how many of the SCORED issues',
      "  could only be read by date, and those can only overstate that row's rate.",
      '  "rate" is over the mixed population; "ancestry" is the same rate over the verified',
      "  rows alone. Read the pair as a range, exactly as under OVERALL.",
      "",
    );
  }

  const modelRows = groupRows(report.byModel, basisByKey(buckets, modelKeysOf));
  if (modelRows.length > 0) {
    out.push(
      "BY MODEL — issues whose run ladder INCLUDED this model, in ANY role",
    );
    out.push(renderTable(["model", ...GROUP_HEADERS], modelRows));
    out.push(
      '  "rate" is over the mixed population; "ancestry" is the same rate over the verified',
      "  rows alone. Read the pair as a range, exactly as under OVERALL.",
      "  A run whose ladder names several models counts its issues in EVERY one of those",
      "  groups, so these rows deliberately do NOT sum to OVERALL. A group keyed by the",
      "  reviewer's model does not mean that model wrote the code — the per-issue table's",
      `  "model" column is the ${IMPLEMENTER_ROLE} role specifically.`,
      "",
    );
  }

  return out.join("\n");
}

/** One issue as `--json` states it: the Part 2 score plus its store context. */
export interface ReworkReportJsonIssue extends IssueReworkScore {
  hostId?: string;
  shippedAtIso: string;
  shippedSha: string;
  quarantined?: boolean;
  costUsd?: number | null;
  wallMs?: number;
  retries?: number;
  /** The {@link IMPLEMENTER_ROLE} model, or "not recorded". */
  implementerModel: string;
  /** How much could be proved about this row's history — see {@link HistoryMode}. */
  historyBasis: HistoryMode;
  historyNote?: string;
}

/**
 * A `byRun` / `byModel` group as `--json` states it: Part 2's aggregate, plus
 * the basis that aggregate rests on.
 *
 * `aggregate` is kept EXACTLY where it was, so no consumer's path changes.
 * `basis` is the addition, and it is not decoration: `byRun[0].aggregate.reworkRate`
 * emitted alone is an unknown wearing the costume of a hard number, which is
 * the one thing this whole report exists not to do. The human OVERALL block has
 * said so since the outcome policy landed; the machine contract will outlive the
 * table, so it says so too.
 */
export interface ReworkGroupJson extends ReworkGroup {
  basis: GroupBasis;
}

/**
 * The `--json` payload — the MACHINE-READABLE CONTRACT, and the reason this is
 * an interface rather than `unknown`.
 *
 * A consumer that pins a field name gets a compile error here when it moves,
 * instead of a silently missing key at 3am. Every bucket the renderer prints has
 * a counterpart in `counts`, and `basis` is not decoration: without it a
 * consumer reads `overall.reworkRate` as a hard number when part of it rests on
 * date-only rows that can only overstate it.
 */
export interface ReworkReportJson {
  tool: string;
  generatedAtIso: string;
  repoRoot: string;
  storePath: string;
  windowDays: number;
  gitUnavailableReason?: string;
  store: {
    exists: boolean;
    /** Records AFTER duplicate collapse — the issue-run count, not the line count. */
    recordCount: number;
    skippedLines: number;
    futureVersionLines: number;
    duplicateLines: number;
  };
  counts: {
    scored: number;
    /** Work that never landed; `reworkRate` is null and stays out of the rate. */
    excludedByOutcome: number;
    insufficientData: number;
    zeroFile: number;
    historyUnreadable: number;
  };
  /** The same rate over ancestry-verified rows only, and how many were not. */
  basis: GroupBasis;
  issues: readonly ReworkReportJsonIssue[];
  historyUnreadable: readonly {
    issueNumber: number;
    runId: string;
    shippedSha: string;
    reason: string;
  }[];
  byRun: readonly ReworkGroupJson[];
  byModel: readonly ReworkGroupJson[];
  overall: ReworkAggregate;
  semantics: readonly string[];
  /** Only on the no-data paths, which still emit a full, valid payload. */
  message?: string;
}

/**
 * Join each group to its basis by KEY. A group with no scored rows at all still
 * appears — Part 2 deliberately keeps it — and gets the empty basis rather than
 * a missing field a consumer would have to guard.
 */
function withGroupBasis(
  groups: readonly ReworkGroup[],
  basis: Map<string, GroupBasis>,
): ReworkGroupJson[] {
  return groups.map((group) => ({
    ...group,
    basis: basis.get(group.key) ?? emptyGroupBasis(),
  }));
}

/** The same report, for machines. Emitted on EVERY path, including no-data. */
export function buildJson(
  input: RenderInput & { exists: boolean; generatedAtIso: string },
): ReworkReportJson {
  const buckets = bucketRows(input.rows);
  const basis = basisSplit(buckets);
  return {
    tool: TOOL,
    generatedAtIso: input.generatedAtIso,
    repoRoot: input.repoRoot,
    storePath: input.storePath,
    windowDays: input.windowDays,
    ...(input.gitUnavailableReason === undefined
      ? {}
      : { gitUnavailableReason: input.gitUnavailableReason }),
    store: {
      exists: input.exists,
      // The DEDUPED record count, not `rows + unreadable`. Those two are what
      // survived scoring, and the positional-pairing guard in `run` legitimately
      // drops a row it cannot attribute — so the old sum under-reported exactly
      // when something went wrong, which is when the number matters.
      recordCount: input.recordCount,
      skippedLines: input.skippedLines,
      futureVersionLines: input.futureVersionLines,
      duplicateLines: input.duplicateLines,
    },
    counts: {
      scored: buckets.scored.length,
      excludedByOutcome: buckets.excluded.length,
      insufficientData: buckets.insufficient.length,
      zeroFile: buckets.zeroFile.length,
      historyUnreadable: input.unreadable.length,
    },
    basis: {
      ancestryScoredCount: basis.ancestryScoredCount,
      dateOnlyScoredCount: basis.dateOnlyScoredCount,
      ancestryOnly: basis.ancestryOnly,
    },
    issues: sortWorstFirst(buckets.scored)
      .concat(buckets.excluded, buckets.insufficient, buckets.zeroFile)
      .map((row) => ({
        ...row.score,
        runId: row.record.runId,
        hostId: row.record.hostId,
        shippedAtIso: row.record.shippedAtIso,
        shippedSha: row.record.shippedSha,
        outcome: row.record.outcome,
        quarantined: row.record.quarantined,
        costUsd: row.record.costUsd,
        wallMs: row.record.wallMs,
        retries: row.record.retries,
        implementerModel: implementerModel(row.record),
        historyBasis: row.mode,
        ...(row.note === undefined ? {} : { historyNote: row.note }),
      })),
    historyUnreadable: input.unreadable.map((h) => ({
      issueNumber: h.record.issueNumber,
      runId: h.record.runId,
      shippedSha: h.record.shippedSha,
      reason: h.note ?? "unknown",
    })),
    byRun: withGroupBasis(input.report.byRun, basisByKey(buckets, runKeysOf)),
    byModel: withGroupBasis(
      input.report.byModel,
      basisByKey(buckets, modelKeysOf),
    ),
    overall: input.report.overall,
    semantics: [
      "reworkRate null means UNKNOWN, never 0% — the window has not elapsed, or no files were recorded.",
      "daysToFirstRework on an aggregate is the MINIMUM across the group, not an average.",
      "byModel counts an issue in every model its run's ladder named, so groups do not sum to overall.",
      "Issues without a runId appear in no byRun group; rows need not sum to overall.",
      "insufficientDataCount, zeroFileIssueCount and excludedByOutcomeCount are all excluded from both numerator and denominator.",
      "Only outcome === 'shipped' is scored. Quarantined, needs-human and UNRECORDED outcomes are excludedByOutcome — their lane never merged, so a later touch is a redo, not rework.",
      "issueCount is exactly scoredIssueCount + insufficientDataCount + zeroFileIssueCount + excludedByOutcomeCount.",
      "historyUnreadable records are excluded from every aggregate — a missing commit is not a 0%.",
      "duplicateLines were collapsed on issueNumber+runId (last wins) — the store is union-merged, so the same line can arrive twice.",
      "Quarantine counts are a FLOOR: a quarantine that reached no ship commit has no sha to score from and is never recorded at all.",
      "historyBasis 'date-only' means the ship commit is not an ancestor of HEAD, so concurrent work by other issues may count as rework — those rows can only OVERSTATE. basis.ancestryOnly is the same rate over verified rows alone.",
      "Every byRun/byModel group carries its OWN basis on the same terms: read group.aggregate.reworkRate and group.basis.ancestryOnly.reworkRate as a range, never the first alone.",
    ],
  };
}
