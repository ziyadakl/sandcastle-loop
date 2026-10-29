/**
 * Where a check-writer's UNIT acceptance check lives, which package may host
 * one, and the command that runs it (issue #956).
 *
 * The unit-runner twin of `check-path.ts`. Everything about the red-first rule
 * is deliberately identical across the two — the same must-fail-first receipt,
 * the same sha256 lock over the check's exact bytes, the same ship-time re-run.
 * ONLY the runner changes (`check-kind.ts`). Read this file beside that one;
 * where the two differ, the difference is load-bearing and said out loud.
 *
 * Everything the two rules genuinely SHARE lives in `check-source.ts` — the
 * comment/literal scanner and the relative-path shape factory — so the twin
 * cannot drift into two different answers to one question. An earlier draft of
 * this file carried its own copy of both and said `check-path.ts` was off
 * limits in that slice; it is not off limits any more, and the copies are gone.
 *
 * ## Why `<packageDir>/src/__checks__/issue-<N>/`
 *
 * `check-path.ts` explains why a browser check MUST sit inside
 * `apps/nextjs/e2e/checks/`: Playwright's config pins `testDir: "./e2e"` and
 * only DISCOVERS specs inside it, so a CLI path argument FILTERS the discovered
 * set rather than adding to it. The identical failure exists here, and it is
 * worse because it is silent.
 *
 * Every package's vitest `include` in this repo is `src/**\/*.{test,spec}.{ts,tsx}`
 * (from `tooling/vitest/base.ts` and `react.ts`; `packages/api` adds
 * `scripts/**` on top). A check file OUTSIDE `src/` is collected by nothing:
 * vitest prints `No test files found, exiting with code 1` and no tally at all.
 * That is not a red check — it is a check that does not exist, and the
 * must-fail-first proof it produces is a proof of absence. Under `src/` is the
 * only tree every configured package actually looks in, so that is where the
 * check goes.
 *
 * `__checks__` rather than `__tests__` so the check machinery stays greppable
 * and distinguishable from ordinary test material — exactly the property
 * `CHECKS_ROOT`'s doc claims for the browser side, where `proof-demand.ts` has
 * to be able to say "this is some issue's live red-first proof, not test
 * material a ticket may freely edit". {@link UNIT_CHECKS_ROOT_GLOB} is that
 * sentence as one pattern.
 *
 * ## Why `packages/*` only, never `apps/*`
 *
 * See {@link isSafeUnitCheckPackage}. Short version: the router
 * (`proof-demand.ts`) makes ANY `apps/**` touch demand a BROWSER proof, and
 * `proofDemandSatisfied` says a unit proof never satisfies a browser demand. A
 * unit check inside an app would therefore create, by the mere fact of
 * existing in the diff, a demand it is structurally incapable of meeting.
 * Refusing it here makes that a rule rather than a coincidence a reader has to
 * re-derive from two other modules.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CHECK_REPORT_INVOCATION,
  checkReportPathFor,
  isSafeCheckNonce,
  runEvidenceEpilogue,
} from "../harness/tally-signals.js";
import { SAFE_PACKAGE_NAME } from "../testing/test-verification.js";
import { manifestHasTestScript } from "../testing/workspace-packages.js";
import { isUsableIssueNumber } from "./check-path.js";
import {
  checkRelativePathPattern,
  LITERAL_MARK,
  scanCheckSource,
} from "./check-source.js";

/**
 * The directory name a per-issue unit check hangs off inside a package's
 * `src/`. Exported for the same reason `CHECKS_ROOT` is: other gates have to be
 * able to recognise check machinery as such, and a bare string literal in three
 * files is how those gates drift apart.
 */
export const UNIT_CHECK_DIR_SEGMENT = "__checks__";

/**
 * The per-issue unit check directory, repo-relative and POSIX-separated.
 *
 * A pure path builder, like `checkDirForIssue`. It does NOT validate
 * `packageDir` — the two functions that turn a path into an action
 * ({@link buildUnitCheckCommand}, {@link missingUnitCheckRequirements}) gate on
 * {@link isSafeUnitCheckPackage} themselves, and a caller building a path for a
 * log line should not be forced through a `undefined` branch.
 */
export function unitCheckDirFor(
  packageDir: string,
  issueNumber: number,
): string {
  return `${packageDir}/src/${UNIT_CHECK_DIR_SEGMENT}/issue-${issueNumber}`;
}

/** The protected-path glob (issue #909 / Piece C) covering that directory. */
export function unitCheckDirGlobFor(
  packageDir: string,
  issueNumber: number,
): string {
  return `${unitCheckDirFor(packageDir, issueNumber)}/**`;
}

/**
 * EVERY issue's unit check directory, anywhere in the repo, as one glob — the
 * unit-side counterpart of `${CHECKS_ROOT}/**`.
 *
 * The browser side can name a single literal root because there is exactly one
 * app hosting checks. The unit side cannot: the root is per-package and the
 * package is chosen per ticket, so the pattern has to be shaped rather than
 * enumerated.
 *
 * VERIFIED against `lib/paths/glob.ts`'s hand-rolled matcher, which is the only
 * matcher any caller will use, and whose `**` semantics are its own (a leading
 * `**\/` compiles to `(?:.*\/)?` and a trailing `/**` to `(?:\/.*)?`, both
 * allowing ZERO segments). This pattern therefore matches both
 * `packages/api/src/__checks__/issue-848/x.test.ts` and the bare directory
 * `packages/api/src/__checks__/issue-848`, and matches neither
 * `packages/api/src/__tests__/x.test.ts` nor a browser check under
 * `apps/nextjs/e2e/checks/`. There are tests for all four; a pattern nobody
 * proved against the real matcher is a pattern that silently matches nothing.
 */
export const UNIT_CHECKS_ROOT_GLOB = `**/src/${UNIT_CHECK_DIR_SEGMENT}/**`;

/**
 * Which directories may host a unit check: `packages/<name>`, exactly two
 * segments, lowercase, and NEVER `apps/*`.
 *
 * ## Why apps are refused rather than merely discouraged
 *
 * `proof-demand.ts` computes what proof a FINISHED diff owes from the diff
 * itself. `apps/**` is the first entry in `SCREEN_OR_FLOW_GLOBS`, so any file
 * under an app raises the demand to `browser`; and `proofDemandSatisfied` is a
 * one-way lattice in which `unit` never meets `browser`. A unit check written
 * into `apps/nextjs/src/__checks__/…` is itself a changed file under `apps/**`,
 * so it would raise a browser demand purely by existing and then fail to
 * satisfy it. The ticket stops, and the stop message blames the ticket for a
 * shape the machinery handed it.
 *
 * There is a second, independent reason: an app's vitest include is the same
 * `src/**` shape, but an app is where screens live, and a ticket that has real
 * business in an app has a screen to photograph. The unit route exists for the
 * tickets that do not.
 *
 * A WHITELIST of what a pnpm workspace directory can actually be named, not a
 * blacklist of metacharacters — the same discipline `SAFE_PACKAGE_NAME` and
 * `isSafeCheckRelativePath` apply, and for the same reason: a blacklist is only
 * ever as complete as the last person who thought about it. The value is
 * interpolated into a filesystem path here and, via the resolved package name,
 * into a shell string downstream.
 */
const SAFE_UNIT_CHECK_PACKAGE = /^packages\/[a-z0-9][a-z0-9._-]*$/;

export function isSafeUnitCheckPackage(dir: unknown): dir is string {
  return (
    typeof dir === "string" &&
    dir.length > 0 &&
    !dir.includes("..") &&
    SAFE_UNIT_CHECK_PACKAGE.test(dir)
  );
}

/**
 * A `checkPath` a unit check-writer's envelope may name, WITHOUT re-trusting
 * the string verbatim. `.test.ts` where the browser rule says `.spec.ts`, and
 * that is the whole difference.
 *
 * `.test.tsx` is refused as well as `.spec.ts`. A `.tsx` unit check would be a
 * component test, which draws something — and anything that draws belongs on
 * the browser route (see {@link isSafeUnitCheckPackage}'s second reason and
 * `proof-demand.ts`'s `packages/**\/*.tsx` entry, which escalates exactly that
 * file to a `browser` demand the unit route cannot meet).
 */
const SAFE_UNIT_CHECK_RELATIVE_PATH = checkRelativePathPattern(".test.ts");

export function isSafeUnitCheckRelativePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("..") &&
    SAFE_UNIT_CHECK_RELATIVE_PATH.test(p)
  );
}

/** The vitest config filenames a package may declare. */
const VITEST_CONFIG_FILENAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
] as const;

/** What the host learned about a candidate host package, from the host's own disk. */
export interface ResolvedUnitCheckPackage {
  /** The npm `name` read out of the package's own manifest, e.g. `@acme/api`. */
  readonly packageName: string;
}

/**
 * Turn the directory the check-writer's envelope NAMED into the npm package
 * name the run command needs — reading the filesystem the host controls, never
 * taking the name from the agent.
 *
 * The envelope can only ever name a directory. Letting it also supply the
 * package name would put an agent-authored string straight into a shell command
 * one step later; making the host read `<dir>/package.json` means the only
 * thing the agent influences is WHICH directory is consulted, and that is
 * whitelisted before anything is opened.
 *
 * Returns `undefined`, never throws, unless ALL of these hold:
 *
 *   1. {@link isSafeUnitCheckPackage} accepts the directory;
 *   2. `<worktree>/<dir>/package.json` reads and JSON-parses, and its `.name`
 *      is a string matching `SAFE_PACKAGE_NAME` (imported from
 *      `lib/testing/test-verification.ts` — the same regex that already gates
 *      every package name this loop interpolates into a shell string; a second
 *      definition of "safe package name" is two answers to one question);
 *   3. the manifest declares a runnable `test` script, per
 *      `manifestHasTestScript` (reused as-is: it is already THE predicate for
 *      that word, shared by the cert gate and workspace discovery, and a third
 *      re-derivation is how one layer goes dormant while another considers the
 *      package testable);
 *   4. one of {@link VITEST_CONFIG_FILENAMES} exists in that directory.
 *
 * ## Why (4) is not redundant with (3)
 *
 * A `test` script proves SOMETHING runs; it does not prove vitest runs. Two
 * real cases in this repo:
 *
 *   - `packages/email` has no vitest config at all. A check written there is
 *     collected by nothing, and "no test files found" is not a red proof.
 *   - `apps/report-share` runs `node --test`, which prints no vitest tally.
 *     `lib/harness/tally-signals.ts` needs positive evidence that a test body
 *     executed and an assertion disagreed — a `Tests N failed` line. Without a
 *     vitest tally every run there classifies `inconclusive`, forever, and an
 *     inconclusive proof is a ticket that stops for a reason nobody can act on.
 *     (It is already refused by (1) for being an app; (4) is what would stop
 *     the same shape appearing under `packages/`.)
 *
 * Fail-quiet on every IO path, matching `workspace-packages.ts`: an unreadable
 * directory, a missing manifest, a manifest that does not parse all read as
 * "cannot host a unit check" rather than throwing out of a check-writer stage
 * mid-run.
 */
export function resolveUnitCheckPackage(
  worktreePath: string,
  packageDir: string,
): ResolvedUnitCheckPackage | undefined {
  if (!isSafeUnitCheckPackage(packageDir)) return undefined;
  try {
    const abs = path.join(worktreePath, packageDir);
    const manifest = JSON.parse(
      readFileSync(path.join(abs, "package.json"), "utf8"),
    ) as { name?: unknown; scripts?: Record<string, unknown> };
    const name = manifest.name;
    if (typeof name !== "string" || !SAFE_PACKAGE_NAME.test(name)) {
      return undefined;
    }
    if (!manifestHasTestScript(manifest)) return undefined;
    const hasVitestConfig = VITEST_CONFIG_FILENAMES.some((f) =>
      existsSync(path.join(abs, f)),
    );
    if (!hasVitestConfig) return undefined;
    return { packageName: name };
  } catch {
    return undefined;
  }
}

/**
 * The command that runs ONE unit check file, from the repo root, inside the
 * sandbox. Reused for both directions, exactly as `buildCheckCommand` is: the
 * pre-implementer must-fail-first proof (expect red) and the reviewer's
 * post-implementer re-run (expect green) — one builder, so the two can never
 * drift into running different things.
 *
 * `env CI=1 NO_COLOR=1 FORCE_COLOR=0 …`: every one of those three is
 * load-bearing, and `lib/testing/test-verification.ts:392-423` documents
 * exactly why, including the container-verified finding that `FORCE_COLOR=0`
 * alone does NOT suppress vitest's colour and `NO_COLOR=1` does. That doc is
 * the source; restating it here would give it a second copy to go stale
 * against.
 *
 * ## THE TRAP: no `--` before the path
 *
 * `buildCheckCommand` (`check-path.ts:90`) writes
 * `pnpm --filter @acme/nextjs e2e -- <path>`, and copying that shape here is
 * the single easiest way to break this module invisibly. Playwright's script
 * needs the `--` to receive its own flags. vitest does not, and pnpm does not
 * swallow it: pnpm passes a LITERAL `--` through to the script, vitest ignores
 * the token entirely, and the path stops acting as a filename filter. VERIFIED
 * by hand: `pnpm --filter <pkg> run test -- <path>` ran the whole package suite
 * — 14 files instead of 1 — while the identical command without `--` ran one.
 *
 * A whole-suite run is the worst possible failure here because it still LOOKS
 * right. It prints a real vitest tally, so the classifier grades it happily; it
 * goes red before the fix because some other pre-existing failure is in the
 * suite, and green after because that other thing got fixed too. The check's
 * own red→green transition is never actually observed, and the ticket ships
 * with a proof of something else. There is a test asserting the built string
 * contains no `" -- "` for exactly this reason.
 *
 * Returns `undefined` — never a raw interpolation — when any input is unsafe: a
 * package name outside `SAFE_PACKAGE_NAME`, a path outside
 * {@link isSafeUnitCheckRelativePath}, a non-integer / negative issue number,
 * or a nonce outside `isSafeCheckNonce`. A caller must treat that as "cannot
 * build a command".
 *
 * ## `nonce`, and why the reporter flags are here at all
 *
 * A vitest check could PRINT its own proof: `console.log("Tests  1 failed
 * (1)")` in a file whose every test is `it.skip`'d made the must-fail-first
 * classifier mint a receipt, and `"Tests  1 passed (1)"` made the ship-time
 * gate say `match`. Nothing in the stream distinguished the runner's summary
 * from the check's own printing. So the verdict no longer reads the stream: the
 * flags below ask vitest for its own JSON report at a host-named path, and
 * `runEvidenceEpilogue` prints the counters back on a line carrying a nonce
 * the check cannot know. See `lib/harness/tally-signals.ts` for the full
 * argument, including why `--silent=true` is a layer and not the fix.
 *
 * `buildCheckCommand`'s doc explains why the nonce is a PARAMETER rather than a
 * `randomUUID()` in here, and why it MUST be fresh per run rather than
 * persisted with the built command. Both rules apply identically on this route.
 */
export function buildUnitCheckCommand(
  packageName: string,
  issueNumber: number,
  relativePath: string,
  nonce: string,
): string | undefined {
  if (typeof packageName !== "string" || !SAFE_PACKAGE_NAME.test(packageName)) {
    return undefined;
  }
  if (!isUsableIssueNumber(issueNumber)) return undefined;
  if (!isSafeUnitCheckRelativePath(relativePath)) return undefined;
  if (!isSafeCheckNonce(nonce)) return undefined;
  const rel = `src/${UNIT_CHECK_DIR_SEGMENT}/issue-${issueNumber}/${relativePath}`;
  const { flags } = CHECK_REPORT_INVOCATION.unit(checkReportPathFor(nonce));
  return (
    `env CI=1 NO_COLOR=1 FORCE_COLOR=0 ` +
    `pnpm --filter ${packageName} run test ${rel}${flags}` +
    runEvidenceEpilogue(nonce)
  );
}

/**
 * The one requirement a unit check must meet before it is allowed to try, as
 * the human-readable string a stop message prints. Exported so the enforcement
 * point and its message cannot drift from each other.
 */
export const UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT =
  "imports at least one real product module (a `../` import that leaves the check directory, or an `@acme/…` workspace import)";

/** This repo's workspace scope — every package in `packages/*` is named `@acme/<x>`. */
const WORKSPACE_ALIAS_PREFIX = "@acme/";

/**
 * Which requirements this unit check does not meet — empty when fine. The
 * unit-side counterpart of `missingGradedHelperCalls`, and deliberately the
 * same shape: ONE function, ONE list, so a single refusal message can name
 * exactly what is missing.
 *
 * ## The requirement, and what it is actually for
 *
 * The check must import at least one module that is real product code: an
 * import specifier that either starts with `../` (relative, and leaving the
 * per-issue check directory) or begins `@acme/` (a workspace package).
 * `vitest`, `node:` builtins and same-directory `./…` imports do not count —
 * none of them is the code under test.
 *
 * ## Be clear about what this buys, and what it does not
 *
 * This is an EARLY, CHEAP REFUSAL WITH A GOOD ERROR MESSAGE. It is not the
 * security property, and it must not be read as one.
 *
 * The real proof of coupling is dynamic, and it is a pincer: the check runs RED
 * against untouched code, then GREEN against the finished code, over a file the
 * builder cannot edit (the protected-path lock covers the check directory —
 * {@link unitCheckDirGlobFor}). A check that never binds to real product code
 * cannot flip red→green from the builder's diff alone, because nothing in that
 * diff can change its result. So a static import scan cannot be DEFEATED into
 * shipping something; at worst it is bypassed, and the ticket then fails the
 * proof it was trying to fake. What the scan buys is that the failure arrives
 * in the check-writer stage with a sentence explaining it, instead of an hour
 * later as a mute must-fail-first failure the owner has to diagnose.
 *
 * ## What remains open, deliberately
 *
 * The pincer narrows the hole; it does not fully close it. A check whose result
 * flips on something OTHER than code still slips through both halves: the clock
 * (a date boundary crossed between the red run and the green one), the
 * filesystem, an environment variable, a network dependency. Those go red then
 * green with no relationship to the builder's diff at all, and neither this
 * scan nor the red→green transition can tell them apart from a real proof.
 * Naming it here rather than discovering it later.
 *
 * Smaller residuals, all of them fail-open in the same harmless direction (they
 * accept a check that should have been refused, and the dynamic proof then
 * refuses it):
 *
 *   - `../` only proves the specifier leaves the ISSUE directory, not that it
 *     reaches product code; `../fixtures/x.js` in a sibling check folder counts;
 *   - a qualifying import that is never USED still counts (this is an import
 *     scan, not a reachability analysis);
 *   - `import.meta` followed by a qualifying-looking string in the same
 *     statement is excluded by a lookahead, but the scan is a regex over
 *     stripped source, not a parser, and other exotic shapes may fool it.
 *
 * FAILS CLOSED on everything that could hide a real answer: an unreadable or
 * missing file, an unsafe package directory, an unsafe relative path — each
 * reports the requirement UNMET rather than "nothing to complain about".
 */
export function missingUnitCheckRequirements(
  worktreePath: string,
  packageDir: string,
  issueNumber: number,
  relativeCheckPath: string,
): readonly string[] {
  const unmet = [UNIT_CHECK_PRODUCT_IMPORT_REQUIREMENT];
  if (!isSafeUnitCheckPackage(packageDir)) return unmet;
  if (!isSafeUnitCheckRelativePath(relativeCheckPath)) return unmet;
  let source: string;
  try {
    source = readFileSync(
      path.join(
        worktreePath,
        unitCheckDirFor(packageDir, issueNumber),
        relativeCheckPath,
      ),
      "utf8",
    );
  } catch {
    return unmet;
  }
  return importedSpecifiers(source).some(isProductModuleSpecifier) ? [] : unmet;
}

/** Does this import specifier name real product code, rather than the test runner or the check's own scaffolding? */
function isProductModuleSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("../") || specifier.startsWith(WORKSPACE_ALIAS_PREFIX)
  );
}

/**
 * Every module specifier this source IMPORTS, in source order.
 *
 * Matched against the PLACEHOLDER view from {@link scanCheckSource}, which is
 * what makes a mention inside a comment or a string literal unable to satisfy
 * the requirement:
 *
 *   - a commented-out import is simply gone before this runs;
 *   - an import written INSIDE a string (`const s = "import x from '../y'"`)
 *     collapses to one opaque placeholder token, so the word `import` is no
 *     longer present in the scanned text at all.
 *
 * `[^;]*?` cannot cross a statement boundary, so `import { a } from "x"; f("y")`
 * resolves to `x`, and a lazy match takes the FIRST specifier after the
 * keyword. `(?!\s*\.)` excludes `import.meta.…`, whose `.url` is not a module
 * specifier and whose statement may well contain an unrelated string.
 *
 * Covers all three shapes a check can use: `import … from "x"`,
 * a bare `import "x"`, and a dynamic `import("x")`. CommonJS `require` is not
 * covered — this repo is ESM throughout and a `require` in a `.test.ts` under a
 * vitest config would not run.
 */
function importedSpecifiers(source: string): string[] {
  const { placeholders, literals } = scanCheckSource(source);
  const re = new RegExp(
    `\\bimport\\b(?!\\s*\\.)[^;]*?["']${LITERAL_MARK}(\\d+)${LITERAL_MARK}["']`,
    "g",
  );
  const out: string[] = [];
  for (const m of placeholders.matchAll(re)) {
    const literal = literals[Number(m[1])];
    if (literal !== undefined) out.push(literal);
  }
  return out;
}

