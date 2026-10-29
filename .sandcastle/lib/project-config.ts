/**
 * Project settings: the ONE committed file (`.sandcastle/project.json`) that
 * carries everything the loop would otherwise hardcode about the project it
 * runs in. Missing file = every default. Every default switches a
 * project-specific feature OFF — an absent setting is never a new failure
 * path (ADR 0015: remove a choice, don't add a way to stop).
 *
 * An INVALID file is the one exception: it throws at startup with a message
 * naming the file and the bad key, because silently ignoring a typo'd
 * `landCheck` would quietly turn a safety gate off.
 *
 * See `.sandcastle/project.example.json` for every key filled in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

/** Where the file lives, relative to the repo root. */
export const PROJECT_CONFIG_RELATIVE_PATH = ".sandcastle/project.json";

const wideReachSchema = z.object({
  paths: z.array(z.string().min(1)),
  what: z.string().min(1),
});

const projectConfigSchema = z
  .object({
    /** argv of the check run on the run-branch tip before the loop lands its own run PR. `null` = the loop never lands. */
    landCheck: z.array(z.string().min(1)).min(1).nullable().default(null),
    /**
     * Opt-in per-job test databases. `templateDb` is a Postgres database on
     * the local test server that every sandbox's own database is cloned from;
     * `setupCommand` (argv, no shell) is the project's own step that brings a
     * fresh clone up to date, run from the repo root with the clone's url in
     * `DATABASE_URL`. `null` = no test database: no psql, no clone.
     */
    testDatabase: z
      .object({
        templateDb: z
          .string()
          .regex(/^[A-Za-z0-9_]+$/, "must be a plain database name (letters, digits, underscore)"),
        setupCommand: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict()
      .nullable()
      .default(null),
    /**
     * Folder (repo-relative) of plain `.sql` migration files. When set, the
     * merge rule reads each added migration and holds the run for the owner
     * if it deletes or rewrites existing data. `null` = no migration reading.
     */
    migrations: z
      .object({ dir: z.string().min(1) })
      .nullable()
      .default(null),
    /** Repo-relative, POSIX. Every issue's check directory hangs off this. */
    checksRoot: z.string().min(1).default("e2e/checks"),
    /**
     * Command prefix that runs one browser check; the check path (relative to
     * the PARENT of `checksRoot`) is appended. `null` = `pnpm exec playwright
     * test` with the repo-relative check path.
     */
    browserCheckCommand: z.string().min(1).nullable().default(null),
    /** The repo-relative `package.json` whose `scripts.e2e` value is guarded. `null` = no such guard. */
    e2eScriptPackageJson: z.string().min(1).nullable().default(null),
    /**
     * Files and folders the judge freezes besides the check itself and its
     * runner config (which are derived from `checksRoot`). `browserRoots`:
     * folders holding the code that GRADES a browser check (e.g. a pure
     * comparison library); `unitRoots` / `unitSeeds`: the shared unit-test
     * runner config folders / files every package inherits.
     */
    checkFreeze: z
      .object({
        browserRoots: z.array(z.string().min(1)).default([]),
        unitRoots: z.array(z.string().min(1)).default([]),
        unitSeeds: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ browserRoots: [], unitRoots: [], unitSeeds: [] }),
    /** Extra globs the builder may not touch (verdict machinery, seed data). */
    protectedPaths: z.array(z.string().min(1)).default([]),
    /** Extra paths that make a change "wide reach" (never small) in the merge rule. */
    wideReachPaths: z.array(wideReachSchema).default([]),
    ownerName: z.string().min(1).default("the owner"),
    commitIdentity: z
      .object({ name: z.string().min(1), email: z.string().min(1) })
      .default({ name: "Claude", email: "noreply@anthropic.com" }),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** Wide-reach entries every project gets, whatever its layout. */
export const GENERIC_WIDE_REACH_PATHS: readonly {
  readonly paths: readonly string[];
  readonly what: string;
}[] = [
  {
    paths: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package-lock.json",
      "turbo.json",
      "yarn.lock",
    ],
    what: "changes dependencies or workspace setup",
  },
  { paths: [".github/"], what: "changes CI" },
  // The loop runs unattended on whatever lands on `main`; a bad change to it
  // breaks the next night's run with nobody watching.
  { paths: [".sandcastle/"], what: "changes the loop itself" },
];

/** Every default: each project-specific feature off. */
export function defaultProjectConfig(): ProjectConfig {
  return projectConfigSchema.parse({});
}

/** Parse + validate raw JSON text. Throws a clear, file-naming error. */
export function parseProjectConfig(text: string, source = PROJECT_CONFIG_RELATIVE_PATH): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(top level)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${source} is invalid:\n${issues}`);
  }
  return parsed.data;
}

/** Read `.sandcastle/project.json` under `repoRoot`; a missing file is all defaults. */
export function loadProjectConfig(repoRoot: string): ProjectConfig {
  const file = join(repoRoot, PROJECT_CONFIG_RELATIVE_PATH);
  if (!existsSync(file)) return defaultProjectConfig();
  return parseProjectConfig(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// The active config. `main.mts` loads the file once at startup and installs it
// here; the pure helpers below it (path lists, identity, owner name) read it so
// the settings don't have to be threaded through ~hundreds of call sites. Until
// something installs a config, every reader sees the defaults.
// ---------------------------------------------------------------------------

let active: ProjectConfig = defaultProjectConfig();

export function setProjectConfig(config: ProjectConfig): void {
  active = config;
}

export function resetProjectConfig(): void {
  active = defaultProjectConfig();
}

export function getProjectConfig(): ProjectConfig {
  return active;
}

/** Generic wide-reach entries plus the project's own. */
export function wideReachPaths(config: ProjectConfig = active) {
  return [...GENERIC_WIDE_REACH_PATHS, ...config.wideReachPaths];
}
