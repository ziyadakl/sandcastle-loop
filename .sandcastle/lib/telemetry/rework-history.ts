/**
 * Rework telemetry, the git half: reading what happened AFTER an issue shipped.
 *
 * `rework-rate.ts` is pure by design — no clock, no filesystem, no git — and
 * `rework-report.mts` is the CLI that prints the answer. Everything in between,
 * the part that has to touch a repository, lives here: resolving the store's
 * repo root, walking history once, and placing each stored record inside that
 * walk.
 *
 * It is a module and not a section of the script for two reasons. The script
 * was 1,189 lines against a 1,000-line ceiling, and — the reason that actually
 * pays — the walk is now testable from a `git log` stdout fixture instead of a
 * temp repo, so the parsing and windowing rules can be pinned without spawning
 * anything.
 *
 * WHAT THIS LAYER MUST NEVER DO: score. It decides which commits a record could
 * possibly have been corrected by, and how much confidence that reading
 * deserves ({@link HistoryMode}). Whether any of them COUNT is Part 2's policy.
 *
 * ## Ancestry, and why there are two ways to read history
 *
 * `<shippedSha>..HEAD` is the rigorous statement of "commits after the ship",
 * and when the ship commit IS an ancestor of `HEAD` the row is labelled
 * `ancestry` to say so. A ship sha stops being an ancestor for several ordinary
 * reasons — the lane was rebased or squashed before landing, the run PR was
 * merged from a branch this clone no longer has, or the report is simply being
 * run from a different branch. (This repo does NOT uniformly squash: `a47e9440`
 * is a merge commit and over a thousand `SANDCASTLE(` commits are reachable
 * from `main`. The fallback is not compensation for one merge style; it is
 * defence against every way a recorded sha can fail to be on the branch in
 * front of us.) Refusing to place those would empty the report of real data, so
 * they fall back to a date-bounded reading of `HEAD` and the row says
 * `date only` — and, because that reading can catch a commit that is merely
 * CONCURRENT rather than causal, the renderer reports the date-only share and
 * restates the rate over ancestry-verified rows alone.
 *
 * The abbreviated-sha trap: the store allows a short `shippedSha`, and Part 2
 * excludes the ship commit from its own rework set by comparing `commit.sha ===
 * record.shippedSha` against a full `%H`. A short sha never matches, so the
 * ship commit would count as rework of its own files and print 100%. Every sha
 * git can resolve is therefore expanded to its full form before it is handed
 * on. A sha git CANNOT resolve needs no exclusion: an object that is not in
 * this clone cannot appear in the walk either.
 */
import { dirname, isAbsolute, resolve } from "node:path";

import type { GitRunner } from "../state/issue-lease.js";
import type { LaterCommit } from "./rework-rate.js";
import type { ReworkRecord } from "./rework-store.js";
import { DAY_MS } from "./rework-rate.js";

/**
 * Slack added to the git `--until` bound. Part 2 re-filters the window exactly,
 * so over-fetching by a minute is free; under-fetching would silently drop a
 * boundary commit and understate rework.
 */
const UNTIL_SLACK_MS = 60_000;

/**
 * `maxBuffer` for the ONE whole-history walk, and why it is not the 8 MiB
 * default every other git call in this repo uses.
 *
 * {@link walkUnionWindow} deliberately has no lower bound, so its output grows
 * with the repository forever. Measured on this repo on 2026-08-01, with the
 * exact arg vector below: 4,239,137 bytes over 2,741 commits — ~1,547 bytes per
 * commit, already 50.5% of the 8 MiB default. Overflow is not a truncation:
 * Node rejects, the walk returns no commits, and EVERY row in the report goes
 * `unavailable` at once. So the whole metric would have gone dark at roughly
 * 5,400 commits — a number this repo reaches in the ordinary course of work.
 *
 * 256 MiB at that measured density is ~173,000 commits, ~63x the current
 * history. THIS DEFERS THE FAILURE, IT DOES NOT REMOVE IT — which is exactly
 * why the overflow is detected and reported specifically below rather than
 * being left to print "unknown error". Raising this constant is the fix a
 * reader hitting that message is told to make.
 *
 * THAT ADVICE HAS A CEILING, and it is not the one people expect. `execFile`
 * with a utf8 encoding accumulates into a STRING, so the hard wall is Node's
 * `buffer.constants.MAX_STRING_LENGTH` — 536,870,888 bytes (~512 MiB) on 64-bit
 * Node 22, measured on this host — and crossing it throws a DIFFERENT error the
 * branch below does not recognise, putting the reader back on "unknown error".
 * 256 MiB is chosen to sit comfortably under that wall with a doubling still in
 * hand. Past ~512 MiB the answer is to STREAM the walk, not to pick a bigger
 * number.
 *
 * NOT SOLVED BY `--since`: that prunes the traversal and hides in-window rework
 * behind an older-committer-date commit — the bug this walk exists without.
 */
export const REWORK_GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Node's `code` when a child's stdout outgrew `maxBuffer`. A STRING, unlike the
 * numeric exit status of an ordinary git failure. Matched by code and never by
 * message: Node's text ("stdout maxBuffer length exceeded") and git's prose are
 * both prose, and this branch has already been bitten by locale-dependent
 * matching on git's English.
 */
const MAXBUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

// ---------------------------------------------------------------------------
// Git log parsing (pure)
// ---------------------------------------------------------------------------

/**
 * The pretty format the parser below expects. `\0` LEADS each commit so the
 * output is self-delimiting regardless of what `--name-only` inserts between
 * records, and `\x1f` separates fields.
 *
 * A COMMIT MESSAGE CAN CONTAIN `\x1f` — nothing stops an author pasting one —
 * so the message field is NOT delimited by counting separators. `%B` is the
 * second-to-last field and the file list is the last, so the parser splits the
 * three fixed leading fields off the front, takes the LAST separator as the
 * message/files boundary, and rejoins whatever is between. Field-counting used
 * to shift a `\x1f`-bearing commit's fields by one and read a fragment of the
 * message as its file list — dropping the real files, which understates rework.
 * The file list cannot collide: git octal-escapes control bytes in paths.
 *
 * `%B` (full body, not `%s`) is deliberate: "Closes #123" and "This reverts
 * commit ..." both live below the subject line, and Part 2's attribution and
 * revert rules read them.
 */
export const GIT_LOG_PRETTY = "format:%x00%H%x1f%cI%x1f%P%x1f%B%x1f";

/** Undo git's quoting of a path that contained a quote or a newline. */
function unquotePath(line: string): string {
  if (line.length < 2 || !line.startsWith('"') || !line.endsWith('"')) {
    return line;
  }
  try {
    return JSON.parse(line) as string;
  } catch {
    return line.slice(1, -1);
  }
}

/**
 * Turn `git log --name-only --pretty=<GIT_LOG_PRETTY>` output into commits.
 *
 * Total by construction: a chunk with too few fields is skipped rather than
 * throwing. A merge commit legitimately lists no files (git omits them without
 * `-m`/`--diff-merges`), which costs nothing — Part 2 excludes merges anyway,
 * and `isMerge` is still set so that exclusion can see it.
 */
export function parseGitLog(stdout: string): LaterCommit[] {
  const commits: LaterCommit[] = [];
  // `format:` prefixes EVERY record with \0, so element 0 is always empty.
  for (const chunk of stdout.split("\0")) {
    if (chunk === "") continue;
    const parts = chunk.split("\x1f");
    if (parts.length < 5) continue;
    const [sha, dateIso, parents] = parts as [string, string, string];
    if (sha === "") continue;
    // Three fixed fields off the front, the file list off the back, and the
    // message is everything between — separators and all. See GIT_LOG_PRETTY.
    const rest = parts.slice(3);
    const tail = rest.pop() ?? "";
    const message = rest.join("\x1f");
    const files: string[] = [];
    for (const rawLine of tail.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      files.push(unquotePath(line));
    }
    commits.push({
      sha,
      dateIso,
      message,
      files,
      isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Git IO
// ---------------------------------------------------------------------------

/**
 * How much we could learn about what happened after an issue shipped.
 *
 * - `ancestry`   — the ship commit is an ancestor of HEAD, so `sha..HEAD` is
 *                  exactly "commits after the ship". The rigorous answer.
 * - `date-only`  — the object exists but is not an ancestor (squash-merged lane
 *                  branch, or another branch). Scored by DATE over HEAD, which
 *                  can catch a commit that is merely concurrent, not causal.
 * - `unavailable`— git cannot resolve the sha or the log failed. NOT scored:
 *                  an empty commit list would print as a clean 0%.
 */
export type HistoryMode = "ancestry" | "date-only" | "unavailable";

export interface IssueHistory {
  record: ReworkRecord;
  mode: HistoryMode;
  /** The FULL sha, so Part 2's self-exclusion can match `%H`. */
  resolvedSha?: string;
  /** Why the mode is not `ancestry`. Printed next to the row. */
  note?: string;
  laterCommits: LaterCommit[];
}

async function git(
  runner: GitRunner,
  cwd: string,
  ...gitArgs: string[]
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode?: string | number;
}> {
  try {
    return await runner(cwd, ...gitArgs);
  } catch (err) {
    // GitRunner is documented not to throw, but a spawn failure (no git on
    // PATH) must degrade like any other git failure, not kill the report.
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The MAIN worktree's root, which is where the store lives.
 *
 * The loop works issues from `.sandcastle/worktrees/<lane>`, so `--show-toplevel`
 * alone would point at a throwaway checkout whose store is empty or stale.
 * `--git-common-dir` resolves to the SHARED `.git`, whose parent is the real
 * repo root — the same reasoning that made `ReworkStoreOpts.path` mandatory.
 *
 * A RELATIVE `--git-common-dir` IS RELATIVE TO `cwd`, NOT TO THE TOPLEVEL. git
 * prints it against the directory the command ran in, so from
 * `<repo>/.sandcastle/scripts` it prints `../../.git`; resolving that against
 * the toplevel walks two levels ABOVE the repo, and the report then finds no
 * store there and prints the reassuring "no data yet" — a confident wrong
 * answer, which is the one thing this feature exists not to give.
 */
export async function resolveMainRepoRoot(
  runner: GitRunner,
  cwd: string,
): Promise<string | undefined> {
  const top = await git(runner, cwd, "rev-parse", "--show-toplevel");
  if (!top.ok) return undefined;
  const toplevel = top.stdout.trim();
  if (toplevel === "") return undefined;
  const common = await git(runner, cwd, "rev-parse", "--git-common-dir");
  const commonDir = common.ok ? common.stdout.trim() : "";
  if (commonDir === "") return toplevel;
  const absCommon = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const parent = dirname(absCommon);
  return parent === "" ? toplevel : parent;
}

/**
 * Is `repoRoot` a git repository at all?
 *
 * PREFLIGHT, not a per-record concern. Without it, a non-repo path makes every
 * `rev-parse` fail and every row reports "ship commit X is not in this clone",
 * which is FALSE and actively misleading — it sends the reader hunting for a
 * fetch problem when the real fault is the path they pointed at.
 */
export async function isGitRepo(
  runner: GitRunner,
  repoRoot: string,
): Promise<boolean> {
  const res = await git(runner, repoRoot, "rev-parse", "--git-dir");
  return res.ok;
}

/**
 * The LATEST instant any record's window can still reach, or `undefined` when
 * not one record carries a parsable ship date.
 *
 * ONLY AN UPPER BOUND, DELIBERATELY. The obvious companion — the earliest ship,
 * handed to `--since` — is not a filter. `--since` is a TRAVERSAL cutoff: git
 * stops descending a line of history at the first commit whose committer date
 * is older than the bound, so an in-window commit sitting UNDER an
 * older-committer-date commit is never reached at all. Rebase and cherry-pick
 * produce exactly that skew, this module's header already reasons about it, and
 * the effect is one-directional: rework that never reaches the walk makes the
 * rate read LOWER than reality, which is the direction that quietly discredits
 * the metric. `--until` has no such property — it is a pure filter — so it is
 * the only bound passed. See {@link walkUnionWindow} for what that costs.
 *
 * One unparsable stamp must not poison the bound: an unparsable date parses to
 * `NaN`, and `Math.max(NaN, x)` is `NaN`, which would render as an invalid
 * `--until` and make git reject the whole walk. Such records are skipped here
 * and reported individually instead.
 */
export function unionWindow(
  records: readonly ReworkRecord[],
  windowDays: number,
): { untilIso: string } | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const shipMs = Date.parse(record.shippedAtIso);
    if (!Number.isFinite(shipMs)) continue;
    const end = shipMs + windowDays * DAY_MS + UNTIL_SLACK_MS;
    if (end > latest) latest = end;
  }
  if (!Number.isFinite(latest)) return undefined;
  return { untilIso: new Date(latest).toISOString() };
}

/**
 * Every commit on `HEAD` that could be rework of ANY record, in ONE process.
 *
 * WHY ONE WALK AND NOT ONE PER RECORD: a hundred-record store used to fork a
 * hundred `git log`s, which `run`'s own comment already forbade in the same
 * breath as doing it. The union of every record's window is walked once and
 * filtered in memory, which also makes the whole layer testable from a stdout
 * fixture rather than a temp repo.
 *
 * WHY DROPPING THE PER-RECORD `<sha>..HEAD` RANGE COSTS NOTHING: that range and
 * a date filter differ only by ancestors of the ship commit whose committer
 * date falls AFTER the ship commit's own — i.e. committer-date skew from a
 * rebase. Part 2 drops any commit with a negative elapsed time and excludes the
 * ship commit by sha, and its header already refuses to trust a skewed date to
 * place a commit in a window. So ancestry survives here as what it always
 * really was: a CONFIDENCE label on the row, not a different set of commits.
 *
 * THE PRICE OF HAVING NO `--since`: the walk descends from `HEAD` to the root
 * commit, because {@link unionWindow} deliberately hands over no lower bound
 * (a `--since` would PRUNE the traversal and hide in-window rework behind an
 * older-committer-date commit). Nothing is fanned out — it is still ONE
 * process, which is the rule that mattered — but it now reads the whole
 * history and discards everything above `--until`. `--since-as-filter` would
 * restore the pruning safely, and is not used: it needs git 2.37+, and an
 * unknown option makes `git log` fail OUTRIGHT, which would take the whole
 * report down on any host with an older git.
 *
 * That unbounded output is why the runner must be given
 * {@link REWORK_GIT_MAX_BUFFER_BYTES} rather than the shared default, and why
 * an overflow is reported as itself instead of as "unknown error": on that
 * failure Node throws the output away and stderr is EMPTY, so the code is the
 * only evidence left of what happened.
 */
export async function walkUnionWindow(
  runner: GitRunner,
  repoRoot: string,
  records: readonly ReworkRecord[],
  windowDays: number,
): Promise<{ commits: LaterCommit[]; error?: string }> {
  const window = unionWindow(records, windowDays);
  // Nothing parsable to bound a walk with. Not an error — every such record is
  // reported on its own line below.
  if (window === undefined) return { commits: [] };

  const log = await git(
    runner,
    repoRoot,
    "-c",
    "core.quotepath=false",
    "log",
    "--no-renames",
    "--name-only",
    `--pretty=${GIT_LOG_PRETTY}`,
    // NO `--since`. It prunes the traversal rather than filtering it — see
    // `unionWindow`. Neither bound is exact here: this `--until` carries
    // `UNTIL_SLACK_MS`, and `commitsInWindow` is deliberately loose too
    // (inclusive ends, the same slack, an optional strict lower bound — its own
    // doc says so). The EXACT window is re-applied by the scorer's elapsed
    // check in `rework-rate.ts`; over-handing here is free, under-handing would
    // drop a boundary commit and understate rework.
    `--until=${window.untilIso}`,
    "HEAD",
  );
  if (!log.ok) {
    // The output outgrew `maxBuffer`: git SUCCEEDED and Node discarded the
    // result, so stderr is empty and the generic branch below could only say
    // "unknown error". Detected by code, never by message text.
    if (log.errorCode === MAXBUFFER_ERROR_CODE) {
      return {
        commits: [],
        // The actionable token comes FIRST: this string is printed in the
        // report's last table column, where a reader scans left to right.
        error:
          `raise REWORK_GIT_MAX_BUFFER_BYTES in lib/telemetry/rework-history.ts — ` +
          `git log output outgrew its ${REWORK_GIT_MAX_BUFFER_BYTES}-byte buffer ` +
          `(this repo's history has grown past it)`,
      };
    }
    return {
      commits: [],
      error: `git log failed: ${log.stderr.trim().split("\n")[0] ?? "unknown error"}`,
    };
  }
  return { commits: parseGitLog(log.stdout) };
}

/**
 * Narrow the union walk to the commits inside ONE record's window.
 *
 * Deliberately inclusive at both ends and slack-tolerant: Part 2 re-filters
 * exactly, so over-handing is free while under-handing would silently drop a
 * boundary commit and understate rework.
 *
 * `strictlyAfterShip` moves the LOWER bound off the ship instant, and exists
 * for one case only — see {@link placeInHistory}'s date-only branch, where
 * there is no sha that provably identifies the ship commit in the walk.
 */
export function commitsInWindow(
  commits: readonly LaterCommit[],
  shipMs: number,
  windowDays: number,
  strictlyAfterShip = false,
): LaterCommit[] {
  const end = shipMs + windowDays * DAY_MS + UNTIL_SLACK_MS;
  return commits.filter((commit) => {
    const commitMs = Date.parse(commit.dateIso);
    if (!Number.isFinite(commitMs)) return false;
    const startOk = strictlyAfterShip ? commitMs > shipMs : commitMs >= shipMs;
    return startOk && commitMs <= end;
  });
}

/**
 * Place ONE issue in the history the union walk already read.
 *
 * The only git this still runs per record is `rev-parse` and `merge-base
 * --is-ancestor` — plumbing that answers a question about one object, not a
 * history walk. The rule `run` states ("never fan out a process per record") is
 * about the walk, which is now singular; these two are O(1) each and there is
 * no batch form of `--is-ancestor` to fold them into.
 *
 * A SHIP CAN NEVER BE ITS OWN REWORK, AND THAT MUST NOT DEPEND ON THE SHA.
 * Part 2 excludes the ship commit by comparing shas, which works only when the
 * commit in the walk IS the recorded object. On a `date only` row it is not,
 * by definition of the row: either git could not resolve the recorded sha at
 * all, or it resolved to a lane commit that is not on `HEAD` while the SAME
 * work sits on `HEAD` as a squash under a different sha. Either way the ship's
 * own content is inside the window at the ship instant, every file matches,
 * and the row prints 100% at 0.0d — an issue scored as rework of itself. So
 * date-only rows take the lower bound STRICTLY after the ship: the timestamp
 * is the only self-identification left when the sha has stopped being one.
 * (Ancestry rows keep the inclusive bound — there the sha match is exact.)
 *
 * The residual this does not close: a ship re-landed a few seconds later under
 * a new sha AND a rewritten message carrying neither `#N` nor `issue=N`. Part
 * 2's `referencesIssue` catches the ordinary forms of that — a squash
 * concatenates the lane's `SANDCASTLE(... issue=N)` subjects, and a `--no-ff`
 * merge is excluded as a merge — so what is left needs a deliberate rewrite.
 */
export async function placeInHistory(
  runner: GitRunner,
  repoRoot: string,
  record: ReworkRecord,
  windowCommits: readonly LaterCommit[],
  windowDays: number,
): Promise<IssueHistory> {
  const shipMs = Date.parse(record.shippedAtIso);
  if (!Number.isFinite(shipMs)) {
    // Part 2 scores this `insufficientData` on the unparsable date alone, so
    // there is no point placing it in history — but it stays IN the report so
    // the damaged stamp is visible rather than quietly dropped.
    return {
      record,
      mode: "date-only",
      laterCommits: [],
      note: `ship date unparsable (${record.shippedAtIso}) — no history walked`,
    };
  }

  const resolved = await git(
    runner,
    repoRoot,
    "rev-parse",
    "--verify",
    "--quiet",
    `${record.shippedSha}^{commit}`,
  );
  const fullSha = resolved.ok ? resolved.stdout.trim() : "";
  if (fullSha === "") {
    // NOT dropped. The record already carries everything Part 2 needs — a ship
    // DATE and a file list; the sha is only wanted so the ship commit can be
    // excluded from its own rework set. An object git cannot resolve is by
    // definition not in this clone, so it cannot appear in the walk above
    // either, and there is nothing for that exclusion to do. Dropping these
    // silently deleted the normal case: a shallow clone, and every lane that
    // never merged.
    return {
      record,
      mode: "date-only",
      laterCommits: commitsInWindow(windowCommits, shipMs, windowDays, true),
      note: `ship commit ${record.shippedSha} is not in this clone (shallow clone, or the branch was never fetched) — scored by date only`,
    };
  }

  const ancestor = await git(
    runner,
    repoRoot,
    "merge-base",
    "--is-ancestor",
    fullSha,
    "HEAD",
  );

  return {
    record,
    mode: ancestor.ok ? "ancestry" : "date-only",
    resolvedSha: fullSha,
    laterCommits: commitsInWindow(
      windowCommits,
      shipMs,
      windowDays,
      !ancestor.ok,
    ),
    ...(ancestor.ok
      ? {}
      : {
          note: "ship commit is not on this branch (squash-merged?) — scored by date only",
        }),
  };
}
