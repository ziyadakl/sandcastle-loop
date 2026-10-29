/**
 * WHAT PROOF THIS DIFF OWES — the router (issue #956).
 *
 * The owner's instruction, verbatim: "IF IT AFFECTS A SCREEN OR FLOW, DEMAND
 * PHOTOS. IF IT DOESNT DEMAND DIFFERENT PROOF." This module is that sentence,
 * made into a pure function of the FINISHED diff.
 *
 * ## What it replaces, and why the old instrument was the wrong one
 *
 * Until this landed there were two states, not three: a ticket either wrote a
 * red-first BROWSER check or claimed `NO_SCREEN_APPLIES`, and the claim was
 * re-checked purely by WHICH FOLDER the finished diff touched — anything under
 * `apps/**` or `packages/**` refused it (`findWorkspaceScreenTouches`, now
 * deleted). For a ticket with no screen that is a choice between a photograph
 * of nothing and no proof at all. Backend tickets took the second, or died
 * taking the first: on 2026-08-04 a 71-ticket run halted at ticket 3 having
 * spent $185 to ship 3.
 *
 * The fix is a third state, not a wider exemption. `UNIT_CHECK_WRITTEN` proves
 * a new vitest test red against untouched code with the SAME must-fail-first
 * receipt, the SAME sha256 lock over the check's exact bytes, and the SAME
 * ship-time re-run. Only the runner changes (`check-kind.ts`). So the router's
 * job is not to decide which proof is cheaper — neither is — but which proof
 * the diff is ENTITLED to offer.
 *
 * ## The rule, as a lattice
 *
 * Proof strength is totally ordered: `none` < `unit` < `browser`. A browser
 * check drives the running app end to end, so it proves everything a unit test
 * proves and more; it therefore satisfies any demand. The demand is the
 * STRONGEST any single changed file raises, and the offer must meet or exceed
 * it ({@link proofDemandSatisfied}). That single property is what makes the two
 * routes non-substitutable in the dangerous direction while leaving
 * over-proving always legal: a unit test can never stand in for a photograph,
 * a photograph can always stand in for a unit test, and neither can stand in
 * for nothing.
 *
 * A ticket cannot satisfy both routes at once because an envelope carries
 * exactly one marker ({@link proofOfferedByMarker} is a total function of it),
 * and it cannot pick the cheaper route to dodge proof because the demand is
 * computed from the diff the builder actually produced, never from the claim
 * the check-writer made before a line of it existed.
 *
 * ## Why the test-file exemption is GONE
 *
 * A cheap carve-out shipped first so the queue could run: a diff made of
 * nothing but test files could claim `NO_SCREEN_APPLIES` (`isTestFilePath`,
 * still used here — but now only to answer "can this file render", never to
 * waive proof). It bought six tickets and cost the thing the rule exists for.
 * #820 is literally "four team-isolation tests pass even with the guard
 * deleted": a test that cannot fail is the exact failure red-first catches, and
 * every path in that diff was exempt, so it shipped proven by nothing. #836
 * did ship that way — one file, `no-screen-applies`, no proof, and its whole
 * point was mutation coverage.
 *
 * So a test-only diff now owes a `unit` proof like anything else. There is
 * nothing left to exempt it, because there is finally a route it can take.
 *
 * ## The one carve-out that survives: you cannot be asked to prove the prover
 *
 * {@link browserInstrumentGlobs}. A ticket whose deliverable is repairing a
 * Playwright spec (#927: a spec asserts Finance is visible; Finance is
 * launch-hidden) cannot be handed a red-first check for "this check asserts a
 * stale fact" — the thing under repair IS the instrument, and the demand is
 * circular. That is a genuinely different shape from #820, which repairs
 * ordinary unit coverage and for which a red-first mutation proof exists.
 *
 * The line is drawn around the browser instrument itself, `apps/*​/e2e/**`, and
 * NOT around "test files" generally. Two things it deliberately does not cover:
 *
 *   - `apps/*​/e2e/checks/**` ({@link checksRoot}) is excluded from the
 *     carve-out. Those files are test-SHAPED, but each is some issue's locked
 *     red-first proof. A ticket has no business touching another ticket's
 *     check; if it needs to, that is a stop, not a shortcut.
 *   - Anything under `apps/*​/e2e/` that is not a spec — helpers like
 *     `e2e/lib/practice-world-auth.ts` — rides in on the carve-out. Accepted
 *     knowingly: that code executes only under Playwright and never ships to a
 *     user, and #928's real diff needs it. It is the residual, and it is named
 *     here rather than discovered later.
 *
 * ## What this deliberately gives up, said plainly
 *
 * `docs/specs/2026-08-04-screen-check-design-lock.md` (Piece D) drew the old
 * line at all of `apps/**` + `packages/**` and called the over-photographing
 * deliberate: "wasting seconds is the right way to be wrong". It cited two real
 * bugs — a cash-flow figure that double-counted an agent's $1,000
 * (`packages/api/src/services/cashflow/`, commit `a892c978`) and a chart that
 * drew wrong numbers from a correct answer (`apps/nextjs/.../widgets/`, commit
 * `ea448668`) — and noted every narrower line fails on both.
 *
 * That argument was made when the only alternative to a photograph was
 * NOTHING. It is not the choice any more. Under this module the chart bug still
 * demands a photograph (it is `apps/**`, and it is the case where a correct
 * answer is drawn wrong — only a screen can catch that). The cash-flow bug now
 * demands a unit proof instead, at the seam the bug actually lived in: the
 * shipped fix's own test asserted 5_000 where the buggy one asserted 155_000,
 * so a red-first unit test there catches it precisely.
 *
 * The honest cost: a wrong figure computed in `packages/**` is now proven at
 * the service rather than on the screen, so nothing re-proves that the figure
 * reaches the page. That is a real reduction for that one shape, it is the
 * price of unblocking every backend ticket, and the browser route stays
 * available to any check-writer that wants it.
 *
 * DO NOT read that cost as offset by instrument strictness. An earlier draft of
 * this comment claimed a unit proof was "graded strictly more harshly" than a
 * browser one, and the 2026-08-06 review was right that it had stopped being
 * true: `lib/harness/tally-signals.ts` now puts BOTH runners through the same
 * nonce-keyed `readRunEvidence`, so neither is stricter than the other. The
 * reduction is real, it is unoffset, and the reason to accept it is the trade
 * itself — a unit proof at the service beats what these tickets get today,
 * which is either a photograph nobody can take or no proof at all.
 *
 * Pure by construction — no IO, no clock, no state.
 */

import { pathMatchesGlob } from "../paths/glob.js";
import { ownerAuthoredPart } from "../state/issue-body-sections.js";
import { isTestFilePath } from "../paths/test-file.js";
import { checksRoot } from "./check-path.js";
import { UNIT_CHECKS_ROOT_GLOB } from "./unit-check-path.js";
import type { CheckWriterMarker } from "./schema.js";

/**
 * How strong a proof is. Totally ordered, and the order is the whole design —
 * see {@link proofDemandSatisfied}.
 */
export type ProofDemand = "none" | "unit" | "browser";

/** The lattice, lowest first. Exported so callers can render it in a message. */
export const PROOF_STRENGTH: Readonly<Record<ProofDemand, number>> = {
  none: 0,
  unit: 1,
  browser: 2,
};

/**
 * The two workspaces a change has to be proven in at all. `tooling/**` is
 * deliberately absent, as it always was: the loop, scripts, docs and CI are the
 * things that genuinely have nothing to show, and `tooling/*` is that kind of
 * workspace member (`pnpm-workspace.yaml`).
 */
const PRODUCT_WORKSPACE_GLOBS: readonly string[] = ["apps/**", "packages/**"];

/**
 * Folders that hold executing code the loop leans on but that draw no screen:
 * the loop's own source, the shared tooling config, and the standalone scripts.
 * A JS/TS file here owes a UNIT proof and never a photograph — issue #972 gap
 * 2, the deliberate hole where the loop could rewrite its own proof gate owing
 * nothing (`6fc3556c`, `fcbb4c24` shipped free).
 *
 * The demand is gated on a code EXTENSION, not the folder alone, because these
 * folders also carry documents (`.md`), settings (`.yml`, `Dockerfile`) and
 * loop-written telemetry (`.jsonl`) that owe nothing — the owner rejected a
 * blanket flip precisely because it would refuse 20 doc/data commits to catch
 * 4 real ones. A `.sh`/`.py` script is executing code too, but the vitest unit
 * route cannot grade it red-first, so demanding a test there is a false refusal
 * — those stay out. Accepted cost: a NEW top-level code folder is free until
 * someone adds it here, which the owner accepted as rare.
 */
const CODE_WORKSPACE_GLOBS: readonly string[] = [
  ".sandcastle/**",
  "tooling/**",
  "scripts/**",
];

/**
 * A file the vitest unit route can actually grade red-first: `.ts`, `.mts`,
 * `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`. Anything else in a code folder
 * owes nothing — see {@link CODE_WORKSPACE_GLOBS}.
 */
const UNIT_TESTABLE_CODE_RE = /\.(?:c|m)?[jt]sx?$/;

/**
 * A changed file that can put different pixels in front of a person, so a
 * photograph is both possible and required.
 *
 * Drawn from the real diffs of the two motivating bugs and three representative
 * screen tickets, not from taste:
 *
 *   - `apps/**` — an app is the thing with screens, and its non-rendering
 *     helpers exist to serve them. The chart bug's fix
 *     (`apps/nextjs/src/app/(tracker)/.../config-driven-chart.tsx`) lands here,
 *     and so does `apps/nextjs/src/lib/`, which Piece F names as "code that
 *     only ever executes inside a browser".
 *   - `packages/ui/**` — the shared component library. Commit `d9466c8b`
 *     (`date-period-picker.tsx`) is one change fanning out to app screens.
 *   - `.tsx`/`.jsx`/`.css`/`.scss` anywhere in a package — a React component or
 *     a stylesheet renders wherever it sits. There are 43 `.tsx` files across
 *     `packages/**` today and every one of them draws something.
 *
 * NOT included, deliberately: `packages/api/src/router/**`. It is tempting —
 * the tRPC routers are the surface screens read — but it is where a large share
 * of backend-only tickets land, and forcing a photograph there walks straight
 * back into the failure this ticket exists to fix. The evidence did not require
 * it: neither motivating bug touched a router.
 */
export const SCREEN_OR_FLOW_GLOBS: readonly string[] = [
  "apps/**",
  "packages/ui/**",
  "packages/**/*.tsx",
  "packages/**/*.jsx",
  "packages/**/*.css",
  "packages/**/*.scss",
];

/**
 * The browser instrument itself — the one thing no proof can be demanded for,
 * because the demand would be circular. See the module doc.
 *
 * `apps/*​/e2e/checks/**` is carved back OUT of this by
 * {@link isBrowserInstrumentRepair}: those are other issues' locked proofs, not
 * the instrument being repaired.
 */
export function browserInstrumentGlobs(): readonly string[] {
  // The instrument is the e2e harness folder that holds the checks root.
  const root = checksRoot();
  const slash = root.lastIndexOf("/");
  return slash > 0 ? [`${root.slice(0, slash)}/**`] : [];
}

/** Every issue's locked browser check. Never carved out, however test-shaped. */
const checksRootGlob = (): string => `${checksRoot()}/**`;

export interface ProofDemandResult {
  /** The strongest proof any single changed file demands. */
  readonly demand: ProofDemand;
  /**
   * The files that forced `browser`, and only those — so a stop message can
   * name the exact evidence rather than gesture at the diff.
   */
  readonly screenOrFlowTouches: readonly string[];
  /** Every file that owed any proof at all. The evidence behind `unit`. */
  readonly productTouches: readonly string[];
}

/**
 * Is this path part of the browser instrument being repaired, rather than
 * product code or another issue's locked proof?
 */
function isBrowserInstrumentRepair(filePath: string): boolean {
  if (pathMatchesGlob(filePath, checksRootGlob())) return false;
  return browserInstrumentGlobs().some((g) => pathMatchesGlob(filePath, g));
}

/**
 * What proof does this FINISHED diff owe?
 *
 * Total and pure, mirroring `detectProtectedPathViolations`'s contract
 * (`lib/paths/protected-paths.ts`): a non-array input, or a non-string, blank
 * or `..`-bearing entry, is SKIPPED rather than thrown on. The caller is a
 * ship-time gate on an overnight run, where a telemetry-adjacent throw can kill
 * a night's work for a reason unrelated to the gate actually working.
 *
 * Note there is no `guttedFiles` parameter, unlike the guard this replaces. It
 * needed one because its test-file exemption had to fail closed on a removal;
 * with no exemption left there is nothing for a removal to change here. Removal
 * is now its own, stronger gate that applies under EVERY route — see
 * {@link removedTestFiles}.
 */
export function requiredProofForDiff(
  changedFiles: readonly string[],
): ProofDemandResult {
  if (!Array.isArray(changedFiles)) {
    return { demand: "none", screenOrFlowTouches: [], productTouches: [] };
  }
  const productTouches: string[] = [];
  const screenOrFlowTouches: string[] = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || file.length === 0) continue;
    // A `..` anywhere makes every glob claim below meaningless. Git cannot put
    // one in a tree path, so no caller reaches this today; it costs one line to
    // keep it that way if a future caller feeds this something less
    // disciplined than a diff. Same guard `isTestFilePath` keeps.
    if (file.split("/").includes("..")) continue;
    if (!PRODUCT_WORKSPACE_GLOBS.some((g) => pathMatchesGlob(file, g))) {
      // Not in a product workspace, but it may be executing loop/tooling/script
      // code that owes a unit proof (#972 gap 2). These folders draw no screen,
      // so the file joins `productTouches` (owes `unit`) and never
      // `screenOrFlowTouches`. Only JS/TS code counts; docs, settings and
      // telemetry inside the same folders owe nothing.
      if (
        UNIT_TESTABLE_CODE_RE.test(file) &&
        // A `.d.ts` declaration file carries no runnable code, so no red-first
        // unit test can grade it — demanding one would be a false refusal.
        !file.endsWith(".d.ts") &&
        CODE_WORKSPACE_GLOBS.some((g) => pathMatchesGlob(file, g))
      ) {
        productTouches.push(file);
      }
      continue;
    }
    if (isBrowserInstrumentRepair(file)) continue;
    productTouches.push(file);
    // Test files never render, whatever folder they sit in. Without this a
    // `forecast-widget.test.tsx` beside its component would escalate a
    // unit-provable diff into a photograph nobody can take.
    if (isTestFilePath(file)) continue;
    if (SCREEN_OR_FLOW_GLOBS.some((g) => pathMatchesGlob(file, g))) {
      screenOrFlowTouches.push(file);
    }
  }
  const demand: ProofDemand =
    screenOrFlowTouches.length > 0
      ? "browser"
      : productTouches.length > 0
        ? "unit"
        : "none";
  return { demand, screenOrFlowTouches, productTouches };
}

/**
 * What strength does this outcome actually PROVE?
 *
 * `undefined` for the two markers that stop the ticket before it can ship —
 * `ALREADY_BUILT` and `NEEDS_WORLD_DATA` never reach a diff, so asking what
 * they prove is a category error, and answering `"none"` would quietly let one
 * of them satisfy a `none` demand if a future caller reached here by mistake.
 *
 * Exhaustive by construction: the `switch` has no `default`, so adding a sixth
 * marker to `CHECK_WRITER_MARKERS` fails to compile here rather than silently
 * defaulting to some strength nobody chose.
 */
export function proofOfferedByMarker(
  marker: CheckWriterMarker,
): ProofDemand | undefined {
  switch (marker) {
    case "CHECKS_WRITTEN":
      return "browser";
    case "UNIT_CHECK_WRITTEN":
      return "unit";
    case "NO_SCREEN_APPLIES":
      return "none";
    case "ALREADY_BUILT":
    case "NEEDS_WORLD_DATA":
      return undefined;
  }
}

/**
 * Does the proof on offer meet or exceed what the diff demands?
 *
 * The one asymmetry that matters: a photograph always satisfies a unit demand
 * (it drives the real app, so it proves everything the unit test would and
 * more), and a unit test NEVER satisfies a photograph demand. Over-proving is
 * always legal; under-proving never is.
 */
export function proofDemandSatisfied(
  offered: ProofDemand,
  demanded: ProofDemand,
): boolean {
  return PROOF_STRENGTH[offered] >= PROOF_STRENGTH[demanded];
}

/**
 * Words that mean a file GOES. Deliberately narrow: this is the half of the
 * pre-authorisation rule that stops an ordinary mention ("repair
 * `isolation.test.ts`", "add three cases to it") from reading as permission to
 * delete the file instead. `replace`/`move` are absent on purpose — a ticket
 * that says coverage MOVES somewhere is describing the surviving file, not the
 * doomed one.
 */
const DELETION_INTENT_RE = /\b(?:delet\w*|remov\w*|drop|drops|dropped|dropping|gone)\b/i;

/**
 * A sentence carrying any of these authorises NOTHING, whatever else it says.
 *
 * #850's own paragraph is why: it names the file to delete and, two sentences
 * later, names a second test file specifically to forbid touching it —
 * "**`archive-codec.test.ts` itself is NOT to be deleted or emptied.**" That
 * sentence is full of deletion words. Rather than parse around the negation,
 * the whole sentence is discarded: the cost of being wrong here is one ticket
 * stopping for a person to look at, and the cost of being wrong the other way
 * is deleted coverage shipping unlooked-at.
 *
 * `no` is NOT in the list, and that is not an oversight — "because it tests a
 * module that will no longer exist" is #850's actual justification for the
 * deletion it is authorising.
 */
const NEGATION_RE =
  /\b(?:not|never|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|shouldn't|mustn't)\b/i;

/**
 * The canonical form a ticket author should write. Recognised explicitly rather
 * than left to {@link DELETION_INTENT_RE} so there is one spelling that is
 * guaranteed to work and cannot be broken by a later change to the prose
 * heuristic. Hyphen or space, any case, one path per line.
 */
const DELETION_DIRECTIVE_RE = /^\s*(?:[-*]\s*)?deletes?[\s-]*tests?\s*:(.*)$/i;

/**
 * One segment of a repo-relative path. Either ordinary path characters, or a
 * WHOLE segment wrapped in parentheses — Next.js App Router route groups,
 * `apps/nextjs/src/app/(tracker)/…`, which this repo uses on every screen.
 *
 * ⚠️ The parenthesised alternative is load-bearing, and it is deliberately
 * narrow. Until 2026-09-04 parentheses were excluded outright as "markdown
 * around a path", which meant NO test file under any screen in this app could
 * ever be pre-authorised: the token broke at `(tracker)` and
 * {@link preauthorizedTestDeletions} answered with a truncated path that
 * matched nothing. Issue #1038 named its doomed file in full, in the body,
 * before the run — and the gate stopped it anyway, after a $26 night.
 *
 * It stays narrow because the exclusion it relaxes was right about prose. Only
 * `(segment)` — an opening paren, ordinary path characters, a closing paren,
 * nothing else between — counts. Prose like `(see lib/state/gh.ts)` still
 * yields `lib/state/gh.ts`, and a markdown link `[x](path/to/a.test.ts)` still
 * yields `path/to/a.test.ts`, exactly as before: in both, the paren is not
 * closed at the end of its own segment, so the alternative cannot fire.
 */
const PATH_SEGMENT_SRC = "(?:\\([A-Za-z0-9_@.+-]+\\)|[A-Za-z0-9_@.+-]+)";

/** A repo-relative path token: at least one `/` joining {@link PATH_SEGMENT_SRC}. */
const PATH_TOKEN_RE = new RegExp(
  `${PATH_SEGMENT_SRC}(?:\\/${PATH_SEGMENT_SRC})+`,
  "g",
);

/**
 * Markdown backslash-escapes, as a ticket author's editor writes them. GitHub
 * renders `\_` as `_`, so `tracker/\_components/forms/a.test.tsx` LOOKS like
 * the real path to the person who wrote it and to anyone reading the issue.
 * The backslash is not a path character, so the token broke there too — the
 * second half of the same #1038 failure. Unescaped before matching, never
 * after: a path is extracted from the text a person meant, not the bytes their
 * formatter emitted.
 */
const MARKDOWN_ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!~|])/g;

/**
 * A region of the issue body the LOOP wrote, not a person: everything between
 * a `<!-- sandcastle:<name>:start -->` marker and its `:end` partner — cut out
 * by {@link ownerAuthoredPart}, which now lives in
 * `lib/state/issue-body-sections.ts` because the `Blocked-by:` gate needs the
 * identical split (see that module's header).
 *
 * ⚠️ THE MOST IMPORTANT LINE IN THIS FILE, and the reason "the issue body is
 * owner-authored" needed qualifying. It is not entirely: `applyStopReport` and
 * `applyScreenCheckWatchReport` (`lib/state/stop-reasons.ts`) append machine
 * sections to the BODY, and the stop report this very gate produces reads
 * "the finished diff DELETES or empties 1 test file(s) ...: <exact path>."
 * That is a deletion word and an exact path in one sentence, so a ticket
 * stopped once would have authorised its own deletion on the next attempt —
 * the gate forging its own permission slip out of its own alarm.
 */

/**
 * Split into SENTENCES, not lines. #850's authorisation and its "must NOT be
 * deleted" counterpart share one markdown line, so a line-scoped rule would
 * have to choose between authorising both and authorising neither.
 *
 * The lookbehind allows markdown emphasis to close AFTER the terminator
 * (`…unannounced.**`), which is exactly how that paragraph is written; without
 * it the two halves never separate.
 */
function sentencesOf(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?][)\]"'`*_]*)\s+/))
    .filter((s) => s.trim() !== "");
}

/**
 * Every `/`-joined path token in `text`, with markdown backslash-escapes undone
 * FIRST and nothing else done to them — trailing punctuation is left on, so the
 * caller decides what counts as part of a path.
 *
 * ## Why this is exported rather than kept inside {@link testPathsIn}
 *
 * The sibling-check road (issue #1271) has to find another ticket's check file
 * inside a REVIEWER's output rather than inside an issue body, and it needs the
 * identical tokeniser: the same route-group segments (`(tracker)`), the same
 * markdown unescaping, the same refusal to see a path where there is no `/`.
 * A second copy would be the worst shape available — the #1038 truncation bug
 * would have been fixed in one and left standing in the other. So there is one
 * body, `testPathsIn` is built on it, and the deletion parser's answers are
 * byte-identical to what they were before the lift.
 *
 * Total and never-throwing, like everything else here.
 */
export function pathTokensIn(text: string): readonly string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const unescaped = text.replace(MARKDOWN_ESCAPE_RE, "$1");
  return unescaped.match(PATH_TOKEN_RE) ?? [];
}

/** Every test-shaped path named in `text`, markdown and punctuation stripped. */
function testPathsIn(text: string): readonly string[] {
  const found: string[] = [];
  for (const raw of pathTokensIn(text)) {
    const candidate = raw.replace(/[.,;:!?)\]]+$/, "");
    // `isTestFilePath` already refuses a `..`-bearing path, which is what makes
    // every segment claim downstream meaningful.
    if (isTestFilePath(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Which test files has the ISSUE BODY already agreed may go?
 *
 * ## Why this exists
 *
 * {@link removedTestFiles} is a hard stop with one justification: "removing a
 * test may well be right for this ticket; it needs a person to agree." On
 * 2026-08-06 it stopped #850 — a ticket whose acceptance criteria named the
 * doomed file by its full path, named its line count, and named what replaces
 * its coverage. The person had agreed, in writing, before the run started. A
 * gate that asks a question the ticket already answered is not carefulness, it
 * is a night of the loop spent stopping finished work.
 *
 * ## Why it cannot be turned against the gate
 *
 * Four properties, and every one of them is load-bearing.
 *
 *  1. THE SOURCE IS THE OWNER-AUTHORED PART OF THE ISSUE BODY. Nothing the
 *     builder authors — commit messages, PR text, code comments, its own report
 *     — is read here, and the caller fetches the body when the issue is CLAIMED,
 *     before any agent runs, so an implementer with `gh` in its sandbox cannot
 *     write its own permission slip mid-run. The body is not entirely a
 *     person's, either: the loop appends machine sections to it, and this gate's
 *     OWN stop report names the deleted path beside the word "DELETES". Those
 *     sections are cut out first — `MACHINE_SECTION_RE` in
 *     `lib/state/issue-body-sections.ts`.
 *
 *     THE RESIDUAL, named rather than left to be found: an agent working ticket
 *     A could in principle edit ticket B's body before B is claimed. Every agent
 *     in this loop shares one `gh` credential, so that is a property of the
 *     loop's trust boundary rather than of this rule, and no parser here can
 *     close it. What IS closed is the realistic case — a ticket authorising its
 *     own deletion, mid-run or on a retry.
 *  2. THE PATH MUST BE EXACT. A basename, a suffix, or a directory authorises
 *     nothing; `__tests__/tar.test.ts` does not clear
 *     `packages/api/.../__tests__/tar.test.ts`. This is what keeps one
 *     authorisation from covering a file the ticket never considered.
 *  3. THE SENTENCE MUST SAY THE FILE GOES. Tickets name test files constantly —
 *     usually as the thing to REPAIR. A bare mention is not consent
 *     ({@link DELETION_INTENT_RE}).
 *  4. A NEGATED SENTENCE AUTHORISES NOTHING ({@link NEGATION_RE}), because the
 *     sentence most likely to name a test file and the word "deleted" in the
 *     same breath is the one forbidding it.
 *
 * Only TEST paths are returned: this feeds a test-coverage stop, and a ticket
 * saying it deletes a source file must not widen anything.
 *
 * Total and never-throwing, like everything else here. A non-string body — the
 * shape a failed `gh` fetch produces — authorises nothing, which is the
 * fail-closed direction: silence from the tracker is not consent.
 */
export function preauthorizedTestDeletions(
  issueBody: string | null | undefined,
): string[] {
  if (typeof issueBody !== "string" || issueBody.length === 0) return [];
  // FIRST, before a word of it is read: cut out what the LOOP wrote into the
  // body. See `MACHINE_SECTION_RE` (`lib/state/issue-body-sections.ts`) — the
  // stop report this gate produces names the deleted path in a sentence full
  // of deletion words.
  const body = ownerAuthoredPart(issueBody);
  const authorized: string[] = [];
  const seen = new Set<string>();
  const admit = (paths: readonly string[]): void => {
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      authorized.push(p);
    }
  };
  for (const line of body.split(/\r?\n/)) {
    const directive = DELETION_DIRECTIVE_RE.exec(line);
    if (directive !== null) admit(testPathsIn(directive[1] ?? ""));
  }
  for (const sentence of sentencesOf(body)) {
    if (NEGATION_RE.test(sentence)) continue;
    if (!DELETION_INTENT_RE.test(sentence)) continue;
    admit(testPathsIn(sentence));
  }
  return authorized;
}

/**
 * Which test files did this diff DELETE or empty out? A hard stop under EVERY
 * route, not just the no-proof one.
 *
 * Writing or repairing a test changes no screen; DELETING one removes the very
 * coverage that made any of this safe, and emptying one out is the same act
 * with the file left behind.
 *
 * They are both removals, but they do NOT read alike in numstat, and that gap
 * WAS the hole — an earlier draft of this comment asserted they did, and the
 * adversarial pass proved it wrong twice. A 200-case suite replaced by
 * `it("noop", () => {})` prints `1<TAB>200<TAB>path`, so "nothing added" is
 * false; and a `.gitattributes` `binary` mark prints `-<TAB>-<TAB>path` for a
 * file that was `git rm`-ed outright, so "something removed" is false too.
 * `guttedFilesBetween` therefore answers from three questions unioned —
 * existence, nothing-added, and how much of the file survived — see
 * `lib/review/coverage-removal.ts`.
 *
 * WHY IT APPLIES UNDER EVERY ROUTE NOW. Under the old guard this lived inside
 * the `NO_SCREEN_APPLIES` branch, so a ticket that wrote a browser check could
 * still delete the 117-file Playwright regression suite under `apps/nextjs/e2e/`
 * and ship: the protected-path lock covers only the issue's own check
 * directory, the ship-time browser run only runs the ONE check file, and
 * `verifyTestRun` runs vitest, whose include is `src/**` — so Playwright specs
 * are never loaded and go green by being absent. Passing one check proves
 * nothing about the coverage the same diff removed.
 *
 * `null` — not `[]` — when git could not be asked. The distinction is the whole
 * point: an empty list is a CLAIM that nothing was removed, and only a real git
 * answer earns it. A caller must decide what to do with "unknowable" rather
 * than being handed a false all-clear.
 *
 * Scoped to `apps/**` and `packages/**`, the same two workspaces everything
 * else here is about. A deleted `scripts/**` or `.sandcastle/**` test is not
 * caught — that is where the gate looks, not what is acceptable.
 *
 * `issueBody` is the ticket's own text, and a file it named as an intended
 * deletion is dropped from the answer — see {@link preauthorizedTestDeletions}
 * for the four properties that keep that from being a way through the gate.
 * OMITTING it (or passing `null`, the shape a failed `gh` fetch produces)
 * authorises nothing, so every existing caller keeps the behaviour it had.
 *
 * IT NARROWS ONLY THE KNOWN CASE. A `null` removal set is still `null` whatever
 * the body says: "the ticket agreed to lose this file" is not an answer to "git
 * could not be asked what was lost".
 */
export function removedTestFiles(
  changedFiles: readonly string[] | null,
  guttedFiles: readonly string[] | null,
  issueBody?: string | null,
): string[] | null {
  // BOTH unknowable inputs answer `null`, not `[]`. Returning the empty list
  // for a malformed changed-file list was the one place this function handed
  // back the all-clear its own contract forbids (2026-08-06 review).
  if (!Array.isArray(changedFiles)) return null;
  if (!Array.isArray(guttedFiles)) return null;
  const gutted = new Set(
    guttedFiles.filter((f): f is string => typeof f === "string"),
  );
  const preauthorized = new Set(preauthorizedTestDeletions(issueBody));
  const hits: string[] = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || file.length === 0) continue;
    if (!gutted.has(file)) continue;
    if (preauthorized.has(file)) continue;
    if (!PRODUCT_WORKSPACE_GLOBS.some((g) => pathMatchesGlob(file, g))) continue;
    if (isTestFilePath(file)) hits.push(file);
  }
  return hits;
}

/**
 * Every test file in this diff that sits in a product workspace — the coverage
 * an UNKNOWABLE removal set could be hiding the destruction of.
 *
 * ## Why this exists, and what it replaces
 *
 * `no-screen-guard.ts` (issue #969, now deleted) drew a line this module has to
 * keep: "a git hiccup makes the removal set unknowable, and an unknowable
 * removal set exempts NOTHING." Its version of that rule fell out for free —
 * test files were exempt from the guard, so withdrawing the exemption when the
 * removal set was `null` turned every test file into a stop.
 *
 * The router has no test-file exemption left to withdraw, so the same
 * protection has to be stated. And it is NOT redundant with
 * {@link requiredProofForDiff}, which is the trap: the browser instrument
 * (`apps/*​/e2e/**`) is carved OUT of the demand entirely, so a diff that
 * deletes a Playwright spec raises no demand at all and is caught by
 * {@link removedTestFiles} alone. When the removal set is unknowable, nothing
 * else in this module is looking at that file.
 *
 * SCOPED TO DIFFS THAT ACTUALLY CARRY TEST MATERIAL, which is what bounds the
 * cost of failing closed here: a diff with no test file in it has no coverage
 * to have lost, so an unaskable git costs it nothing.
 *
 * Same total, never-throwing contract as everything else here.
 */
export function unprovableTestFiles(
  changedFiles: readonly string[] | null,
): string[] {
  if (!Array.isArray(changedFiles)) return [];
  const hits: string[] = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || file.length === 0) continue;
    if (file.split("/").includes("..")) continue;
    if (!PRODUCT_WORKSPACE_GLOBS.some((g) => pathMatchesGlob(file, g))) continue;
    if (isTestFilePath(file)) hits.push(file);
  }
  return hits;
}

/**
 * Every check directory in the repo, browser and unit. The unit side cannot
 * name a literal root — it is per-package — which is exactly what
 * {@link UNIT_CHECKS_ROOT_GLOB} is for.
 */
const lockedCheckGlobs = (): readonly string[] => [
  checksRootGlob(),
  UNIT_CHECKS_ROOT_GLOB,
];

/**
 * Which changed files are ANOTHER ticket's locked red-first proof?
 *
 * Test-SHAPED, but none of it is test material: each file is some issue's live
 * must-fail-first check, sha256-locked, and the thing every other gate here is
 * measured by. A ticket has no business touching one; if it needs to, that is a
 * stop for a person, not a shortcut. Carried across from `no-screen-guard.ts`
 * (issue #969), where it was one of the two hits that are never waived.
 *
 * THIS ISSUE'S OWN DIRECTORIES ARE EXCLUDED, and that exclusion is what makes
 * the rule usable at all rather than a blanket ban. The old guard ran only
 * inside the `NO_SCREEN_APPLIES` branch, where by construction the ticket had
 * written no check, so it never had to draw this line. The router runs under
 * EVERY marker — and a `CHECKS_WRITTEN` ticket necessarily adds files under
 * `apps/nextjs/e2e/checks/issue-<N>/`, a `UNIT_CHECK_WRITTEN` one under
 * `<pkg>/src/__checks__/issue-<N>/`. A rule that could not tell those apart
 * would stop every check-writing ticket in the queue.
 *
 * Ownership is decided on the DIRECTORY THIS RUN'S CHECK-WRITER ACTUALLY
 * CREATED (`result.checkLocation.checkDir`), not on `issue-<N>` derived from the
 * number — issue #972 gap 5. The old key skipped ANY `issue-<N>` directory,
 * so a re-dispatch of #N whose check-writer this run returns `NO_SCREEN_APPLIES`
 * (creating no directory) could still EDIT an `issue-<N>` check that an earlier
 * run left on `main`, and the exclusion waved it through. Keying on the real
 * created directory means: created a directory this run → its own output is
 * excluded; created none → nothing is excluded, so touching an old locked check
 * is caught. `ownCheckDirs` is empty (or `null`/`undefined`) exactly when this
 * ticket owns no check directory.
 *
 * IT IS A LIST (#1361) because one ticket can own two directories — #1310 had
 * `apps/nextjs/e2e/checks/issue-1310/` AND `packages/api/src/__checks__/issue-1310/`
 * — and because a ticket resumed from its saved work owns the `issue-<N>`
 * directories that saved work created, though this run's check-writer
 * created none. A ticket owns exactly the directories locked for it
 * (`ctx.protectedPathGlobs` in `main.mts`); that is decided there, never here.
 *
 * Both check layouts nest the directory as real path segments, so a
 * segment-prefix comparison (append `/`) cannot be fooled by a sibling prefix
 * (`.../issue-9560/x` is not inside `.../issue-956`).
 *
 * ## The one authorised exception: `authorizedOlderTestPaths`
 *
 * A ticket that changes a rule the product already has can turn an OLDER
 * ticket's check red without doing anything wrong — #1235 turned three cases of
 * #1058's cross-Team relist guard red on 2026-09-10 by adding exactly the
 * address check its own ticket asked for. The builder or the fixer may then
 * edit that older test, and the ship gate's older-test check
 * (`verifyOlderTestEdits` in `main.mts`, spec #1334 SH) decides whether the
 * edit stands; the files it allowed have to be let through here.
 *
 * Four properties keep that from being a way through the lock:
 *
 *  1. IT IS AN EXACT-PATH ALLOWLIST. A directory, a prefix or a basename
 *     authorises nothing — so authorising one case file never quietly
 *     authorises the file beside it.
 *  2. AN ENTRY MUST ITSELF BE A LOCKED CHECK PATH. Handing in an ordinary
 *     source file opens nothing, in either direction: it was never a hit, and
 *     it cannot make one.
 *  3. A `..`-BEARING ENTRY IS IGNORED, the same guard every path claim here
 *     makes meaningful.
 *  4. THE CALLER'S LIST IS THE RUN'S OWN, not an agent's. It is what the
 *     host's older-test check allowed after running the original test red and
 *     the edited one green, and measuring the case counts itself. Same
 *     discipline as `preauthorizedTestDeletions`: the permission is computed
 *     from what the host already holds, never read out of agent text.
 *
 * Omitting the argument (or passing `null`) authorises nothing, so every
 * existing caller keeps exactly the behaviour it had.
 */
export function lockedCheckTouches(
  changedFiles: readonly string[] | null,
  ownCheckDirs: readonly string[] | null | undefined,
  authorizedOlderTestPaths?: readonly string[] | null,
): string[] {
  if (!Array.isArray(changedFiles)) return [];
  const ownPrefixes = (Array.isArray(ownCheckDirs) ? ownCheckDirs : [])
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map((d) => `${d}/`);
  const authorized = new Set<string>();
  if (Array.isArray(authorizedOlderTestPaths)) {
    for (const p of authorizedOlderTestPaths) {
      if (typeof p !== "string" || p.length === 0) continue;
      if (p.split("/").includes("..")) continue;
      // An entry that is not itself a locked check path can authorise nothing
      // — it was never a hit to begin with.
      if (!lockedCheckGlobs().some((g) => pathMatchesGlob(p, g))) continue;
      authorized.add(p);
    }
  }
  const hits: string[] = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || file.length === 0) continue;
    const segments = file.split("/");
    if (segments.includes("..")) continue;
    if (!lockedCheckGlobs().some((g) => pathMatchesGlob(file, g))) continue;
    if (ownPrefixes.some((own) => file.startsWith(own))) continue;
    if (authorized.has(file)) continue;
    hits.push(file);
  }
  return hits;
}
