/**
 * The target block — the aim-point a ticket must carry when its subject does
 * not exist yet (issue #1143, ruling 3 of #1106: "No target, no dispatch").
 *
 * ## The hole this closes
 *
 * The run writes a check that must fail against today's code before any builder
 * starts. A ticket whose subject does not exist gives the check-writer nothing
 * to aim at, so it guesses, writes a check that passes against broken code, and
 * the ticket dies at `stopped:no-failing-check` having built nothing — a whole
 * build cycle bought for nothing. Three of six stops on one run were this.
 *
 * ## One home for the format
 *
 * The three server-only target lines — **Call this / Called by / Expect this**
 * — were defined only in the triage checklist skill
 * (`~/.claude/skills/triage-plus-skills/SKILL.md`, step 10), which is not under
 * version control. This module is that format's home INSIDE the repo, so the
 * dispatch guard here and the checklist there read the same source and cannot
 * drift. See `docs/reference/target-block.md`.
 *
 * Pure — string parsing only, no `gh`, no clock — so the guard's decision is
 * testable without the pipeline.
 */

/** The screen target line a SCREEN ticket carries (`docs/reference/target-block.md`). */
export const SCREEN_TARGET_LABEL = "Screen:";

/** The three lines a SERVER-ONLY ticket must carry when its subject is absent. */
export const SERVER_TARGET_LABELS = [
  "Call this:",
  "Called by:",
  "Expect this:",
] as const;

/** The triage receipt line whose value records whether an aim-point was even
 *  needed — `written, <shape>` or `not needed`. */
export const TARGET_RECEIPT_LABEL = "Target:";

/** What {@link auditServerTarget} decided about one ticket body. */
export interface ServerTargetAudit {
  /** The ticket aims at a screen (a `Screen:` line, or a receipt saying so),
   *  so the three server lines do not apply — its target is visual. */
  readonly hasScreen: boolean;
  /** The triage receipt says the subject already exists, so no aim-point was
   *  ever needed — this ticket builds against code that is already there. */
  readonly subjectExistsClaimed: boolean;
  /** Which of the three server target lines are absent or empty. */
  readonly missingServerTargets: readonly string[];
  /** True when the ticket must STOP before the check-writer: server-only, its
   *  subject is not claimed to exist, and it is missing a target line. */
  readonly shouldStop: boolean;
}

/**
 * True when a line carrying `label` has a real, non-empty value.
 *
 * Deliberately FORGIVING — a target line's job is to state an aim a human can
 * read, not to pass a fragile format check. It accepts everything a triage
 * agent naturally writes:
 *   - `- **Call this:** foo`            (the canonical shape)
 *   - `Call this: foo`                  (no markdown)
 *   - `- **Expect this (on refusal):** a 403`   (a note before the colon)
 *   - `- **Expect this (owner rule, 2026-08-25), delivered in-app:**`
 *                                        (the whole aim written before the colon)
 *   - `1. **Call this:** foo`           (a numbered list)
 * The previous version matched the literal `"Expect this:"` — colon glued to
 * the words — so ANY note between the words and the colon read as absent and
 * false-stopped a well-formed ticket (issue #1147). The colon's position no
 * longer matters; only two things do.
 *
 * A line qualifies when, after stripping leading list/markdown decoration:
 *   1. it STARTS with the label words (so a prose line that merely mentions
 *      them mid-sentence — `We should call this feature: a win` — is NOT a
 *      target line), on a word boundary (so `Screen:` does not match
 *      `Screenshots:`), and
 *   2. some real content follows the words (so a bare `- **Call this:**` stub,
 *      which strips to nothing, still counts as ABSENT — a stub is not a
 *      target).
 */
function hasFilledLine(body: string, label: string): boolean {
  const words = label.replace(/:\s*$/, "").toLowerCase();
  return body.split(/\r?\n/).some((line) => {
    // Strip any leading non-letter decoration: list bullets (`- `, `1. `),
    // markdown (`**`, `_`), blockquote (`> `), and whitespace.
    const stripped = line.replace(/^[^A-Za-z]*/, "");
    if (!stripped.toLowerCase().startsWith(words)) return false;
    const after = stripped.slice(words.length);
    // Require a word boundary right after the label words, so `Screen` does
    // not match `Screenshots` and `Call this` does not match `Call thistle`.
    if (/^[A-Za-z]/.test(after)) return false;
    // Real content = anything left once markdown, the colon, brackets and
    // separators are removed. The value may sit before OR after the colon.
    const content = after.replace(/[*_`>\s:().,[\]/-]/g, "");
    return content.length > 0;
  });
}

/** The lowercased value of the `Target:` receipt line, or `""` when absent. */
function targetReceiptValue(body: string): string {
  const needle = TARGET_RECEIPT_LABEL.toLowerCase();
  for (const line of body.split(/\r?\n/)) {
    const idx = line.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    return line.slice(idx + TARGET_RECEIPT_LABEL.length).toLowerCase();
  }
  return "";
}

/**
 * Decide whether a SERVER-ONLY ticket may be dispatched, or must stop for a
 * missing target block.
 *
 * The safety valves matter as much as the stop: an ordinary backend ticket
 * whose subject already exists must NOT be stopped just for lacking a target
 * block (it needs none), and a screen ticket must not be judged by the
 * server-only lines. Both are read from the ticket the loop only ever
 * dispatches AFTER triage, which always writes a `Target:` receipt.
 *
 *   STOP  ⇔  no screen  AND  subject not claimed to exist  AND  a server
 *            target line is missing.
 */
export function auditServerTarget(body: string): ServerTargetAudit {
  const receipt = targetReceiptValue(body);
  const hasScreen =
    hasFilledLine(body, SCREEN_TARGET_LABEL) || receipt.includes("screen shape");
  const subjectExistsClaimed =
    receipt.includes("not needed") || receipt.includes("subject exists");
  const missingServerTargets = SERVER_TARGET_LABELS.filter(
    (label) => !hasFilledLine(body, label),
  );
  const shouldStop =
    !hasScreen && !subjectExistsClaimed && missingServerTargets.length > 0;
  return { hasScreen, subjectExistsClaimed, missingServerTargets, shouldStop };
}
