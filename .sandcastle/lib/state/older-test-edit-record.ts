/**
 * THE SIBLING-CHECK AMENDMENT (#1271) — the record the loop writes onto an
 * OLDER ticket whose loop-written test it had to amend to ship a newer one.
 *
 * ## Why this exists at all
 *
 * Every ticket the loop ships leaves a test behind that pins the rule as it
 * stood that night. On `main` as of 2026-09-10 that is 107 test files across
 * 103 check folders, and the pile only grows. When a LATER ticket changes one
 * of those pinned rules, the older test goes red on correct code, and
 * until #1271 the finished build was thrown away and a person salvaged it by
 * hand. That is what happened to #1235
 * (naming a live deal while filing an unrelated one) on 2026-09-10: three
 * cases in #1058's cross-Team relist guard relist a property at a DIFFERENT
 * address, which #1235's rule correctly refuses.
 *
 * Since spec #1334 (slice SH) the builder or the fixer may edit the older
 * test on the ordinary path, and the ship gate (`verifyOlderTestEdits` in
 * `main.mts`) allows the edit only when the original older test failed on the
 * new code, the edit stayed inside that one file, its case count is unchanged
 * and nothing was switched off. That is still a real edit to another ticket's
 * proof, on a ticket that may have been closed for weeks — so it must be
 * findable by whoever owned that ticket, on the ticket, in words, without
 * reading a run log that is wiped nightly. This module builds that record.
 *
 * ## Why the markers carry the amending issue's number
 *
 * One older ticket can be amended by SEVERAL later tickets over its life, and
 * each amendment is a separate fact with its own date and files. A
 * single fixed marker pair would make the second amendment silently overwrite
 * the first, or (worse, under the `already-present` latch) never be written at
 * all. Keying the markers on the AMENDER means each amending ticket owns
 * exactly one section on the older ticket's body: idempotent per amender, additive
 * across amenders.
 *
 * Both markers still match `MACHINE_SECTION_RE`
 * (`lib/state/issue-body-sections.ts`), so `ownerAuthoredPart` cuts every one
 * of them out — nothing written here can be read back as owner-authored
 * permission by the `Deletes-test:` gate or the `Blocked-by:` gate.
 */

/**
 * One file of one older ticket's check that the loop amended.
 *
 * `linesAdded` / `linesRemoved` are the diff stats for that file alone. They
 * are on the record because they are the cheapest honest measure of how big
 * the machine's edit was: a two-line fixture change and a rewritten file read
 * identically in prose and very differently here.
 */
export interface OlderTestEditFile {
  /** The OLDER ticket whose check directory this file lives under. */
  readonly issueNumber: number;
  /** Repo-relative path of the amended file. */
  readonly path: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/**
 * Everything the run knows about the older tests one ticket edited, assembled
 * by the ship gate the moment it proved the edit allowed and carried to the
 * ship moment (and the run report).
 */
export interface OlderTestEditRecord {
  /** The ticket being built — the one whose new rule made the older check
   *  wrong. */
  readonly amendedByIssue: number;
  /** The run branch the amendment commit sits on. */
  readonly runBranch: string;
  /** The commit the ship gate verified the edit on. */
  readonly commitSha: string;
  readonly files: readonly OlderTestEditFile[];
  /**
   * Every `files[i].path`, flattened — the exact-path allowlist the ship
   * gate reads (`lockedCheckTouches`). Held as its own field rather than
   * derived at each gate so the list the gate admits and the list the record
   * names cannot drift apart.
   */
  readonly paths: readonly string[];
}

export interface BuildOlderTestEditSectionOptions {
  readonly amendment: OlderTestEditRecord;
  /** The OLDER ticket this section is being written onto. */
  readonly olderIssue: number;
  /** ISO date (`YYYY-MM-DD`), for the heading. */
  readonly date: string;
}

/**
 * The HTML-comment markers for one amender's section on an older ticket's body,
 * passed to `upsertMarkedSection` / `readMarkedSection`
 * (`lib/state/body-sections.ts`) by
 * {@link import("./gh.js").applyOlderTestEditRecord}.
 *
 * Shaped to match `MACHINE_SECTION_RE` in `lib/state/issue-body-sections.ts`,
 * exactly like `FIRST_TEST_FALLTHROUGH_SECTION_START`, so
 * `ownerAuthoredPart` removes it.
 */
export function olderTestEditMarkers(amendedByIssue: number): {
  readonly start: string;
  readonly end: string;
} {
  // The pre-#1334 marker name, kept: older ticket bodies already carry it,
  // and the latch must keep finding them.
  const name = `sibling-check-amendment-by-${amendedByIssue}`;
  return {
    start: `<!-- sandcastle:${name}:start -->`,
    end: `<!-- sandcastle:${name}:end -->`,
  };
}

/**
 * Build the marked-section markdown for ONE older ticket.
 *
 * Returns the section CONTENT, not the wrapped block: the markers are applied
 * by the writer, through `upsertMarkedSection`, exactly the way
 * `buildFirstTestFallThroughSection` / `applyFirstTestFallThroughReport`
 * already split that job. Emitting the markers here as well would nest one
 * marked block inside another and leave an orphan `:end` marker in the part
 * of the body `ownerAuthoredPart` hands back as owner-authored.
 *
 * Only the files belonging to {@link BuildOlderTestEditSectionOptions.olderIssue}
 * are listed. One repair can amend checks of up to three different older
 * tickets, and each of their bodies must describe its OWN file, not the
 * others'.
 *
 * Pure and total — the same inputs always produce the same string, which is
 * what lets the writer decide whether anything actually changed rather than
 * reasoning about it.
 */
export function buildOlderTestEditSection(
  opts: BuildOlderTestEditSectionOptions,
): string {
  const { amendment, olderIssue } = opts;
  const mine = amendment.files.filter((f) => f.issueNumber === olderIssue);
  const bullets =
    mine.length > 0
      ? mine
          .map(
            (f) =>
              `- \`${f.path}\` — +${f.linesAdded} −${f.linesRemoved} lines`,
          )
          .join("\n")
      : "- (no file recorded)";

  return [
    `## An older check here was amended by the loop — #${amendment.amendedByIssue}, ${opts.date}`,
    "",
    `Issue #${amendment.amendedByIssue} changed a rule that this ticket's own ` +
      "test pinned, so that test started failing on code that is correct " +
      "under the new rule. The loop ran the ORIGINAL test against the new " +
      "code and saw it fail, then let the edit through only because it " +
      "stayed inside the test file, kept every test case and switched none " +
      "off, and the edited test passed. The reviewer read the whole change " +
      `before #${amendment.amendedByIssue} was allowed to merge.`,
    "",
    "What changed here:",
    "",
    bullets,
    "",
    "**No test case was added, removed or skipped.** The `it(` / `test(` " +
      "count in each file above is unchanged, measured by the run rather " +
      "than claimed by whoever made the edit.",
    "",
    `The amendment is commit \`${amendment.commitSha}\` on run branch ` +
      `\`${amendment.runBranch}\`.`,
    "",
    "If this looks wrong, do not simply revert the file: putting the old " +
      "lines back reinstates the OLD rule inside this ticket's test, which " +
      `would make #${amendment.amendedByIssue}'s guard fail its own suite ` +
      "the next time anyone runs it. Change the rule, or change both, " +
      "together.",
  ].join("\n");
}
