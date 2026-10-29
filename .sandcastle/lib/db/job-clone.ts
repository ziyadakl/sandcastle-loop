/**
 * Per-job database clones (Piece B, issue #908,
 * docs/specs/2026-08-04-screen-check-design-lock.md).
 *
 * WHY THIS EXISTS
 * ----------------
 * Before this file, every parallel sandcastle job shared ONE local test
 * Postgres — see `sandboxTestDbEnv` in `main.mts`. With several jobs running
 * at once, one job's test data (a deal it created) could shift a total
 * another job's screen check reads moments later — a red result for a
 * reason that has nothing to do with that job's own change, or a green one
 * by luck.
 *
 * The fix: every job gets its OWN database, cloned from the
 * project's frozen template database (`testDatabase.templateDb` in
 * `.sandcastle/project.json`) via Postgres's own `CREATE DATABASE ...
 * TEMPLATE <x>` — a filesystem-level copy Postgres does internally, not a
 * row-by-row re-seed.
 *
 * WHERE THE ADMIN CONNECTION MUST POINT
 * --------------------------------------
 * `CREATE DATABASE` / `DROP DATABASE` cannot run "inside" the database being
 * created or dropped — they need a connection to a THIRD database (by
 * convention, the `postgres` maintenance database that always exists). Every
 * function here takes that connection as `adminUrl` and never assumes where
 * it points; callers pass `testDbAdminUrl()` from `main.mts`, which is
 * already the host-side, guarded, disposable-only local Postgres.
 *
 * THE PRODUCTION GUARD SURVIVES HERE TOO
 * ----------------------------------------
 * Every function that touches the database runs `assertDisposableDbTarget`
 * on `adminUrl` first — the SAME allowlist-based guard
 * `testDbAdminUrl()` already uses (see
 * `./disposable-target.ts`). There is no path in this file that can
 * reach a non-loopback host or port 5432, and no override.
 *
 * NAMING, SAFELY
 * ---------------
 * Postgres identifiers have no bind-parameter form for `CREATE DATABASE
 * <name>` — the name itself IS the SQL. Every name this file ever
 * interpolates into a statement is either produced by `jobDatabaseName`
 * (which sanitizes to `[a-z0-9_]+`) or re-checked by `assertSafeIdentifier`
 * before use, so a caller-supplied string can never smuggle SQL through a
 * database name.
 *
 * REAPING ORPHANS
 * -----------------
 * A job database is created before that job's sandbox starts and dropped in
 * its `close()`. A job whose PROCESS dies mid-run (kill -9, host reboot, OOM)
 * never reaches its own `close()`, so nothing in THIS file alone prevents a
 * crashed night from leaving orphaned databases on disk forever.
 * `sweepOrphanedJobDatabases` is the backstop: `main.mts` runs it once, at
 * the first `createSandbox` call of a fresh orchestrator process (mirroring
 * the existing "first sandbox gets the worktree repair" one-shot pattern),
 * so every run starts by reclaiming whatever a previous run's crash left
 * behind before creating anything new.
 */

import { assertDisposableDbTarget } from "./disposable-target.js";
import { _createExecRunner, toPsqlUri, type ExecRunner } from "./psql-exec.js";

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Every job database name starts with this. It is the ONLY thing
 * `isJobDatabaseName` / the reap sweep use to recognise "a database this
 * mechanism created" versus every other database in the cluster (`postgres`,
 * the template, someone's manually-created scratch db).
 * Deliberately short and deliberately unlikely to collide with anything a
 * human would type by hand.
 */
export const JOB_DB_PREFIX = "sc_job_";

/**
 * Postgres identifier limit (`NAMEDATALEN` 64, usable length 63 — the 64th
 * byte is reserved for the terminator). A name built from a long branch
 * name has to be truncated to fit, and truncation happens on the SANITIZED
 * LABEL portion only — the prefix (for reap recognition) and the pid+unique
 * suffix (for collision-avoidance) are never shortened.
 */
const MAX_IDENTIFIER_LENGTH = 63;

/** Only characters ever produced or accepted as a Postgres identifier here. */
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

/**
 * Lower-case, collapse every run of non-`[a-z0-9]` into a single `_`, trim
 * leading/trailing `_`. `agent/issue-761` becomes `agent_issue_761`; an
 * empty or entirely-punctuation input falls back to `job` rather than
 * producing an empty identifier.
 */
export function sanitizeForIdentifier(raw: string): string {
  const lowered = raw.toLowerCase();
  const collapsed = lowered.replace(/[^a-z0-9]+/g, "_");
  const trimmed = collapsed.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "job";
}

/**
 * Build a unique, safe, reapable database name for one job.
 *
 * `label` is normally the job's branch name (`spec.branch` in `main.mts`) —
 * stable and human-readable in a `psql -l` listing, which matters when
 * someone is staring at a disk-full night. `pid` + `unique` guarantee
 * uniqueness even across two orchestrator PROCESSES that both happen to
 * work on the same issue (a stale crashed run's orphan and a fresh run's
 * live clone must never collide, or the fresh run's `CREATE DATABASE` would
 * fail outright, or worse, the reap sweep could race a live database).
 */
export function jobDatabaseName(
  label: string,
  opts: { readonly pid?: number; readonly unique?: string } = {},
): string {
  const pid = opts.pid ?? process.pid;
  const unique = opts.unique ?? Math.random().toString(36).slice(2, 8);
  const suffix = `_${pid}_${unique}`;
  const budget = MAX_IDENTIFIER_LENGTH - JOB_DB_PREFIX.length - suffix.length;
  const safeLabel = sanitizeForIdentifier(label).slice(
    0,
    Math.max(budget, 1),
  );
  return `${JOB_DB_PREFIX}${safeLabel}${suffix}`;
}

/** The reaping predicate: true iff this name was minted by `jobDatabaseName`. */
export function isJobDatabaseName(name: string): boolean {
  return name.startsWith(JOB_DB_PREFIX);
}

/**
 * The exact shape `jobDatabaseName` produces: `sc_job_<label>_<pid>_<unique>`.
 * `label` and `unique` are both `[a-z0-9_]*`/`[a-z0-9]+` (see
 * `sanitizeForIdentifier`), so the only reliably-anchored group is the
 * NUMERIC pid immediately before the final `_<unique>` segment — hence the
 * greedy `.*` on label and the trailing `\d+` capture.
 */
const JOB_DB_NAME_PATTERN = /^sc_job_.*_(\d+)_[a-z0-9]+$/;

/**
 * Extract the creating process's pid from a name `jobDatabaseName` produced,
 * or `null` if the name doesn't parse (should never happen for a real
 * `sc_job_%` row — every one of them was minted by `jobDatabaseName` — but a
 * malformed name must never crash the sweep, and must never be TREATED as
 * safe to drop either; see `sweepOrphanedJobDatabases`).
 */
export function parseJobDatabasePid(name: string): number | null {
  const m = JOB_DB_NAME_PATTERN.exec(name);
  if (m === null) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * True iff a process with this pid is currently running on THIS machine.
 * `process.kill(pid, 0)` sends no signal — it only asks the kernel whether
 * the pid exists and is reachable.
 *
 * Conservative by construction: only `ESRCH` ("no such process") counts as
 * "dead". `EPERM` (the process exists but belongs to another user) and any
 * other unexpected error are treated as ALIVE — this function's only job is
 * to stop a destructive `DROP DATABASE`, so a false "alive" costs one extra
 * night of a database sitting on disk; a false "dead" would drop a database
 * a sibling process is actively using.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Swap the database name in a Postgres connection URL, leaving host, port,
 * credentials and every other part untouched. Used to turn the host-side
 * admin URL into the URL a job's OWN sandbox should connect with, and in
 * tests to build fixture URLs without a live database.
 */
export function withDatabaseName(baseUrl: string, databaseName: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${databaseName}`;
  return u.toString();
}

function assertSafeIdentifier(name: string, subject: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `${subject}: "${name}" is not a safe Postgres identifier (only ` +
        "lowercase letters, digits and underscores are accepted) — " +
        "refusing to interpolate it into SQL.",
    );
  }
}

// ---------------------------------------------------------------------------
// psql plumbing
// ---------------------------------------------------------------------------

// A generous but bounded buffer: admin statements here return at most a
// short list of database names, never bulk output. 16 MiB is orders of
// magnitude more than any real response and catches a runaway/looping query
// the same way.
const ADMIN_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const defaultExecRunner: ExecRunner = _createExecRunner(
  ADMIN_EXEC_MAX_BUFFER,
);

interface PsqlResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function psql(
  adminUrl: string,
  args: readonly string[],
  exec: ExecRunner,
  timeoutMs: number,
): Promise<PsqlResult> {
  const { stdout, stderr, exitCode } = await exec(
    "psql",
    [...args, toPsqlUri(adminUrl)],
    { env: process.env, timeout: timeoutMs },
  );
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

function combinedOutput(r: PsqlResult): string {
  return `${r.stdout}\n${r.stderr}`.trim();
}

async function runStatement(
  adminUrl: string,
  sql: string,
  exec: ExecRunner,
  timeoutMs: number,
): Promise<PsqlResult> {
  return psql(adminUrl, ["-X", "-v", "ON_ERROR_STOP=1", "-c", sql], exec, timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export interface CloneJobDatabaseOptions {
  /** Host-side admin connection — e.g. `testDbAdminUrl()`. Never the template or job db itself. */
  readonly adminUrl: string;
  /** Name of the frozen, already-migrated, already-seeded template database. */
  readonly templateDb: string;
  /** Name to give the new clone — normally `jobDatabaseName(branch)`. */
  readonly jobDb: string;
  readonly timeoutMs?: number;
  /**
   * How many times to retry ONLY the "template is busy" race. Default
   * {@link DEFAULT_CLONE_MAX_ATTEMPTS} — see that constant's doc comment for
   * why it is 40, not 3.
   */
  readonly maxAttempts?: number;
  /** Test seam — production code never sets this. */
  readonly _exec?: ExecRunner;
  /** Test seam — production code never sets this; overrides the real `setTimeout`-based backoff sleep so a retry-budget test doesn't actually wait tens of seconds. */
  readonly _sleep?: (ms: number) => Promise<void>;
}

/**
 * Postgres refuses `CREATE DATABASE ... TEMPLATE x` while ANY other session
 * is connected to `x`. This project's operational rule is "don't refresh the
 * template while jobs are cloning from it" (documented in
 * docs/reference/database.md), so the race window is normally empty — but a
 * refresh (`pnpm db:test:template`) that overlaps a clone by a few seconds
 * is a real possibility, and retrying a handful of times costs nothing on
 * the far more common case where it never happens.
 */
const TEMPLATE_BUSY_PATTERN =
  /is being accessed by other users|source database ".*" is being accessed/i;

/**
 * How many times a clone retries when Postgres reports the template is
 * "being accessed by other users". Postgres refuses `CREATE DATABASE ...
 * TEMPLATE x` while any other session is connected to `x`; something briefly
 * holding a connection to the template (a refresh, a slow setup step) is a
 * short, self-clearing race. The budget covers tens of seconds of contention
 * while staying a no-op in cost on the overwhelmingly common case where it
 * never fires — see `cloneJobDatabase`'s retry loop for the resulting backoff
 * schedule (~77s worst case).
 */
export const DEFAULT_CLONE_MAX_ATTEMPTS = 40;

/** Per-attempt backoff never grows past this — bounds the wait on any ONE retry even as the attempt count climbs. */
const CLONE_BACKOFF_CAP_MS = 2000;

function realSleep(ms: number): Promise<void> {
  return sleep(ms);
}

/**
 * Clone the frozen template database into a brand-new database named
 * `options.jobDb`. Throws on any failure — including "the template doesn't
 * exist" (create it first) and "a database with that name
 * already exists" (a naming collision, which should never happen given
 * `jobDatabaseName`'s pid+random suffix, but must not be swallowed if it
 * somehow does).
 */
export async function cloneJobDatabase(
  options: CloneJobDatabaseOptions,
): Promise<void> {
  assertDisposableDbTarget(options.adminUrl, "cloneJobDatabase");
  assertSafeIdentifier(options.templateDb, "cloneJobDatabase templateDb");
  assertSafeIdentifier(options.jobDb, "cloneJobDatabase jobDb");

  const exec = options._exec ?? defaultExecRunner;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? DEFAULT_CLONE_MAX_ATTEMPTS;
  const sleepFn = options._sleep ?? realSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runStatement(
      options.adminUrl,
      `CREATE DATABASE "${options.jobDb}" TEMPLATE "${options.templateDb}"`,
      exec,
      timeoutMs,
    );
    if (result.ok) return;

    const combined = combinedOutput(result);
    const isBusy = TEMPLATE_BUSY_PATTERN.test(combined);
    if (!isBusy || attempt === maxAttempts) {
      throw new Error(
        `cloneJobDatabase: failed to create "${options.jobDb}" from template ` +
          `"${options.templateDb}" after ${attempt} attempt(s): ` +
          `${combined || `psql exited ${result.exitCode}`}`,
      );
    }
    // Linear backoff, capped — a short, self-clearing race (a template refresh or setup step finishing), not a systemic
    // outage worth exponential backoff over. Capped so the per-attempt wait
    // doesn't grow unbounded as attempt climbs toward maxAttempts.
    await sleepFn(Math.min(500 * attempt, CLONE_BACKOFF_CAP_MS));
  }
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

export interface DropJobDatabaseOptions {
  readonly adminUrl: string;
  readonly jobDb: string;
  readonly timeoutMs?: number;
  readonly _exec?: ExecRunner;
}

/**
 * Drop a job database, terminating any lingering connections first — a
 * sandbox's connection pool can take a moment to close its sockets after
 * the job's work is done, and `DROP DATABASE` refuses while anything is
 * still connected. `IF EXISTS` makes this idempotent: calling it twice (or
 * calling it from the reap sweep on a database another caller already
 * dropped) is a no-op, not an error.
 */
export async function dropJobDatabase(
  options: DropJobDatabaseOptions,
): Promise<void> {
  assertDisposableDbTarget(options.adminUrl, "dropJobDatabase");
  assertSafeIdentifier(options.jobDb, "dropJobDatabase jobDb");

  const exec = options._exec ?? defaultExecRunner;
  const timeoutMs = options.timeoutMs ?? 30_000;

  // Best-effort: if there is nothing connected, this affects zero rows and
  // is not an error. Its own failure (e.g. no permission) is not fatal to
  // the drop attempt below — a database with a genuinely-idle connection
  // will still drop fine, and if it doesn't, the DROP's own error is what
  // the caller sees.
  await runStatement(
    options.adminUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
      `WHERE datname = '${options.jobDb}' AND pid <> pg_backend_pid()`,
    exec,
    timeoutMs,
  );

  const result = await runStatement(
    options.adminUrl,
    `DROP DATABASE IF EXISTS "${options.jobDb}"`,
    exec,
    timeoutMs,
  );
  if (!result.ok) {
    throw new Error(
      `dropJobDatabase: failed to drop "${options.jobDb}": ${combinedOutput(result)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reap
// ---------------------------------------------------------------------------

export interface SweepOrphanedJobDatabasesOptions {
  readonly adminUrl: string;
  readonly timeoutMs?: number;
  readonly _exec?: ExecRunner;
  /**
   * Test seam ONLY — production always uses the real `process.kill(pid, 0)`
   * -based check. Overriding this in production would defeat the entire
   * point of issue #915's fix: this project uses git worktrees routinely,
   * so two CHECKOUTS on the SAME machine share one local Postgres
   * (port 55432) — each running its own orchestrator process, each calling
   * this sweep at its own startup. Without a liveness check, checkout B's
   * startup sweep drops every `sc_job_%` database, including the ones
   * checkout A's still-running loop created moments earlier and is actively
   * using — the single-instance `.loop.lock` is per-CHECKOUT
   * (`<repoRoot>/.sandcastle/.loop.lock`), so it does nothing to prevent
   * this.
   */
  readonly _isPidAlive?: (pid: number) => boolean;
}

export interface SweepResult {
  readonly dropped: readonly string[];
  readonly failed: readonly { readonly name: string; readonly error: string }[];
  /**
   * Names that matched `isJobDatabaseName` but were LEFT ALONE because their
   * creating pid is still alive — almost certainly a sibling checkout's live
   * job, not an orphan. Reported (never silently skipped) so an operator
   * staring at a disk-full night can see why a name they expected dropped
   * wasn't.
   */
  readonly skippedAlive: readonly string[];
}

/**
 * Drop every database whose name matches `isJobDatabaseName` AND whose
 * creating process is no longer running — the backstop for jobs whose
 * process died before its own `close()` could drop its database. Called
 * once, at the first `createSandbox` of a fresh orchestrator process (see
 * `main.mts`), BEFORE that first job's own clone is created, so a live
 * database created moments earlier in the same process can never be
 * mistaken for an orphan: nothing has had the chance to exist yet.
 *
 * The pid-liveness check (issue #915 fix) is what makes this safe when TWO
 * orchestrator processes — e.g. two git worktree checkouts of this repo,
 * a routine setup here — share the same local Postgres: a name whose
 * embedded pid (`jobDatabaseName` always encodes `_<pid>_<unique>`) belongs
 * to a still-running process is left alone rather than dropped, even though
 * it matches the prefix. A name that fails to parse (should never happen —
 * every `sc_job_%` row was minted by `jobDatabaseName`) is treated the SAME
 * as "alive": never drop a database this sweep can't positively prove is
 * orphaned.
 *
 * Never throws for an individual database's drop failure — one stuck
 * database (e.g. a connection the terminate couldn't kill) must not stop
 * the sweep from reclaiming every other orphan. Failures are returned, not
 * swallowed, so the caller can log them loudly.
 */
export async function sweepOrphanedJobDatabases(
  options: SweepOrphanedJobDatabasesOptions,
): Promise<SweepResult> {
  assertDisposableDbTarget(options.adminUrl, "sweepOrphanedJobDatabases");

  const exec = options._exec ?? defaultExecRunner;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const alive = options._isPidAlive ?? isPidAlive;

  const listResult = await psql(
    options.adminUrl,
    [
      "-X",
      "-t",
      "-A",
      "-c",
      `SELECT datname FROM pg_database WHERE datname LIKE '${JOB_DB_PREFIX}%' ORDER BY datname`,
    ],
    exec,
    timeoutMs,
  );
  if (!listResult.ok) {
    throw new Error(
      `sweepOrphanedJobDatabases: failed to list job databases: ${combinedOutput(listResult)}`,
    );
  }

  const names = listResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isJobDatabaseName(line));

  const dropped: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const skippedAlive: string[] = [];
  for (const name of names) {
    const pid = parseJobDatabasePid(name);
    // A name whose owning process is still alive — or whose pid this sweep
    // couldn't parse at all — is presumed live, never dropped.
    if (pid === null || alive(pid)) {
      skippedAlive.push(name);
      continue;
    }
    try {
      await dropJobDatabase({
        adminUrl: options.adminUrl,
        jobDb: name,
        timeoutMs,
        _exec: exec,
      });
      dropped.push(name);
    } catch (err) {
      failed.push({ name, error: (err as Error).message });
    }
  }
  return { dropped, failed, skippedAlive };
}

// ---------------------------------------------------------------------------
// Startup-sweep singleton gate (issue #915 fix)
// ---------------------------------------------------------------------------

/**
 * Wrap an async factory so it runs AT MOST ONCE no matter how many times the
 * returned function is called — every call, including ones that arrive
 * while the first is still in flight, awaits the SAME promise and sees the
 * SAME result (or the same rejection).
 *
 * Built for `main.mts`'s job-database startup sweep, which used to guard
 * re-entry with a plain boolean (`firstJobDbSweepDone = true`) set
 * SYNCHRONOUSLY before the sweep's own `await` — closing the door on running
 * the sweep twice, but NOT on a second, concurrent `createSandbox` call
 * racing past the guard while the first sweep was still awaiting its own
 * `DROP DATABASE` statements. That second call would clone its OWN job
 * database and could have it dropped out from under it if the sweep's
 * listing query happened to run after the clone completed. A shared
 * in-flight PROMISE closes the race: every concurrent caller waits for the
 * sweep to fully finish — including everything it awaits — before any of
 * them proceeds.
 *
 * General-purpose (no job-clone-specific types), but kept here because this
 * is its one real caller and the file header's own "REAPING ORPHANS"
 * section is where a reader looking for this race would already be.
 */
export function createOnceGate<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= fn();
    return inFlight;
  };
}

// ---------------------------------------------------------------------------
// Leak-on-failure cleanup (issue #915 fix)
// ---------------------------------------------------------------------------

export interface WithJobDbCleanupOnFailureOptions {
  readonly adminUrl: string;
  readonly jobDb: string;
  readonly timeoutMs?: number;
  readonly _exec?: ExecRunner;
}

/**
 * Run `createHandle` — which the caller has already made depend on
 * `options.jobDb` existing (the clone happened before this is called) — and,
 * if it THROWS, best-effort drop that job database before rethrowing the
 * original error unchanged.
 *
 * Without this, a `cloneJobDatabase` that succeeds followed by a
 * `provider.createSandbox` that fails (worktree corruption, a Docker error,
 * a retry inside `createSandboxWithWorktreeRepair` minting a fresh clone on
 * the next attempt) leaks the first clone forever — nothing else ever calls
 * `close()` on a handle that was never returned, so nothing else ever drops
 * it. The NEXT run's startup sweep eventually reclaims it (once its owning
 * process has actually exited — see `sweepOrphanedJobDatabases`'s pid
 * check), but on a long-running host that "eventually" can be days.
 *
 * The original error is what the caller sees either way — a failure to drop
 * the leaked database is logged via `onDropFailure`, never thrown, so a
 * cleanup problem can't mask (or replace) the real failure that triggered
 * it.
 */
export async function withJobDbCleanupOnFailure<T>(
  options: WithJobDbCleanupOnFailureOptions,
  createHandle: () => Promise<T>,
  onDropFailure: (err: Error) => void,
): Promise<T> {
  try {
    return await createHandle();
  } catch (err) {
    try {
      await dropJobDatabase({
        adminUrl: options.adminUrl,
        jobDb: options.jobDb,
        timeoutMs: options.timeoutMs,
        _exec: options._exec,
      });
    } catch (dropErr) {
      onDropFailure(dropErr as Error);
    }
    throw err;
  }
}
