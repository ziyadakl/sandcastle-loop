/**
 * "Is this changed path a test file?" — one canonical answer, for gates that
 * must tell a ticket's *deliverable* apart from the product it exercises.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/checkwriter/`: its caller is
 * `proof-demand.ts`, but this is not check-writer policy — it decides
 * nothing about markers, screens or shipping. It answers "what shape is this
 * path", which is a path question, and `lib/paths/` is where the other path
 * questions already live (`glob.ts`, `protected-paths.ts`,
 * `e2e-script-guard.ts`). Same reasoning `glob.ts:4-11` records for itself.
 *
 * WHAT ITS CALLER USES IT FOR CHANGED under issue #956, and the difference
 * matters when reading the argument below. Under the guard this replaced, a
 * "yes" here WAIVED the proof outright for a test-only diff. It no longer
 * does: `proof-demand.ts` asks only "can this file RENDER" (a test never can,
 * so it cannot force a photograph) and "is this file test material a diff must
 * not delete". A test-only diff owes a unit proof like anything else.
 *
 * DELIBERATELY TIGHT. The two ways this can be wrong are not symmetric:
 *
 *   - Say "not a test" about a real test file → a ticket stops and a person
 *     looks at it. Costs minutes.
 *   - Say "a test" about a real source file → that file rides into `main`
 *     having never been proven to change anything on a screen. That is the
 *     exact hole the red-first rule exists to close.
 *
 * So the match is limited to shapes that CANNOT hold shipped behaviour, by
 * two different mechanisms — worth keeping straight, because they are not
 * equally strict:
 *
 *   - BY FILENAME: `.test.` / `.spec.` in a JS/TS dialect, or a `.snap` file.
 *     A file named this way is a test wherever it sits.
 *   - BY LOCATION: anything at all inside a `__tests__/` or `__snapshots__/`
 *     segment, INCLUDING helpers, seeders and factories that are not
 *     themselves tests. That is the repo's own convention for those two
 *     directory names — nothing inside them is imported by product code —
 *     and four such helper files already exist under `__tests__/` today.
 *
 * Everything else is a real touch, even when a human would call it "just
 * test scaffolding": vitest setup and config files, a fixture builder or
 * factory sitting OUTSIDE a `__tests__/` directory, `package.json`. Note the
 * asymmetry that follows — `packages/api/src/testing/factories.ts` is a real
 * touch, `packages/api/src/__tests__/factories.ts` is not. A test-only ticket
 * that needs the former stops for triage rather than shipping unlooked-at.
 *
 * NOT to be confused with `lib/ops-config/scan.ts`'s local `TEST_FILE_RE`,
 * which asks a different question ("is this a deployable cron route?") and is
 * deliberately left alone.
 *
 * Pure by construction — no IO, no clock, no state.
 */

/** A `.test.` / `.spec.` filename in any JS/TS dialect the repo compiles. */
const TEST_SPEC_FILENAME_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** Directory segments whose entire contents are test material. */
const TEST_DIRECTORY_SEGMENTS: readonly string[] = [
  "__tests__",
  "__snapshots__",
];

/**
 * Does `filePath` (repo-relative, `/`-separated) name a file that can only
 * ever be test material? Total: a non-string, blank, or malformed entry
 * answers `false` — the safe direction, matching `requiredProofForDiff`'s own
 * never-throw contract (`lib/checkwriter/proof-demand.ts`).
 */
export function isTestFilePath(filePath: string): boolean {
  if (typeof filePath !== "string" || filePath.length === 0) return false;

  const segments = filePath.split("/");
  // A `..` anywhere makes every segment-based claim below meaningless:
  // `packages/api/src/__tests__/../../../apps/nextjs/src/app/page.tsx` reads
  // as test material and is not. Git cannot put `..` in a tree path, so no
  // caller can reach this today — it costs one line to keep it that way if a
  // future caller feeds this something less disciplined than a diff.
  if (segments.includes("..")) return false;
  if (segments.some((s) => TEST_DIRECTORY_SEGMENTS.includes(s))) return true;

  const basename = segments[segments.length - 1] ?? "";
  if (basename.endsWith(".snap")) return true;

  return TEST_SPEC_FILENAME_RE.test(basename);
}
