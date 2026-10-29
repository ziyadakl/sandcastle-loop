/**
 * The durable receipt that a check-writer's check is not owed a
 * must-fail-first proof, and WHY (issue #916 defect 2; the "why" half added
 * by the 2026-08-04 review, blocker 4). Ordinarily the why is "the loop ran
 * the proof against the code as it stood before the builder touched it, and
 * it failed" — but two other provenances mint one too, and the record says
 * which: see {@link MustFailFirstBasis}.
 *
 * ## The hole this fills
 *
 * A ticket that is checkpointed mid-flight and later resumed used to skip the
 * must-fail-first proof entirely, silently:
 *
 *   1. A checkpoint commits the WHOLE worktree, check file included
 *      (`../state/branch-checkpoint.ts`'s `commitWorktreeCheckpoint`).
 *   2. On resume the per-issue branch is force-pointed at that ref, so the
 *      check file is on disk before the check-writer pass even starts.
 *   3. `hasPreexistingCheckFiles` therefore reports "inherited" — which is a
 *      correct observation of the FILE, but was being read as a claim about
 *      the PROOF. The whole red-before-green proof sits behind
 *      `if (!inherited)`, and `mustFailFirstUnproven` short-circuits on
 *      `inherited` too, so neither the one-retry ladder nor the
 *      `stopped:no-failing-check` stop could fire.
 *   4. Nothing carried the earlier proof forward, so the ticket shipped on a
 *      check nobody had ever seen fail — while `review-prompt.md` told the
 *      reviewer, in as many words, that it "was proven to FAIL against the
 *      untouched code".
 *
 * ## Why a receipt, and not simply re-running the proof
 *
 * Re-running is not available on the resume path and never will be: by the
 * time a checkpoint exists, the builder has usually already changed the code,
 * so "run the check against untouched code" has no untouched code left to run
 * against. A re-run there would come back GREEN for the most honest possible
 * reason — the fix works — and stop a healthy ticket. The proof has to travel.
 *
 * ## Why it travels as a file inside the check directory
 *
 * Three properties, none of which a host-local record has:
 *
 *   - It is committed by the same `git add -A` the checkpoint already does,
 *     and pushed with the WIP ref, so it survives a resume on a DIFFERENT
 *     machine — which is the only situation the bug is reachable in
 *     (`SANDCASTLE_CROSS_HOST_SYNC`).
 *   - It sits inside the per-issue check directory, which `runCheckWriterStage`
 *     adds to `protectedPathGlobs` the moment the check-writer stage returns
 *     (`checkDirGlobForIssue` on the browser route, `unitCheckDirGlobFor` on
 *     the unit one), so the builder cannot forge one or delete one without
 *     tripping the protected-path lock (issue #909).
 *   - A human triaging a stopped ticket can open it and read, in plain JSON,
 *     which check was proven, against which content, and when.
 *
 * It is a `.json`, so neither runner's discovery ever mistakes it for a test:
 * Playwright collects `.spec.ts`, and every package's vitest `include` is
 * `src/**\/*.{test,spec}.{ts,tsx}`. `hasPreexistingCheckFiles` never counts it
 * as a check either.
 *
 * ## Why the check's CONTENT is hashed, not just its name
 *
 * A resumed check-writer pass may rewrite its own check. A receipt that
 * pinned only the filename would then waive the proof for a file nobody has
 * ever run. The hash makes the receipt a statement about a specific piece of
 * text: change one character of the check and the receipt stops applying, and
 * the proof runs again.
 *
 * ## Why every function here takes a {@link CheckLocation} (issue #956)
 *
 * There are now TWO runners, and each has its own check directory and its own
 * legal filename: `apps/nextjs/e2e/checks/issue-<N>/x.spec.ts` for the browser,
 * `<packages/pkg>/src/__checks__/issue-<N>/x.test.ts` for the unit runner. A
 * receipt must live inside ITS check's directory, next to ITS check — a
 * receipt in the browser directory naming a unit check has nothing to lock,
 * because the file it hashes is not there. It would then fail to write (and
 * cost a re-proof), or, worse, read back as a valid receipt whose sha never
 * matches anything, quietly forcing the proof to re-run every resume.
 *
 * These four functions used to take `(worktreePath, issueNumber, checkPath)`
 * and hardcode `checkDirForIssue(issueNumber)`. Adding a `kind` parameter
 * beside `checkPath` would have made the mixed pair merely WRONG rather than
 * IMPOSSIBLE: nothing would stop `(kind: "unit", checkPath: "x.spec.ts")`, or
 * a unit kind with no package to hang the directory off.
 *
 * THE MIXED PAIR IS NOW UNREPRESENTABLE, and here is exactly why. A
 * `CheckLocation` has no public constructor — the only two ways to obtain one
 * are {@link browserCheckLocation} and {@link unitCheckLocation}, and each
 * takes precisely the arguments ITS kind needs and no others:
 *
 *   - `browserCheckLocation(issueNumber, checkPath)` has no `packageDir`
 *     parameter at all, so a browser location cannot be pointed at a package;
 *     and it validates `checkPath` with `isSafeCheckRelativePath`, which
 *     accepts ONLY `.spec.ts`.
 *   - `unitCheckLocation(issueNumber, packageDir, checkPath)` REQUIRES a
 *     `packageDir`, whitelists it with `isSafeUnitCheckPackage` (never an
 *     app), and validates `checkPath` with `isSafeUnitCheckRelativePath`,
 *     which accepts ONLY `.test.ts`.
 *
 * The `kind` and the `checkDir` on the resulting value are therefore DERIVED
 * from which door was used, never passed in — there is no argument a caller
 * could get wrong, and no combination of arguments that names a directory
 * from one runner and a path from the other. Both constructors return
 * `undefined` rather than throwing when anything fails, so an unusable
 * envelope is a value a caller must handle, not an exception thrown out of a
 * check-writer stage mid-run.
 *
 * The whitelist therefore still runs BEFORE any `path.join` — it just runs
 * once, at construction, instead of on every entry point. That is the same
 * path-traversal guard, moved to the one place it cannot be forgotten.
 *
 * Every function here is total — a missing, unreadable, malformed, forged or
 * stale receipt reads as "NOT proven", which forces the proof rather than
 * skipping it.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CheckKind } from "./check-kind.js";
import {
  checkDirForIssue,
  checkDirGlobForIssue,
  isSafeCheckRelativePath,
  isUsableIssueNumber,
  withoutRedundantIssueDirPrefix,
} from "./check-path.js";
import {
  isSafeUnitCheckPackage,
  isSafeUnitCheckRelativePath,
  unitCheckDirFor,
  unitCheckDirGlobFor,
} from "./unit-check-path.js";

/** Filename of the receipt, inside the per-issue check directory. */
export const MUST_FAIL_FIRST_RECEIPT_FILENAME = "must-fail-first-proof.json";

/**
 * One VALIDATED check: which runner grades it, which issue owns it, the
 * repo-relative directory it lives in, and its filename within that directory.
 *
 * Obtainable only through {@link browserCheckLocation} or
 * {@link unitCheckLocation} — see the module doc for why that is what makes a
 * browser-directory/unit-path pair unrepresentable rather than merely wrong.
 * Everything on it has already passed its runner's whitelist, so no function
 * taking one needs to re-validate before joining paths.
 */
export interface CheckLocation {
  readonly kind: CheckKind;
  readonly issueNumber: number;
  /** Repo-relative, POSIX-separated per-issue check directory. */
  readonly checkDir: string;
  /**
   * The protected-path glob (issue #909 / Piece C) covering that directory —
   * `checkDirGlobForIssue(...)` on the browser route, `unitCheckDirGlobFor(...)`
   * on the unit one.
   *
   * Carried HERE rather than re-derived by the caller because the unit form
   * needs the host package, which is an input to this constructor and nowhere
   * on the resulting value. A caller holding a `CheckLocation` and reaching
   * for a glob would otherwise have to branch on `kind` and re-supply a
   * `packageDir` it may not still have — and the branch that gets it wrong
   * falls back to the BROWSER glob, which locks a directory the unit check is
   * not in, leaving the check the builder is about to be graded by editable.
   */
  readonly checkDirGlob: string;
  /** The check's filename, relative to {@link CheckLocation.checkDir}. */
  readonly checkPath: string;
}

/**
 * The BROWSER runner's check location, or `undefined` when the issue number or
 * the path is unusable. No `packageDir` parameter exists, so this door cannot
 * produce a location pointing anywhere but `apps/nextjs/e2e/checks/issue-<N>/`.
 */
export function browserCheckLocation(
  issueNumber: number,
  checkPath: string,
): CheckLocation | undefined {
  if (!isUsableIssueNumber(issueNumber)) return undefined;
  // THE ONE NORMALISATION, and it happens BEFORE the whitelist so the
  // whitelist still grades the string that will actually be joined (issue
  // #1235). Both doors do it, because both are reachable from an envelope the
  // #1271 sibling-repair road handed a repo-relative path to — see
  // `withoutRedundantIssueDirPrefix` for why a doubled `issue-<N>/` segment is
  // repaired rather than refused.
  const rel = withoutRedundantIssueDirPrefix(issueNumber, checkPath);
  if (!isSafeCheckRelativePath(rel)) return undefined;
  return {
    kind: "browser",
    issueNumber,
    checkDir: checkDirForIssue(issueNumber),
    checkDirGlob: checkDirGlobForIssue(issueNumber),
    checkPath: rel,
  };
}

/**
 * The UNIT runner's check location, or `undefined` when the issue number, the
 * host package or the path is unusable. `packageDir` is REQUIRED and
 * whitelisted to `packages/<name>` (never an app — see
 * {@link isSafeUnitCheckPackage}), and `checkPath` must end `.test.ts`, so
 * this door cannot produce a location pointing at a browser check directory or
 * naming a browser check file.
 */
export function unitCheckLocation(
  issueNumber: number,
  packageDir: string,
  checkPath: string,
): CheckLocation | undefined {
  if (!isUsableIssueNumber(issueNumber)) return undefined;
  if (!isSafeUnitCheckPackage(packageDir)) return undefined;
  // See `browserCheckLocation`'s note: normalise, then whitelist.
  const rel = withoutRedundantIssueDirPrefix(issueNumber, checkPath);
  if (!isSafeUnitCheckRelativePath(rel)) return undefined;
  return {
    kind: "unit",
    issueNumber,
    checkDir: unitCheckDirFor(packageDir, issueNumber),
    checkDirGlob: unitCheckDirGlobFor(packageDir, issueNumber),
    checkPath: rel,
  };
}

/** Repo-relative, POSIX-separated path of the check file itself. */
export function checkFileRelPath(loc: CheckLocation): string {
  return `${loc.checkDir}/${loc.checkPath}`;
}

/**
 * The requirement a check file meets simply by BEING THERE, as the
 * human-readable string a refusal prints (issue #1235).
 *
 * It exists because a missing file and a bad file were wearing one message. Both
 * content scans — `missingGradedHelperCalls` and `missingUnitCheckRequirements`
 * — fail closed on an unreadable file by reporting THEIR OWN requirement unmet,
 * which is the right instinct and the wrong sentence: when the #1271 sibling
 * repair named a path that did not exist, the run told the owner the check
 * "does not import at least one real product module", of a file nobody could
 * open. Two different faults, one message, and the message pointed away from
 * the actual problem for a full night.
 *
 * The scans keep their fail-closed behaviour unchanged — they are content
 * scans, and a caller that skipped them on an unreadable file would be trusting
 * an absence. This is asked FIRST, by the caller, so the specific fault is the
 * one reported.
 */
export const CHECK_FILE_ON_DISK_REQUIREMENT =
  "exist at all — no file was found at that path in the worktree";

/**
 * Is this location's check file actually on disk? `false` for absent, for a
 * directory, and for anything `stat` itself cannot reach — an unsearchable
 * parent directory, a broken symlink, a stray non-path — every one of which is
 * "there is no check here to run", which is what the caller needs to say out
 * loud.
 *
 * WHAT IT DOES NOT PROVE, deliberately: `statSync(...).isFile()` says the entry
 * exists and is a regular file, NOT that its bytes can be read. A file whose
 * permissions forbid reading (mode 000) passes this probe, and the content scan
 * behind it then fails closed and reports ITS OWN requirement unmet — the very
 * conflation {@link CHECK_FILE_ON_DISK_REQUIREMENT} exists to end, surviving in
 * one narrow case. It stays narrow on purpose: probing with a read would cost
 * an open and a full file read on every check, twice per ticket, and the loop
 * has never once hit an unreadable-but-present check file. If it ever does, the
 * fix is to read here, not to widen this sentence.
 *
 * Never throws, like everything else in this module.
 */
export function checkFileIsOnDisk(
  worktreePath: string,
  loc: CheckLocation,
): boolean {
  try {
    return statSync(path.join(worktreePath, checkFileRelPath(loc))).isFile();
  } catch {
    return false;
  }
}

/** Repo-relative, POSIX-separated path of the receipt for one check. */
export function mustFailFirstReceiptRelPath(loc: CheckLocation): string {
  return `${loc.checkDir}/${MUST_FAIL_FIRST_RECEIPT_FILENAME}`;
}

/**
 * Is `p` a legal check path for THIS location's runner? The receipt on disk
 * carries its own `checkPath`, and a forged or hand-edited copy can name
 * anything at all — so it is whitelisted with the predicate belonging to the
 * runner whose directory it was found in, never with whichever one happens to
 * be imported.
 */
function isSafePathForKind(kind: CheckKind, p: unknown): p is string {
  return kind === "browser"
    ? isSafeCheckRelativePath(p)
    : isSafeUnitCheckRelativePath(p);
}

/**
 * WHO saw this check fail, and against WHAT code (2026-08-04 review, blocker
 * 4 + the resume-path honesty finding). One receipt, three genuinely
 * different provenances — a record that said only "verdict: red" made two of
 * them into claims that were not true:
 *
 *   - `proved-red-pre-build` — the ordinary case, and the only one the
 *     receipt's own contract used to describe: the loop ran the proof against
 *     the code as it stood BEFORE the builder touched it, and it failed.
 *   - `proved-red-post-resume` — the loop ran the proof on a worktree cut
 *     from a WIP checkpoint, which may already contain the builder's work. It
 *     really did come back red, so it is worth carrying; it was simply not
 *     proven against untouched code, and the record must not say it was.
 *   - `inherited-human-committed` — Piece J. The loop never ran a proof at
 *     all: a person watched this check go red during a supervised diagnosis
 *     session and committed it before the loop ever claimed the issue
 *     (`check-writer-prompt.md`'s "Inheriting an already-proven-red check").
 *     Minting one of these is what lets an inherited check survive a
 *     checkpoint/resume — see this module's header.
 */
export const MUST_FAIL_FIRST_BASES = [
  "proved-red-pre-build",
  "proved-red-post-resume",
  "inherited-human-committed",
] as const;
export type MustFailFirstBasis = (typeof MUST_FAIL_FIRST_BASES)[number];

/**
 * What the receipt records. `verdict` is a fixed `"red"` rather than the
 * three-way `mustFailFirst` value on purpose: a receipt exists ONLY for a
 * check somebody has seen FAIL. "Green" and "inconclusive" are not proofs to
 * be carried forward — they are the two readings that already ride the
 * one-retry-then-stop ladder, and a ticket must never resume on either.
 * {@link MustFailFirstBasis} says who saw it and against what code.
 */
export interface MustFailFirstReceipt {
  readonly issue: number;
  /** The check that was proven, relative to the per-issue check directory. */
  readonly checkPath: string;
  /** sha256 of that check file's exact bytes at the moment it was proven. */
  readonly checkSha256: string;
  readonly verdict: "red";
  readonly basis: MustFailFirstBasis;
  readonly provedAtIso: string;
}

function isMustFailFirstBasis(v: unknown): v is MustFailFirstBasis {
  return (MUST_FAIL_FIRST_BASES as readonly unknown[]).includes(v);
}

/**
 * Record that `loc`'s check is not owed a must-fail-first proof, and WHY
 * (`basis`, defaulting to the ordinary pre-build proof). Returns the receipt
 * it wrote, or `undefined` when the check file could not be read or the
 * receipt could not be written — never throws, and a failure to write only
 * costs a re-proof later, never a false waiver.
 *
 * There is no "unsafe path" failure left to report here: a `CheckLocation`
 * cannot hold one.
 */
export function writeMustFailFirstReceipt(
  worktreePath: string,
  loc: CheckLocation,
  basis: MustFailFirstBasis = "proved-red-pre-build",
): MustFailFirstReceipt | undefined {
  const sha = checkFileSha256(worktreePath, loc);
  if (sha === undefined) return undefined;
  const receipt: MustFailFirstReceipt = {
    issue: loc.issueNumber,
    checkPath: loc.checkPath,
    checkSha256: sha,
    verdict: "red",
    basis,
    provedAtIso: new Date().toISOString(),
  };
  try {
    writeFileSync(
      path.join(worktreePath, mustFailFirstReceiptRelPath(loc)),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
  } catch {
    return undefined;
  }
  return receipt;
}

/**
 * The receipt sitting in this location's check directory, when there is a
 * well-formed one. `undefined` for absent, unreadable, malformed, or
 * structurally invalid — all four are the same thing to a caller: no proof to
 * carry.
 */
export function readMustFailFirstReceipt(
  worktreePath: string,
  loc: CheckLocation,
): MustFailFirstReceipt | undefined {
  let raw: string;
  try {
    raw = readFileSync(
      path.join(worktreePath, mustFailFirstReceiptRelPath(loc)),
      "utf8",
    );
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.issue !== "number" || !Number.isInteger(r.issue)) return undefined;
  // The receipt is committed inside the check directory, which the
  // protected-path lock covers — but it is still a file on disk that a
  // forged or hand-edited copy can name anything at all. Same whitelist
  // discipline the command builders apply, and specifically THIS runner's
  // whitelist: a `.test.ts` sitting in a receipt found in the browser
  // directory is not a check this loop can run, so it is not a receipt.
  if (!isSafePathForKind(loc.kind, r.checkPath)) return undefined;
  if (typeof r.checkSha256 !== "string" || r.checkSha256.length === 0) {
    return undefined;
  }
  if (r.verdict !== "red") return undefined;
  // A receipt written before `basis` existed means the only thing a receipt
  // could mean back then: an ordinary pre-build proof.
  const basis = r.basis === undefined ? "proved-red-pre-build" : r.basis;
  if (!isMustFailFirstBasis(basis)) return undefined;
  if (typeof r.provedAtIso !== "string" || r.provedAtIso.length === 0) {
    return undefined;
  }
  return {
    issue: r.issue,
    checkPath: r.checkPath,
    checkSha256: r.checkSha256,
    verdict: "red",
    basis,
    provedAtIso: r.provedAtIso,
  };
}

/**
 * Has THIS issue's THIS check already been proven to fail against untouched
 * code, durably enough to skip re-proving it?
 *
 * Four things must all line up, and any one of them missing means "no":
 * a well-formed receipt exists in this location's directory; it was minted for
 * this issue; it names this check path; and the check file on disk right now
 * still hashes to what the receipt says was proven.
 */
export function mustFailFirstAlreadyProven(
  worktreePath: string,
  loc: CheckLocation,
): boolean {
  const receipt = readMustFailFirstReceipt(worktreePath, loc);
  if (receipt === undefined) return false;
  if (receipt.issue !== loc.issueNumber) return false;
  if (receipt.checkPath !== loc.checkPath) return false;
  const sha = checkFileSha256(worktreePath, loc);
  return sha !== undefined && sha === receipt.checkSha256;
}

function checkFileSha256(
  worktreePath: string,
  loc: CheckLocation,
): string | undefined {
  // No whitelist call here any more, and that is not a weakening: `loc` cannot
  // exist unless its `checkPath` already passed its runner's whitelist and its
  // `checkDir` was built by this module from a validated issue number and
  // package. The guard moved to the one place it cannot be skipped, which is
  // exactly what the call site that used to skip it needed. Nothing here can
  // leak (the bytes become a discarded hash) or write, but an arbitrary-path
  // read is still a read.
  try {
    const bytes = readFileSync(
      path.join(worktreePath, loc.checkDir, loc.checkPath),
    );
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}
