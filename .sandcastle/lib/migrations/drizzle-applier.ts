/**
 * Drizzle migration auto-applier.
 *
 * Detects newly-added SQL migration files in the diff between two commits,
 * applies them statement-by-statement via `psql -X`, and classifies errors
 * as "benign" (idempotency collisions on re-apply — fine, the implementer
 * already ran the migration) or "real" (genuine SQL failure that must
 * fail the iteration).
 *
 * This is the most-loved feature of the bash local fork (afk-ralph.sh
 * ~L618-661): the implementer agent often applies migrations itself via
 * MIGRATION_BLOCK, but we re-apply idempotently as a backstop so the dev
 * DB can never silently miss a migration. The benign-error classifier is
 * the load-bearing piece — without it, every successful re-apply would
 * look like a failure.
 *
 * Invocation discipline:
 *   - `git diff` and `psql` are invoked via `execFile` (NEVER `exec`) so
 *     SHA strings, file paths, and SQL statements can't shell-inject. Every
 *     argument is a separate argv entry.
 *   - Statements are sent one-per-call via `psql -X -c "<stmt>"` rather than
 *     `psql -f <file>`. This gives us per-statement error attribution and
 *     avoids the "psql exits 0 even with errors" trap from the bash version.
 *     `-v ON_ERROR_STOP=1` makes psql exit non-zero on any error.
 *   - SQL splitting respects `--` line comments, `'...'` single-quoted strings,
 *     and `$$...$$` (and tagged `$tag$...$tag$`) dollar-quoted blocks used by
 *     PostgreSQL function bodies.
 */

import { execFile } from "node:child_process";
import { promises as fs, readdirSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single real (non-benign) error attributable to one statement in one file. */
export interface MigrationRealError {
  /** Repo-relative path to the migration file. */
  readonly file: string;
  /** The SQL statement (trimmed) that triggered the error. */
  readonly stmt: string;
  /** The psql ERROR line(s), joined with newlines. */
  readonly msg: string;
}

/** Result of applying a batch of migrations between two commits. */
export interface ApplyMigrationsResult {
  /** Number of statements that ran without ANY error. */
  readonly applied: number;
  /** Number of statements whose error was a benign idempotency collision. */
  readonly benignSkipped: number;
  /** Real errors — the caller should treat the iteration as failed if length > 0. */
  readonly realErrors: MigrationRealError[];
}

export interface ApplyMigrationsOptions {
  /**
   * `DATABASE_URL` (or equivalent) to pass to psql. Defaults to
   * `process.env.DATABASE_URL`. Throws if neither is set.
   */
  readonly databaseUrl?: string;
  /**
   * Per-`psql` invocation timeout in ms. Defaults to 60s. Long migrations
   * (CREATE INDEX CONCURRENTLY on a big table) can blow this; callers
   * should size up.
   */
  readonly perStatementTimeoutMs?: number;
  /**
   * Override the `git`/`psql` runner. Test seam — production code never
   * sets this. Receives `(bin, args, opts)` and returns
   * `{ stdout, stderr, exitCode }`. A non-zero exit code is reported via
   * the result, NOT thrown — psql errors are normal flow here.
   */
  readonly _exec?: ExecRunner;
}

/** Test-seam shape for overriding shell invocation. */
export type ExecRunner = (
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Benign-error classifier
// ---------------------------------------------------------------------------

/**
 * Anchored to PostgreSQL's exact "already exists" phrasing for structural
 * objects. The bash version's loose `already exists|duplicate (key|object)`
 * filter false-classified real INSERT conflicts (`duplicate key value
 * violates unique constraint`) as benign. We anchor strictly.
 *
 * The full kind list mirrors what postgres can report: relation, type,
 * extension, index, constraint, table, schema, column, sequence, function,
 * trigger, policy, view, materialized view, operator, aggregate, domain,
 * role, user, database, tablespace.
 *
 * The required spec called out a smaller subset
 * (`relation|type|index|constraint|trigger|sequence|function`); we keep
 * the full bash list because dropping any of them would silently turn
 * benign collisions into iteration failures on real-world re-apply.
 */
export const BENIGN_ALREADY_EXISTS_REGEX =
  /^ERROR:\s+(?:relation|type|extension|index|constraint|table|schema|column|sequence|function|trigger|policy|view|materialized view|operator|aggregate|domain|role|user|database|tablespace)\s+"[^"]*"\s+already\s+exists$/m;

/**
 * True iff every `ERROR:` line in the psql output is a benign
 * "<kind> "<name>" already exists" collision. `''` and "no errors at all"
 * both return false — caller checks `realErrors.length === 0` separately.
 */
export function classifyPsqlErrors(rawOutput: string): {
  real: string[];
  benign: string[];
} {
  const errorLines = extractErrorLines(rawOutput);
  const real: string[] = [];
  const benign: string[] = [];
  for (const line of errorLines) {
    if (BENIGN_ALREADY_EXISTS_REGEX.test(line)) {
      benign.push(line);
    } else {
      real.push(line);
    }
  }
  return { real, benign };
}

/**
 * Extract canonical `ERROR: ...` lines from psql output. Strips the
 * `psql:<file>:<lineno>: ` prefix that psql adds when running with `-f`,
 * so the regex check is uniform across `-c` and `-f` invocations.
 *
 * Matches both bash forms:
 *   `^ERROR: ...`
 *   `^psql:<file>:<line>: ERROR: ...`
 */
function extractErrorLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let m = /^ERROR:\s+.*/.exec(line);
    if (m) {
      out.push(m[0]);
      continue;
    }
    m = /^psql:[^:]+:[0-9]+:\s+(ERROR:\s+.*)/.exec(line);
    if (m && m[1]) {
      out.push(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL statement splitter
// ---------------------------------------------------------------------------

/**
 * Split a migration file's text into individual statements at unquoted `;`
 * boundaries. Honors:
 *   - `--` line comments (rest of line is ignored)
 *   - `/* ... *\/` block comments (everything between is ignored)
 *   - `'...'` single-quoted strings (escaped via doubled `''`)
 *   - `"..."` double-quoted identifiers (escaped via doubled `""`)
 *   - `$$ ... $$` dollar-quoted blocks (PostgreSQL function bodies)
 *   - `$tag$ ... $tag$` tagged dollar-quoted blocks
 *
 * Empty/whitespace-only statements are dropped.
 *
 * Note: this is a pragmatic splitter, not a full SQL parser. For Drizzle
 * migrations (the common case here) it covers everything in practice.
 * If a migration uses something exotic, the implementer agent already
 * applied it via MIGRATION_BLOCK and our re-apply just sees benign
 * "already exists" — so our splitter only needs to be good enough that
 * we don't accidentally chop a function body in half.
 */
export function splitSqlStatements(sql: string): string[] {
  const result: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : "";

    // Line comment: -- ... \n
    if (ch === "-" && next === "-") {
      // Preserve the comment in the buffer (psql tolerates leading comments
      // on a -c statement). Walk to end-of-line.
      while (i < n && sql[i] !== "\n") {
        buf += sql[i];
        i++;
      }
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      buf += "/*";
      i += 2;
      while (i < n) {
        if (sql[i] === "*" && i + 1 < n && sql[i + 1] === "/") {
          buf += "*/";
          i += 2;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }

    // Single-quoted string: '...' with '' as escape
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          // Doubled '' is an escaped quote, not a terminator
          if (i + 1 < n && sql[i + 1] === "'") {
            buf += "''";
            i += 2;
            continue;
          }
          buf += "'";
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }

    // Double-quoted identifier: "..." with "" as escape
    if (ch === '"') {
      buf += ch;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') {
            buf += '""';
            i += 2;
            continue;
          }
          buf += '"';
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }

    // Dollar-quote: $$ or $tag$ ... $tag$
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const open = tagMatch[0]; // e.g. "$$" or "$tag$"
        buf += open;
        i += open.length;
        const closeIdx = sql.indexOf(open, i);
        if (closeIdx === -1) {
          // Unterminated dollar-quote — treat the rest as one chunk.
          buf += sql.slice(i);
          i = n;
        } else {
          buf += sql.slice(i, closeIdx + open.length);
          i = closeIdx + open.length;
        }
        continue;
      }
    }

    // Statement boundary
    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
      buf = "";
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  // Trailing statement without a final ";"
  const tail = buf.trim();
  if (tail.length > 0) {
    result.push(tail);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Migration-file detection
// ---------------------------------------------------------------------------

/**
 * Filter for paths that look like Drizzle migrations:
 *   - path contains a `/migrations/` segment, AND
 *   - filename matches `<NNNN>_<rest>.sql` (Drizzle's numeric-prefix convention).
 *
 * The bash version filtered explicitly to `packages/db/migrations/*.sql` and
 * excluded `/meta/`. We generalize: any `/migrations/<NNNN>_*.sql` outside
 * `/meta/` qualifies. Callers in non-Drizzle repos can extend.
 */
export function isDrizzleMigrationPath(p: string): boolean {
  if (!p.endsWith(".sql")) return false;
  if (p.includes("/meta/")) return false;
  if (!p.includes("/migrations/")) return false;
  const base = path.basename(p);
  return /^[0-9]{4}_.+\.sql$/.test(base);
}

/**
 * Walk `repoRoot` and return any on-disk file that satisfies
 * `isDrizzleMigrationPath`. Pure filesystem scan — no git, no SQL exec — so
 * it's safe to call at loop startup before any commits exist.
 *
 * Synchronous so it can run inside `preflight()` alongside the other sync
 * checks (`existsSync`, `execFileSync`).
 *
 * Defensive bits worth knowing about:
 *   - Symlinks are skipped entirely (Dirent.isSymbolicLink). Otherwise a
 *     cycle (e.g. a vendored repo with `node_modules/foo -> ../..`) would
 *     blow the stack at boot.
 *   - Returned relative paths are normalized to forward slashes before being
 *     passed to `isDrizzleMigrationPath`, which hardcodes `/migrations/` /
 *     `/meta/` substrings. Otherwise Windows hosts would always return [].
 *   - Skip list is an explicit denylist of known-large dirs, not a blanket
 *     `startsWith(".")`, so a project that puts migrations under e.g.
 *     `.db/migrations/0001_init.sql` is still detected.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".sandcastle",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  ".svelte-kit",
  ".nuxt",
  ".output",
  ".expo",
  ".parcel-cache",
  ".yarn",
  ".pnpm-store",
]);

export function listMigrationsOnDisk(repoRoot: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(repoRoot, full).split(path.sep).join("/");
        if (isDrizzleMigrationPath(rel)) out.push(rel);
      }
    }
  }
  walk(repoRoot);
  return out;
}

/**
 * Run `git diff --name-only --diff-filter=A {pre}..{post} -- "*.sql"` and
 * return repo-relative paths in commit order.
 */
async function listAddedSqlFiles(
  repoRoot: string,
  preSha: string,
  postSha: string,
  exec: ExecRunner,
): Promise<string[]> {
  const { stdout, exitCode, stderr } = await exec(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=A",
      `${preSha}..${postSha}`,
      "--",
      "*.sql",
    ],
    { cwd: repoRoot, timeout: 30_000 },
  );
  if (exitCode !== 0) {
    throw new Error(
      `git diff failed (rc=${exitCode}) between ${preSha}..${postSha}: ${stderr || stdout}`,
    );
  }
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const defaultExecRunner: ExecRunner = async (bin, args, opts) => {
  try {
    const { stdout, stderr } = await execFileP(bin, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const exitCode =
      typeof e.code === "number" ? e.code : e.code === undefined ? 1 : 1;
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : e.message ?? "execFile failed",
      exitCode,
    };
  }
};

/**
 * Detect new migration files added between `preSha` and `postSha`, then run
 * each statement via `psql -X -v ON_ERROR_STOP=1 -c <stmt>` against
 * `process.env.DATABASE_URL`. Errors are classified as benign (idempotency
 * collisions) or real.
 *
 * Returns a structured result; never throws on SQL errors. Throws only when
 * the environment is misconfigured (no DATABASE_URL) or git fails.
 */
export async function applyMigrationsBetween(
  repoRoot: string,
  preSha: string,
  postSha: string,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  if (preSha === postSha) {
    return { applied: 0, benignSkipped: 0, realErrors: [] };
  }

  const databaseUrl =
    options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const exec: ExecRunner = options._exec ?? defaultExecRunner;
  const timeout = options.perStatementTimeoutMs ?? 60_000;

  const allAdded = await listAddedSqlFiles(repoRoot, preSha, postSha, exec);
  const migrations = allAdded.filter(isDrizzleMigrationPath);
  if (migrations.length === 0) {
    return { applied: 0, benignSkipped: 0, realErrors: [] };
  }

  if (databaseUrl.length === 0) {
    throw new Error(
      "applyMigrationsBetween: no DATABASE_URL set (and none passed via options.databaseUrl) — " +
        `${migrations.length} new migration(s) cannot be applied`,
    );
  }

  let applied = 0;
  let benignSkipped = 0;
  const realErrors: MigrationRealError[] = [];

  for (const mig of migrations) {
    const abs = path.isAbsolute(mig) ? mig : path.join(repoRoot, mig);
    let sql: string;
    try {
      sql = await fs.readFile(abs, "utf8");
    } catch (err) {
      realErrors.push({
        file: mig,
        stmt: "",
        msg: `failed to read migration file: ${(err as Error).message}`,
      });
      // A read failure on this migration shouldn't poison subsequent ones —
      // but the caller should treat the iteration as failed regardless.
      continue;
    }

    const statements = splitSqlStatements(sql);
    for (const stmt of statements) {
      const { stdout, stderr, exitCode } = await exec(
        "psql",
        [
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          stmt,
          databaseUrl,
        ],
        {
          env: { ...process.env, PGAPPNAME: "ralph-migration-applier" },
          timeout,
        },
      );

      const combined = `${stdout}\n${stderr}`.trim();
      const { real: realLines, benign: benignErrors } = classifyPsqlErrors(combined);

      if (realLines.length > 0) {
        realErrors.push({
          file: mig,
          stmt,
          msg: realLines.join("\n"),
        });
        // Continue to next statement: we want the full picture, not just
        // the first failure. Caller still treats iteration as failed.
        continue;
      }

      if (benignErrors.length > 0) {
        benignSkipped += 1;
        continue;
      }

      // No errors at all. exitCode==0 is expected; if exitCode !== 0 with no
      // ERROR lines, something weird happened (psql crashed, signal, etc.) —
      // treat it as a real error.
      if (exitCode !== 0) {
        realErrors.push({
          file: mig,
          stmt,
          msg:
            `psql exited ${exitCode} with no parseable ERROR lines: ` +
            (combined.length > 0 ? combined.slice(0, 500) : "(no output)"),
        });
        continue;
      }

      applied += 1;
    }
  }

  return { applied, benignSkipped, realErrors };
}
