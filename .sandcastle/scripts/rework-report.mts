#!/usr/bin/env tsx

/**
 * Rework report — "did the work the loop shipped have to be corrected after?"
 *
 * WHY THIS EXISTS: Part 1 (`lib/telemetry/rework-store.ts`) records, durably,
 * which files the loop touched per issue. Part 2 (`lib/telemetry/rework-rate.ts`)
 * scores those records — but it is deliberately PURE: no clock, no filesystem,
 * no git. This file is the CLI that joins them to the world.
 *
 * ## What lives where
 *
 * This file owns argv, the wiring, and the exit code — nothing else. The two
 * halves it used to hold inline are modules now, because at 1,189 lines it was
 * past this repo's ceiling and neither half could be tested without it:
 *
 * - `lib/telemetry/rework-history.ts` — the git side. Repo-root resolution, the
 *   single history walk, and placing each record inside it.
 * - `lib/telemetry/rework-render.ts` — the pure side. Bucketing, sorting, the
 *   human report and the typed `--json` payload.
 *
 * Scoring policy is Part 2's and is tested there. The three things the report
 * must never misprint, and the rules about `null` rates, are documented in
 * `rework-render.ts` beside the code that enforces them.
 *
 * Why a row reads `ancestry` or `date only`, and why a short sha is expanded
 * before it reaches Part 2, are documented in `rework-history.ts` — both are
 * properties of the walk, not of this file.
 *
 * EXIT CODE CONTRACT: non-zero means THE TOOL BROKE. Missing store, empty
 * store, unknown sha, shallow clone, detached HEAD, not-a-repo — all degrade to
 * a clear message and exit 0. An unflattering number is not a failure.
 */

import { resolve } from "node:path";

import {
  dedupeRecords,
  readReworkRecords,
  reworkStorePath,
} from "../lib/telemetry/rework-store.js";
import {
  DEFAULT_REWORK_WINDOW_DAYS,
  resolveWindowDays,
  scoreRework,
  type ReworkAggregate,
  type ReworkInput,
} from "../lib/telemetry/rework-rate.js";
import { flattenModels } from "../lib/telemetry/rework-projection.js";
import {
  isGitRepo,
  placeInHistory,
  resolveMainRepoRoot,
  REWORK_GIT_MAX_BUFFER_BYTES,
  walkUnionWindow,
  type IssueHistory,
} from "../lib/telemetry/rework-history.js";
import {
  buildJson,
  renderReport,
  TOOL,
  type RenderInput,
  type Row,
} from "../lib/telemetry/rework-render.js";
import { makeExecFileGitRunner } from "../lib/state/index.js";
import type { GitRunner } from "../lib/state/issue-lease.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface Args {
  /** Repo whose history is walked. Defaults to the git toplevel of cwd. */
  repoRoot?: string;
  /** Explicit store path. Defaults to the MAIN worktree's store. */
  storePath?: string;
  windowDays?: number;
  json: boolean;
  help: boolean;
}

export const HELP_TEXT = `${TOOL} — did the loop's shipped work have to be corrected?

Usage: pnpm ${TOOL} [options]

  --window-days N   Days after ship during which a later edit counts as rework
                    (default ${DEFAULT_REWORK_WINDOW_DAYS}; non-positive falls back to the default)
  --store PATH      Read this JSONL instead of <repo>/.sandcastle/telemetry/issues.jsonl
  --repo-root PATH  Walk this repo's history (default: the git toplevel of cwd)
  --json            Machine-readable output on every path, including "no data"
  --help            This text

Exit code is 0 whenever the tool worked, even when there is no data and even
when the numbers are bad. Non-zero means the tool itself broke.
`;

/** Parse argv. Unknown flags are reported, never silently ignored. */
export function parseArgs(argv: readonly string[]): {
  args: Args;
  error?: string;
} {
  const args: Args = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string | undefined => argv[++i];
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--window-days": {
        const raw = value();
        if (raw === undefined) return { args, error: `${flag} needs a value` };
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          return { args, error: `${flag} needs a number, got ${raw}` };
        }
        args.windowDays = parsed;
        break;
      }
      case "--store": {
        const raw = value();
        if (raw === undefined) return { args, error: `${flag} needs a value` };
        args.storePath = raw;
        break;
      }
      case "--repo-root": {
        const raw = value();
        if (raw === undefined) return { args, error: `${flag} needs a value` };
        args.repoRoot = raw;
        break;
      }
      default:
        return { args, error: `unknown flag: ${flag}` };
    }
  }
  return { args };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const EMPTY_AGGREGATE: ReworkAggregate = {
  issueCount: 0,
  scoredIssueCount: 0,
  insufficientDataCount: 0,
  zeroFileIssueCount: 0,
  excludedByOutcomeCount: 0,
  totalFileCount: 0,
  reworkedFileCount: 0,
  reworkRate: null,
  daysToFirstRework: null,
};

export async function run(
  argv: readonly string[],
  deps: {
    runner: GitRunner;
    cwd: string;
    nowIso: string;
    write: (text: string) => void;
  },
): Promise<number> {
  const { args, error } = parseArgs(argv);
  if (error !== undefined) {
    deps.write(`${TOOL}: ${error}\n\n${HELP_TEXT}`);
    return 2;
  }
  if (args.help) {
    deps.write(HELP_TEXT);
    return 0;
  }

  const windowDays = resolveWindowDays(args.windowDays);
  const repoRoot =
    args.repoRoot ??
    (await resolveMainRepoRoot(deps.runner, deps.cwd)) ??
    deps.cwd;
  const storePath = args.storePath ?? reworkStorePath(repoRoot);

  const read = readReworkRecords({ path: storePath });
  // Collapse union-merge duplicates ONCE, here, before anything downstream sees
  // a record — the positional `scoreable[i]` ↔ `report.issues[i]` invariant
  // below is built on this exact list, so deduping later would break the
  // pairing that 1fd331c1 fixed.
  const deduped = dedupeRecords(read.records);

  const emptyRender = (): RenderInput => ({
    storePath,
    repoRoot,
    windowDays,
    skippedLines: read.skipped,
    futureVersionLines: read.futureVersion,
    duplicateLines: deduped.duplicates,
    recordCount: deduped.records.length,
    report: {
      issues: [],
      byRun: [],
      byModel: [],
      overall: EMPTY_AGGREGATE,
      windowDays,
    },
    rows: [],
    unreadable: [],
  });

  // No file at all, or a file with nothing usable in it. Both are exit 0 —
  // "no data" is not a tool failure.
  if (!read.exists || deduped.records.length === 0) {
    if (args.json) {
      deps.write(
        `${JSON.stringify(
          {
            ...buildJson({
              ...emptyRender(),
              exists: read.exists,
              generatedAtIso: deps.nowIso,
            }),
            message: read.exists
              ? "the store exists but holds no readable records"
              : "no data yet, the loop has not shipped an issue since telemetry landed",
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    const lines = [`${TOOL} — rework within ${windowDays} days of ship`, ""];
    if (!read.exists) {
      lines.push(
        "no data yet, the loop has not shipped an issue since telemetry landed.",
        "",
        `Expected store: ${storePath}`,
        "It appears the first time the loop ships an issue with telemetry wired in.",
      );
    } else {
      lines.push(
        `The store exists at ${storePath} but holds no readable records.`,
        read.skipped > 0
          ? `All ${read.skipped} line(s) in it were damaged and skipped — this is a store problem, not an empty one.`
          : "The file is present and empty.",
      );
      if (read.futureVersion > 0) {
        lines.push(
          `${read.futureVersion} line(s) were written by a NEWER schema than this tool understands.`,
        );
      }
    }
    deps.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // PREFLIGHT: decide ONCE whether git is usable. Per-record failures would
  // otherwise all report "not in this clone", which is the wrong diagnosis.
  const gitUsable = await isGitRepo(deps.runner, repoRoot);
  const gitUnavailableReason = gitUsable
    ? undefined
    : `not a git repository: ${repoRoot}`;

  // ONE walk over the union of every record's window — never fan out a `git
  // log` per record. Each record is then placed in the commits already in
  // memory; see `walkUnionWindow` for why that costs no rigour.
  const walk = gitUsable
    ? await walkUnionWindow(deps.runner, repoRoot, deduped.records, windowDays)
    : { commits: [], error: gitUnavailableReason };

  const histories: IssueHistory[] = [];
  for (const record of deduped.records) {
    histories.push(
      walk.error === undefined
        ? await placeInHistory(
            deps.runner,
            repoRoot,
            record,
            walk.commits,
            windowDays,
          )
        : {
            record,
            mode: "unavailable",
            laterCommits: [],
            note: walk.error,
          },
    );
  }

  const scoreable = histories.filter((h) => h.mode !== "unavailable");
  const unreadable = histories.filter((h) => h.mode === "unavailable");

  const inputs: ReworkInput[] = scoreable.map((h) => {
    // Hoisted: this is the only flatten per record, and it is typed off BOTH
    // record shapes in `rework-projection.ts` — that signature is the guard
    // against store/scorer model drift, so do not re-widen it here.
    const models = flattenModels(h.record.models);
    return {
      record: {
        issueNumber: h.record.issueNumber,
        shippedAtIso: h.record.shippedAtIso,
        // Prefer the FULL sha — an abbreviated one never matches `%H`, and Part
        // 2 would then count the ship commit as rework of its own files. When
        // git could not resolve it at all the recorded sha is passed through
        // unchanged: the object is not in this clone, so it cannot be in the
        // walk either and there is nothing for the exclusion to do.
        shippedSha: h.resolvedSha ?? h.record.shippedSha,
        ...(h.record.changedFilePaths === undefined
          ? {}
          : { changedFilePaths: h.record.changedFilePaths }),
        runId: h.record.runId,
        hostId: h.record.hostId,
        // WITHOUT THIS the default outcome policy treats every record as an
        // unknown and excludes it, emptying the report. Quarantined work is not
        // scored as if it shipped, and "we did not record how it left" is not
        // the same claim as "it shipped".
        outcome: h.record.outcome,
        ...(models === undefined ? {} : { models }),
      },
      laterCommits: h.laterCommits,
    };
  });

  const report = scoreRework(inputs, { nowIso: deps.nowIso, windowDays });

  // `issues` come back in INPUT order, so index i is scoreable[i]. If that ever
  // stopped holding, a positional fallback into the UNFILTERED record list
  // would credit one issue with another issue's cost and model — the exact bug
  // 1fd331c1 fixed. Drop the row instead of mis-attributing it.
  const rows: Row[] = report.issues.flatMap((score, i) => {
    const history = scoreable[i];
    if (history === undefined || history.record.issueNumber !== score.issueNumber) {
      return [];
    }
    return [
      {
        score,
        record: history.record,
        mode: history.mode,
        ...(history.note === undefined ? {} : { note: history.note }),
      },
    ];
  });

  const renderInput: RenderInput = {
    storePath,
    repoRoot,
    windowDays,
    skippedLines: read.skipped,
    futureVersionLines: read.futureVersion,
    duplicateLines: deduped.duplicates,
    recordCount: deduped.records.length,
    report,
    rows,
    unreadable,
    ...(gitUnavailableReason === undefined ? {} : { gitUnavailableReason }),
  };

  if (args.json) {
    deps.write(
      `${JSON.stringify(
        buildJson({
          ...renderInput,
          exists: read.exists,
          generatedAtIso: deps.nowIso,
        }),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  deps.write(`${renderReport(renderInput)}\n`);
  return 0;
}

/** Is this file being run directly, rather than imported by the test? */
function isMain(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return (
      resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  void (async (): Promise<void> => {
    try {
      const code = await run(process.argv.slice(2), {
        // The union walk is unbounded from HEAD, so its output grows with the
        // repo and the shared 8 MiB default is already half spent. See
        // REWORK_GIT_MAX_BUFFER_BYTES — without this argument the whole metric
        // goes dark at once when history outgrows the default.
        runner: makeExecFileGitRunner(REWORK_GIT_MAX_BUFFER_BYTES),
        cwd: process.cwd(),
        nowIso: new Date().toISOString(),
        write: (text) => process.stdout.write(text),
      });
      process.exit(code);
    } catch (err) {
      // Reaching here means the TOOL broke — the data paths above all return 0.
      process.stderr.write(
        `${TOOL}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}
