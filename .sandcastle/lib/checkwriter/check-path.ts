/**
 * Where a check-writer's acceptance check lives, and the command that runs
 * it (issue #911, Piece D).
 *
 * ## Why `apps/nextjs/e2e/checks/issue-<N>/`, not `.sandcastle/checks/`
 *
 * The obvious loop-internal home would be alongside the practice-world lock
 * (`.sandcastle/checks/…`), and an earlier ticket's test fixture even guessed
 * that path. It does not work: Playwright's own config pins
 * `testDir: "./e2e"` (`apps/nextjs/playwright.config.ts:81`) and only
 * DISCOVERS spec files inside that directory — a CLI path argument FILTERS
 * the discovered set, it does not add files from outside it. A check file
 * anywhere outside `apps/nextjs/e2e/` would be unrunnable by the exact
 * command this module builds, no matter how carefully the path were passed.
 * So the check lives inside the app's own e2e tree, in a per-issue
 * subdirectory Playwright already knows how to find.
 *
 * This also means a check-writer ticket structurally satisfies Piece D's "no
 * backend exemption" line for free: the check directory is inside `apps/`,
 * so ANY ticket that gets a real `CHECKS_WRITTEN` check also touches `apps/`
 * — one of the two workspaces the ship-time proof router measures against
 * (`proof-demand.ts`). That is intentional, not a coincidence to route around.
 * Note the router does NOT carve these files out of its browser-instrument
 * exemption: everything under {@link checksRoot} is some issue's live
 * red-first proof, so touching one raises a demand rather than waiving it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CHECK_REPORT_INVOCATION,
  checkReportPathFor,
  isSafeCheckNonce,
  runEvidenceEpilogue,
} from "../harness/tally-signals.js";
import {
  GRADE_MARK_ENV,
  gradeMarkEpilogue,
  gradeMarkPathFor,
} from "../harness/grade-mark.js";
import { getProjectConfig } from "../project-config.js";
import { VerdictParseError } from "../verdicts/parse.js";
import { checkRelativePathPattern, scanCheckSource } from "./check-source.js";

/**
 * The root every issue's check directory hangs off, repo-relative and
 * POSIX-separated. Exported because it is not just a path prefix: everything
 * under it is a LIVE red-first proof belonging to some issue, so other gates
 * have to be able to say "this is check machinery, not ordinary test
 * material" — see `proof-demand.ts`, whose browser-instrument carve-out
 * deliberately excludes this root and so refuses to wave these through.
 */
export function checksRoot(): string {
  return getProjectConfig().checksRoot.replace(/\/+$/, "");
}

/** The per-issue check directory, repo-relative, POSIX-separated. */
export function checkDirForIssue(issueNumber: number): string {
  return `${checksRoot()}/issue-${issueNumber}`;
}

/** The protected-path glob (issue #909 / Piece C) covering that directory. */
export function checkDirGlobForIssue(issueNumber: number): string {
  return `${checkDirForIssue(issueNumber)}/**`;
}

/**
 * An issue number the loop can actually use: a positive, exactly-representable
 * integer.
 *
 * THE ONE DEFINITION. Four sites had grown their own copy of this two-clause
 * test — the check locations in `must-fail-first-receipt.ts`,
 * `buildUnitCheckCommand` in `unit-check-path.ts`, the sibling-brief collector
 * in `sibling-briefs.ts`, and `runMain`'s dispatch pool in `main.mts` — and
 * two of them had drifted to `Number.isInteger`, which accepts `1e21` and
 * would interpolate `issue-1e+21` into a directory name and a shell path.
 * Every one of those sites now calls this, so "what counts as an issue number"
 * cannot be answered two ways in one run.
 *
 * `lib/state/gh.ts`'s own argument guard deliberately stays where it is: it
 * belongs to the transport layer, and importing check-writer code into the
 * module that shells to `gh` would point the dependency the wrong way for a
 * three-line test.
 *
 * The predicate is shared; what a caller DOES about a failure is not. A path
 * builder returns `undefined`, a dispatch pool throws, a prompt-context
 * collector drops the entry — those are three correct reactions to one fact,
 * and each is argued where it happens.
 */
export function isUsableIssueNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/**
 * Drop a leading `issue-<N>/` segment from a `checkPath` when it names THE SAME
 * issue whose directory the path is about to be joined under (issue #1235).
 *
 * ## The night this exists for
 *
 * On 2026-09-10 the sibling-check repair road (#1271, since deleted by spec
 * #1334) dispatched the check-writer to amend issue #1058's unit check,
 * handing it the file as a REPO-RELATIVE path (its brief listed
 * `packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts`).
 * The agent answered with the last two segments —
 * `"checkPath": "issue-1058/cross-team-relist-guard.test.ts"` — which the host
 * then joined under a `checkDir` that ALREADY ended `.../issue-1058`, giving
 * `packages/api/src/__checks__/issue-1058/issue-1058/cross-team-relist-guard.test.ts`.
 * No such file exists, so the content scan read nothing, and #1235 — built,
 * reviewed and correct — was thrown away after a full builder and a full
 * reviewer had been paid for.
 *
 * ## Why this STRIPS rather than refuses
 *
 * Neighbouring validation in this folder refuses agent-authored path strings on
 * sight ({@link isSafeCheckRelativePath}, `isSafeUnitCheckPackage`), and the
 * instinct here is to do the same. Two facts decide it the other way.
 *
 *   1. THE SLIP IS UNAMBIGUOUS. `checkDir` is not agent input: the host derives
 *      it from an issue number it already holds. So "the first segment is the
 *      very directory I am about to join under" has exactly one possible
 *      meaning, and repairing it invents nothing. That is the same call
 *      `proof-demand.ts`'s `MARKDOWN_ESCAPE_RE` already makes for a
 *      `Deletes-test:` path a person wrote with a markdown backslash in it:
 *      normalise a clerical shape whose intent is certain, refuse anything
 *      whose intent is not.
 *   2. A REFUSAL HERE COSTS THE TICKET. On the #1271 road a refused envelope
 *      throws the amendment away as `no-repair` and the ticket stops on the
 *      reviewer's original objection — which is the exact failure that road
 *      exists to end. Refusing would rename the failure, not remove it.
 *
 * It is NOT a licence to guess. Only the one redundant segment is dropped, only
 * when it matches THIS issue, and only when something is left after it; a
 * different issue's directory (`issue-999/x.spec.ts` under `issue-1058`) is
 * left exactly as written, so it still fails the existence probe and reports
 * the missing file by name rather than being quietly re-pointed. And a stripped
 * path is still put through its runner's whitelist afterwards — this function
 * hands nothing through, it only rewrites.
 *
 * Total: a non-string, or anything without the redundant prefix, comes back
 * unchanged.
 *
 * TAKES `unknown`, LIKE EVERY OTHER RUNTIME-CHECKING NEIGHBOUR IN THIS FOLDER
 * ({@link isUsableIssueNumber}, {@link isSafeCheckRelativePath},
 * `isSafeUnitCheckRelativePath`). Declaring `string` in and `string` out while
 * guarding `typeof` in the body states something the function does not
 * actually promise — the envelope's fields are agent-authored and reach here
 * unvalidated. Returning `unknown` costs the callers nothing: both doors in
 * `must-fail-first-receipt.ts` hand the result straight to the whitelist
 * predicate for their runner, which narrows it back to `string` before it is
 * ever stored on a {@link CheckLocation}.
 */
export function withoutRedundantIssueDirPrefix(
  issueNumber: unknown,
  checkPath: unknown,
): unknown {
  if (typeof checkPath !== "string") return checkPath;
  if (!isUsableIssueNumber(issueNumber)) return checkPath;
  const prefix = `issue-${issueNumber}/`;
  if (!checkPath.startsWith(prefix)) return checkPath;
  const rest = checkPath.slice(prefix.length);
  // Nothing left after the segment is not a clerical doubling — it is a path
  // naming a directory. Leave it; the whitelist refuses it on its own.
  return rest.length === 0 ? checkPath : rest;
}

/**
 * A `checkPath` value the check-writer's envelope may name, WITHOUT
 * re-trusting the string verbatim: a single path segment (or a shallow
 * nested one) ending in `.spec.ts`, no `..`, no leading `/`, no shell
 * metacharacters. The command this module builds interpolates the value
 * directly into a shell string handed to the sandbox, so this is a
 * WHITELIST, not a blacklist — the same discipline `SAFE_PACKAGE_NAME` in
 * `lib/testing/test-verification.ts` applies to package names.
 *
 * The SHAPE comes from `check-source.ts`, shared with the unit rule in
 * `unit-check-path.ts`; `.spec.ts` versus `.test.ts` is the only difference
 * between the two, and it is the only thing stated here.
 */
const SAFE_CHECK_RELATIVE_PATH = checkRelativePathPattern(".spec.ts");

export function isSafeCheckRelativePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("..") &&
    SAFE_CHECK_RELATIVE_PATH.test(p)
  );
}

/**
 * The command that runs one check file against the app, from the repo root,
 * inside the sandbox. Reused for BOTH directions this design needs the same
 * execution for: the pre-implementer must-fail-first proof (expect red) and
 * the reviewer's post-implementer re-run (expect green) — one command
 * builder, so the two can never silently drift into checking different
 * things.
 *
 * Returns `undefined` when `relativePath` fails {@link isSafeCheckRelativePath}
 * — a caller must treat that as "cannot build a command", never fall back to
 * interpolating the raw value.
 *
 * ## `nonce` — WHY IT IS A PARAMETER AND NOT A `randomUUID()` CALL IN HERE
 *
 * A check written by an agent used to be able to PRINT the very sentence that
 * constituted its own proof — `console.log("1 passed")` was enough to launder
 * an exit-0 all-skipped run into a `match`. The fix (see
 * `lib/harness/tally-signals.ts`) is that the verdict is read from the
 * runner's own machine-readable report, delivered on a line the HOST prints,
 * keyed by a value generated at run time that the check's sha256-locked bytes
 * cannot contain.
 *
 * Taken as an explicit argument, never generated in here, for two reasons that
 * both bite:
 *
 *   1. This function is PURE and unit-tested on its exact output string. A
 *      hidden entropy source would make it untestable and would hide, from
 *      every reader, that a run-time secret is involved at all.
 *   2. The caller is thereby FORCED to decide where the nonce comes from — and
 *      the only correct answer is a fresh {@link newCheckNonce} per RUN. The
 *      must-fail-first proof and the ship-time re-check are two runs with the
 *      builder's entire diff in between, and the check must import real
 *      product code, so builder-authored code executes inside the check's
 *      process. Reusing one nonce across both would hand that code the report
 *      path the ship-time verdict is read from. NEVER persist a built command
 *      and re-run it; persist the inputs and rebuild.
 *
 * An unsafe nonce returns `undefined` for the same reason an unsafe path does:
 * the value is interpolated into a shell string, a filesystem path AND a
 * `RegExp`.
 */
export function buildCheckCommand(
  issueNumber: number,
  relativePath: string,
  nonce: string,
): string | undefined {
  if (!isSafeCheckRelativePath(relativePath)) return undefined;
  if (!isSafeCheckNonce(nonce)) return undefined;
  // With `browserCheckCommand` configured (a package-script style runner such
  // as `pnpm --filter app e2e`), the path it receives is relative to the
  // parent of the checks root; otherwise the default runner gets the
  // repo-relative path.
  const configuredRunner = getProjectConfig().browserCheckCommand;
  const root = checksRoot();
  const rel =
    configuredRunner !== null
      ? `${root.slice(root.lastIndexOf("/") + 1)}/issue-${issueNumber}/${relativePath}`
      : `${root}/issue-${issueNumber}/${relativePath}`;
  const runner = configuredRunner ?? "pnpm exec playwright test";
  const { envAssignments, flags } = CHECK_REPORT_INVOCATION.browser(
    checkReportPathFor(nonce),
  );
  // NO `--` BEFORE `${rel}`. This is not a style choice and re-adding it
  // silently breaks EVERY browser check on the repo. Playwright's CLI is a
  // commander program: a bare `--` ends option parsing, so every token after
  // it becomes a positional test-filter. `${flags}` (`--reporter=line,json`)
  // is therefore never seen, no JSON report is written, and the run's verdict
  // reads `report=missing` → `inconclusive` → `stopped:no-failing-check`, on
  // a check that DID correctly fail. The ticket dies having proven itself.
  //
  // VERIFIED by hand on the loop host, not read off documentation
  // (2026-08-06, playwright 1.56.x, pnpm 10.19):
  //   `npx playwright test -- e2e/checks --reporter=json --list` → default
  //     reporter, and `--list` swallowed too (it started the web server).
  //   `npx playwright test    e2e/checks --reporter=json --list` → JSON on
  //     stdout, no server.
  // pnpm forwards trailing args to the script without needing `--` (pnpm 10;
  // re-verified on pnpm 12.3.4, 2026-10-28, `--list` → JSON), which
  // is why `unit-check-path.ts` has never carried one and its checks report
  // fine. Issue #803 burned two full attempts and quarantined on this.
  // `GRADE_MARK_ENV` is set for BROWSER checks only, and deliberately not in
  // `CHECK_REPORT_INVOCATION`: a unit check has no screen to grade, so a mark
  // file there would only ever read zero and would turn every unit check into
  // a refusal. Issue #925, build step 1.
  return (
    `env CI=1 NO_COLOR=1 FORCE_COLOR=0 ${envAssignments} ` +
    `${GRADE_MARK_ENV}=${gradeMarkPathFor(nonce)} ` +
    `${runner} ${rel}${flags}` +
    runEvidenceEpilogue(nonce, gradeMarkEpilogue(nonce))
  );
}

/**
 * Does the per-issue check directory already contain at least one
 * `*.spec.ts` file, BEFORE the check-writer's pass has run? This is the
 * host's own, independently-observed answer to "is this an inherited check"
 * — Piece J describes a ticket arriving with its own already-proven-red
 * check, committed by a person during a supervised diagnosis session, before
 * the overnight loop ever claims the issue. If those files are already on
 * the branch at the pipeline's very first commit, that is inheritance by
 * DEFINITION, independent of anything the check-writer agent later claims
 * about itself — see the schema module's doc comment on why the agent's own
 * `inherited` field is corroborating evidence, never the sole source of
 * truth.
 *
 * Reads the WORKTREE on disk (not `git show`), matching how
 * `protected-path-restore.ts` and every other per-issue worktree read in
 * this loop works — the sandbox's worktree is a real, host-visible
 * directory. Never throws: an unreadable directory (permissions, a stray
 * non-directory at that path) reads as "no pre-existing files", the safe
 * default that forces the normal, unearned must-fail-first proof rather than
 * silently skipping it.
 */
export function hasPreexistingCheckFiles(
  worktreePath: string,
  issueNumber: number,
): boolean {
  try {
    const dir = path.join(worktreePath, checkDirForIssue(issueNumber));
    if (!existsSync(dir)) return false;
    return walkForSpecFile(dir);
  } catch {
    return false;
  }
}

/**
 * Every helper a check-writer's spec must literally import AND call, in the
 * order a check uses them. Exported so the one enforcement point and its
 * failure message cannot drift from the list itself.
 *
 * WHY BOTH HELPERS ARE LOAD-BEARING, for two DIFFERENT verdicts:
 *
 *   - `waitForGradableScreen` throws the two sentinel errors the harness
 *     classifier (`lib/harness/verdict.ts`) greps for. A hand-rolled wait
 *     produces neither, so — as `graded-screen-check.ts`'s own header warns —
 *     never-settled and claim-mismatch are both misread as an ordinary
 *     wrong-figure `graded-mismatch` instead.
 *   - `gradeScreenText` is the ONLY thing in the codebase that emits
 *     `GRADED_FIGURE_SENTINEL`, and `classifyHarnessRun` requires that
 *     sentinel to be PRESENT before it will return `graded-mismatch`,
 *     falling through to `environment-fault` when it is absent. A check that
 *     waits correctly and then finishes with a plain
 *     `expect(locator).toContainText("$1,234")` therefore files a genuinely
 *     wrong number on screen as an INFRASTRUCTURE fault: the owner is never
 *     asked to break the tie (`environment-fault` maps to
 *     `stopped:could-not-grade`, which does NOT carry `needs-owner-decision`).
 */
export const REQUIRED_GRADED_HELPERS = [
  "waitForGradableScreen",
  "gradeScreenText",
] as const;

/**
 * The module both helpers must be imported FROM. Matched against the tail of
 * an import specifier so the check-writer's own relative depth
 * (`../../lib/graded-screen-check`) and an explicit extension are both fine.
 */
const GRADED_HELPER_MODULE_RE =
  /(?:^|[/\\])graded-screen-check(?:\.[cm]?[jt]s)?$/;

/** Named-binding imports: `import { a, b as c } from "…"`, single or multi-line. */
const NAMED_IMPORT_RE =
  /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/**
 * Which of {@link REQUIRED_GRADED_HELPERS} this check file does not properly
 * use — empty when it imports and calls them all. The single question the
 * check-writer stage asks, so one refusal message can name exactly what is
 * missing instead of two independent yes/no gates each guessing at half the
 * story.
 *
 * ## Two requirements per helper, not one (2026-08-04 review, blocker 5)
 *
 * This started life as a bare `source.includes("gradeScreenText(")`, on the
 * documented ground that a no-op mention would be backstopped by the
 * must-fail-first proof. IT IS NOT, in the ordinary pre-fix case: pre-fix the
 * figure does not exist, so `waitForGradableScreen` throws inside the WAIT,
 * the run exits non-zero, and the proof goes red and mints its receipt
 * without any grading having happened. Post-fix the page settles, the claim
 * matches, the only `gradeScreenText(` in the file sits inside a `//` comment
 * or a string, Playwright exits 0, `classifyHarnessRun` returns `match`, and
 * the ticket ships with the wrong number on screen behind a green screen
 * check. So the guard now requires, per helper:
 *
 *   1. an `import { <helper> } from "…/graded-screen-check"` in this same
 *      file — which ties the name to the ONE implementation that emits the
 *      sentinels, rather than to a local function of the same name; and
 *   2. a `<helper>(` call in text that is neither a comment nor a string
 *      literal.
 *
 * ## What is still open, deliberately
 *
 * This is a cheap scan, not static analysis, and it does not claim otherwise:
 *
 *   - a call inside `if (false) { … }`, or in a function nobody invokes, or
 *     after an early `return`, still counts;
 *   - an un-`await`ed call still counts (the assertion may never be reached);
 *   - `import { gradeScreenText as g }` plus `g(...)` is REFUSED rather than
 *     accepted — the prompt gives one exact call shape, and fail-closed is
 *     the right side to err on;
 *   - a regex literal containing `//` can be misread as the start of a line
 *     comment, which can only ever hide a call (fail-closed).
 *
 * Closing those needs a parser, and a parser is NOT what closed them.
 *
 * ## This check is no longer load-bearing — issue #925, build step 6
 *
 * The paragraph that used to sit here claimed the remaining hole was covered
 * by the must-fail-first proof, because "a call the run never reaches emits
 * no sentinel". That backstop did not exist. `classifyCheckRun` read only
 * spawn failure, timeout, the runner's tally line and the exit code; it never
 * looked for a sentinel and never asked whether grading ran. The claim was
 * removed rather than softened, because a confident comment describing an
 * unfixed gap is the hazard this repo has already logged.
 *
 * What closes it is a RUNTIME MARK, not a reading of the source. The grading
 * helper writes a mark every time it actually executes and its figure
 * matches, and `classifyHarnessRun` refuses to return `match` on a browser
 * check that produced none — see `../harness/grade-mark.ts`.
 *
 * So this function STAYS, deliberately, as a cheap first filter that names a
 * missing helper to the check-writer in words, at authoring time, instead of
 * failing the whole night later. It just decides nothing on its own any more.
 *
 * FAILS CLOSED: an unreadable file (missing, permissions, a stray non-file)
 * reports BOTH as missing, never "nothing to complain about".
 */
export function missingGradedHelperCalls(
  worktreePath: string,
  issueNumber: number,
  relativeCheckPath: string,
): readonly string[] {
  let source: string;
  try {
    source = readFileSync(
      path.join(
        worktreePath,
        checkDirForIssue(issueNumber),
        relativeCheckPath,
      ),
      "utf8",
    );
  } catch {
    return [...REQUIRED_GRADED_HELPERS];
  }
  const { withoutComments, codeOnly } = scanCheckSource(source);
  const imported = gradedHelperImports(withoutComments);
  return REQUIRED_GRADED_HELPERS.filter(
    (h) => !imported.has(h) || !codeOnly.includes(`${h}(`),
  );
}

/**
 * The names imported from the graded-screen-check module in `source`.
 * Aliased bindings (`x as y`) are deliberately NOT collected — see
 * {@link missingGradedHelperCalls}'s "what is still open".
 */
function gradedHelperImports(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(NAMED_IMPORT_RE)) {
    const [, clause, specifier] = m;
    if (!GRADED_HELPER_MODULE_RE.test(specifier)) continue;
    for (const raw of clause.split(",")) {
      const name = raw.trim();
      if (name.length > 0) names.add(name);
    }
  }
  return names;
}

function walkForSpecFile(dir: string): boolean {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (walkForSpecFile(path.join(dir, entry.name))) return true;
    } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      return true;
    }
  }
  return false;
}

/**
 * The check-writer wrote a check that does not properly use one or both of
 * {@link REQUIRED_GRADED_HELPERS} (2026-08-04 review finding #5 + issue #916
 * defect 1; given its own class by the #884 retry decision).
 *
 * WHY IT IS ITS OWN CLASS. It extends `VerdictParseError`, so everything that
 * already treated it as one — the `instanceof` arm in `runCheckWriterStage`,
 * the quarantine path, the run log — keeps working unchanged. What the
 * subclass buys is the ONE distinction issue #884 asked for: this is a
 * CLERICAL miss whose refusal message names the exact missing call, so the
 * agent gets one more go with the thing it needs in hand. An envelope that
 * cannot be read at all is not a clerical miss, has nothing specific to hand
 * back, and keeps its old stop-at-attempt-1 behaviour. Before this, the two
 * were the same error and the first cost the owner a morning on the loop's
 * own error — on what #884 calls "the cheapest retry in the design".
 */
export class CheckWriterMissingGradedHelperError extends VerdictParseError {
  readonly missingHelpers: readonly string[];

  constructor(opts: {
    readonly message: string;
    readonly missingHelpers: readonly string[];
    readonly rawText: string;
    /**
     * The inner cause sentence, when the default composition would not read as
     * English (issue #1235).
     *
     * The default below assumes every entry in `missingHelpers` is a HELPER
     * NAME, and wraps each one as `name(...)` — correct for the two graded
     * helpers this class was minted for. The missing-file arm added by #1235
     * carries a REQUIREMENT instead of a helper name
     * (`CHECK_FILE_ON_DISK_REQUIREMENT`), so the default composed
     * `missing exist at all — no file was found at that path in the
     * worktree(...) call(s)` into the one run log this whole branch exists to
     * make readable. That site passes its own plain sentence instead.
     *
     * Optional, and the class is deliberately NOT split into two: the briefed-
     * retry ladder and the quarantine road both key off
     * `instanceof CheckWriterMissingGradedHelperError`, and a sibling class
     * would change which road a missing file takes.
     */
    readonly causeMessage?: string;
  }) {
    super(
      opts.message,
      new Error(
        opts.causeMessage ??
          `missing ${opts.missingHelpers.map((h) => `${h}(...)`).join(", ")} call(s)`,
      ),
      opts.rawText,
    );
    this.name = "CheckWriterMissingGradedHelperError";
    this.missingHelpers = [...opts.missingHelpers];
  }
}
