/**
 * Deploy-config blind-spot scanner (pure, no I/O).
 *
 * The sandbox can compile and test a change but is blind to two things that
 * live OUTSIDE the repo and must be provisioned by a human on the deploy target:
 *   1. cron SCHEDULING — an `api/cron/...` route handler (or a `vercel.json`
 *      `crons` entry) ships the code, but nothing in the repo makes the
 *      scheduler actually CALL it on an interval.
 *   2. required SECRETS — code that newly reads `process.env.X` / `env.X` needs
 *      that value to exist as a secret/env var in the deploy target, which the
 *      sandbox never sees.
 *
 * {@link scanOpsConfig} reads an already-computed run diff and surfaces exactly
 * those two lists so the loop can emit an explicit "ops-config to-do" for the
 * owner. It performs NO filesystem, git, or process.env access — the CLI
 * wrapper (`../../scripts/scan-ops-config.mts`) owns all I/O.
 *
 * SCOPE: this is a BEST-EFFORT ACCELERATOR for the common JS/TS-on-Vercel
 * stack, NOT a universal detector. The patterns below are CONSUMER-SHAPED — they
 * recognise a Next.js `api/cron/` route handler, a Vercel `vercel.json` cron
 * entry, and a `process.env.X` / bare `env.X` read. On a repo that schedules or
 * reads secrets any other way (GitHub Actions `schedule:`, crontab, k8s CronJob,
 * `os.environ` / `ENV[...]`, a typed-env accessor like `serverEnv.X` in
 * `@t3-oss/env` apps, …) it correctly returns EMPTY rather than guessing — the
 * `sandcastle-complete` skill's Stage 7 prose owns the framework-agnostic
 * fallback (inspect the diff for that stack's equivalents). Patterns are
 * centralised here so a consumer can tune/extend them in one place. It also
 * deliberately ignores `import.meta.env.*` (Vite build-time constants, not
 * runtime secrets).
 */

export interface ScanOpsConfigInput {
  /** Paths changed in the run diff (e.g. `git diff --name-only origin/main...HEAD`). */
  readonly changedFiles: string[];
  /** The unified run diff (e.g. `git diff origin/main...HEAD`). */
  readonly patch: string;
}

export interface ScanOpsConfigResult {
  /** Human-readable cron route identifiers the owner must schedule out-of-repo. */
  readonly cronRoutes: string[];
  /** Distinct newly-read required env vars that must be provisioned as secrets. */
  readonly newRequiredEnvVars: string[];
}

/**
 * A cron route-handler source file — its SCHEDULING lives out-of-repo. Requires
 * a JS/TS extension so a doc/markdown path under `api/cron/` isn't mistaken for
 * a deployable route.
 */
const CRON_ROUTE_RE = /api\/cron\/.*\.[cm]?[jt]sx?$/;
/** Test/spec files are not deployable routes — exclude them from cron hits. */
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/__tests__\/)/;
/**
 * A `vercel.json` cron entry: `"path": "/..."` on an ADDED line. Applied ONLY
 * to the vercel.json hunk (see below), and to any path — Vercel crons are not
 * required to live under `/api/`.
 */
const VERCEL_CRON_PATH_RE = /"path"\s*:\s*"(\/[^"]+)"/g;
/** `vercel.json` at repo root or any monorepo package dir. */
const VERCEL_JSON_RE = /(^|\/)vercel\.json$/;
/**
 * A newly-read env var: `process.env.X` or a bare `env.X`, X an UPPER_SNAKE
 * ident. The `env` form carries a `(?<![\w.])` guard so it matches a standalone
 * `env` binding but NOT an identifier that merely ends in `env`
 * (`parsedEnv.FOO`) or a nested accessor (`ctx.env.FOO`, `import.meta.env.FOO`),
 * which are usually already-provisioned build constants, not new secrets.
 */
const ENV_VAR_RE = /(?:process\.env|(?<![\w.])env)\.([A-Z][A-Z0-9_]*)/g;

/**
 * Group a unified diff's ADDED lines by their new-file path, read from each
 * `+++ b/<path>` header. Lines added before any header, or under `/dev/null`
 * (a deletion), are dropped. Used to scope the vercel.json cron scan to the
 * vercel.json hunk instead of the whole patch.
 */
function addedLinesByFile(patch: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim().replace(/^b\//, "");
      current = path === "/dev/null" ? null : path;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const arr = byFile.get(current) ?? [];
      arr.push(line);
      byFile.set(current, arr);
    }
  }
  return byFile;
}

/**
 * Scan a run diff for deploy-config blind spots. Pure over its input; see the
 * module header for the contract. De-duped, first-seen order preserved.
 */
export function scanOpsConfig(input: ScanOpsConfigInput): ScanOpsConfigResult {
  const cronRoutes: string[] = [];
  const seenCron = new Set<string>();
  const addCron = (id: string): void => {
    if (!seenCron.has(id)) {
      seenCron.add(id);
      cronRoutes.push(id);
    }
  };

  // 1. Cron route handlers straight from the changed-file list (test/spec
  //    files under the cron path are not deployable routes — skip them).
  for (const file of input.changedFiles) {
    if (CRON_ROUTE_RE.test(file) && !TEST_FILE_RE.test(file)) addCron(file);
  }

  // ADDED patch lines (`+`, not the `+++` header) — a removed/context line is
  // not a NEW blind spot. The whole-patch list feeds the env scan (env vars can
  // be read in any file); the per-file grouping keeps the vercel.json cron scan
  // scoped to the vercel.json hunk.
  const addedLines = input.patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const addedByFile = addedLinesByFile(input.patch);

  // 2. Cron paths introduced in a changed vercel.json's `crons` config — scoped
  //    to the vercel.json hunk so a `"path": "/api/..."` in some OTHER changed
  //    file (e.g. a route table) is not misread as a Vercel cron.
  for (const [file, lines] of addedByFile) {
    if (!VERCEL_JSON_RE.test(file)) continue;
    for (const line of lines) {
      for (const match of line.matchAll(VERCEL_CRON_PATH_RE)) addCron(match[1]);
    }
  }

  // 3. Newly-read required env vars across every added line.
  const newRequiredEnvVars: string[] = [];
  const seenEnv = new Set<string>();
  for (const line of addedLines) {
    for (const match of line.matchAll(ENV_VAR_RE)) {
      const name = match[1];
      if (!seenEnv.has(name)) {
        seenEnv.add(name);
        newRequiredEnvVars.push(name);
      }
    }
  }

  return { cronRoutes, newRequiredEnvVars };
}
