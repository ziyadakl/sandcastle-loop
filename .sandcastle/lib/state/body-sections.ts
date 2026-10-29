/**
 * Marked sections inside a GitHub issue BODY — insert, replace, and read
 * back one block without disturbing a byte of anything around it.
 *
 * This repo keeps a ticket's state in the issue BODY, never in a comment
 * (`CLAUDE.md`: "Record state in an issue's BODY, never in a comment"), and
 * `gh` has no partial-body-edit verb. So every writer follows the same
 * shape: fetch the whole body, swap one marked block, write the whole body
 * back. Three writers already do it — the stop report (issue #923), the
 * watch-only screen-check observation (issue #916), and now the verdict
 * (issue #1117).
 *
 * Extracted here rather than copied a third time. A body-editing routine
 * that exists in three places is a routine that will be fixed in one of
 * them: each copy fetches a human-edited ticket description and writes it
 * back whole, so a divergence between copies is a ticket-clobbering bug,
 * not a style problem.
 */

/**
 * Insert or REPLACE the block between `start` and `end` inside `body`.
 *
 * Pure and total. `body` may be empty (a brand-new issue), may already
 * carry this block from an earlier write, or may carry unrelated
 * human-written content above and below — all three are handled, and
 * everything outside the markers survives byte-for-byte.
 *
 * A body carrying the start marker but not the end marker (a half-deleted
 * block, which a hand edit can easily leave behind) is treated as having no
 * block at all, and a fresh one is appended. Splicing on a marker whose
 * partner is missing would cut the body at an arbitrary point and delete
 * whatever followed.
 */
export function upsertMarkedSection(
  body: string,
  start: string,
  end: string,
  section: string,
): string {
  const block = `${start}\n${section}\n${end}`;
  const startIdx = body.indexOf(start);
  const endIdx = body.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = body.slice(0, startIdx);
    const after = body.slice(endIdx + end.length);
    return `${before}${block}${after}`;
  }
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
}

/**
 * Read the text between `start` and `end` back out of `body`, or
 * `undefined` when the block is absent or malformed.
 *
 * The reader's tolerance is deliberate and is the whole reason this exists
 * as a shared function: a person is expected to edit these blocks by hand
 * (issue #1117 acceptance 3 — "a person can set or change a verdict after
 * the fact, by editing the ticket"), and a hand edit is exactly what
 * produces a body with one marker and not the other. Returning `undefined`
 * there means the caller reports "nothing recorded" instead of parsing the
 * rest of the ticket description as if it were the block.
 */
export function readMarkedSection(
  body: string,
  start: string,
  end: string,
): string | undefined {
  const startIdx = body.indexOf(start);
  if (startIdx === -1) return undefined;
  const endIdx = body.indexOf(end, startIdx + start.length);
  if (endIdx === -1) return undefined;
  return body.slice(startIdx + start.length, endIdx).trim();
}
