/**
 * The merge rule for the loop's own run PR (tokenmaxxing#29, build plan 4.6).
 *
 * The same rule every agent on the owner's machines follows: merge your own
 * pull request only when it is a two-way door (easy to undo), its blast
 * radius is small, and every check is green. Anything else stays open for
 * the owner.
 *
 * Pure and deterministic: the answer depends only on the facts passed in
 * (the branch's diff against the base, the run's own warnings, the PR's
 * check rollup). Nothing here reads git, GitHub or the clock.
 */

import { posix, sep } from "node:path";

import { getProjectConfig, wideReachPaths } from "../project-config.js";

import { REWORK_STORE_RELATIVE_PATH } from "../telemetry/rework-store.js";
import { classifyMigrationSql, isMigrationSqlPath } from "./migration-sorter.js";

export interface ChangedFile {
  readonly path: string;
  /** `git diff --name-status` letter: A(dded), M(odified), D(eleted), R(enamed) … */
  readonly status: "A" | "M" | "D" | "R" | "C" | "T";
  readonly additions: number;
  readonly deletions: number;
}

export interface RunFacts {
  readonly files: readonly ChangedFile[];
  readonly issueCount: number;
  readonly promotionFailed: boolean;
  readonly breakerTripped: boolean;
  readonly previouslyShippedCount: number;
  /**
   * The content of every ADDED migration (`.sql` under the migrations folder),
   * keyed by path, read at the exact commit being classified. An added
   * migration missing from this map is treated as destructive: an unread
   * migration is never assumed safe.
   */
  readonly migrationSql: ReadonlyMap<string, string>;
}

export type Door = "one-way" | "two-way";
export type BlastRadius = "small" | "large";

export interface ChangeClass {
  readonly door: Door;
  /** Why the door is one-way, in plain words. Empty for a two-way door. */
  readonly doorReasons: readonly string[];
  readonly blastRadius: BlastRadius;
  /** Why the blast radius is large, in plain words. Empty when small. */
  readonly blastReasons: readonly string[];
  /**
   * The migrations that hold this run for the owner (spec #1334): each one
   * deletes or rewrites existing data, could not be read, or edits a migration
   * already on the default branch. Empty when every migration only adds. The
   * run report reads this to count a held migration as reaching the owner.
   */
  readonly destructiveMigrations: readonly string[];
}

export type ChecksState = "green" | "pending" | "failing" | "none";

export interface MergeDecision {
  readonly merge: boolean;
  readonly why: string;
}

/**
 * Paths whose merge to the default branch does something `git revert` cannot
 * take back. `.github/workflows/release-migrations.yml` applies every
 * migration to the PRODUCTION database on each push to `main`; it is the gate
 * in front of production, so changing it is a one-way door.
 *
 * Migrations themselves are sorted by what their SQL does, not by path
 * (`migrationDoorReasons`): only one that deletes or rewrites existing data
 * holds the run. Reverting an additive migration's commit leaves an unused
 * table or column behind, but loses nothing anyone had.
 */
const ONE_WAY_PATHS: readonly { readonly paths: readonly string[]; readonly what: string }[] = [
  { paths: [".github/workflows/release-migrations.yml"], what: "changes the production migration release" },
];

/** One door reason per migration that holds the run, and the paths that hold. */
function migrationDoorReasons(
  files: readonly ChangedFile[],
  migrationSql: ReadonlyMap<string, string>,
): { reasons: string[]; held: string[] } {
  const reasons: string[] = [];
  const held: string[] = [];
  for (const f of files) {
    if (!isMigrationSqlPath(f.path)) continue;
    let reason: string | undefined;
    if (f.status !== "A") {
      // A migration tool never re-runs an applied migration, so an edit or removal
      // silently splits production from the code.
      reason = `edits a migration already on the default branch (${f.path})`;
    } else {
      const sql = migrationSql.get(f.path);
      if (sql === undefined) {
        reason = `a migration the loop could not read (${f.path})`;
      } else {
        const verdict = classifyMigrationSql(sql);
        if (verdict.destructive) {
          reason = `deletes or rewrites existing data (${f.path}: ${verdict.reasons.join("; ")})`;
        }
      }
    }
    if (reason !== undefined) {
      reasons.push(reason);
      held.push(f.path);
    }
  }
  return { reasons, held };
}

/** Upper bounds of a "small" run. Above any one of them, the owner looks first. */
export const SMALL_MAX_FILES = 10;
export const SMALL_MAX_LINES = 300;
export const SMALL_MAX_ISSUES = 3;

/**
 * Paths every other part of the product leans on. A bug in any of them breaks
 * far more than the ticket that touched it, so a change there is never small,
 * however few lines it is. An entry ending in `/` matches a folder; any other
 * entry matches that exact file. The generic entries (`GENERIC_WIDE_REACH_PATHS`)
 * are built in; a project adds its own through `wideReachPaths` in
 * `.sandcastle/project.json`.
 */

/** The loop commits its rework telemetry to every run branch. It is bookkeeping,
 *  not product code, so it never counts toward the size of a change. */
const TELEMETRY_PATH = REWORK_STORE_RELATIVE_PATH.split(sep).join(posix.sep);

const matches = (path: string, rule: string): boolean =>
  rule.endsWith("/") ? path.startsWith(rule) : path === rule;

function reasonsFor(
  files: readonly ChangedFile[],
  rules: readonly { readonly paths: readonly string[]; readonly what: string }[],
): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const hits = files.filter((f) => rule.paths.some((p) => matches(f.path, p)));
    if (hits.length > 0) out.push(`${rule.what} (${hits.map((f) => f.path).join(", ")})`);
  }
  return out;
}

export function classifyChange(facts: RunFacts): ChangeClass {
  const files = facts.files.filter((f) => f.path !== TELEMETRY_PATH);
  const migrations = migrationDoorReasons(files, facts.migrationSql);
  const doorReasons = [...migrations.reasons, ...reasonsFor(files, ONE_WAY_PATHS)];

  const blastReasons: string[] = [];
  if (files.length > SMALL_MAX_FILES) {
    blastReasons.push(`changes ${files.length} files (small is at most ${SMALL_MAX_FILES})`);
  }
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines > SMALL_MAX_LINES) {
    blastReasons.push(`changes ${lines} lines (small is at most ${SMALL_MAX_LINES})`);
  }
  if (facts.issueCount > SMALL_MAX_ISSUES) {
    blastReasons.push(`ships ${facts.issueCount} issues (small is at most ${SMALL_MAX_ISSUES})`);
  }
  blastReasons.push(...reasonsFor(files, wideReachPaths()));
  const deleted = files.filter((f) => f.status === "D");
  if (deleted.length > 0) {
    blastReasons.push(`deletes a file (${deleted.map((f) => f.path).join(", ")})`);
  }
  if (facts.promotionFailed) blastReasons.push("a final promotion failed, so the branch may be incomplete");
  if (facts.breakerTripped) blastReasons.push("the circuit breaker cut the run short");
  if (facts.previouslyShippedCount > 0) {
    blastReasons.push(
      `carries ${facts.previouslyShippedCount} issue(s) from an interrupted run that nobody re-checked`,
    );
  }

  return {
    door: doorReasons.length > 0 ? "one-way" : "two-way",
    doorReasons,
    blastRadius: blastReasons.length > 0 ? "large" : "small",
    blastReasons,
    destructiveMigrations: migrations.held,
  };
}

const CHECKS_WHY: Record<Exclude<ChecksState, "green">, string> = {
  pending: "a check is still running",
  failing: "a check failed",
  none: "no check ran on this PR",
};

export function decideMerge(c: ChangeClass, checks: ChecksState): MergeDecision {
  if (c.door === "one-way") return { merge: false, why: `one-way door: ${c.doorReasons.join("; ")}` };
  if (c.blastRadius === "large") return { merge: false, why: `large blast radius: ${c.blastReasons.join("; ")}` };
  if (checks !== "green") return { merge: false, why: CHECKS_WHY[checks] };
  return { merge: true, why: "two-way door, small blast radius, every check green" };
}

/** One entry of `gh pr view --json statusCheckRollup`: a GitHub Actions (or
 *  app) check run, or a commit status such as Vercel's. */
export type RollupEntry =
  | {
      readonly __typename: "CheckRun";
      readonly name?: string;
      readonly status?: string | null;
      readonly conclusion?: string | null;
    }
  | { readonly __typename: "StatusContext"; readonly context?: string; readonly state?: string | null }
  | { readonly __typename?: string };

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

/**
 * Fold a PR's check rollup into one state. Failing beats pending: one red
 * check already decides the answer, so there is no reason to wait for the
 * rest. An empty rollup is `none`, never green: "every check passes" means
 * something must have run.
 */
export function readChecks(rollup: readonly RollupEntry[]): ChecksState {
  if (rollup.length === 0) return "none";
  let pending = false;
  for (const entry of rollup) {
    if (entry.__typename === "CheckRun" && "status" in entry) {
      if (entry.status !== "COMPLETED") pending = true;
      else if (!PASSING_CONCLUSIONS.has(entry.conclusion ?? "")) return "failing";
    } else if (entry.__typename === "StatusContext" && "state" in entry) {
      if (PENDING_STATES.has(entry.state ?? "")) pending = true;
      else if (entry.state !== "SUCCESS") return "failing";
    } else {
      // A shape this code does not know cannot be called green.
      pending = true;
    }
  }
  return pending ? "pending" : "green";
}

/** The `pr` skill's Merge Danger section: door, blast radius, and what the loop
 *  will do with this PR. `mergeLine` is the loop's own plan or final word. */
export function renderMergeDanger(c: ChangeClass, mergeLine: string): string {
  const bullets = (reasons: readonly string[]) =>
    reasons.length === 0 ? [] : ["", ...reasons.map((r) => `- ${r}`)];
  return [
    "## Merge Danger",
    "",
    `**Door:** ${c.door}`,
    ...bullets(c.doorReasons),
    "",
    `**Blast Radius:** ${c.blastRadius}`,
    ...bullets(c.blastReasons),
    "",
    `**Merge rule:** ${mergeLine}`,
  ].join("\n");
}

/** Name at most this many files in the Summary; a PR body has a size cap. */
const SUMMARY_MAX_FILES = 40;

const STATUS_MARK: Record<ChangedFile["status"], string> = { A: "+", D: "-", M: " ", R: " ", C: " ", T: " " };

/** The `pr` skill's Summary section: one line of prose, then the changed files
 *  as a diff-sketch (added `+`, deleted `-`) with their line counts. */
export function renderSummary(lead: string, files: readonly ChangedFile[]): string {
  const shown = files.filter((f) => f.path !== TELEMETRY_PATH);
  const lines = shown
    .slice(0, SUMMARY_MAX_FILES)
    .map((f) => `${STATUS_MARK[f.status]} ${f.path}  (+${f.additions} -${f.deletions})`);
  if (shown.length > SUMMARY_MAX_FILES) lines.push(`  ... and ${shown.length - SUMMARY_MAX_FILES} more files`);
  return ["## Summary", "", lead, "", "```diff", ...lines, "```"].join("\n");
}

/**
 * Join `git diff --no-renames --numstat` and `git diff --no-renames
 * --name-status` (same range) into one entry per file. `--no-renames` keeps
 * one path per line: a rename shows as a delete plus an add, and the delete
 * counts against the blast radius, as moving a file others import should.
 */
export function parseDiff(numstat: string, nameStatus: string): ChangedFile[] {
  const statusOf = new Map<string, ChangedFile["status"]>();
  for (const line of nameStatus.split("\n")) {
    const [letter, path] = line.split("\t");
    if (letter && path) statusOf.set(path, letter.charAt(0) as ChangedFile["status"]);
  }
  const files: ChangedFile[] = [];
  for (const line of numstat.split("\n")) {
    const [add, del, path] = line.split("\t");
    if (add === undefined || del === undefined || !path) continue;
    files.push({
      path,
      status: statusOf.get(path) ?? "M",
      // `-` is git's mark for a binary file, which has no line count.
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
    });
  }
  return files;
}

/** Marker comments around the Merge Danger section, so the loop can rewrite
 *  it with its final word after the checks settle. One section per PR, not
 *  per host: it always describes the PR's current head. */
export function mergeRuleSectionStart(): string {
  return "<!-- sandcastle:merge-rule:start -->";
}
export function mergeRuleSectionEnd(): string {
  return "<!-- sandcastle:merge-rule:end -->";
}

/** The Merge rule line while the checks have not been read yet. */
export function plannedMergeLine(c: ChangeClass): string {
  const { ownerName, landCheck } = getProjectConfig();
  // No pre-merge check configured: the loop never lands its own run PR.
  if (landCheck === null) return noLandCheckLine(ownerName);
  const blocked = decideMerge(c, "green");
  return blocked.merge
    ? "the loop merges this itself once every check is green."
    : `waits for ${ownerName} (${blocked.why}).`;
}

/** Why a run PR waits when `landCheck` is not set in `.sandcastle/project.json`. */
export const NO_LAND_CHECK_WHY =
  "no pre-merge check is configured (landCheck in .sandcastle/project.json), so the loop does not land its own run PR";

export function noLandCheckLine(ownerName: string): string {
  return `waits for ${ownerName} (${NO_LAND_CHECK_WHY}).`;
}

/**
 * Why the run PR was left waiting for the owner, in the merge rule's own
 * words — empty when the loop merged it (or had no rule to settle it with).
 * Every hold counts: a one-way door (a migration that deletes data, an edit
 * to one already on main, a release workflow), a large blast radius, and
 * whatever else the settle reported (a failed check, a failed pre-merge
 * check, a land that could not fast-forward).
 */
export function runHeldReasons(
  change: ChangeClass | undefined,
  settled: { readonly merged: boolean; readonly why: string } | undefined,
): readonly string[] {
  if (settled?.merged === true) return [];
  const fromChange = [
    ...(change?.door === "one-way" ? change.doorReasons : []),
    ...(change?.blastRadius === "large" ? change.blastReasons : []),
  ];
  if (fromChange.length > 0) return fromChange;
  return settled !== undefined ? [settled.why] : [];
}
